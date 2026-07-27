import { t } from '../i18n'
import { BRAND_ACCENT_COLOR } from '../shared/lib'
import type { Repository } from '../types'

/** 无仓库时的稳定占位 DTO；每次渲染读取当前语言，避免文案冻结在模块加载时。 */
export function createPlaceholderRepository(): Repository {
  return {
    id: 'no-repository',
    name: t('chooseALoreRepository'),
    branch: t('noWorkspaceOpen'),
    revision: '',
    path: t('useRepositorySwitcherOpenDirectory_1a07'),
    ahead: 0,
    behind: 0,
    online: false,
    remoteState: 'local',
    color: BRAND_ACCENT_COLOR,
    conflictCount: 0,
    unresolvedConflictCount: 0
  }
}
