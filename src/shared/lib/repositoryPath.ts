/**
 * 工作区身份由原生目录解析提供。保留完整路径，不在浏览器猜测文件系统的大小写、
 * 分隔符或空格语义；同一 Lore Repository ID 的本地副本仍是不同工作区。
 */
export function repositoryPathKey(path: string): string {
  return path
}

/**
 * 路径表单每行表示一个精确文件名；空行没有选区含义，空格和逗号则属于文件名。
 * CRLF 仅作为换行分隔符处理，原生返回的路径数组无需经过此文本输入解析。
 */
export function parseRepositoryFilePathLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).filter((path) => path.length > 0))]
}
