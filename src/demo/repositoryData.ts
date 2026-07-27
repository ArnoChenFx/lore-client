import { repositoryAccentFromIndex } from '../shared/lib'
import type { Branch, ChangeFile, LoreTag, Repository, Revision } from '../types'

export const repositories: Repository[] = [
  {
    id: 'meridian',
    name: 'meridian-world',
    branch: 'world/lighting-pass',
    revision: 'c7f3a81d824a47d1a329d9ee9dc53703',
    path: 'E:\\Worlds\\Meridian',
    ahead: 2,
    behind: 1,
    online: true,
    remoteState: 'online',
    color: repositoryAccentFromIndex(0),
    conflictCount: 0,
    unresolvedConflictCount: 0
  },
  {
    id: 'solstice',
    name: 'solstice-tools',
    branch: 'main',
    revision: '5de935ea27ae40b0a6ba6df114dad190',
    path: 'E:\\Tools\\Solstice',
    ahead: 0,
    behind: 0,
    online: true,
    remoteState: 'online',
    color: repositoryAccentFromIndex(1),
    conflictCount: 0,
    unresolvedConflictCount: 0
  },
  {
    id: 'atlas',
    name: 'atlas-materials',
    branch: 'release/2.4',
    revision: '1206db638d224805aef96f815da0cd43',
    path: 'E:\\Assets\\Atlas',
    ahead: 0,
    behind: 4,
    online: false,
    remoteState: 'offline',
    color: repositoryAccentFromIndex(2),
    conflictCount: 0,
    unresolvedConflictCount: 0
  }
]

export const branches: Branch[] = [
  {
    id: 'lighting',
    name: 'world/lighting-pass',
    latest: 'c7f3a81d824a47d1a329d9ee9dc53703',
    current: true,
    ahead: 2,
    author: 'Lin Moore'
  },
  {
    id: 'main',
    name: 'main',
    latest: '5de935ea27ae40b0a6ba6df114dad190',
    author: 'Team'
  },
  {
    id: 'terrain',
    name: 'world/terrain-v7',
    latest: '1dd6e2a38c1d4719b9ce1156695ef1ca',
    ahead: 1,
    author: 'Chen Yu'
  },
  {
    id: 'cinematic',
    name: 'cinematic/prologue',
    latest: '0a9d82f37dfa4f3fb252f4f04669514c',
    author: 'Xu Tang'
  },
  {
    id: 'audio',
    name: 'audio/ambient-remix',
    latest: 'c7f3a81d824a47d1a329d9ee9dc53703',
    author: 'Zhou Ye'
  },
  {
    id: 'origin-main',
    name: 'origin/main',
    latest: '5de935ea27ae40b0a6ba6df114dad190',
    remote: true
  },
  {
    id: 'origin-release',
    name: 'origin/release/0.8',
    latest: '1206db638d224805aef96f815da0cd43',
    remote: true
  },
  {
    id: 'origin-cinematic',
    name: 'origin/cinematic/prologue',
    latest: '0a9d82f37dfa4f3fb252f4f04669514c',
    remote: true
  }
]

/** 浏览器演示中的标签只用于验证布局；桌面模式始终读取 Lore 仓库共享元数据。 */
export const tags: LoreTag[] = [
  {
    id: 'tag-release-meridian-08',
    name: 'release/meridian-0.8',
    branch: 'world/lighting-pass',
    revision: 'c7f3a81d824a47d1a329d9ee9dc53703',
    message: 'The first reviewable version of Meridian dusk lighting and distance fog.',
    createdAt: Date.parse('2026-07-24T07:37:00.000Z'),
    updatedAt: Date.parse('2026-07-24T07:37:00.000Z')
  },
  {
    id: 'tag-lighting-review-2',
    name: 'lighting/review-2',
    branch: 'world/lighting-pass',
    revision: '7aa51c94cf7d44e4a461c1a573f3c84d',
    message: 'Lighting review checkpoint after the water material merge.',
    createdAt: Date.parse('2026-07-24T06:58:00.000Z'),
    updatedAt: Date.parse('2026-07-24T06:58:00.000Z')
  },
  {
    id: 'tag-terrain-v7-preview',
    name: 'preview/terrain-v7',
    branch: 'world/terrain-v7',
    revision: '1dd6e2a38c1d4719b9ce1156695ef1ca',
    message: 'Preview of the updated reflection capture volumes in the harbor district.',
    createdAt: Date.parse('2026-07-24T05:42:00.000Z'),
    updatedAt: Date.parse('2026-07-24T05:42:00.000Z')
  },
  {
    id: 'tag-cinematic-prologue',
    name: 'cinematic/prologue-preview',
    branch: 'cinematic/prologue',
    revision: '0a9d82f37dfa4f3fb252f4f04669514c',
    message: 'Director review checkpoint for the prologue airship silhouette.',
    createdAt: Date.parse('2026-07-24T03:06:00.000Z'),
    updatedAt: Date.parse('2026-07-24T03:06:00.000Z')
  }
]

