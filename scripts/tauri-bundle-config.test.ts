import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'

interface TauriBundleConfig {
  bundle?: {
    icon?: string[]
  }
}

describe('Tauri bundle configuration', () => {
  test('declares an existing square PNG icon for Linux AppImage packaging', () => {
    const projectRoot = resolve(import.meta.dir, '..')
    const configPath = resolve(projectRoot, 'src-tauri', 'tauri.conf.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as TauriBundleConfig
    const configuredIcons = config.bundle?.icon ?? []

    /*
     * AppImage 打包器只检查显式传入的 bundle.icon，不能依赖 icons 目录中的文件被
     * 自动发现。直接读取 PNG 的 IHDR 宽高可避免引入图片解码依赖，并精确锁定本次
     * Linux 打包失败的条件。
     */
    const hasSquarePng = configuredIcons.some((relativePath) => {
      if (extname(relativePath).toLowerCase() !== '.png') {
        return false
      }

      const iconBytes = readFileSync(resolve(projectRoot, 'src-tauri', relativePath))
      const isPng = iconBytes.subarray(1, 4).toString('ascii') === 'PNG'
      const width = iconBytes.readUInt32BE(16)
      const height = iconBytes.readUInt32BE(20)
      return isPng && width === height
    })

    expect(hasSquarePng).toBe(true)
  })
})
