import {
  AlertTriangle,
  ArrowDownToLine,
  File,
  GitBranchPlus,
  LocateFixed,
  LoaderCircle,
  Network,
  RefreshCw,
  Trash2,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, WheelEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CheckboxInput } from '../../../shared/ui'
import type { LoreDependencyGraphEdge, LoreDependencyGraphQuery, LoreDependencySelection } from '../../../types'
import {
  dependencyGraphPanOffsetAfterZoom,
  dependencyPathDirectory,
  dependencyPathLabel,
  findDependencyCycle,
  findDependencyPath,
  layoutDependencyGraph
} from './dependencyGraphModel'

interface DependencyGraphPanelProps {
  query: LoreDependencyGraphQuery | null
  available: boolean
  loading: boolean
  onQuery: (
    paths: string[],
    options: LoreDependencySelection,
    reverse: boolean
  ) => Promise<LoreDependencyGraphQuery | null>
  onAdd: (sourcePath: string, dependencyPath: string, tags: string[], force: boolean) => Promise<boolean>
  onRemove: (sourcePath: string, dependencyPath: string, tags: string[]) => Promise<boolean>
  onSync: (options: LoreDependencySelection) => Promise<boolean>
}

const MIN_GRAPH_ZOOM = 0.55
const MAX_GRAPH_ZOOM = 1.4
const GRAPH_WHEEL_ZOOM_STEP = 0.1

interface DependencyGraphPanState {
  pointerId: number
  pointerX: number
  pointerY: number
  panX: number
  panY: number
}

