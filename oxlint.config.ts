import { defineConfig } from 'oxlint'

/**
 * Oxlint 统一配置（TS 格式，取代原 .oxlintrc.json）。
 *
 * jsPlugins 是实验性 API，只在 Node 运行时加载：vendored 的 anti-slop 插件
 * （tools/oxlint/anti-slop/）按上游原样保留（tab 缩进与双引号），不参与 oxfmt
 * 格式检查，与 src-tauri/vendor/ 的第三方源码惯例一致。
 */
export default defineConfig({
  plugins: ['eslint', 'react', 'unicorn', 'typescript', 'oxc', 'import'],
  env: {
    browser: true,
    node: true
  },
  ignorePatterns: ['dist/**'],
  jsPlugins: [
    // 拒绝低证据、低信号的 TS/JS 模式（来自 dmmulroy/anti-slop，MIT）。
    { name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' }
  ],
  rules: {
    // 既有规则：类型安全与 React 语义门禁。
    'no-unused-vars': 'off',
    'typescript/no-floating-promises': 'off',
    'unicorn/no-new-array': 'off',
    'react/exhaustive-deps': 'error',
    'react/no-array-index-key': 'error',
    'react/self-closing-comp': 'error',
    // anti-slop：拒绝低证据模式。分级评估（2026-08-13）：
    // - error：能发现真实问题的规则；少量生产代码命中已修复。
    // - warn：意见性强或需要大量机械注释的规则，先观察。
    // - 关闭：大量误伤项目合法边界解析（IPC 的 typeof 验证、unknown 入参 + 运行时
    //   校验正是规则鼓励的“边界解析”模式）或与 AGENTS.md 规范冲突（LocaleShape）。
    'anti-slop/no-chained-type-assertions': 'error',
    'anti-slop/no-conditional-empty-object-spread': 'error',
    'anti-slop/no-known-value-widening': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop/no-reflect-get': 'error',
    'anti-slop/no-unknown-type-aliases': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    // 测试对 Tauri 原生 API / 服务层 / React hooks 的 mock 是项目既定隔离策略
    // （原生 IPC 无法 DI），重写会降低测试保真度。
    'anti-slop/no-module-mocking': 'off',
    // 要求每个断言前写 SAFETY: 注释是纯意见性规则；项目断言都是 TS 语法必需的
    // 标准模式（泛型断言、固定 null 字段标注），100 处注释只会制造噪音。
    'anti-slop/require-safety-comment-for-type-assertion': 'off',
    'anti-slop/no-object-parameters': 'error',
    'anti-slop/no-runtime-typeof': 'off',
    'anti-slop/no-shape-in-symbol-names': 'off',
    'anti-slop/no-unknown-parameters': 'off',
    'anti-slop/no-unknown-returns': 'off',
    'anti-slop/no-unsafe-dictionary-type': 'off'
  },
  options: {
    typeAware: true,
    typeCheck: true
  },
  categories: { correctness: 'error' }
})
