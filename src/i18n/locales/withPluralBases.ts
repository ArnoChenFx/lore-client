/**
 * 为 i18next 复数键补上无后缀的回退值。
 * 资源文件只维护 `_one` / `_other`；入口合并时再补裸键，便于类型与缺后缀时仍可读。
 */
export function withPluralBases<T extends Record<string, Record<string, string>>>(groups: T): T {
  const next = { ...groups }
  for (const [groupName, values] of Object.entries(groups)) {
    const group = { ...values }
    for (const [key, value] of Object.entries(values)) {
      if (!key.endsWith('_other')) continue
      const base = key.slice(0, -'_other'.length)
      if (!(base in group)) group[base] = value
    }
    next[groupName as keyof T] = group as T[keyof T]
  }
  return next
}
