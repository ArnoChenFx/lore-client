/** 文件预览与文本读取，包括二进制预览的流式分块组装。 */
import { Channel, isTauri } from '@tauri-apps/api/core'

import { t } from '../../i18n'
import type { OperationContext, BinaryFilePreview } from '../../types'
import { invokeCommand } from './core'
import { DEFAULT_WORKSPACE_TEXT_LIMIT_BYTES, normalizeWorkspaceTextLimit } from './utils'

/**
 * 按需读取一个工作区或不可变 Revision 文件的二进制预览。
 *
 * `revision` 为空表示工作区真实文件；非空时 Rust 会从该 Revision Tree 的内容地址
 * 读取。调用方只为当前主要选择调用；关闭二进制 Diff 时传入 `metadataOnly`，Rust 只
 * 返回前后大小且不读取正文，避免完整 Diff 批量传输资产。
 */
export async function loadBinaryFilePreview(
  repositoryPath: string,
  path: string,
  revision?: string,
  metadataOnly = false,
  previewLimitMiB = 20,
  operationContext?: OperationContext
): Promise<BinaryFilePreview> {
  const assembler = createBinaryPreviewStreamAssembler()
  const onChunk = new Channel<BinaryPreviewStreamMessage>((message) => assembler.accept(message))
  try {
    await invokeCommand<void>(
      'lore_file_preview_stream',
      {
        repositoryPath,
        path,
        revision,
        metadataOnly,
        previewLimitMib: previewLimitMiB,
        onChunk
      },
      operationContext
    )
    assembler.complete()
  } catch (error) {
    // 统一让下方等待中的 Promise 传播失败，避免 invoke 失败时产生一个无人消费的
    // rejection；这条路径仍会保留 invokeCommand 已完成的结构化错误映射。
    assembler.fail(error)
  }
  const envelope = await assembler.result
  return decodeBinaryFilePreviewEnvelope(envelope)
}

interface BinaryPreviewStreamHeader {
  byteLength: number
}

type BinaryPreviewStreamMessage = BinaryPreviewStreamHeader | ArrayBuffer

interface BinaryPreviewStreamAssembler {
  result: Promise<ArrayBuffer>
  accept: (message: BinaryPreviewStreamMessage) => void
  complete: () => void
  fail: (error: unknown) => void
}

const BINARY_PREVIEW_BASE_COMPLETION_TIMEOUT_MS = 30_000

const BINARY_PREVIEW_TIMEOUT_BYTES_PER_SECOND = 8 * 1024 * 1024

const MAX_JAVASCRIPT_TIMEOUT_MS = 2_147_000_000

/**
 * Rust 命令完成后，Channel 的 Raw 块仍可能在 WebView 传输队列中。
 *
 * 设置不设产品最大值，因此等待窗口按信封大小和保守的 8 MiB/s 吞吐量增长；只在
 * JavaScript 计时器自身的技术边界截断，避免合法的大文件仍被旧 30 秒窗口误杀。
 */
export function binaryPreviewCompletionTimeoutMs(byteLength: number): number {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    return BINARY_PREVIEW_BASE_COMPLETION_TIMEOUT_MS
  }
  return Math.min(
    MAX_JAVASCRIPT_TIMEOUT_MS,
    BINARY_PREVIEW_BASE_COMPLETION_TIMEOUT_MS + Math.ceil(byteLength / BINARY_PREVIEW_TIMEOUT_BYTES_PER_SECOND) * 1000
  )
}

/**
 * 汇集 Tauri Channel 的有序二进制预览小块。
 *
 * 第一条 JSON 消息声明最终长度，后续每个 Raw ArrayBuffer 都只做一次有界 `set`。
 * 这避免 WebView2 在一个 IPC 回调里接收、复制完整预览载荷；最终仍保持现有稳定
 * DTO 所需的单一连续 ArrayBuffer，组件和取消队列无需感知传输细节。
 */
