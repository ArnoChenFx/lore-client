import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

/**
 * 终止脚本拥有的子进程并等待退出，避免随后删除浏览器资料目录时仍有文件句柄存活。
 */
export async function terminateOwnedProcess(childProcess, timeoutMilliseconds = 5_000) {
  if (!childProcess || childProcess.exitCode !== null) {
    return
  }

  const exited = new Promise((resolveExit) => childProcess.once('exit', resolveExit))
  childProcess.kill()
  await Promise.race([exited, delay(timeoutMilliseconds)])

  // 普通终止超时后再尽力强制结束；Windows 会把该信号映射为 TerminateProcess。
  if (childProcess.exitCode === null) {
    childProcess.kill('SIGKILL')
    await Promise.race([new Promise((resolveExit) => childProcess.once('exit', resolveExit)), delay(2_000)])
  }
}

/**
 * 只清理由调用方明确创建、且严格位于系统临时目录内部的路径。
 */
export async function removeOwnedTemporaryDirectory(directoryPath, options = {}) {
  if (!directoryPath) {
    return
  }

  const resolvedTemporaryRoot = resolve(tmpdir())
  const resolvedDirectory = resolve(directoryPath)
  const relativePath = relative(resolvedTemporaryRoot, resolvedDirectory)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Refusing to remove a path outside the system temporary directory: ${resolvedDirectory}`)
  }

  const attempts = options.attempts ?? 40
  const retryDelayMilliseconds = options.retryDelayMilliseconds ?? 250
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(resolvedDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
      return
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        await delay(retryDelayMilliseconds)
      }
    }
  }

  throw lastError
}
