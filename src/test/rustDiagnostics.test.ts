import { describe, expect, test } from 'bun:test'

import { inspectRustDiagnostics } from './rustDiagnostics'

describe('Rust diagnostic discovery', () => {
  test('finds test names in standalone test modules and ignores example strings and comments', () => {
    const result = inspectRustDiagnostics(
      `
      // #[test] fn 假测试() {}
      const EXAMPLE: &str = "#[test] fn 示例() {}";
      #[test]
      #[ignore = "requires a live server"]
      fn real_test() {}
      #[tokio::test]
      async fn 中文测试() {}
    `,
      true
    )
    expect(result.testNames).toEqual(['real_test', '中文测试'])
    expect(result.productionStrings).toEqual([])
  })

  test('continues checking production strings after test modules and inline test functions', () => {
    const result = inspectRustDiagnostics(`
      #[cfg(test)]
      mod tests;
      const BEFORE: &str = "生产错误";
      #[cfg(test)]
      mod inline_tests {
        #[test]
        fn fixture_test() { let fixture = "中文夹具"; }
      }
      #[test]
      fn another_test() { let fixture = "}"; }
      #[cfg(not(test))]
      fn production() { panic!("后续错误"); }
    `)
    expect(result.testNames).toEqual(['fixture_test', 'another_test'])
    expect(result.productionStrings.map((finding) => finding.text)).toEqual(['"生产错误"', '"后续错误"'])
  })

  test('handles raw strings, escaped quotes, lifetimes and nested comments without false diagnostics', () => {
    const valid = String.raw`
      /* 中文注释 /* nested */ #[test] fn 假测试() {} */
      fn message(value: &'static str) -> &'static str { value }
      const MESSAGE: &str = "English \"quoted\" message";
      const EXAMPLE: &str = r##"#[test] fn example() { /* example */ }"##;
    `
    expect(inspectRustDiagnostics(valid)).toEqual({ testNames: [], productionStrings: [] })
    const invalid = inspectRustDiagnostics(`${valid}\nconst ERROR: &str = r#"多行\n错误"#;`)
    expect(invalid.productionStrings).toHaveLength(1)
    expect(invalid.productionStrings[0].text).toBe('r#"多行\n错误"#')
    expect(invalid.productionStrings[0].line).toBe(valid.split('\n').length + 1)
  })

  test('does not mistake semicolons in test-only array types for the end of an item', () => {
    const result = inspectRustDiagnostics(`
      #[cfg(test)]
      const FIXTURE: [&str; 1] = ["中文夹具"];
      #[cfg(test)]
      fn helper(bytes: [u8; 2]) { let fixture = "测试内容"; }
      const MESSAGE: &str = "生产错误";
    `)
    expect(result.productionStrings.map((finding) => finding.text)).toEqual(['"生产错误"'])
  })
})
