import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const packageJsonPath = resolve(projectRoot, 'package.json')
const tauriConfigPath = resolve(projectRoot, 'src-tauri', 'tauri.conf.json')
const cargoTomlPath = resolve(projectRoot, 'src-tauri', 'Cargo.toml')
const releaseConfigPath = resolve(projectRoot, 'src-tauri', 'tauri.release.conf.json')
const updaterEndpoint = 'https://github.com/ArnoChenFx/lore-client/releases/latest/download/latest.json'

/**
 * 只接受三段式稳定语义版本标签。GitHub 的标签过滤器是 glob，仍需在真正构建前
 * 做严格校验，避免 `v-next.1.0` 之类的标签意外创建正式 Release。
 */
function parseReleaseTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag)
  if (!match) {
    throw new Error(`Invalid release tag "${tag}". Use vMAJOR.MINOR.PATCH, for example v0.1.2.`)
  }
  return match.slice(1).join('.')
}

/** 仅从 Cargo.toml 的 [package] 区段读取版本，避免误取依赖版本。 */
function readCargoPackageVersion(cargoToml) {
  const packageSection = /^\[package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(cargoToml)?.[1] ?? ''
  const version = /^\s*version\s*=\s*"([^"]+)"\s*$/m.exec(packageSection)?.[1]
  if (!version) {
    throw new Error('Failed to read the version from the [package] section of src-tauri/Cargo.toml.')
  }
  return version
}

/** GitHub Secret 可保存真实换行或转义换行，两种形式都规范化为 Tauri 接受的内容。 */
function normalizePublicKey(rawKey) {
  return rawKey.trim().replaceAll('\\n', '\n')
}

async function main() {
  const args = process.argv.slice(2)
  const checkOnly = args[0] === '--check'
  const tag = (checkOnly ? args[1] : args[0]) || process.env.GITHUB_REF_NAME || ''
  const tagVersion = parseReleaseTag(tag)

  const [packageJsonText, tauriConfigText, cargoToml] = await Promise.all([
    readFile(packageJsonPath, 'utf8'),
    readFile(tauriConfigPath, 'utf8'),
    readFile(cargoTomlPath, 'utf8')
  ])
  const packageVersion = JSON.parse(packageJsonText).version
  const tauriVersion = JSON.parse(tauriConfigText).version
  const cargoVersion = readCargoPackageVersion(cargoToml)
  const versions = {
    'Git tag': tagVersion,
    'package.json': packageVersion,
    'src-tauri/tauri.conf.json': tauriVersion,
    'src-tauri/Cargo.toml': cargoVersion
  }
  const mismatches = Object.entries(versions).filter(([, version]) => version !== tagVersion)
  if (mismatches.length > 0) {
    const detail = Object.entries(versions)
      .map(([source, version]) => `${source}=${version}`)
      .join(', ')
    throw new Error(`Version mismatch; release preparation stopped: ${detail}`)
  }

  if (checkOnly) {
    console.log(`Release version validation passed: ${tag}`)
    return
  }

  const publicKey = normalizePublicKey(process.env.TAURI_UPDATER_PUBLIC_KEY ?? '')
  if (!publicKey) {
    throw new Error('Missing GitHub secret: TAURI_UPDATER_PUBLIC_KEY.')
  }

  /*
   * 普通开发构建不生成 Updater 产物，因此不需要本地签名私钥。正式发布才通过
   * --config 合并此临时文件，同时把公钥固化进应用、开启签名产物并指向 GitHub。
   */
  const releaseConfig = {
    bundle: {
      createUpdaterArtifacts: true,
      macOS: {
        // 没有 Apple Developer 证书时至少做 ad-hoc 签名，兼容 Apple Silicon。
        signingIdentity: '-'
      }
    },
    plugins: {
      updater: {
        pubkey: publicKey,
        endpoints: [updaterEndpoint],
        windows: {
          installMode: 'passive'
        }
      }
    }
  }
  await writeFile(releaseConfigPath, `${JSON.stringify(releaseConfig, null, 2)}\n`, 'utf8')
  console.log(`Generated ${releaseConfigPath}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
