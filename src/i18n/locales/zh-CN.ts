import { withPluralBases } from './withPluralBases'
import zhCNDynamic from './zh-CN.dynamic'
import zhCNStatic from './zh-CN.static'

/**
 * 简体中文资源：静态标签 + 插值/复数动态句。
 * 新增语言时复制本文件结构，并保证键集合与 `AppLocale` 一致。
 */
const zhCN = {
  ...zhCNStatic,
  ...withPluralBases(zhCNDynamic)
} as const

export type AppLocale = typeof zhCN
export default zhCN
