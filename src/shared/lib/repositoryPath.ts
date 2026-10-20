/**
 * 工作区身份由原生目录解析提供。保留完整路径，不在浏览器猜测文件系统的大小写、
 * 分隔符或空格语义；同一 Lore Repository ID 的本地副本仍是不同工作区。
 */
export function repositoryPathKey(path: string): string {
  return path
}
