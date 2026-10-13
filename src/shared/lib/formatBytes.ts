/** 二进制单位的紧凑字节数；与既有 Store / 变更列表的写法保持一致，便于后续合并重复实现。 */
export function formatBytes(bytes: number): string {
  // 速率会被指数平滑到 1 以下；负数和 NaN 同样落到这里，不能算出 undefined 单位。
  if (!(bytes > 0)) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = bytes < 1 ? 0 : Math.min(Math.floor(Math.log(bytes) / Math.log(1_024)), units.length - 1)
  return `${(bytes / 1_024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}
