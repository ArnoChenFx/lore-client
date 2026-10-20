import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseSync, traverse } from '@babel/core'

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SOURCE_ROOT = resolve(PROJECT_ROOT, 'src')

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
function readImportSpecifiers(source: string, filename = 'example.ts'): string[] {
  const ast = parseSync(source, {
    filename,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: filename.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'] }
  })
  if (!ast) throw new Error(`Could not parse architecture input: ${filename}`)
  const specifiers: string[] = []
  traverse(ast, {
    ImportDeclaration({ node }) {
      specifiers.push(node.source.value)
    },
    ExportNamedDeclaration({ node }) {
      if (node.source) specifiers.push(node.source.value)
    },
    ExportAllDeclaration({ node }) {
      specifiers.push(node.source.value)
    },
    ImportExpression({ node }) {
      if (node.source.type === 'StringLiteral') specifiers.push(node.source.value)
    },
    TSImportType({ node }) {
      specifiers.push(node.source.value)
    }
  })
  return specifiers
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
  return readImportSpecifiers(source, absoluteImporter)
    .map((specifier) => resolveLocalModule(absoluteImporter, specifier))
    .filter((target): target is string => target !== null)
    .map((target) => ({ importer, target }))
})

describe('source architecture boundaries', () => {
  it('reads real imports and re-exports without treating comments or examples as dependencies', () => {
    expect(
      readImportSpecifiers(`
      import type { Model } from './types'
      import './setup'
      export { value } from './value'
      export * from './public'
      const view = import('./view')
      type State = import('./state').State
      // import './comment'
      const example = "from './example'"
    `)
    ).toEqual(['./types', './setup', './value', './public', './view', './state'])
    expect(localImports.length).toBeGreaterThan(0)
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
