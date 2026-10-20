interface RustToken {
  text: string
  line: number
  string: boolean
}

export interface RustStringFinding {
  line: number
  text: string
}

/**
 * 只扫描诊断守卫需要的 Rust 词法单元；字符串和注释不能参与花括号或属性匹配。
 * 字符字面量与生命周期分开处理，避免 `'static` 吞掉后面的源码。
 */
function rustTokens(source: string): RustToken[] {
  const tokens: RustToken[] = []
  let index = 0
  let line = 1
  const consume = (text: string) => {
    index += text.length
    line += text.split('\n').length - 1
  }

  while (index < source.length) {
    const remaining = source.slice(index)
    const whitespace = /^\s+/u.exec(remaining)?.[0]
    if (whitespace) {
      consume(whitespace)
      continue
    }
    if (remaining.startsWith('//')) {
      consume(remaining.split('\n')[0])
      continue
    }
    if (remaining.startsWith('/*')) {
      let end = index + 2
      let depth = 1
      while (end < source.length && depth > 0) {
        if (source.startsWith('/*', end)) {
          depth += 1
          end += 2
        } else if (source.startsWith('*/', end)) {
          depth -= 1
          end += 2
        } else {
          end += 1
        }
      }
      if (depth !== 0) throw new Error('Unterminated Rust block comment')
      consume(source.slice(index, end))
      continue
    }
    const rawStart = /^(?:br|cr|r)(#{0,255})"/u.exec(remaining)
    if (rawStart) {
      const closing = `"${rawStart[1]}`
      const end = source.indexOf(closing, index + rawStart[0].length)
      if (end < 0) throw new Error('Unterminated Rust raw string')
      const text = source.slice(index, end + closing.length)
      tokens.push({ text, line, string: true })
      consume(text)
      continue
    }
    const string = /^(?:b|c)?"(?:\\[\s\S]|[^"\\])*"/u.exec(remaining)?.[0]
    const character = /^(?:b)?'(?:\\(?:u\{[\da-fA-F_]+\}|x[\da-fA-F]{2}|[\s\S])|[^'\\])'/u.exec(remaining)?.[0]
    const word = /^(?:r#)?[\p{ID_Start}_][\p{ID_Continue}]*/u.exec(remaining)?.[0]
    const text = string ?? character ?? word ?? remaining[0]
    tokens.push({ text, line, string: Boolean(string) })
    consume(text)
  }
  return tokens
}

function afterGroup(tokens: RustToken[], start: number, open: string, close: string): number {
  let depth = 1
  for (let index = start + 1; index < tokens.length; index += 1) {
    if (tokens[index].text === open) depth += 1
    if (tokens[index].text === close) depth -= 1
    if (depth === 0) return index + 1
  }
  throw new Error(`Unterminated Rust ${open} group`)
}

function attributeAt(tokens: RustToken[], index: number) {
  if (tokens[index]?.text !== '#' || tokens[index + 1]?.text !== '[') return null
  const end = afterGroup(tokens, index + 1, '[', ']')
  return {
    text: tokens
      .slice(index + 2, end - 1)
      .map((token) => token.text)
      .join(''),
    end
  }
}

function isTestAttribute(text: string): boolean {
  return /^(?:\w+::)*test(?:\(|$)/u.test(text)
}

/** 跳过一个测试专用项，随后继续扫描生产代码，而不是截断整个文件。 */
function afterItem(tokens: RustToken[], start: number): number {
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].text === '(' || tokens[index].text === '[') {
      const open = tokens[index].text
      index = afterGroup(tokens, index, open, open === '(' ? ')' : ']') - 1
      continue
    }
    if (tokens[index].text === ';') return index + 1
    if (tokens[index].text === '{') return afterGroup(tokens, index, '{', '}')
  }
  throw new Error('Rust test-only attribute is missing its item')
}

export function inspectRustDiagnostics(source: string, testOnlyFile = false) {
  const tokens = rustTokens(source)
  const testNames: string[] = []
  const productionStrings: RustStringFinding[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const attribute = attributeAt(tokens, index)
    if (!attribute || !isTestAttribute(attribute.text)) continue
    for (let next = attribute.end; next < tokens.length; next += 1) {
      const text = tokens[next].text
      if (text === 'fn') {
        testNames.push(tokens[next + 1].text)
        break
      }
      if (text === '{' || text === ';') break
    }
  }
  if (!testOnlyFile) {
    for (let index = 0; index < tokens.length; index += 1) {
      const attribute = attributeAt(tokens, index)
      if (attribute && (attribute.text === 'cfg(test)' || isTestAttribute(attribute.text))) {
        index = afterItem(tokens, attribute.end) - 1
        continue
      }
      const token = tokens[index]
      if (token.string && /\p{Script=Han}/u.test(token.text)) {
        productionStrings.push({ line: token.line, text: token.text })
      }
    }
  }
  return { testNames, productionStrings }
}
