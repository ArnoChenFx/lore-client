/**
 * 表示一个尚未开始的读取已被更新的界面意图替代。
 *
 * 该错误只在应用内部控制异步生命周期，不应直接展示给用户。调用方仍使用自己的
 * 请求序号判断结果是否属于当前视图，从而让淘汰旧任务与防止旧结果写回互相独立。
 */
export class SupersededTaskError extends Error {
  constructor() {
    super('The queued task was superseded before it started')
    this.name = 'SupersededTaskError'
  }
}

/**
 * 在 Promise `catch` 边界消费队列淘汰产生的预期控制流。
 *
 * 调用方不能使用空 `catch`，否则真实读取错误也会被隐藏；非队列淘汰错误必须保持原始
 * 拒绝状态，继续交给页面错误处理或全局日志边界。
 */
export function ignoreSupersededTaskError(reason: unknown): void {
  if (reason instanceof SupersededTaskError) return
  throw reason
}

interface PendingTask {
  execute: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

/**
 * 顺序完成一组可能失败的读取，并保留与 `Promise.allSettled` 相同的结果结构。
 *
 * 二进制 Diff 的 before/after 单侧都可能携带几十 MiB 原始字节与解码缓存；并行读取
 * 会让两侧峰值直接相加。顺序执行不改变最终展示，却能保证同一预览最多只有一侧在
 * Rust、IPC 与 WebView 解码链路中活动。
 */
export async function settleTasksSequentially<T>(
  tasks: Array<() => Promise<T>>
): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = []
  for (const task of tasks) {
    try {
      results.push({ status: 'fulfilled', value: await task() })
    } catch (reason) {
      results.push({ status: 'rejected', reason })
    }
  }
  return results
}

/**
 * 将高成本读取收敛为“一个执行中任务 + 一个最新等待任务”。
 *
 * WebView 无法撤销已经进入 Tauri 的 invoke；如果只用 React 请求序号丢弃旧响应，
 * 快速切换仍会把每一次完整树扫描、Diff 和二进制解码送进 Rust。该队列不假装取消
 * 已经执行的调用，而是在调用发生前淘汰所有中间意图，使内存峰值不再随点击次数线性
 * 增长。不同读取域应使用独立实例，避免文件树读取阻塞当前文件的文本 Diff。
 */
export class LatestTaskQueue {
  private active = false
  private disposed = false
  private pending: PendingTask | null = null

  /** Strict Mode 会重复执行 effect 的清理与安装，因此所有者可以显式重新启用队列。 */
  activate() {
    this.disposed = false
  }

  /** 提交任务；已有等待任务会在进入真实 I/O 前被最新任务替代。 */
  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new SupersededTaskError())
    }

    return new Promise<T>((resolve, reject) => {
      this.cancelPending()
      this.pending = {
        execute: task,
        resolve: (value) => resolve(value as T),
        reject
      }
      this.drain()
    })
  }

  /** 离开视图但没有新任务接替时，主动释放尚未开始的闭包及其捕获参数。 */
  cancelPending() {
    const pending = this.pending
    this.pending = null
    pending?.reject(new SupersededTaskError())
  }

  /** 所有者卸载时禁止后续任务，并释放唯一一个等待任务。 */
  dispose() {
    this.disposed = true
    this.cancelPending()
  }

  private drain() {
    if (this.active || this.disposed || !this.pending) return

    const current = this.pending
    this.pending = null
    this.active = true
    void current
      .execute()
      .then(current.resolve, current.reject)
      .finally(() => {
        this.active = false
        this.drain()
      })
  }
}
