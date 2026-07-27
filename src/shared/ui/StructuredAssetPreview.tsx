import { Archive, Box, File, Folder } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { AssetMetadataFact, StructuredAssetPreview as StructuredAssetPreviewData } from '../../types'
import { formatPreviewBytes } from '../lib'

interface StructuredAssetPreviewProps {
  fileName: string
  label: string
  preview: StructuredAssetPreviewData | null | undefined
  /** 原始文件字节数；preview 为 null 时用于显示基础文件信息。 */
  size?: number
}

/** 稳定元数据键到当前语言标签的显式映射；未知未来键仍以原值可诊断展示。 */
function MetadataFactLabel({ factKey }: { factKey: string }) {
  const { t } = useTranslation()
  switch (factKey) {
    case 'version':
      return t('assetMetadataVersion')
    case 'formatVersion':
      return t('assetMetadataFormatVersion')
    case 'engineVersion':
      return t('assetMetadataEngineVersion')
    case 'fileSize':
      return t('assetMetadataFileSize')
    case 'metadataSize':
      return t('assetMetadataMetadataSize')
    case 'dataOffset':
      return t('assetMetadataDataOffset')
    case 'indexOffset':
      return t('assetMetadataIndexOffset')
    case 'indexSize':
      return t('assetMetadataIndexSize')
    case 'legacyVersion':
      return t('assetMetadataLegacyVersion')
    case 'legacyUe3Version':
      return t('assetMetadataLegacyUe3Version')
    case 'endianness':
      return t('assetMetadataEndianness')
    case 'pointerSize':
      return t('assetMetadataPointerSize')
    case 'floatingPoint':
      return t('assetMetadataFloatingPoint')
    case 'blockCount':
      return t('assetMetadataBlockCount')
    case 'objectCount':
      return t('assetMetadataObjectCount')
    case 'meshCount':
      return t('assetMetadataMeshCount')
    case 'materialCount':
      return t('assetMetadataMaterialCount')
    case 'imageCount':
      return t('assetMetadataImageCount')
    case 'sceneCount':
      return t('assetMetadataSceneCount')
    case 'actionCount':
      return t('assetMetadataActionCount')
    case 'armatureCount':
      return t('assetMetadataArmatureCount')
    case 'width':
      return t('assetMetadataWidth')
    case 'height':
      return t('assetMetadataHeight')
    case 'depth':
      return t('assetMetadataDepth')
    case 'layers':
      return t('assetMetadataLayers')
    case 'faces':
      return t('assetMetadataFaces')
    case 'mipLevels':
      return t('assetMetadataMipLevels')
    case 'format':
      return t('assetMetadataPixelFormat')
    case 'typeSize':
      return t('assetMetadataTypeSize')
    case 'compression':
      return t('assetMetadataCompression')
    default:
      return factKey
  }
}

function AssetWarning({ code }: { code: string }) {
  const { t } = useTranslation()
  switch (code) {
    case 'unrealPakVersionedIndex':
      return t('assetWarningUnrealPakVersionedIndex')
    case 'unrealPakInvalidIndex':
      return t('assetWarningUnrealPakInvalidIndex')
    case 'unityLegacyBundleDirectoryUnavailable':
      return t('assetWarningUnityLegacyBundleDirectoryUnavailable')
    case 'unityLzmaDirectoryUnavailable':
      return t('assetWarningUnityLzmaDirectoryUnavailable')
    case 'unityDeclaredSizeMismatch':
      return t('assetWarningUnityDeclaredSizeMismatch')
    case 'unityVersionMetadataMissing':
      return t('assetWarningUnityVersionMetadataMissing')
    case 'godotEncryptedDirectory':
      return t('assetWarningGodotEncryptedDirectory')
    case 'unrealCompanionRequiresPackage':
      return t('assetWarningUnrealCompanionRequiresPackage')
    case 'unrealVersionedSummaryOnly':
      return t('assetWarningUnrealVersionedSummaryOnly')
    case 'unityObjectTableVersionDependent':
      return t('assetWarningUnityObjectTableVersionDependent')
    case 'godotResourceHeaderOnly':
      return t('assetWarningGodotResourceHeaderOnly')
    default:
      return t('assetWarningLimitedPreview')
  }
}

function MetadataFacts({ facts }: { facts: AssetMetadataFact[] }) {
  const { t } = useTranslation()
  if (facts.length === 0) return null
  return (
    <dl className="binary-diff-preview__metadata-grid">
      {facts.map((fact) => (
        <div key={fact.key}>
          <dt>
            <MetadataFactLabel factKey={fact.key} />
          </dt>
          <dd>
            {fact.key === 'endianness' && fact.value === 'little'
              ? t('littleEndian')
              : fact.key === 'endianness' && fact.value === 'big'
                ? t('bigEndian')
                : fact.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** 渲染 Rust 解析后的归档目录或引擎资产元数据，不接触原始容器字节。 */
export function StructuredAssetPreview({ fileName, label, preview, size }: StructuredAssetPreviewProps) {
  const { t } = useTranslation()
  // 结构化预览不可用时只显示基础文件信息，避免阻塞其他交互。
  if (!preview) {
    return (
      <div className="binary-diff-preview__structured-viewer">
        <header>
          <File size={18} />
          <div>
            <strong>{fileName}</strong>
            {size != null && <small>{formatPreviewBytes(size)}</small>}
          </div>
        </header>
      </div>
    )
  }

  const warningCodes = preview.warningCodes ?? []
  return (
    <div className="binary-diff-preview__structured-viewer" aria-label={t('status.assetPreview', { fileName, label })}>
      <header>
        {preview.type === 'archive' ? <Archive size={18} /> : <Box size={18} />}
        <div>
          <strong>{preview.format}</strong>
          <span>{fileName}</span>
        </div>
        {preview.type === 'archive' && <small>{t('status.archiveEntryCount', { count: preview.totalEntries })}</small>}
      </header>
      <MetadataFacts facts={preview.facts} />
      {preview.type === 'archive' && preview.entries.length > 0 && (
        <div className="binary-diff-preview__archive-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('assetEntryPath')}</th>
                <th scope="col">{t('assetEntrySize')}</th>
                <th scope="col">{t('assetEntryCompressedSize')}</th>
              </tr>
            </thead>
            <tbody>
              {preview.entries.map((entry) => (
                <tr key={`${entry.kind}:${entry.path}:${entry.size}:${entry.compressedSize ?? 'raw'}`}>
                  <td title={entry.path}>
                    {entry.kind === 'directory' ? <Folder size={13} /> : <File size={13} />}
                    <span>{entry.path}</span>
                  </td>
                  <td>{formatPreviewBytes(entry.size)}</td>
                  <td>{entry.compressedSize === undefined ? '—' : formatPreviewBytes(entry.compressedSize)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {preview.type === 'archive' && preview.truncated && (
        <p className="binary-diff-preview__model-hint">
          {t('status.archivePreviewTruncated', { shown: preview.entries.length, total: preview.totalEntries })}
        </p>
      )}
      {warningCodes.map((code) => (
        <p key={code} className="binary-diff-preview__model-hint">
          <AssetWarning code={code} />
        </p>
      ))}
    </div>
  )
}
