import enUSDynamic from './en-US.dynamic'
import enUSStatic from './en-US.static'
import { withPluralBases } from './withPluralBases'
import type { AppLocale } from './zh-CN'

/** 将中文资源的字符串字面量放宽为 string，仍强制键结构一致。 */
type LocaleShape<T> = {
  [K in keyof T]: T[K] extends string ? string : T[K] extends Record<string, unknown> ? LocaleShape<T[K]> : T[K]
}

/**
 * English 资源必须与 zh-CN 保持相同键集合。
 * 静态与动态句分别在 `en-US.static.ts` / `en-US.dynamic.ts` 与中文成对维护。
 */
const enUS = {
  ...enUSStatic,
  ...withPluralBases(enUSDynamic)
} as const satisfies LocaleShape<AppLocale>

export default enUS
