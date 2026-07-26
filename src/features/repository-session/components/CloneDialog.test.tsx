import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../../i18n'
import { buildCloneSubmission, CloneDialog, resolveCloneDependencyAvailability } from './CloneDialog'

describe('Clone option availability', () => {
  beforeEach(async () => {
    // 固定语言后断言禁用原因，避免共享 i18n 实例使结果依赖其他测试的执行顺序。
    await i18n.changeLanguage('zh-CN')
  })

  it('keeps low-frequency Clone controls inside a collapsed advanced section', () => {
    const html = renderToStaticMarkup(
      <CloneDialog
        repository={{ id: 'repository-1', name: 'test-lore-repo2' }}
        serverUrl="lore://127.0.0.1:41337"
        sharedStoreInfo={null}
        busy={false}
        onChooseParent={async () => null}
        onChooseView={async () => null}
        onConfirm={() => undefined}
        onClose={() => undefined}
      />
    )

    expect(html.match(/clone-dependencies__option[^"]*is-disabled/g)).toHaveLength(2)
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(2)
    expect(html).toContain('aria-describedby="clone-transitive-disabled-reason"')
    expect(html).toContain('aria-describedby="clone-depth-disabled-reason"')
    expect(html.match(/不可用：请先填写依赖根文件/g)).toHaveLength(3)
    expect(html).toContain('<details class="clone-options">')
    expect(html).not.toContain('<details class="clone-options" open')
    expect(html).toContain('高级选项')
    // 常规 Clone 的两个必填字段必须位于折叠区之前，精确目标等低频设置位于其中。
    expect(html.indexOf('本地目录名')).toBeLessThan(html.indexOf('<details class="clone-options">'))
    expect(html.indexOf('目标父目录')).toBeLessThan(html.indexOf('<details class="clone-options">'))
    expect(html.indexOf('目标修订或分支（可选）')).toBeGreaterThan(html.indexOf('<details class="clone-options">'))
    expect(html).toContain('目标修订或分支（可选）')
    expect(html).toContain('Bare 克隆')
    expect(html).toContain('直接文件 I/O')
    expect(html).toContain('初始 Layer')
  })

  it('disables dependency filters when root files are empty', () => {
    const availability = resolveCloneDependencyAvailability(' \n ', true)

    expect(availability).toEqual({
      hasDependencyRootFiles: false,
      materializationDisabled: false,
      tagsDisabled: true,
      transitiveDisabled: true,
      depthDisabled: true
    })
  })

  it('enables dependency filters after root files are provided', () => {
    const availability = resolveCloneDependencyAvailability('Content/Maps/World.umap', true)

    expect(availability).toEqual({
      hasDependencyRootFiles: true,
      materializationDisabled: false,
      tagsDisabled: false,
      transitiveDisabled: false,
      depthDisabled: false
    })
  })

  it('keeps tags enabled but disables depth when recursive traversal is off', () => {
    const availability = resolveCloneDependencyAvailability('Content/Maps/World.umap', false)

    expect(availability).toEqual({
      hasDependencyRootFiles: true,
      materializationDisabled: false,
      tagsDisabled: false,
      transitiveDisabled: false,
      depthDisabled: true
    })
  })

  it('disables every materialization option for a Bare Clone', () => {
    expect(resolveCloneDependencyAvailability('Content/Maps/World.umap', true, true)).toEqual({
      hasDependencyRootFiles: true,
      materializationDisabled: true,
      tagsDisabled: true,
      transitiveDisabled: true,
      depthDisabled: true
    })
  })
})

describe('Clone submission normalization', () => {
  it('keeps safe advanced options and deduplicates dependency inputs', () => {
    expect(
      buildCloneSubmission({
        viewPath: ' C:\\views\\game.view ',
        targetRevision: ' release/1.0 ',
        bare: false,
        directFileIo: true,
        layerRepository: ' world-lighting ',
        layerMetadataKey: ' build-id ',
        useSharedStore: true,
        sharedStorePath: 'C:\\LoreStore',
        dependencyRootFiles: 'Content/World.umap\nContent/World.umap,Content/Hero.uasset',
        dependencyTags: 'runtime, runtime, high-resolution',
        dependencyRecursive: true,
        dependencyDepthLimit: 4
      })
    ).toEqual({
      viewPath: 'C:\\views\\game.view',
      options: {
        useSharedStore: true,
        sharedStorePath: 'C:\\LoreStore',
        revision: 'release/1.0',
        bare: false,
        directFileIo: true,
        layer: {
          repository: 'world-lighting',
          metadataKey: 'build-id'
        },
        dependency: {
          rootFiles: ['Content/World.umap', 'Content/Hero.uasset'],
          tags: ['runtime', 'high-resolution'],
          recursive: true,
          depthLimit: 4
        }
      }
    })
  })

  it('removes inert materialization options from a Bare Clone', () => {
    expect(
      buildCloneSubmission({
        viewPath: 'C:\\views\\game.view',
        targetRevision: 'main',
        bare: true,
        directFileIo: true,
        layerRepository: 'world-lighting',
        layerMetadataKey: 'build-id',
        useSharedStore: false,
        dependencyRootFiles: 'Content/World.umap',
        dependencyTags: 'runtime',
        dependencyRecursive: true,
        dependencyDepthLimit: 4
      })
    ).toEqual({
      viewPath: '',
      options: {
        useSharedStore: false,
        sharedStorePath: undefined,
        revision: 'main',
        bare: true,
        directFileIo: false,
        layer: undefined,
        dependency: undefined
      }
    })
  })
})