/** 管理真实文件依赖边，并把有界直连查询重建为可选择、可检查的分层有向图。 */
export function DependencyGraphPanel({
  query,
  available,
  loading,
  onQuery,
  onAdd,
  onRemove,
  onSync
}: DependencyGraphPanelProps) {
  const { t } = useTranslation()
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const panStateRef = useRef<DependencyGraphPanState | null>(null)
  // 平移的原生值由 state 承载（渲染期读取 CSS 变量初值）；拖拽过程中的高频更新仍
  // 由 moveGraphPan 直接写 DOM 合成层变量，不触发重渲染（见该函数注释）。
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [rootFiles, setRootFiles] = useState('')
  const [tags, setTags] = useState('')
  const [recursive, setRecursive] = useState(true)
  const [reverse, setReverse] = useState(false)
  const [depthLimit, setDepthLimit] = useState(0)
  const [sourcePath, setSourcePath] = useState('')
  const [dependencyPath, setDependencyPath] = useState('')
  const [edgeTags, setEdgeTags] = useState('')
  const [force, setForce] = useState(false)
  const [pending, setPending] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [panning, setPanning] = useState(false)
  const [selectedNodePath, setSelectedNodePath] = useState('')
  const [selectedEdgeKey, setSelectedEdgeKey] = useState('')
  const [proposedCyclePath, setProposedCyclePath] = useState<string[] | null>(null)
  const roots = useMemo(() => parseList(rootFiles), [rootFiles])
  const queryTags = useMemo(() => parseList(tags), [tags])
  const busy = loading || pending
  const selection = useMemo<LoreDependencySelection>(
    () => ({ rootFiles: roots, tags: queryTags, recursive, depthLimit }),
    [depthLimit, queryTags, recursive, roots]
  )
  const layout = useMemo(() => (query ? layoutDependencyGraph(query) : null), [query])
  const detectedCyclePath = useMemo(() => (query ? findDependencyCycle(query.edges) : null), [query])
  const visibleCyclePath = proposedCyclePath ?? detectedCyclePath
  const cycleNodePaths = useMemo(() => new Set(visibleCyclePath ?? []), [visibleCyclePath])
  const cycleEdgeKeys = useMemo(() => {
    const result = new Set<string>()
    if (!visibleCyclePath) return result
    for (let index = 0; index < visibleCyclePath.length - 1; index += 1) {
      result.add(dependencyEdgeKey(visibleCyclePath[index], visibleCyclePath[index + 1]))
    }
    return result
  }, [visibleCyclePath])
  const selectedNode = query?.nodes.find((node) => node.path === selectedNodePath) ?? null
  const selectedEdge =
    query?.edges.find((edge) => dependencyEdgeKey(edge.sourcePath, edge.dependencyPath) === selectedEdgeKey) ?? null

  useEffect(() => {
    // 查询结果变化时校正选区。写入放到微任务：query 引用稳定性无法静态保证，
    // 渲染期调整有循环风险；值未变的写入由 React bail out，顺序由微任务 FIFO 保证。
    queueMicrotask(() => {
      if (!query || query.nodes.length === 0) {
        setSelectedNodePath('')
        setSelectedEdgeKey('')
        return
      }
      setSelectedNodePath((current) =>
        query.nodes.some((node) => node.path === current)
          ? current
          : (query.nodes.find((node) => node.root)?.path ?? query.nodes[0].path)
      )
      setSelectedEdgeKey((current) =>
        query.edges.some((edge) => dependencyEdgeKey(edge.sourcePath, edge.dependencyPath) === current) ? current : ''
      )
    })
  }, [query])

  const runPending = async <T,>(operation: () => Promise<T>): Promise<T> => {
    setPending(true)
    try {
      return await operation()
    } finally {
      setPending(false)
    }
  }

  const submitQuery = async () => {
    setProposedCyclePath(null)
    await runPending(() => onQuery(roots, selection, reverse))
  }

  const submitAdd = async () => {
    const source = sourcePath.trim()
    const dependency = dependencyPath.trim()
    const edgeTagList = parseList(edgeTags)
    if (
      force &&
      !window.confirm(
        t('confirm.forceDependencyCycleCheckBypass', {
          source,
          dependency
        })
      )
    ) {
      return
    }

    await runPending(async () => {
      const added = await onAdd(source, dependency, edgeTagList, force)
      if (added) {
        const refreshRoots = roots.length > 0 ? roots : [source]
        if (roots.length === 0) setRootFiles(source)
        setDependencyPath('')
        setEdgeTags('')
        setForce(false)
        setProposedCyclePath(null)
        await onQuery(refreshRoots, { ...selection, rootFiles: refreshRoots }, reverse)
        return
      }

      /*
       * Add 失败可能是 Lore 的循环保护。只在未 force 时按目标文件读取精确正向图；
       * 若能到达来源文件，就展示“拟新增边 + 现有路径”组成的完整循环。其他失败继续
       * 由 App 的结构化错误 Toast 表达，不猜测为循环。
       */
      if (!force) {
        const probeOptions: LoreDependencySelection = {
          rootFiles: [dependency],
          tags: [],
          recursive: true,
          depthLimit: 0
        }
        const probe = await onQuery([dependency], probeOptions, false)
        const existingPath = probe ? findDependencyPath(probe.edges, dependency, source) : null
        if (existingPath) setProposedCyclePath([source, ...existingPath])
      }
    })
  }

  const submitRemove = async (edge: LoreDependencyGraphEdge) => {
    if (
      !window.confirm(t('confirm.removeFileDependency', { source: edge.sourcePath, dependency: edge.dependencyPath }))
    ) {
      return
    }
    await runPending(async () => {
      if (await onRemove(edge.sourcePath, edge.dependencyPath, edge.tags)) {
        setSelectedEdgeKey('')
        await onQuery(roots, selection, reverse)
      }
    })
  }

  const submitSync = async () => {
    if (
      !window.confirm(
        t('confirm.dependencyDrivenSync', {
          count: roots.length,
          depth: recursive ? (depthLimit === 0 ? t('unlimited') : depthLimit) : 1
        })
      )
    ) {
      return
    }
    await runPending(() => onSync(selection))
  }

  const fitGraph = () => {
    if (!layout || !viewportRef.current || layout.width === 0 || layout.height === 0) return
    const widthRatio = (viewportRef.current.clientWidth - 24) / layout.width
    const heightRatio = (viewportRef.current.clientHeight - 24) / layout.height
    const nextZoom = clampGraphZoom(Math.min(1, widthRatio, heightRatio))
    setPan({
      x: Math.round((viewportRef.current.clientWidth - layout.width * nextZoom) / 2),
      y: Math.round((viewportRef.current.clientHeight - layout.height * nextZoom) / 2)
    })
    setZoom(nextZoom)
  }

  /**
   * 仅从画布空白处开始左键平移。节点和边继续保留原有点击、聚焦与键盘选择语义，
   * 不会因为新增拖拽手势而被抢占。
   */
  const startGraphPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return
    const target = event.target as Element
    if (target.closest('.dependency-visualizer__node, .dependency-visualizer__edge')) return

    panStateRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      panX: pan.x,
      panY: pan.y
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setPanning(true)
    event.preventDefault()
  }

  /** Pointer Capture 保证鼠标离开画布后仍能连续平移，直到左键释放。 */
  const moveGraphPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = panStateRef.current
    if (!origin || origin.pointerId !== event.pointerId) return
    const nextPan = {
      x: origin.panX + event.clientX - origin.pointerX,
      y: origin.panY + event.clientY - origin.pointerY
    }
    /*
     * pointermove 是高频热路径。直接更新合成层变量，避免整棵依赖图和详情面板随
     * 每个鼠标采样重渲染；释放时的 panning 状态更新会自然保留 ref 中的最终值。
     */
    canvasRef.current?.style.setProperty('--dependency-graph-pan-x', `${nextPan.x}px`)
    canvasRef.current?.style.setProperty('--dependency-graph-pan-y', `${nextPan.y}px`)
    event.preventDefault()
  }

  const stopGraphPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = panStateRef.current
    if (!origin || origin.pointerId !== event.pointerId) return
    panStateRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setPanning(false)
  }

  /**
   * 滚轮直接控制缩放，并以指针所在位置为缩放中心。平移使用不受滚动边界限制的
   * 二维相机偏移，因此图小于视口时也能继续上下左右移动。
   */
  const zoomGraphWithWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY === 0) return
    const viewport = event.currentTarget
    const nextZoom = clampGraphZoom(zoom + (event.deltaY < 0 ? GRAPH_WHEEL_ZOOM_STEP : -GRAPH_WHEEL_ZOOM_STEP))
    event.preventDefault()
    if (nextZoom === zoom) return

    const bounds = viewport.getBoundingClientRect()
    const pointerX = event.clientX - bounds.left
    const pointerY = event.clientY - bounds.top
    /*
     * 相机偏移对齐到整数 CSS 像素，避免非整数 translate 让整张节点文字落在半像素
     * 上。最多不到 0.5px 的锚点误差不会被感知，但能显著降低缩放后的字形发虚。
     */
    const nextPanX = Math.round(dependencyGraphPanOffsetAfterZoom(pan.x, pointerX, zoom, nextZoom))
    const nextPanY = Math.round(dependencyGraphPanOffsetAfterZoom(pan.y, pointerY, zoom, nextZoom))
    setPan({ x: nextPanX, y: nextPanY })
    setZoom(nextZoom)
  }

  const selectEdge = (edge: LoreDependencyGraphEdge) => {
    setSelectedNodePath('')
    setSelectedEdgeKey(dependencyEdgeKey(edge.sourcePath, edge.dependencyPath))
  }

  return (
    <div className="dependency-graph">
      <div className="dependency-graph__notice">
        <Network size={17} />
        <span>
          <strong>{t('fileDependencyGraph')}</strong>
          <small>{t('fileDependencyGraphDescription')}</small>
        </span>
      </div>

      <div className="dependency-graph__controls">
        <section className="dependency-query">
          <header>
            <strong>{t('inspectDependencyClosure')}</strong>
            <small>{t('dependencyQueryUsesStagedState')}</small>
          </header>
          <label className="is-wide">
            <span>{t('dependencyRootFiles')}</span>
            <textarea
              value={rootFiles}
              spellCheck={false}
              placeholder={t('dependencyRootFilesPlaceholder')}
              onChange={(event) => setRootFiles(event.target.value)}
            />
          </label>
          <label>
            <span>{t('dependencyTagsOptional')}</span>
            <input
              value={tags}
              spellCheck={false}
              placeholder={t('dependencyTagsPlaceholder')}
              onChange={(event) => setTags(event.target.value)}
            />
          </label>
          <label>
            <span>{t('dependencyDepthLimit')}</span>
            <input
              type="number"
              min={0}
              max={1024}
              value={depthLimit}
              disabled={!recursive}
              onChange={(event) => setDepthLimit(Math.max(0, Math.min(1024, Number(event.target.value) || 0)))}
            />
          </label>
          <div className="dependency-query__options">
            <label>
              <CheckboxInput checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />
              {t('includeTransitiveDependencies')}
            </label>
            <label>
              <CheckboxInput checked={reverse} onChange={(event) => setReverse(event.target.checked)} />
              {t('showReverseDependencies')}
            </label>
            <small>
              {depthLimit === 0 ? t('zeroMeansUnlimited') : t('status.maximumDependencyDepth', { depth: depthLimit })}
            </small>
          </div>
          <footer>
            <button
              type="button"
              disabled={busy || !available || roots.length === 0}
              onClick={() => void submitQuery()}
            >
              <RefreshCw size={13} />
              {t('queryDependencies')}
            </button>
            <button
              className="is-primary"
              type="button"
              disabled={busy || !available || roots.length === 0}
              onClick={() => void submitSync()}
            >
              <ArrowDownToLine size={13} />
              {t('dependencyDrivenSync')}
            </button>
          </footer>
        </section>

        <form
          className="dependency-editor"
          onSubmit={(event) => {
            event.preventDefault()
            void submitAdd()
          }}
        >
          <header>
            <GitBranchPlus size={15} />
            <strong>{t('addFileDependency')}</strong>
          </header>
          <label>
            <span>{t('dependencySourcePath')}</span>
            <input
              value={sourcePath}
              spellCheck={false}
              placeholder={t('dependencySourcePathPlaceholder')}
              onChange={(event) => setSourcePath(event.target.value)}
            />
          </label>
          <label>
            <span>{t('dependencyTargetPath')}</span>
            <input
              value={dependencyPath}
              spellCheck={false}
              placeholder={t('dependencyTargetPathPlaceholder')}
              onChange={(event) => setDependencyPath(event.target.value)}
            />
          </label>
          <label className="dependency-editor__tags">
            <span>{t('dependencyTagsOptional')}</span>
            <input
              value={edgeTags}
              spellCheck={false}
              placeholder={t('dependencyTagsPlaceholder')}
              onChange={(event) => setEdgeTags(event.target.value)}
            />
          </label>
          <footer>
            <label className="dependency-editor__force">
              <CheckboxInput checked={force} onChange={(event) => setForce(event.target.checked)} />
              <span>{t('skipDependencyCycleDetection')}</span>
            </label>
            <button
              className="is-primary"
              type="submit"
              disabled={busy || !available || !sourcePath.trim() || !dependencyPath.trim()}
            >
              {pending ? <LoaderCircle className="is-spinning" size={13} /> : <GitBranchPlus size={13} />}
              {t('addDependency')}
            </button>
          </footer>
        </form>
      </div>

      {visibleCyclePath && (
        <div className="dependency-cycle-warning" role="alert">
          <AlertTriangle size={15} />
          <span>
            <strong>{t('dependencyCycleDetected')}</strong>
            <code>{visibleCyclePath.join(' → ')}</code>
          </span>
        </div>
      )}

      {!query || query.nodes.length === 0 || !layout ? (
        <div className="dialog-empty dependency-graph__empty">
          <Network size={27} />
          <strong>{t('noDependencyQueryResults')}</strong>
          <small>{t('enterRootFilesToInspectDependencies')}</small>
        </div>
      ) : (
        <section className="dependency-visualizer" aria-label={t('dependencyGraphCanvas')}>
          <header className="dependency-visualizer__toolbar">
            <span>
              <strong>{t('dependencyGraphCanvas')}</strong>
              <small>
                {t('status.dependencyGraphSummary', {
                  nodes: query.nodes.length,
                  edges: query.edges.length
                })}
                {' · '}
                {query.reverse ? t('reverseDependencyTraversal') : t('forwardDependencyTraversal')}
                {' · '}
                <code>{query.revision.slice(0, 12)}</code>
              </small>
            </span>
            <div>
              <button
                type="button"
                title={t('zoomOut')}
                aria-label={t('zoomOut')}
                disabled={zoom <= MIN_GRAPH_ZOOM}
                onClick={() => setZoom((current) => clampGraphZoom(current - 0.1))}
              >
                <ZoomOut size={14} />
              </button>
              <output aria-label={t('dependencyGraphZoom')}>{Math.round(zoom * 100)}%</output>
              <button
                type="button"
                title={t('zoomIn')}
                aria-label={t('zoomIn')}
                disabled={zoom >= MAX_GRAPH_ZOOM}
                onClick={() => setZoom((current) => clampGraphZoom(current + 0.1))}
              >
                <ZoomIn size={14} />
              </button>
              <button
                type="button"
                title={t('fitDependencyGraph')}
                aria-label={t('fitDependencyGraph')}
                onClick={fitGraph}
              >
                <LocateFixed size={14} />
              </button>
            </div>
          </header>

          {query.truncated && (
            <p className="dependency-visualizer__limit">
              <AlertTriangle size={13} />
              {t('status.dependencyGraphTruncated', { count: query.nodeLimit })}
            </p>
          )}

          <div className="dependency-visualizer__workspace">
            <div
              className={`dependency-visualizer__viewport${panning ? ' is-panning' : ''}`}
              ref={viewportRef}
              onPointerDown={startGraphPan}
              onPointerMove={moveGraphPan}
              onPointerUp={stopGraphPan}
              onPointerCancel={stopGraphPan}
              onLostPointerCapture={() => {
                panStateRef.current = null
                setPanning(false)
              }}
              onWheel={zoomGraphWithWheel}
            >
              <div className="dependency-visualizer__scaled" style={{ width: layout.width, height: layout.height }}>
                <div
                  className="dependency-visualizer__canvas"
                  ref={canvasRef}
                  style={
                    {
                      width: layout.width,
                      height: layout.height,
                      '--dependency-graph-zoom': zoom,
                      '--dependency-graph-pan-x': `${pan.x}px`,
                      '--dependency-graph-pan-y': `${pan.y}px`
                    } as CSSProperties
                  }
                >
                  <svg aria-label={t('dependencyGraphEdges')} height={layout.height} role="group" width={layout.width}>
                    <defs>
                      <marker
                        id="dependency-graph-arrow"
                        markerWidth="7"
                        markerHeight="7"
                        refX="6"
                        refY="3.5"
                        orient="auto"
                      >
                        <path d="M 0 0 L 7 3.5 L 0 7 z" fill="context-stroke" />
                      </marker>
                    </defs>
                    {layout.edges.map((edge) => {
                      const key = dependencyEdgeKey(edge.sourcePath, edge.dependencyPath)
                      const selected = selectedEdgeKey === key
                      const inCycle = cycleEdgeKeys.has(key)
                      return (
                        <g
                          className={`dependency-visualizer__edge${selected ? ' is-selected' : ''}${inCycle ? ' is-cycle' : ''}`}
                          key={edge.id}
                          role="button"
                          tabIndex={0}
                          aria-label={t('status.dependencyEdgeBetween', {
                            source: edge.sourcePath,
                            dependency: edge.dependencyPath
                          })}
                          onClick={() => selectEdge(edge)}
                          onKeyDown={(event) => handleGraphItemKey(event, () => selectEdge(edge))}
                        >
                          <path className="dependency-visualizer__edge-hit" d={edge.path} />
                          <path className="dependency-visualizer__edge-line" d={edge.path} />
                          {edge.tags.length > 0 && (
                            <text x={edge.labelX} y={edge.labelY - 5} textAnchor="middle">
                              {edge.tags.join(', ')}
                            </text>
                          )}
                        </g>
                      )
                    })}
                  </svg>

                  {layout.nodes.map((node) => (
                    <button
                      className={`dependency-visualizer__node${node.root ? ' is-root' : ''}${
                        selectedNodePath === node.path ? ' is-selected' : ''
                      }${cycleNodePaths.has(node.path) ? ' is-cycle' : ''}`}
                      type="button"
                      key={node.path}
                      title={node.path}
                      style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
                      aria-pressed={selectedNodePath === node.path}
                      onClick={() => {
                        setSelectedEdgeKey('')
                        setSelectedNodePath(node.path)
                      }}
                    >
                      <File size={14} />
                      <span>
                        <strong>{dependencyPathLabel(node.path)}</strong>
                        <small>{dependencyPathDirectory(node.path)}</small>
                      </span>
                      <em>{node.root ? t('rootFile') : node.distance}</em>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <aside className="dependency-visualizer__details">
              {selectedEdge ? (
                <>
                  <header>
                    <Network size={14} />
                    <strong>{t('exactDependencyEdge')}</strong>
                  </header>
                  <dl>
                    <div>
                      <dt>{t('dependencySourcePath')}</dt>
                      <dd>
                        <code>{selectedEdge.sourcePath}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>{t('dependencyTargetPath')}</dt>
                      <dd>
                        <code>{selectedEdge.dependencyPath}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>{t('dependencyTags')}</dt>
                      <dd>{selectedEdge.tags.length > 0 ? selectedEdge.tags.join(', ') : t('none')}</dd>
                    </div>
                  </dl>
                  <button
                    className="is-danger"
                    type="button"
                    disabled={busy || !available}
                    onClick={() => void submitRemove(selectedEdge)}
                  >
                    <Trash2 size={13} />
                    {t('removeExactDependencyEdge')}
                  </button>
                </>
              ) : selectedNode ? (
                <>
                  <header>
                    <File size={14} />
                    <strong>{t('dependencyFileNode')}</strong>
                  </header>
                  <code className="dependency-visualizer__selected-path">{selectedNode.path}</code>
                  <dl>
                    <div>
                      <dt>{t('dependencyTraversalDistance')}</dt>
                      <dd>{selectedNode.root ? t('rootFile') : selectedNode.distance}</dd>
                    </div>
                    <div>
                      <dt>{t('incomingDependencies')}</dt>
                      <dd>{query.edges.filter((edge) => edge.dependencyPath === selectedNode.path).length}</dd>
                    </div>
                    <div>
                      <dt>{t('outgoingDependencies')}</dt>
                      <dd>{query.edges.filter((edge) => edge.sourcePath === selectedNode.path).length}</dd>
                    </div>
                  </dl>
                  <div className="dependency-visualizer__node-actions">
                    <button type="button" onClick={() => setSourcePath(selectedNode.path)}>
                      {t('useAsDependencySource')}
                    </button>
                    <button type="button" onClick={() => setDependencyPath(selectedNode.path)}>
                      {t('useAsDependencyTarget')}
                    </button>
                  </div>
                </>
              ) : (
                <p>{t('selectDependencyGraphItem')}</p>
              )}
            </aside>
          </div>
        </section>
      )}
    </div>
  )
}

/** 支持换行或逗号分隔，并保持输入顺序。 */
function parseList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ]
}

function dependencyEdgeKey(sourcePath: string, dependencyPath: string): string {
  return `${sourcePath}\u0000${dependencyPath}`
}

function clampGraphZoom(value: number): number {
  return Math.min(MAX_GRAPH_ZOOM, Math.max(MIN_GRAPH_ZOOM, Math.round(value * 100) / 100))
}

/** SVG 边通过 Enter/Space 与鼠标共享选择行为。 */
function handleGraphItemKey(event: KeyboardEvent<SVGGElement>, select: () => void) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  select()
}
