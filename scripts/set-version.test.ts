import { describe, expect, test } from 'bun:test'

import { normalizeVersion, updateCargoLockVersion, updateCargoTomlVersion, updateJsonVersion } from './set-version.mjs'

describe('project version synchronization', () => {
  test('normalizes stable versions with an optional tag prefix', () => {
    expect(normalizeVersion('0.2.0')).toBe('0.2.0')
    expect(normalizeVersion(' v1.4.7 ')).toBe('1.4.7')
  })

  test('rejects incomplete and prerelease versions', () => {
    expect(() => normalizeVersion('1.2')).toThrow('MAJOR.MINOR.PATCH')
    expect(() => normalizeVersion('1.2.3-beta.1')).toThrow('MAJOR.MINOR.PATCH')
  })

  test('updates the top-level JSON version without reformatting other fields', () => {
    const source = `{\n  "nested": {\n    "version": "9.9.9"\n  },\n  "version": "0.1.0",\n  "items": ["a", "b"]\n}\n`
    const result = updateJsonVersion(source, '0.2.0', 'demo.json')
    expect(result).toBe(source.replace('"version": "0.1.0"', '"version": "0.2.0"'))
  })

  test('updates only the Cargo package version', () => {
    const source = `[package]\nname = "lore-client"\nversion = "0.1.0"\n\n[dependencies]\ndemo = { version = "9.9.9" }\n`
    const result = updateCargoTomlVersion(source, '0.2.0')
    expect(result).toContain('version = "0.2.0"')
    expect(result).toContain('demo = { version = "9.9.9" }')
  })

  test('updates only the lore-client package in Cargo.lock', () => {
    const source = `[[package]]\nname = "dependency"\nversion = "8.0.0"\n\n[[package]]\nname = "lore-client"\nversion = "0.1.0"\ndependencies = []\n`
    const result = updateCargoLockVersion(source, '0.2.0')
    expect(result).toContain('name = "dependency"\nversion = "8.0.0"')
    expect(result).toContain('name = "lore-client"\nversion = "0.2.0"')
  })

  test('fails when Cargo.lock has no unique project package', () => {
    expect(() => updateCargoLockVersion('[[package]]\nname = "dependency"\nversion = "1.0.0"\n', '0.2.0')).toThrow(
      'found 0'
    )
  })
})
