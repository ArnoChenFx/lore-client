import { isTauri } from '@tauri-apps/api/core'
import type { MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'

import {
  PROJECT_RELEASES_URL,
  PROJECT_REPOSITORY_URL,
  openProjectReleases,
  openProjectRepository
} from '../../services/application'
import { logWarning } from '../../services/logging'

interface ProjectRepositoryLinkProps {
  className?: string
}

interface ProjectReleasesLinkProps {
  className?: string
}

/**
 * GitHub 官方 Mark 的紧凑单色轮廓。
 *
 * 品牌图标使用 currentColor 跟随控件文字，避免为深浅主题维护两份图片；它仅作视觉
 * 辨识，链接本身已经提供完整名称，因此从辅助技术树中隐藏。
 */
function GitHubMark() {
  return (
    <svg
      className="project-repository-link__mark"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 0C3.58 0 0 3.64 0 8c0 3.5 2.29 6.45 5.47 7.5.4.08.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.88-3.64-3.91 0-.87.31-1.58.82-2.14-.08-.2-.36-1.01.08-2.11 0 0 .67-.21 2.2.82A7.5 7.5 0 0 1 8 3.91a7.5 7.5 0 0 1 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.91.08 2.11.51.56.82 1.27.82 2.14 0 3.04-1.87 3.7-3.65 3.9.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

/**
 * 关于页与更新页共享的项目仓库入口。
 *
 * 保留真实 anchor，可让浏览器演示、复制链接与辅助技术正常工作；仅在 Tauri 桌面环境
 * 阻止 WebView 内导航，并转交 Rust 使用系统默认浏览器打开固定地址。
 */
export function ProjectRepositoryLink({ className }: ProjectRepositoryLinkProps) {
  const { t } = useTranslation()

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isTauri()) return
    event.preventDefault()
    void openProjectRepository().catch((error: unknown) => logWarning('project-repository-open', error))
  }

  return (
    <a
      className={['project-repository-link', className].filter(Boolean).join(' ')}
      href={PROJECT_REPOSITORY_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('openProjectRepository')}
      title={t('openProjectRepository')}
      onClick={handleClick}
    >
      <GitHubMark />
      <span>ArnoChenFx/lore-client</span>
    </a>
  )
}

/**
 * 更新弹窗中的发布页入口只保留 GitHub Mark。
 *
 * 纯图标链接仍提供本地化的可访问名称和悬停提示；桌面环境转交固定 Rust 命令，浏览器
 * 演示则直接使用标准链接语义，二者都不会接受运行期传入的任意外部地址。
 */
export function ProjectReleasesLink({ className }: ProjectReleasesLinkProps) {
  const { t } = useTranslation()

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isTauri()) return
    event.preventDefault()
    void openProjectReleases().catch((error: unknown) => logWarning('project-releases-open', error))
  }

  return (
    <a
      className={['project-repository-link', 'project-repository-link--icon-only', className].filter(Boolean).join(' ')}
      href={PROJECT_RELEASES_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('openProjectReleases')}
      title={t('openProjectReleases')}
      onClick={handleClick}
    >
      <GitHubMark />
    </a>
  )
}
