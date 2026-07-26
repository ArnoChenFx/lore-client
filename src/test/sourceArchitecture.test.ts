import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SOURCE_ROOT = resolve(PROJECT_ROOT, 'src')
const ROOT_FILE_ALLOWLIST = ['App.tsx', 'main.tsx', 'styles.css', 'types.ts', 'vite-env.d.ts']

function toProjectPath(filePath: string): string {
  return relative(PROJECT_ROOT, filePath).split(sep).join('/')
}

/** 递归收集源码文件，架构守卫本身不依赖构建工具的文件发现规则。 */
function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = resolve(directory, entry.name)
    return entry.isDirectory() ? collectSourceFiles(absolutePath) : [absolutePath]
  })
}

const sourceFiles = collectSourceFiles(SOURCE_ROOT)
const moduleFiles = sourceFiles.filter((filePath) => ['.ts', '.tsx'].includes(extname(filePath)))
const moduleFileSet = new Set(moduleFiles.map(toProjectPath))

/**
 * 把相对导入解析成项目路径。
 *
 * 这里只覆盖项目现有的 TypeScript 模块解析形式；样式与第三方包不是目录边界检查对象。
 */
function resolveLocalModule(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const unresolved = toProjectPath(resolve(dirname(importer), specifier))
  const candidates = [
    unresolved,
    `${unresolved}.ts`,
    `${unresolved}.tsx`,
    `${unresolved}/index.ts`,
    `${unresolved}/index.tsx`
  ]
  return candidates.find((candidate) => moduleFileSet.has(candidate)) ?? null
}

/** 提取静态、动态和仅副作用导入，确保架构守卫不会漏掉懒加载边界。 */
function readImportSpecifiers(source: string): string[] {
  const pattern = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*['"]([^'"]+)['"]/gu
  return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3])
}

function boundaryRoot(modulePath: string): string | null {
  if (modulePath.startsWith('src/app/')) return 'src/app'
  if (modulePath.startsWith('src/demo/')) return 'src/demo'
  if (modulePath.startsWith('src/shared/lib/')) return 'src/shared/lib'
  if (modulePath.startsWith('src/shared/ui/')) return 'src/shared/ui'

  const featureMatch = modulePath.match(/^src\/features\/([^/]+)\//u)
  return featureMatch ? `src/features/${featureMatch[1]}` : null
}

interface LocalImport {
  importer: string
  target: string
}

const localImports: LocalImport[] = moduleFiles.flatMap((absoluteImporter) => {
  const importer = toProjectPath(absoluteImporter)
  const source = readFileSync(absoluteImporter, 'utf8')
  return readImportSpecifiers(source)
    .map((specifier) => resolveLocalModule(absoluteImporter, specifier))
    .filter((target): target is string => target !== null)
    .map((target) => ({ importer, target }))
})

describe('source architecture boundaries', () => {
  it('keeps only application entry files in the source root', () => {
    const rootFiles = readdirSync(SOURCE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()

    expect(rootFiles).toEqual([...ROOT_FILE_ALLOWLIST].sort())
  })

  it('uses public indexes for imports that cross module boundaries', () => {
    const violations = localImports.filter(({ importer, target }) => {
      const importerBoundary = boundaryRoot(importer)
      const targetBoundary = boundaryRoot(target)
      if (!targetBoundary || importerBoundary === targetBoundary) return false
      return target !== `${targetBoundary}/index.ts` && target !== `${targetBoundary}/index.tsx`
    })

    expect(violations).toEqual([])
  })

  it('prevents shared modules from depending on app or feature modules', () => {
    const violations = localImports.filter(({ importer, target }) => {
      const importerBoundary = boundaryRoot(importer)
      const targetBoundary = boundaryRoot(target)
      return (
        (importerBoundary === 'src/shared/lib' || importerBoundary === 'src/shared/ui') &&
        (targetBoundary === 'src/app' || targetBoundary?.startsWith('src/features/'))
      )
    })

    expect(violations).toEqual([])
  })
})
