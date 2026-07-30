import { describe, expect, it } from 'vitest'

import { isTextLikeFile } from './textLikeFiles'

describe('text-like file detection', () => {
  it('recognizes common Unity and Godot text assets', () => {
    expect(isTextLikeFile('Assets/Hero.prefab')).toBe(true)
    expect(isTextLikeFile('Assets/Hero.cs.meta')).toBe(true)
    expect(isTextLikeFile('Assets/Scenes/Main.unity')).toBe(true)
    expect(isTextLikeFile('Assets/Materials/Rock.mat')).toBe(true)
    expect(isTextLikeFile('Assets/Scripts/Game.asmdef')).toBe(true)
    expect(isTextLikeFile('Assets/Input/Controls.inputactions')).toBe(true)
    expect(isTextLikeFile('Scripts/Player.gd')).toBe(true)
    expect(isTextLikeFile('Scenes/Main.tscn')).toBe(true)
    expect(isTextLikeFile('Resources/Enemy.tres')).toBe(true)
    expect(isTextLikeFile('project.godot')).toBe(true)
    expect(isTextLikeFile('icon.svg.import')).toBe(true)
  })

  it('recognizes Zig, Odin, shell, and batch scripts', () => {
    expect(isTextLikeFile('src/main.zig')).toBe(true)
    expect(isTextLikeFile('build.zig.zon')).toBe(true)
    expect(isTextLikeFile('src/app.odin')).toBe(true)
    expect(isTextLikeFile('tools/setup.bash')).toBe(true)
    expect(isTextLikeFile('tools/build.bat')).toBe(true)
    expect(isTextLikeFile('tools/run.cmd')).toBe(true)
    expect(isTextLikeFile('scripts/deploy.sh')).toBe(true)
  })

  it('recognizes Lore ignore files as text configuration', () => {
    expect(isTextLikeFile('.loreignore')).toBe(true)
    expect(isTextLikeFile('Nested/Workspace/.LOREIGNORE')).toBe(true)
  })

  it('rejects engine binaries and unknown asset containers', () => {
    expect(isTextLikeFile('Content/Map.umap')).toBe(false)
    expect(isTextLikeFile('Content/Actor.uasset')).toBe(false)
    expect(isTextLikeFile('Textures/Hero.png')).toBe(false)
    expect(isTextLikeFile('Meshes/Hero.fbx')).toBe(false)
  })
})