export const revisions: Revision[] = [
  {
    id: 'c7f3a81d824a47d1a329d9ee9dc53703',
    shortId: 'c7f3a81d',
    title: 'Refine dusk volumetric lighting and distance fog',
    description:
      'Rebalance the Golden Hour scattering curve and split distance fog into a standalone Layer. This revision also updates the probe cache and rendering budget for the harbor district.',
    author: 'yourname@gmail.com',
    initials: 'A',
    timestamp: '2026-07-24 15:37',
    relativeTime: 'just now',
    branchPointers: [
      { id: 'local:lighting', name: 'world/lighting-pass', kind: 'local' },
      { id: 'head', name: 'HEAD', kind: 'head' }
    ],
    parentCount: 1,
    parentIds: ['7aa51c94cf7d44e4a461c1a573f3c84d'],
    filesChanged: 7,
    additions: 286,
    deletions: 34,
    size: '18.4 MB'
  },
  {
    id: '7aa51c94cf7d44e4a461c1a573f3c84d',
    shortId: '7aa51c94',
    title: 'Merge water material updates from main',
    description:
      'Synchronize surface normals and reflection parameters while preserving the current branch dusk grading.',
    author: 'lectem@gmail.com',
    initials: 'L',
    timestamp: '2026-07-24 14:58',
    relativeTime: '39 minutes ago',
    branchPointers: [],
    parentCount: 2,
    // 第一父修订沿当前照明主线继续，第二父修订是被合并的 terrain 支线。
    parentIds: ['f063298b851f44c6a9edc99df3bd1c60', '1dd6e2a38c1d4719b9ce1156695ef1ca'],
    filesChanged: 12,
    additions: 418,
    deletions: 77,
    size: '41.2 MB'
  },
  {
    id: '1dd6e2a38c1d4719b9ce1156695ef1ca',
    shortId: '1dd6e2a3',
    title: 'Update reflection capture volumes in the harbor district',
    description: 'Improve indirect highlight stability on wet surfaces and remove duplicate reflection probes.',
    author: 'arnochen101@gmail.com',
    initials: 'D',
    timestamp: '2026-07-24 13:42',
    relativeTime: '1 hour ago',
    branchPointers: [{ id: 'local:terrain', name: 'world/terrain-v7', kind: 'local' }],
    parentCount: 1,
    parentIds: ['f063298b851f44c6a9edc99df3bd1c60'],
    filesChanged: 5,
    additions: 109,
    deletions: 61,
    size: '8.8 MB'
  },
  {
    id: 'f063298b851f44c6a9edc99df3bd1c60',
    shortId: 'f063298b',
    title: 'Compress the skybox sequence and rebuild the chunk index',
    description: 'Rebuild the skybox cache with new content-defined chunking parameters to reduce duplicate transfers.',
    author: 'Xu Tang',
    initials: 'X',
    timestamp: '2026-07-24 12:17',
    relativeTime: '3 hours ago',
    branchPointers: [],
    parentCount: 1,
    parentIds: ['8e78f87bc4be4c82ae2c77774ba56d23'],
    filesChanged: 3,
    additions: 72,
    deletions: 12,
    size: '126.7 MB'
  },
  {
    id: '0a9d82f37dfa4f3fb252f4f04669514c',
    shortId: '0a9d82f3',
    title: 'Add a distant airship silhouette to the prologue shot',
    description: 'Add a distant narrative element to the third prologue shot and refine the depth-of-field transition.',
    author: 'Xu Tang',
    initials: 'X',
    timestamp: '2026-07-24 11:06',
    relativeTime: '4 hours ago',
    branchPointers: [{ id: 'local:cinematic', name: 'cinematic/prologue', kind: 'local' }],
    parentCount: 1,
    parentIds: ['8e78f87bc4be4c82ae2c77774ba56d23'],
    filesChanged: 9,
    additions: 256,
    deletions: 44,
    size: '84.1 MB'
  },
  {
    id: '8e78f87bc4be4c82ae2c77774ba56d23',
    shortId: '8e78f87b',
    title: 'Standardize Layer naming and asset metadata',
    description: 'Clean up legacy Layer names and complete asset owner and source fields.',
    author: 'Zhou Ye',
    initials: 'Z',
    timestamp: '2026-07-24 09:31',
    relativeTime: '6 hours ago',
    branchPointers: [],
    parentCount: 1,
    parentIds: ['d33129dfdc784670b5202dd92b348788'],
    filesChanged: 28,
    additions: 603,
    deletions: 311,
    size: '4.7 MB'
  },
  {
    id: 'd33129dfdc784670b5202dd92b348788',
    shortId: 'd33129df',
    title: 'Fix streaming boundary flicker in the underground passage',
    description:
      'Expand the preload area at the underground passage entrance to prevent transient chunk gaps at high speed.',
    author: 'Chen Yu',
    initials: 'C',
    timestamp: '2026-07-23 21:48',
    relativeTime: 'yesterday',
    branchPointers: [],
    parentCount: 1,
    parentIds: ['ab18d30e5e134867b333d6e223be64ff'],
    filesChanged: 4,
    additions: 91,
    deletions: 18,
    size: '12.9 MB'
  },
  {
    id: 'ab18d30e5e134867b333d6e223be64ff',
    shortId: 'ab18d30e',
    title: 'Merge the ambient audio remix branch',
    description: 'Introduce the updated harbor ambience track and revise the spatial attenuation curve.',
    author: 'Zhou Ye',
    initials: 'Z',
    timestamp: '2026-07-23 19:22',
    relativeTime: 'yesterday',
    branchPointers: [],
    parentCount: 2,
    /*
     * 环境音支线的提交位于当前可见窗口之外，但仍保留父 ID，模拟 Lore
     * 分页历史中“父修订已知、对应行尚未加载”的真实情况。
     */
    parentIds: ['5de935ea27ae40b0a6ba6df114dad190', '74c020af3a75445f9acbd69ca70c3291'],
    filesChanged: 17,
    additions: 740,
    deletions: 122,
    size: '392.4 MB'
  },
  {
    id: '5de935ea27ae40b0a6ba6df114dad190',
    shortId: '5de935ea',
    title: 'Establish the Meridian night lighting baseline',
    description: 'Commit the first night-lighting baseline for subsequent district tuning.',
    author: 'Lin Moore',
    initials: 'L',
    timestamp: '2026-07-23 17:03',
    relativeTime: 'yesterday',
    branchPointers: [{ id: 'remote:origin-main', name: 'origin/main', kind: 'remote' }],
    parentCount: 1,
    parentIds: ['f50b74b5928943498f29e77fbbf470dd'],
    filesChanged: 31,
    additions: 1180,
    deletions: 405,
    size: '214.6 MB'
  },
  {
    id: 'f50b74b5928943498f29e77fbbf470dd',
    shortId: 'f50b74b5',
    title: 'Optimize the chunk heat budget for the city center',
    description: 'Adjust the shared cache budget from sampled data to reduce stutter during cross-district movement.',
    author: 'Su An',
    initials: 'S',
    timestamp: '2026-07-23 14:36',
    relativeTime: 'yesterday',
    branchPointers: [],
    parentCount: 1,
    parentIds: ['ae188aee4623484da981a7ecbc3fcf21'],
    filesChanged: 6,
    additions: 183,
    deletions: 95,
    size: '2.1 MB'
  },
  {
    id: 'ae188aee4623484da981a7ecbc3fcf21',
    shortId: 'ae188aee',
    title: 'Migrate Old Town buildings to World Partition',
    description: 'Complete the partition migration and reference repair for the Old Town building collection.',
    author: 'Chen Yu',
    initials: 'C',
    timestamp: '2026-07-23 10:11',
    relativeTime: 'yesterday',
    branchPointers: [],
    parentCount: 1,
    parentIds: ['1206db638d224805aef96f815da0cd43'],
    filesChanged: 46,
    additions: 2097,
    deletions: 861,
    size: '1.2 GB'
  },
  {
    id: '1206db638d224805aef96f815da0cd43',
    shortId: '1206db63',
    title: 'Create the release/0.8 stabilization branch',
    description: 'Freeze the content baseline for version 0.8 and generate a verifiable revision anchor.',
    author: 'Team',
    initials: 'T',
    timestamp: '2026-07-22 18:44',
    relativeTime: '2 days ago',
    branchPointers: [{ id: 'remote:origin-release', name: 'origin/release/0.8', kind: 'remote' }],
    /*
     * release 指针停在较早的 Revision 上不影响图谱 lane；布局只读取
     * `parentIds`，不能根据分支名称或是否附着标签猜测。
     */
    parentCount: 1,
    parentIds: ['0f9c4ba7826241639d491326c73fa648'],
    filesChanged: 2,
    additions: 42,
    deletions: 0,
    size: '36 KB'
  }
]

