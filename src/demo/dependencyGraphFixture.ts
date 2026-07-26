import type { ApplicationMode, LoreDependencyGraphQuery } from '../types'

/**
 * 纯前端依赖图展示夹具。
 *
 * 数据刻意同时包含分叉、汇合、边标签和一个两节点循环，便于在不连接 Lore
 * 后端时检查布局、箭头、选择详情、循环高亮、缩放和双主题。它只在项目统一的
 * browser-demo 模式进入 App，不参与真实仓库查询，也不会被写回偏好或仓库文件。
 */
export const browserDependencyGraphFixture: LoreDependencyGraphQuery = {
  revision: 'c7f3a81d824a47d1a329d9ee9dc53703',
  groups: [],
  nodes: [
    { path: 'Content/Maps/Meridian.umap', distance: 0, root: true },
    { path: 'Content/Lighting/WorldLighting.asset', distance: 1, root: false },
    { path: 'Content/Materials/Terrain.material', distance: 1, root: false },
    { path: 'Content/Shaders/Landscape.shader', distance: 2, root: false },
    { path: 'Content/Textures/Ground_Albedo.tga', distance: 2, root: false },
    { path: 'Content/Textures/Sky_LUT.tiff', distance: 2, root: false }
  ],
  edges: [
    {
      sourcePath: 'Content/Maps/Meridian.umap',
      dependencyPath: 'Content/Lighting/WorldLighting.asset',
      tags: ['editor']
    },
    {
      sourcePath: 'Content/Maps/Meridian.umap',
      dependencyPath: 'Content/Materials/Terrain.material',
      tags: ['runtime']
    },
    {
      sourcePath: 'Content/Lighting/WorldLighting.asset',
      dependencyPath: 'Content/Shaders/Landscape.shader',
      tags: ['shared']
    },
    {
      sourcePath: 'Content/Lighting/WorldLighting.asset',
      dependencyPath: 'Content/Textures/Sky_LUT.tiff',
      tags: ['runtime']
    },
    {
      sourcePath: 'Content/Materials/Terrain.material',
      dependencyPath: 'Content/Shaders/Landscape.shader',
      tags: ['shared']
    },
    {
      sourcePath: 'Content/Materials/Terrain.material',
      dependencyPath: 'Content/Textures/Ground_Albedo.tga',
      tags: ['runtime']
    },
    {
      sourcePath: 'Content/Textures/Ground_Albedo.tga',
      dependencyPath: 'Content/Materials/Terrain.material',
      tags: ['fixture-cycle']
    }
  ],
  reverse: false,
  recursive: true,
  depthLimit: 0,
  truncated: false,
  nodeLimit: 240
}

/**
 * 判断当前启动是否应使用纯前端依赖图夹具。
 *
 * `applicationMode` 是项目统一的运行环境边界。桌面 WebView 始终返回 false，
 * 因而不会用样例数据覆盖真实 Lore 查询结果。
 */
export function shouldUseBrowserDependencyGraphFixture(applicationMode: ApplicationMode): boolean {
  return applicationMode === 'browser-demo'
}
