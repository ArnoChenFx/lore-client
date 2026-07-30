/**
 * 判定路径是否应按文本 Diff / 预览处理。
 *
 * 工作区 status 与 Revision 文件树会用它决定 `binary` 标志；未知扩展名仍可能由
 * Rust 侧按体积探测 UTF-8，但白名单内的引擎资产与脚本应始终走文本路径。
 */

/** 无扩展名或点文件名的常见文本配置。 */
const TEXT_LIKE_BASENAMES = new Set([
  '.babelrc',
  '.dockerignore',
  '.editorconfig',
  '.env',
  '.eslintrc',
  '.gitattributes',
  '.gitignore',
  '.loreignore',
  '.npmrc',
  '.nvmrc',
  '.prettierrc',
  'bun.lock',
  'Cargo.lock',
  'cmakelists.txt',
  'dockerfile',
  'gemfile',
  'gnumakefile',
  'jenkinsfile',
  'makefile',
  'procfile',
  'rakefile',
  'vagrantfile'
])

/**
 * 明确按文本处理的扩展名。
 *
 * 含 Unity Force Text YAML/JSON 资产、Godot 文本场景/资源、以及常见脚本语言。
 * 不包含 uasset/umap 等引擎二进制容器。
 */
const TEXT_LIKE_EXTENSIONS = new Set([
  // 通用文档与配置
  'txt',
  'md',
  'markdown',
  'rst',
  'adoc',
  'tex',
  'bib',
  'org',
  'json',
  'jsonc',
  'json5',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'config',
  'xml',
  'csv',
  'tsv',
  'svg',
  'plist',
  'properties',
  'editorconfig',
  // Web / 前端
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'vue',
  'svelte',
  'graphql',
  'gql',
  // 系统 / 原生 / 通用语言
  'rs',
  'cpp',
  'cc',
  'cxx',
  'c',
  'h',
  'hpp',
  'hh',
  'hxx',
  'py',
  'pyi',
  'go',
  'java',
  'kt',
  'kts',
  'scala',
  'cs',
  'fs',
  'fsx',
  'fsi',
  'vb',
  'swift',
  'm',
  'mm',
  'rb',
  'php',
  'lua',
  'r',
  'sql',
  'proto',
  'dart',
  'nim',
  'groovy',
  'gradle',
  'cmake',
  'zig',
  'zon',
  'odin',
  // Shell / 批处理
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'psm1',
  'psd1',
  'bat',
  'cmd',
  // 着色器
  'glsl',
  'hlsl',
  'wgsl',
  'vert',
  'frag',
  'geom',
  'comp',
  'tesc',
  'tese',
  'metal',
  'compute',
  // Unity 常见文本资产（Force Text YAML / JSON / 着色器）
  'meta',
  'unity',
  'prefab',
  'asset',
  'mat',
  'anim',
  'controller',
  'overridecontroller',
  'mask',
  'physicmaterial',
  'physicsmaterial2d',
  'guiskin',
  'fontsettings',
  'preset',
  'asmdef',
  'asmref',
  'inputactions',
  'shader',
  'cginc',
  'raytrace',
  'template',
  'uxml',
  'uss',
  'rsp',
  'shadergraph',
  'shadersubgraph',
  'vfx',
  'playable',
  'signal',
  'terrainlayer',
  'brush',
  'giparams',
  'wlt',
  'scenetemplate',
  'spriteatlasv2',
  // Godot 文本场景 / 资源 / 脚本
  'gd',
  'tscn',
  'tres',
  'godot',
  'import',
  'gdshader',
  'gdshaderinc',
  'gdextension',
  'uid'
])

/** 返回仓库相对路径是否应默认按文本 Diff / 预览处理。 */
export function isTextLikeFile(path: string): boolean {
  const normalized = path.split(/[?#]/, 1)[0]?.replaceAll('\\', '/') ?? ''
  const fileName = normalized.split('/').at(-1) ?? ''
  if (!fileName) return false

  const lowerName = fileName.toLocaleLowerCase()
  if (TEXT_LIKE_BASENAMES.has(lowerName)) return true

  const dotIndex = fileName.lastIndexOf('.')
  // 点文件（如 `.gitignore`）已由 basename 集合覆盖；这里只识别普通扩展名。
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return false
  return TEXT_LIKE_EXTENSIONS.has(fileName.slice(dotIndex + 1).toLocaleLowerCase())
}
