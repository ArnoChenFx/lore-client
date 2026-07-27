import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const versionFilePaths = {
  packageJson: resolve(projectRoot, 'package.json'),
  tauriConfig: resolve(projectRoot, 'src-tauri', 'tauri.conf.json'),
  cargoToml: resolve(projectRoot, 'src-tauri', 'Cargo.toml'),
  cargoLock: resolve(projectRoot, 'src-tauri', 'Cargo.lock')
}

/**
 * 规范化用户输入的版本号。
 *
 * 命令行可以传入发布标签风格的 `v0.1.4`，但四个项目文件都只保存裸语义版本。
 * 这里刻意只接受三段式稳定版本，避免把预发布标签意外带入正式发布流程。
 */
export function normalizeVersion(rawVersion) {
  const version = rawVersion?.trim().replace(/^v/, '') ?? ''
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Invalid version "${rawVersion ?? ''}". Use MAJOR.MINOR.PATCH, for example 0.1.4.`)
  }
  return version
}

/** 更新 JSON 顶层 version，同时保留文件中其余字段的原始排版。 */
export function updateJsonVersion(source, version, fileLabel) {
  const parsed = JSON.parse(source)
  if (typeof parsed.version !== 'string') {
    throw new Error(`${fileLabel} does not contain a top-level string version.`)
  }

  /*
   * JSON.parse 不保留源码位置；这里收集所有独占一行的 version 属性，并选择缩进
   * 最浅的一项作为顶层字段。这样只替换版本值，不会重排数组或其他用户维护的格式。
   */
  const candidates = [...source.matchAll(/^([ \t]*)"version"\s*:\s*"([^"]+)"/gm)].sort(
    (left, right) => left[1].length - right[1].length
  )
  const target = candidates[0]
  if (!target || target[2] !== parsed.version || target.index === undefined) {
    throw new Error(`${fileLabel} top-level version could not be located safely.`)
  }
  const valueOffset = target[0].lastIndexOf(target[2])
  const valueStart = target.index + valueOffset
  return `${source.slice(0, valueStart)}${version}${source.slice(valueStart + target[2].length)}`
}

/**
 * 只修改 Cargo.toml 的 `[package]` 区段。
 *
 * 依赖声明中可能出现大量 `version` 字段，因此不能对整个 TOML 做宽泛替换。
 */
export function updateCargoTomlVersion(source, version) {
  const packagePattern = /(^\[package\]\s*$[\s\S]*?^version\s*=\s*")[^"]+("\s*$)/m
  if (!packagePattern.test(source)) {
    throw new Error('src-tauri/Cargo.toml does not contain [package].version.')
  }
  return source.replace(packagePattern, `$1${version}$2`)
}

/**
 * 精确更新 Cargo.lock 中 `name = "lore-client"` 的包块。
 *
 * Cargo.lock 包含所有依赖的版本，先按 `[[package]]` 切块再按包名筛选，可避免把
 * Tauri、Lore 或其他第三方依赖的版本一起改掉。
 */
export function updateCargoLockVersion(source, version) {
  const packagePattern = /^\[\[package\]\]\s*$[\s\S]*?(?=^\[\[package\]\]\s*$|(?![\s\S]))/gm
  const matches = [...source.matchAll(packagePattern)]
  const projectPackages = matches.filter((match) => /^name\s*=\s*"lore-client"\s*$/m.test(match[0]))
  if (projectPackages.length !== 1) {
    throw new Error(
      `src-tauri/Cargo.lock must contain exactly one lore-client package; found ${projectPackages.length}.`
    )
  }

  const projectPackage = projectPackages[0]
  const updatedPackage = projectPackage[0].replace(/(^version\s*=\s*")[^"]+("\s*$)/m, `$1${version}$2`)
  if (
    updatedPackage === projectPackage[0] &&
    !new RegExp(`^version\\s*=\\s*"${version}"\\s*$`, 'm').test(updatedPackage)
  ) {
    throw new Error('The lore-client package in src-tauri/Cargo.lock does not contain a version.')
  }

  return `${source.slice(0, projectPackage.index)}${updatedPackage}${source.slice(projectPackage.index + projectPackage[0].length)}`
}

/** 读取全部输入并完成校验后再写入，避免格式错误时只更新部分文件。 */
export async function setProjectVersion(rawVersion, paths = versionFilePaths) {
  const version = normalizeVersion(rawVersion)
  const [packageJson, tauriConfig, cargoToml, cargoLock] = await Promise.all([
    readFile(paths.packageJson, 'utf8'),
    readFile(paths.tauriConfig, 'utf8'),
    readFile(paths.cargoToml, 'utf8'),
    readFile(paths.cargoLock, 'utf8')
  ])
  const updatedFiles = {
    packageJson: updateJsonVersion(packageJson, version, 'package.json'),
    tauriConfig: updateJsonVersion(tauriConfig, version, 'src-tauri/tauri.conf.json'),
    cargoToml: updateCargoTomlVersion(cargoToml, version),
    cargoLock: updateCargoLockVersion(cargoLock, version)
  }

  await Promise.all(Object.entries(paths).map(([name, path]) => writeFile(path, updatedFiles[name], 'utf8')))
  return version
}

async function main() {
  const version = await setProjectVersion(process.argv[2])
  console.log(`Updated project version to ${version} in 4 files.`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
