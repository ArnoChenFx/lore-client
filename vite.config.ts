import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vitest/config'

// Tauri 在移动端开发时会通过环境变量注入宿主地址；桌面开发则保持本机回环地址。
const tauriHost = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [
    react(),
    // React Compiler：经 @rolldown/plugin-babel 在 Oxc 转换管线中按需执行 Babel 编译，
    // 自动记忆组件与 Hook（target 19 使用 React 内置 react/compiler-runtime）；
    // 无法安全编译的函数默认跳过，不阻断构建。插件内部按代码特征过滤，仅客户端环境生效。
    babel({ presets: [reactCompilerPreset({ target: '19' })] })
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: tauriHost ?? '127.0.0.1',
    hmr: tauriHost
      ? {
          protocol: 'ws',
          host: tauriHost,
          port: 1421
        }
      : undefined,
    watch: {
      // Rust 构建目录体积较大且变化频繁，不应触发前端热更新。
      ignored: ['**/src-tauri/**', '**/.browser-profile/**']
    }
  },
  test: {
    setupFiles: ['./src/test/setup.ts'],
    // vendored anti-slop 插件的自测文件不属于本项目测试集。
    exclude: ['node_modules/**', 'tools/**', 'dist/**']
  }
})
