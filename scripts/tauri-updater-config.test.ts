import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface TauriUpdaterConfig {
  endpoints: string[]
  pubkey: string
}

interface TauriConfig {
  plugins?: {
    updater?: TauriUpdaterConfig | null
  }
}

describe('Tauri updater configuration', () => {
  test('keeps a deserializable updater object in the base configuration', () => {
    /*
     * Updater 插件会在 Rust 启动阶段反序列化 `plugins.updater`。字段缺失时 Tauri
     * 提供的值是 null，而插件只接受 Config 对象，因此这里必须锁定真实基础配置，
     * 避免开发启动在任何前端代码执行前直接崩溃。
     */
    const configPath = resolve(import.meta.dir, '..', 'src-tauri', 'tauri.conf.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as TauriConfig
    const updater = config.plugins?.updater

    expect(updater).not.toBeNull()
    expect(updater).toBeDefined()
    expect(updater?.endpoints).toEqual([])
    expect(updater?.pubkey).toBe('')
  })
})
