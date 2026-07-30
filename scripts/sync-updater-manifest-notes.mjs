import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 从稳定版本标签得到 Tauri 更新清单使用的裸版本号。
 * 发布流程只接受 vMAJOR.MINOR.PATCH，避免误把其他草稿清单覆盖到当前 Release。
 */
function versionFromReleaseTag(releaseTag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(releaseTag.trim())
  if (!match) {
    throw new Error(`Invalid release tag "${releaseTag}". Use vMAJOR.MINOR.PATCH.`)
  }
  return match.slice(1).join('.')
}

/**
 * 将最终 GitHub Release 正文写入 Tauri latest.json。
 *
 * 版本一致性检查是这里最重要的边界：多平台构建会共同更新同一个草稿 Release，
 * 即使工作流或资产选择出错，也不能把另一个版本的说明静默写入当前更新清单。
 */
export function synchronizeUpdaterManifestNotes(manifestText, releaseNotes, releaseTag) {
  const manifest = JSON.parse(manifestText)
  const expectedVersion = versionFromReleaseTag(releaseTag)
  const normalizedNotes = releaseNotes.trim()

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Updater manifest must be a JSON object.')
  }
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `Updater manifest version mismatch: expected ${expectedVersion}, received ${String(manifest.version)}.`
    )
  }
  if (!normalizedNotes) {
    throw new Error('Release notes must not be empty.')
  }
  if (!manifest.platforms || typeof manifest.platforms !== 'object' || Array.isArray(manifest.platforms)) {
    throw new Error('Updater manifest must contain a platforms object.')
  }

  return `${JSON.stringify({ ...manifest, notes: normalizedNotes }, null, 2)}\n`
}

async function main() {
  const [manifestPathArgument, releaseNotesPathArgument, releaseTag] = process.argv.slice(2)
  if (!manifestPathArgument || !releaseNotesPathArgument || !releaseTag) {
    throw new Error(
      'Usage: node scripts/sync-updater-manifest-notes.mjs <latest.json> <release-notes.md> <release-tag>'
    )
  }

  const manifestPath = resolve(manifestPathArgument)
  const releaseNotesPath = resolve(releaseNotesPathArgument)
  const [manifestText, releaseNotes] = await Promise.all([
    readFile(manifestPath, 'utf8'),
    readFile(releaseNotesPath, 'utf8')
  ])
  const synchronizedManifest = synchronizeUpdaterManifestNotes(manifestText, releaseNotes, releaseTag)
  await writeFile(manifestPath, synchronizedManifest, 'utf8')
  console.log(`Synchronized updater release notes for ${releaseTag}.`)
}

// 使用文件绝对路径判断 CLI 入口，保证该模块被 Bun 测试导入时不会修改磁盘文件。
const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
