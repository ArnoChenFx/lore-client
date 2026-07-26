import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

const HAN_TEXT = /\p{Script=Han}/u
// 本测试已归入 `src/test`，因此需要回到两级父目录才能定位项目根。
const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * 删除源码注释但保留字符串内容与行号。
 *
 * 诊断测试必须允许项目继续使用中文注释，同时不能简单删除 `//` 后面的文本：
 * URL、Windows 路径和模板字符串都可能合法包含类似注释分隔符的字符。
 */
function stripComments(source: string): string {
  let result = ''
  let index = 0
  let blockDepth = 0
  let quote: '"' | "'" | '`' | null = null

  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]

    if (quote !== null) {
      result += character
      if (character === '\\') {
        result += next ?? ''
        index += 2
        continue
      }
      if (character === quote) quote = null
      index += 1
      continue
    }

    if (blockDepth > 0) {
      if (character === '/' && next === '*') {
        blockDepth += 1
        result += '  '
        index += 2
        continue
      }
      if (character === '*' && next === '/') {
        blockDepth -= 1
        result += '  '
        index += 2
        continue
      }
      result += character === '\n' ? '\n' : ' '
      index += 1
      continue
    }

    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        result += ' '
        index += 1
      }
      continue
    }
    if (character === '/' && next === '*') {
      blockDepth = 1
      result += '  '
      index += 2
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
    }
    result += character
    index += 1
  }

  return result
}

/** 返回给定左括号对应的调用参数文本，并正确跳过字符串中的括号。 */
function readCallArguments(source: string, openParenthesis: number): string | null {
  let depth = 1
  let quote: '"' | "'" | '`' | null = null

  for (let index = openParenthesis + 1; index < source.length; index += 1) {
    const character = source[index]
    if (quote !== null) {
      if (character === '\\') {
        index += 1
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
      continue
    }
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (depth === 0) return source.slice(openParenthesis + 1, index)
  }

  return null
}

/** 按顶层逗号拆分参数，避免条件表达式和对象字面量干扰断言消息定位。 */
function splitTopLevelArguments(argumentsSource: string): string[] {
  const argumentsList: string[] = []
  let start = 0
  let depth = 0
  let quote: '"' | "'" | '`' | null = null

  for (let index = 0; index < argumentsSource.length; index += 1) {
    const character = argumentsSource[index]
    if (quote !== null) {
      if (character === '\\') {
        index += 1
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
      continue
    }
    if (character === '(' || character === '[' || character === '{') depth += 1
    if (character === ')' || character === ']' || character === '}') depth -= 1
    if (character === ',' && depth === 0) {
      argumentsList.push(argumentsSource.slice(start, index))
      start = index + 1
    }
  }
  argumentsList.push(argumentsSource.slice(start))
  return argumentsList
}

interface DiagnosticFinding {
  call: string
  line: number
  text: string
}

/**
 * 只读取会产生内部诊断的调用参数。
 *
 * `assert` 的首个参数会查询中文界面文案，因此只检查第二个断言说明；其余调用
 * 的参数本身就是异常或日志内容，全部纳入检查。
 */
function findChineseDiagnostics(source: string): DiagnosticFinding[] {
  const stripped = stripComments(source)
  const callPattern = /new\s+Error\s*\(|console\.(?:log|warn|error)\s*\(|\bassert\s*\(|\brejectPendingCommands\s*\(/gu
  const findings: DiagnosticFinding[] = []

  for (const match of stripped.matchAll(callPattern)) {
    const openParenthesis = stripped.indexOf('(', match.index)
    const argumentsSource = readCallArguments(stripped, openParenthesis)
    if (argumentsSource === null) continue
    const call = match[0].slice(0, match[0].indexOf('(')).trim()
    const argumentsToCheck = call === 'assert' ? splitTopLevelArguments(argumentsSource).slice(1) : [argumentsSource]
    for (const argument of argumentsToCheck) {
      if (!HAN_TEXT.test(argument)) continue
      findings.push({
        call,
        line: stripped.slice(0, match.index).split('\n').length,
        text: argument.trim()
      })
    }
  }

  return findings
}

function readProjectFile(relativePath: string): string {
  return readFileSync(resolve(PROJECT_ROOT, relativePath), 'utf8')
}

/** 递归收集目录中的测试源码，避免英文命名守卫依赖某个测试运行器的发现规则。 */
function collectTestFiles(directory: string): string[] {
  return readdirSync(resolve(PROJECT_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = `${directory}/${entry.name}`
    if (entry.isDirectory()) return collectTestFiles(relativePath)
    return /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name) ? [relativePath] : []
  })
}

/**
 * 提取 Vitest/Bun 的直接名称和 `it.each(...)(name, ...)` 参数化名称。
 *
 * 这里只检查名称字面量；中文本地化夹具、可访问名称和断言期望仍是合法测试数据。
 */
function findChineseTestNames(source: string): string[] {
  const stripped = stripComments(source)
  const namePattern = /(?:\b(?:describe|it|test)(?:\.(?:only|skip|todo))?|\]\))\s*\(\s*(['"`])([\s\S]*?)\1/gu
  return [...stripped.matchAll(namePattern)].map((match) => match[2]).filter((name) => HAN_TEXT.test(name))
}

describe('English internal diagnostics', () => {
  test('TypeScript and Rust test names contain no Chinese text', () => {
    const frontendFindings = [...collectTestFiles('src'), ...collectTestFiles('scripts')].flatMap((relativePath) =>
      findChineseTestNames(readProjectFile(relativePath)).map((name) => ({
        file: relativePath,
        name
      }))
    )
    const rustSource = readProjectFile('src-tauri/src/lore_adapter.rs').split('#[cfg(test)]')[1] ?? ''
    const rustFindings = [...rustSource.matchAll(/#\[test\][\s\S]*?\bfn\s+([^\s(]+)/gu)]
      .map((match) => match[1])
      .filter((name) => HAN_TEXT.test(name))

    expect({ frontendFindings, rustFindings }).toEqual({
      frontendFindings: [],
      rustFindings: []
    })
  })

  test('JavaScript and TypeScript diagnostics contain no Chinese text', () => {
    const diagnosticFiles = ['src/app/appUpdater.ts', 'src/services/preferences.ts', 'scripts/prepare-release.mjs']
    const findings = diagnosticFiles.flatMap((relativePath) =>
      findChineseDiagnostics(readProjectFile(relativePath)).map((finding) => ({
        file: relativePath,
        ...finding
      }))
    )

    expect(findings).toEqual([])
  })

  test('Rust production strings contain no Chinese text', () => {
    const rustFiles = [
      'src-tauri/build.rs',
      'src-tauri/src/lib.rs',
      'src-tauri/src/client_preferences.rs',
      'src-tauri/src/lore_adapter.rs'
    ]
    const findings = rustFiles.flatMap((relativePath) => {
      const productionSource = readProjectFile(relativePath).split('#[cfg(test)]')[0]
      return productionSource
        .split('\n')
        .map((line, index) => ({ line, lineNumber: index + 1 }))
        .filter(({ line }) => {
          const trimmed = line.trimStart()
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false
          return /"(?:\\.|[^"\\])*[\p{Script=Han}]/u.test(line)
        })
        .map(({ line, lineNumber }) => ({ file: relativePath, line: lineNumber, text: line.trim() }))
    })

    expect(findings).toEqual([])
  })
})
