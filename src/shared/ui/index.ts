/** 被多个领域复用的基础 UI 与稳定交互原语入口。 */
export * from './AppIcon'
export * from './BinaryDiffPreview'
export * from './binaryPreviewData'
export type { ConflictResolutionResult, ConflictResolutionViewProps } from './ConflictResolutionView'
export * from './AudioPreview'
export * from './FontPreview'
export * from './StructuredAssetPreview'
export * from './TextureCanvasPreview'
export * from './ControlPrimitives'
export * from './CsvTablePreview'
export * from './DiffOptionsControl'
export * from './IconButton'
export * from './ModelCanvasPreview'
export * from './PaneResizer'
export * from './PdfCanvasPreview'
export * from './RevisionAuthorAvatar'
export type { TextDiffFullFileLoader, TextDiffFullFileTarget, TextDiffViewProps } from './TextDiffView'

/**
 * Diffs/Shiki 属于大体积可选界面；由共享 UI 的公开入口负责延迟导入具体实现。
 * 功能模块只调用公开 loader，既保持代码分割，也不穿透 `shared/ui` 模块边界。
 */
export function loadTextDiffViewModule() {
  return import('./TextDiffView')
}

/** 与文本 Diff 共用按需边界的行内冲突视图模块。 */
export function loadConflictResolutionViewModule() {
  return import('./ConflictResolutionView')
}
export * from './VersionContextMenu'
