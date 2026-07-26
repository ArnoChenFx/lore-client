import { useEffect, useState } from 'react'

type RevisionAuthorAvatarVariant = 'compact' | 'detail'

interface RevisionAuthorAvatarProps {
  identity: string
  initials: string
  variant: RevisionAuthorAvatarVariant
}

/*
 * Revision identity 是 Lore 历史元数据中的自由文本。这里只接受“整段内容就是邮箱”
 * 的形式，避免把普通作者名称中的 `@`、尖括号身份或损坏元数据误发给第三方服务。
 * 邮箱完整 RFC 语法远比头像查询需要的边界复杂；当前约束覆盖 Lore 配置中的常见邮箱，
 * 同时拒绝空白、多个 @、缺少域名后缀以及超过协议常用上限的值。
 */
const REVISION_EMAIL_PATTERN = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u
const MAX_EMAIL_LENGTH = 254

/** Gravatar 官方要求在哈希前去除首尾空白并转为小写。 */
export function normalizeRevisionAuthorEmail(identity: string): string | null {
  const normalized = identity.trim().toLocaleLowerCase('en-US')
  if (normalized.length === 0 || normalized.length > MAX_EMAIL_LENGTH || !REVISION_EMAIL_PATTERN.test(normalized)) {
    return null
  }
  return normalized
}

/** 把 Web Crypto 返回的字节序列转换为 Gravatar URL 所需的小写十六进制。 */
function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * 根据历史 identity 构造 Gravatar 图片地址。
 *
 * `d=404` 很关键：邮箱没有设置头像时，Gravatar 必须返回加载错误，组件才能继续
 * 显示本地缩写，而不是悄悄换成第三方生成的默认图。`r=g` 则把内容限制为通用分级。
 * Web Crypto 不可用时返回 null，使离线、旧 WebView 和服务端渲染都保持可用。
 */
export async function createRevisionAvatarUrl(identity: string, pixelSize: number): Promise<string | null> {
  const email = normalizeRevisionAuthorEmail(identity)
  if (!email || !globalThis.crypto?.subtle) {
    return null
  }

  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(email))
  const hash = bytesToHex(digest)
  const safeSize = Math.min(2048, Math.max(1, Math.round(pixelSize)))
  return `https://www.gravatar.com/avatar/${hash}?s=${safeSize}&d=404&r=g`
}

/*
 * 同一作者通常会同时出现在列表多行或 Inspector 中。Promise 级缓存可以合并同邮箱、
 * 同尺寸的 SHA-256 计算；这里只缓存 URL，不缓存图片响应，也不改变浏览器自身缓存策略。
 */
const avatarUrlCache = new Map<string, Promise<string | null>>()

function cachedRevisionAvatarUrl(identity: string, pixelSize: number): Promise<string | null> {
  const email = normalizeRevisionAuthorEmail(identity)
  if (!email) {
    return Promise.resolve(null)
  }

  const cacheKey = `${email}:${pixelSize}`
  const cached = avatarUrlCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const request = createRevisionAvatarUrl(email, pixelSize).catch(() => null)
  avatarUrlCache.set(cacheKey, request)
  return request
}

/**
 * Revision 作者头像。
 *
 * 缩写始终先渲染在底层，远程图片只有在 SHA-256 计算完成且加载成功后才覆盖它。
 * 图片失败只影响当前 URL 的显示，不移除作者文字，也不会让列表行发生尺寸跳动。
 */
export function RevisionAuthorAvatar({ identity, initials, variant }: RevisionAuthorAvatarProps) {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const requestedPixelSize = variant === 'compact' ? 40 : 64

  useEffect(() => {
    let active = true
    setAvatarUrl(null)
    setFailedUrl(null)

    void cachedRevisionAvatarUrl(identity, requestedPixelSize).then((url) => {
      if (active) {
        setAvatarUrl(url)
      }
    })

    return () => {
      active = false
    }
  }, [identity, requestedPixelSize])

  const visibleUrl = avatarUrl && avatarUrl !== failedUrl ? avatarUrl : undefined

  return (
    <span
      className={`revision-author-avatar revision-author-avatar--${variant}`}
      data-avatar-state={visibleUrl ? 'remote' : 'fallback'}
      aria-hidden="true"
    >
      <span className="revision-author-avatar__fallback">{initials || '?'}</span>
      {visibleUrl && (
        <img
          src={visibleUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(visibleUrl)}
        />
      )}
    </span>
  )
}