export const initialChanges: ChangeFile[] = [
  {
    id: 'change-1',
    path: 'Content/World/Meridian/Lighting',
    name: 'GoldenHour_Profile.uasset',
    status: 'modified',
    staged: true,
    additions: 42,
    deletions: 17,
    binary: true,
    size: '2.6 MB'
  },
  {
    id: 'change-2',
    path: 'Content/World/Meridian/Fog',
    name: 'Harbor_DistanceFog.uasset',
    status: 'modified',
    staged: true,
    additions: 18,
    deletions: 8,
    binary: true,
    size: '840 KB'
  },
  {
    id: 'change-3',
    path: 'Content/World/Meridian/Layers',
    name: 'Meridian_Lighting.layer.json',
    status: 'added',
    staged: false,
    additions: 124,
    deletions: 0
  },
  {
    id: 'change-4',
    path: 'Content/World/Meridian/Reflections',
    name: 'Harbor_ReflectionGrid.uasset',
    status: 'modified',
    staged: false,
    additions: 33,
    deletions: 15,
    binary: true,
    size: '8.1 MB'
  },
  {
    id: 'change-5',
    path: 'Config/World',
    name: 'StreamingBudget.ini',
    status: 'modified',
    staged: false,
    additions: 9,
    deletions: 3
  },
  {
    id: 'change-6',
    path: 'Content/World/Meridian/Legacy',
    name: 'OldFogVolume.uasset',
    status: 'deleted',
    staged: false,
    additions: 0,
    deletions: 1,
    binary: true,
    size: '1.3 MB'
  }
]

export const inspectorFiles: ChangeFile[] = [
  {
    id: 'file-1',
    path: 'Content/World/Meridian/Lighting',
    name: 'GoldenHour_Profile.uasset',
    status: 'modified',
    staged: true,
    additions: 88,
    deletions: 12,
    binary: true,
    size: '2.6 MB'
  },
  {
    id: 'file-2',
    path: 'Content/World/Meridian/Fog',
    name: 'Harbor_DistanceFog.uasset',
    status: 'modified',
    staged: true,
    additions: 61,
    deletions: 9,
    binary: true,
    size: '840 KB'
  },
  {
    id: 'file-3',
    path: 'Content/World/Meridian/Layers',
    name: 'Meridian_Lighting.layer.json',
    status: 'added',
    staged: true,
    additions: 124,
    deletions: 0
  },
  {
    id: 'file-4',
    path: 'Config/World',
    name: 'StreamingBudget.ini',
    status: 'modified',
    staged: true,
    additions: 13,
    deletions: 4
  }
]
