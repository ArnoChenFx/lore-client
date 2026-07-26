/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Tauri 在移动端开发时会通过环境变量注入宿主地址；桌面开发则保持本机回环地址。
const tauriHost = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react()],
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
    setupFiles: ['./src/test/setup.ts']
  }
})
