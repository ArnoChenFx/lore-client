import { t } from '../../i18n'

/**
 * 判断 Lore 是否没有为协作锁返回可识别 Owner。
 *
 * 固定 Lore 版本可能返回空字符串、`unknown` 或 `<unknown>` 哨兵。它们都表示锁事件
 * 没有关联到可展示的认证身份；仓库提交 identity 属于另一套语义，不能用于回填。
 */
export function isUnidentifiedFileLockOwner(owner: string): boolean {
  const normalized = owner.trim().toLocaleLowerCase()
  return normalized.length === 0 || normalized === 'unknown' || normalized === '<unknown>'
}

/**
 * 在渲染期解析 Owner 文案，确保切换语言后不会保留模块加载时的旧翻译。
 * 有效 Owner ID 必须原样展示，不能擅自当作邮箱、用户名或账户显示名改写。
 */
export function fileLockOwnerLabel(owner: string): string {
  return isUnidentifiedFileLockOwner(owner) ? t('unidentifiedFileLockOwner') : owner.trim()
}
