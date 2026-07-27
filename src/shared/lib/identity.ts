import { t } from '../../i18n'

/** Git 风格身份的稳定前端投影；Lore 磁盘与 IPC 边界仍只传递单个 identity 字符串。 */
export interface CommitIdentityParts {
  name: string
  email: string
  raw: string
}

const COMPLETE_EMAIL_PATTERN = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u
const GIT_STYLE_IDENTITY_PATTERN = /^(.*?)\s*<([^<>]+)>$/u

/** 去除 IPC 和 TOML 单行字段不允许的换行，同时保留姓名内部有意义的普通空格。 */
function normalizeIdentityPart(value: string): string {
  return value.replace(/[\r\n]/g, '').trim()
}

/**
 * 解析 Lore 的自由文本 identity。
 *
 * 新客户端使用 `作者名 <email>`，旧仓库可能只有邮箱或任意可读名称；解析失败时
 * 必须把完整原文留在 name 中，不能丢弃用户已经固化到历史 Revision 的身份。
 */
export function parseCommitIdentity(value: string): CommitIdentityParts {
  const raw = normalizeIdentityPart(value)
  const gitStyle = raw.match(GIT_STYLE_IDENTITY_PATTERN)
  if (gitStyle) {
    const name = normalizeIdentityPart(gitStyle[1])
    const email = normalizeIdentityPart(gitStyle[2])
    if (name && COMPLETE_EMAIL_PATTERN.test(email)) {
      return { name, email, raw }
    }
  }
  if (COMPLETE_EMAIL_PATTERN.test(raw)) {
    return { name: '', email: raw, raw }
  }
  return { name: raw, email: '', raw }
}

/**
 * 把分离输入编码成固定 Lore 版本能够保存的单个 identity。
 *
 * 姓名或邮箱可以单独存在，以兼容现有自由文本仓库；两者都有值时才使用 Git 风格
 * 尖括号表示，后续历史列表即可稳定拆出可读姓名与 Gravatar 邮箱。
 */
export function formatCommitIdentity(name: string, email: string): string {
  const normalizedName = normalizeIdentityPart(name)
  const normalizedEmail = normalizeIdentityPart(email)
  if (normalizedName && normalizedEmail) {
    return `${normalizedName} <${normalizedEmail}>`
  }
  return normalizedName || normalizedEmail
}

/** 返回 Revision 列表的可读作者名；纯邮箱历史仍原样显示，避免产生虚构姓名。 */
export function revisionAuthorFromIdentity(identity: string): { author: string; email?: string } {
  const parts = parseCommitIdentity(identity)
  return {
    author: parts.name || parts.email || t('unknownAuthor'),
    email: parts.email || undefined
  }
}

/**
 * 判断 Revision 邮箱是否还需作为独立副标题显示。
 *
 * 纯 email identity 已经把完整内容放在 `author` 中，`authorEmail` 仍需
 * 保留给 Gravatar，但界面不应再重复一行相同文本。
 */
export function shouldDisplayRevisionAuthorEmail(author: string, email?: string): email is string {
  return Boolean(email && email !== author)
}