export function createBinaryPreviewStreamAssembler(): BinaryPreviewStreamAssembler {
  let target: Uint8Array<ArrayBuffer> | null = null
  let receivedBytes = 0
  let commandCompleted = false
  let settled = false
  let completionTimeout: ReturnType<typeof setTimeout> | null = null
  let resolveResult: (value: ArrayBuffer) => void = () => undefined
  let rejectResult: (reason?: unknown) => void = () => undefined
  const result = new Promise<ArrayBuffer>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const fail = (error: unknown) => {
    if (settled) return
    settled = true
    if (completionTimeout) clearTimeout(completionTimeout)
    rejectResult(error instanceof Error ? error : new Error(String(error)))
  }

  const scheduleCompletionTimeout = () => {
    if (settled || !commandCompleted) return
    if (completionTimeout) clearTimeout(completionTimeout)
    completionTimeout = setTimeout(
      () => {
        fail(
          new Error(
            target
              ? 'Binary preview IPC stream completed before all bytes arrived'
              : 'Binary preview IPC stream completed without a header'
          )
        )
      },
      binaryPreviewCompletionTimeoutMs(target?.byteLength ?? 0)
    )
  }

  const finishIfReady = () => {
    if (settled || !commandCompleted || !target || receivedBytes !== target.byteLength) return
    settled = true
    if (completionTimeout) clearTimeout(completionTimeout)
    resolveResult(target.buffer)
  }

  const accept = (message: BinaryPreviewStreamMessage) => {
    if (settled) return
    if (!(message instanceof ArrayBuffer)) {
      if (target || !Number.isSafeInteger(message.byteLength) || message.byteLength <= 0) {
        fail(new Error('Binary preview IPC stream header is invalid'))
        return
      }
      target = new Uint8Array(message.byteLength)
      // invoke 可能先于排队的 Channel 头返回；拿到真实长度后必须扩展先前的基础窗口。
      scheduleCompletionTimeout()
      finishIfReady()
      return
    }
    if (!target) {
      fail(new Error('Binary preview IPC stream payload arrived before its header'))
      return
    }
    const chunk = new Uint8Array(message)
    if (receivedBytes + chunk.byteLength > target.byteLength) {
      fail(new Error('Binary preview IPC stream exceeds its declared length'))
      return
    }
    // Rust 将单块限制为 256 KiB；每次复制都是有界短任务，浏览器可在消息间绘制和响应输入。
    target.set(chunk, receivedBytes)
    receivedBytes += chunk.byteLength
    finishIfReady()
  }

  const complete = () => {
    commandCompleted = true
    finishIfReady()
    if (settled) return
    /*
     * Rust 命令返回只说明所有 Channel 消息已经排入 WebView；较大的 Raw 消息仍可能在
     * 独立 fetch 中传输，不能在 invoke resolve 时误判为缺块。超时只防御底层通道异常，
     * 正常的用户可配置上限远低于该窗口。
     */
    scheduleCompletionTimeout()
  }

  return { result, accept, complete, fail }
}

interface BinaryFilePreviewMetadata extends Omit<BinaryFilePreview, 'data'> {}

/**
 * 解码 Rust Raw IPC 二进制信封。
 *
 * 只为 UTF-8 JSON 元数据创建短字符串；资产正文保持 `Uint8Array` 视图，避免
 * ArrayBuffer → Base64 → atob → Uint8Array 的三重峰值与长期字符串高水位。
 */
export function decodeBinaryFilePreviewEnvelope(envelope: ArrayBuffer): BinaryFilePreview {
  const bytes = new Uint8Array(envelope)
  if (bytes.byteLength < 4) {
    throw new Error('Binary preview IPC envelope is incomplete')
  }
  const metadataLength = new DataView(envelope, 0, 4).getUint32(0, true)
  const payloadOffset = 4 + metadataLength
  if (metadataLength <= 0 || payloadOffset > bytes.byteLength) {
    throw new Error('Binary preview IPC metadata length is invalid')
  }
  const metadataText = new TextDecoder().decode(bytes.subarray(4, payloadOffset))
  const metadata = JSON.parse(metadataText) as BinaryFilePreviewMetadata
  if (
    !metadata.path ||
    !metadata.kind ||
    !metadata.mimeType ||
    !Number.isFinite(metadata.size) ||
    (metadata.contentState !== 'available' &&
      metadata.contentState !== 'tooLarge' &&
      metadata.contentState !== 'unsupported' &&
      metadata.contentState !== 'metadataOnly')
  ) {
    throw new Error('Binary preview IPC metadata is invalid')
  }
  return {
    ...metadata,
    // subarray 不复制载荷；React state 只保留本次信封的一个 ArrayBuffer 所有权。
    data: bytes.subarray(payloadOffset)
  }
}

/**
 * 有界读取工作区文本文件内容，供行内冲突解决等真实内容预览使用。
 *
 * 只接受 Rust 已确认为文本的工作区普通文件；超过大小上限时返回结构化错误，
 * 前端据此显示原因而不是把截断内容交给 Diff 库。
 */
export async function loadWorkspaceText(
  repositoryPath: string,
  path: string,
  maxBytes = DEFAULT_WORKSPACE_TEXT_LIMIT_BYTES,
  operationContext?: OperationContext
): Promise<string> {
  if (!isTauri()) {
    throw new Error(t('browserDemoMode'))
  }
  return invokeCommand<string>(
    'lore_read_workspace_text',
    {
      repositoryPath,
      relativePath: path,
      maxBytes: normalizeWorkspaceTextLimit(maxBytes)
    },
    operationContext
  )
}

/**
 * 有界读取指定不可变 Revision 中的文本文件内容，供 Diff 展开全文使用。
 *
 * 只接受 Rust 已确认为文本的 Revision 普通文件；超过大小上限或非 UTF-8 时返回
 * 结构化错误，前端据此显示原因而不是把截断内容交给 Diff 库。
 */
export async function loadRevisionText(
  repositoryPath: string,
  revision: string,
  path: string,
  maxBytes = DEFAULT_WORKSPACE_TEXT_LIMIT_BYTES,
  operationContext?: OperationContext
): Promise<string> {
  if (!isTauri()) {
    throw new Error(t('browserDemoMode'))
  }
  return invokeCommand<string>(
    'lore_read_revision_text',
    {
      repositoryPath,
      revision,
      relativePath: path,
      maxBytes: normalizeWorkspaceTextLimit(maxBytes)
    },
    operationContext
  )
}
