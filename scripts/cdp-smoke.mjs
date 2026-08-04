import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveBrowserExecutable } from './browser-path.mjs'
import { removeOwnedTemporaryDirectory, terminateOwnedProcess } from './temporary-resources.mjs'

// 自动覆盖 Windows、Linux 与 macOS 的常见 Chrome、Chromium 和 Edge 安装；
// CI 使用非标准浏览器时仍可通过 LORE_CLIENT_BROWSER_PATH 显式指定。
const chromePath = resolveBrowserExecutable()
// 每个测试进程使用独立调试端口，避免并行执行或异常退出的旧 Chromium 让新用例
// 误连到另一份页面状态。端口范围保持在普通用户可监听区间，并远离 Vite 的 1420。
const debugPort = 9_300 + (process.pid % 20_000)
const debugBaseUrl = `http://127.0.0.1:${debugPort}`
const applicationUrl = 'http://127.0.0.1:1420/'
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
let applicationServer = null

async function applicationServerIsReady() {
  try {
    const response = await fetch(applicationUrl, {
      signal: AbortSignal.timeout(500)
    })
    return response.ok
  } catch {
    return false
  }
}

async function closeOwnedApplicationServer() {
  if (!applicationServer) {
    return
  }

  const server = applicationServer
  applicationServer = null
  /*
   * Vite 的程序化实例能在三个平台上关闭真实监听器，不依赖 Shell 或启动器的
   * 父子进程关系。超时保护只防止异常插件句柄阻塞测试进程。
   */
  await Promise.race([server.close().catch(() => {}), delay(2_000)])
}

async function ensureApplicationServer() {
  if (await applicationServerIsReady()) {
    return
  }

  /*
   * `bun run test:ui` 必须能够独立执行；没有现成开发服务时创建项目内 Vite。
   * 若开发者已经运行 1420 服务则只复用，不负责关闭。程序化生命周期避免
   * Windows 启动器退出后遗留 Node 子进程，也避免 Unix 上出现未回收的子进程。
   */
  const { createServer } = await import('vite')
  applicationServer = await createServer({
    root: projectRoot,
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port: 1420,
      strictPort: true
    }
  })
  try {
    await applicationServer.listen()
  } catch (error) {
    await closeOwnedApplicationServer()
    throw error
  }

  if (!(await applicationServerIsReady())) {
    await closeOwnedApplicationServer()
    throw new Error('The Lore Client UI test server did not respond after startup')
  }
}

await ensureApplicationServer()
// 浏览器缓存不能放进 Vite 监听的项目树，否则其锁文件会触发 Windows EBUSY。
const profilePath = resolve(tmpdir(), `lore-client-cdp-profile-${process.pid}-${Date.now()}`)

// 使用独立、一次性的无头浏览器实例，避免读取或污染用户真实浏览器资料。
await mkdir(profilePath, { recursive: true })
const browserProcess = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-extensions',
    '--hide-scrollbars',
    // UI 冒烟测试只访问本机 Vite 页面并使用一次性资料目录；受限 Windows
    // 执行环境无法启动 Chromium 沙箱子进程时，允许测试实例无沙箱运行。
    '--no-sandbox',
    '--no-default-browser-check',
    '--no-first-run',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profilePath}`,
    '--window-size=1440,900',
    applicationUrl
  ],
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
)
let browserDiagnostic = ''
browserProcess.stderr?.on('data', (chunk) => {
  // 仅保留尾部诊断，失败时帮助区分页面错误与 Chrome 启动策略限制。
  browserDiagnostic = `${browserDiagnostic}${chunk}`.slice(-4_000)
})

async function waitForDebugTarget() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const targets = await fetch(`${debugBaseUrl}/json/list`).then((response) => response.json())
      const applicationTarget = targets.find((target) => target.url?.startsWith(applicationUrl))
      if (applicationTarget) {
        return applicationTarget
      }
    } catch {
      // Chrome 启动初期端口尚未监听，短暂重试即可。
    }
    await delay(100)
  }

  throw new Error('No Lore Client debugging target appeared before the timeout')
}

function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl)
  let commandId = 0
  const pendingCommands = new Map()
  const runtimeErrors = []

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)

    if (message.id && pendingCommands.has(message.id)) {
      const { method, resolve, reject } = pendingCommands.get(message.id)
      pendingCommands.delete(message.id)
      if (message.error) {
        reject(new Error(`CDP command ${method} failed: ${message.error.message}`))
      } else {
        resolve(message.result)
      }
      return
    }

    if (message.method === 'Runtime.exceptionThrown') {
      runtimeErrors.push(message.params.exceptionDetails.text)
    }
  })

  async function send(method, params = {}) {
    await opened
    commandId += 1

    return new Promise((resolve, reject) => {
      // 保存方法名，让浏览器只返回通用错误时仍能定位失败发生在哪个交互阶段。
      pendingCommands.set(commandId, { method, resolve, reject })
      socket.send(JSON.stringify({ id: commandId, method, params }))
    })
  }

  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text)
    }
    return result.result.value
  }

  return { socket, send, evaluate, runtimeErrors }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function waitForApplication(cdp) {
  // 首次启动时 Vite 可能正在优化依赖，不能用固定 120ms 假定 React 已挂载。
  let lastContextError = ''
  let lastPageState = ''
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const state = await cdp.evaluate(`({
        mounted: Boolean(document.querySelector(".app-shell")),
        url: location.href,
        title: document.title,
        body: document.body?.textContent?.trim().slice(0, 300) ?? "",
        rootHtml: document.querySelector("#root")?.innerHTML.slice(0, 300) ?? "",
        resources: performance.getEntriesByType("resource")
          .map((entry) => entry.name)
          .slice(-12)
      })`)
      lastPageState = JSON.stringify(state)
      if (state.mounted) {
        return
      }
    } catch (error) {
      // Chrome 已公开调试 Target 但默认执行上下文仍可能尚未建立，等待下一轮即可。
      lastContextError = error instanceof Error ? error.message : String(error)
    }
    await delay(100)
  }
  throw new Error(
    `Lore Client did not finish mounting React before the timeout${lastContextError ? ` (${lastContextError})` : ''}${lastPageState ? `; page state: ${lastPageState}` : ''}${cdp.runtimeErrors.length ? `; runtime errors: ${JSON.stringify(cdp.runtimeErrors)}` : ''}${browserDiagnostic ? `: ${browserDiagnostic}` : ''}`
  )
}

try {
  const target = await waitForDebugTarget()
  const cdp = createCdpClient(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  // Chrome 150 可能先公开空白 Target，再异步处理命令行 URL；显式导航可稳定建立默认执行上下文。
  await cdp.send('Page.navigate', { url: applicationUrl })
  await waitForApplication(cdp)

  const results = {}

  results.initial = await cdp.evaluate(`({
    revisionRows: document.querySelectorAll(".revision-row").length,
    hasInspector: Boolean(document.querySelector(".inspector")),
    historyFooterRemoved: !document.querySelector(".history-footer"),
    historyGridRows:
      getComputedStyle(document.querySelector(".history-panel")).gridTemplateRows,
    bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
  })`)
  assert(results.initial.revisionRows >= 10, 'Revision history was not fully rendered')
  assert(results.initial.hasInspector, 'The revision inspector was not rendered')
  assert(
    results.initial.historyFooterRemoved && results.initial.historyGridRows.trim().split(/\s+/).length === 3,
    `The removed revision footer still occupies a history grid row: ${JSON.stringify(results.initial)}`
  )
  assert(!results.initial.bodyOverflowX, 'The main page has horizontal overflow')

  /*
   * 历史按新到旧排列；精确 HEAD 上方的每一行都必须带相对状态类，
   * HEAD 自身及更旧历史不得误标。搜索隐藏 HEAD 后，状态仍由完整投影保留。
   */
  results.revisionsAheadOfHead = await cdp.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll(".revision-row"));
    const headIndex = rows.findIndex((row) => row.querySelector(".revision-row__meta em.is-head"));
    const aheadIndices = rows
      .map((row, index) => row.classList.contains("is-ahead-of-head") ? index : -1)
      .filter((index) => index >= 0);
    return {
      headIndex,
      aheadIndices,
      headMarked: headIndex >= 0 && rows[headIndex].classList.contains("is-ahead-of-head"),
      olderMarked: headIndex >= 0 && rows.slice(headIndex + 1).some((row) =>
        row.classList.contains("is-ahead-of-head")
      )
    };
  })()`)
  assert(
    results.revisionsAheadOfHead.headIndex >= 0 &&
      JSON.stringify(results.revisionsAheadOfHead.aheadIndices) ===
        JSON.stringify(Array.from({ length: results.revisionsAheadOfHead.headIndex }, (_, index) => index)) &&
      !results.revisionsAheadOfHead.headMarked &&
      !results.revisionsAheadOfHead.olderMarked,
    `Revision rows ahead of HEAD were classified incorrectly: ${JSON.stringify(results.revisionsAheadOfHead)}`
  )

  /*
   * 默认演示仓库的 HEAD 就是首行，因此真实界面覆盖“不误标”边界；
   * HEAD 落后时的正向分类与筛选稳定性由 HistoryPanel 组件夹具覆盖。
   */

  /*
   * 底部实例、分区和状态栏都是高密度缩写信息；每一项都必须提供完整 title，
   * 让鼠标用户无需猜测图标或短文本的语义。
   */
  results.bottomInformationTooltips = await cdp.evaluate(`(() => {
    const readItems = (selector) =>
      Array.from(document.querySelectorAll(selector)).map((element) => ({
        text: element.textContent?.trim() ?? "",
        title: element.getAttribute("title") ?? ""
      }));
    return {
      sidebar: readItems(".sidebar__instance > div"),
      status: readItems(".statusbar > span:not(.statusbar__spacer)")
    };
  })()`)
  assert(
    results.bottomInformationTooltips.sidebar.length === 2 &&
      results.bottomInformationTooltips.status.length === 6 &&
      [...results.bottomInformationTooltips.sidebar, ...results.bottomInformationTooltips.status].every(
        (item) => item.text.length > 0 && item.title.length > 0 && item.title !== item.text && item.title.includes('：')
      ),
    `Bottom information tooltips are incomplete: ${JSON.stringify(results.bottomInformationTooltips)}`
  )

  // 桌面交互表面不允许拖出跨面板文本选区；搜索输入仍必须保留文字编辑与选择。
  results.textSelectionPolicy = await cdp.evaluate(`(() => {
    const shell = document.querySelector(".app-shell");
    const input = document.querySelector(".sidebar__filter input");
    return {
      shell: shell ? getComputedStyle(shell).userSelect : "",
      input: input ? getComputedStyle(input).userSelect : ""
    };
  })()`)
  assert(
    results.textSelectionPolicy.shell === 'none' && results.textSelectionPolicy.input === 'text',
    `The interface text-selection policy is invalid: ${JSON.stringify(results.textSelectionPolicy)}`
  )
  /*
   * 顶部仓库工具栏必须真正释放垂直空间，而不是只把内部内容缩小后仍保留
   * 旧网格轨道。这里读取浏览器最终矩形，并同时确认动作已经采用横向排列。
   */
  results.compactToolbar = await cdp.evaluate(`(() => {
    const toolbar = document.querySelector(".toolbar");
    const repositorySwitcher = document.querySelector(
      ".repository-switcher"
    );
    const actions = Array.from(document.querySelectorAll(".toolbar-action"));
    const labeledAction = actions.find((action) =>
      action.querySelector(":scope > span")
    );
    return {
      height: toolbar?.getBoundingClientRect().height ?? 0,
      repositoryHeight:
        repositorySwitcher?.getBoundingClientRect().height ?? 0,
      maximumActionHeight: actions.length
        ? Math.max(
            ...actions.map(
              (action) => action.getBoundingClientRect().height,
            ),
          )
        : 0,
      actionCount: actions.length,
      actionLabels: actions.map(
        (action) =>
          action.getAttribute("aria-label") ??
          action.textContent?.trim() ??
          "",
      ),
      labeledActionDirection: labeledAction
        ? getComputedStyle(labeledAction).flexDirection
        : "",
      overflowX: toolbar
        ? toolbar.scrollWidth > toolbar.clientWidth
        : true
    };
  })()`)
  const expectedToolbarActions = [
    '同步',
    '推送',
    '新建修订',
    '打开项目目录',
    '命令',
    '全局搜索',
    '服务器设置',
    '客户端设置'
  ]
  assert(
    results.compactToolbar.height <= 42 &&
      results.compactToolbar.repositoryHeight <= 34 &&
      results.compactToolbar.maximumActionHeight <= 34 &&
      results.compactToolbar.actionCount === expectedToolbarActions.length &&
      expectedToolbarActions.every((label) => results.compactToolbar.actionLabels.includes(label)) &&
      results.compactToolbar.labeledActionDirection === 'row' &&
      !results.compactToolbar.overflowX,
    `The top toolbar did not release vertical space as expected: ${JSON.stringify(results.compactToolbar)}`
  )
  /*
   * 首次启动和缺少轨道偏好字段的配置都必须进入平铺模式。当前 Branch 的
   * 本地指针与精确 HEAD 仍需可见，其他 Branch 指针不能混入默认列表。
   */
  results.revisionLaneDefault = await cdp.evaluate(`(() => ({
    mode: document.querySelector(".history-list")?.dataset.laneMode ?? "",
    revisionRows: document.querySelectorAll(".revision-row").length,
    visibleBranchPointers: Array.from(
      document.querySelectorAll(".revision-row__meta > em")
    ).map((pointer) => pointer.textContent?.trim() ?? "")
  }))()`)
  assert(
    results.revisionLaneDefault.mode === 'flat' &&
      results.revisionLaneDefault.revisionRows === 10 &&
      results.revisionLaneDefault.visibleBranchPointers.includes('world/lighting-pass') &&
      results.revisionLaneDefault.visibleBranchPointers.includes('HEAD') &&
      results.revisionLaneDefault.visibleBranchPointers.every(
        (pointer) => pointer === 'world/lighting-pass' || pointer === 'HEAD'
      ),
    `Revision History did not default to the current-branch Flat view: ${JSON.stringify(results.revisionLaneDefault)}`
  )
  /*
   * 后续仍需验证完整拓扑的跨行连接；先通过真实显示选项切到拓扑模式，再执行
   * 既有 SVG 几何断言。该动作也验证用户明确选择拓扑后不会被默认值覆盖。
   */
  await cdp.evaluate(`document.querySelector('button[aria-label="显示选项"]')?.click()`)
  await delay(40)
  await cdp.evaluate(`document.querySelector('input[name="revision-lane-mode"][value="topology"]')?.click()`)
  await delay(60)
  await cdp.evaluate(`document.querySelector('button[aria-label="显示选项"]')?.click()`)
  await delay(40)
  /*
   * 侧栏 Branch 单击必须使用精确 latest 联动 Revision History，但不能触发 Checkout。
   * 先把目标行滚出视口，再点击 main，并等待平滑滚动结束，以同时覆盖选中态与定位。
   */
  await cdp.evaluate(`(() => {
    const list = document.querySelector(".history-list");
    if (list instanceof HTMLElement) list.scrollTop = list.scrollHeight;
    const branch = Array.from(
      document.querySelectorAll(".sidebar__scroll .tree-row--local")
    ).find((button) => button.getAttribute("aria-label") === "main");
    branch?.click();
  })()`)
  await delay(450)
  results.sidebarBranchRevisionReveal = await cdp.evaluate(`(() => {
    const list = document.querySelector(".history-list");
    const selectedRow = document.querySelector(".revision-row.is-selected");
    const selectedGraph = selectedRow?.querySelector(".revision-graph");
    const selectedBranch = document.querySelector(".sidebar__scroll .tree-row--local.is-selected");
    const currentBranch = document.querySelector(".sidebar__scroll .tree-row--local.is-current");
    const listBounds = list?.getBoundingClientRect();
    const rowBounds = selectedRow?.getBoundingClientRect();
    return {
      historyVisible: Boolean(document.querySelector(".history-panel")),
      // 树叶只显示末段，完整 Lore Branch 名称由稳定可访问名称保留。
      selectedBranch: selectedBranch?.getAttribute("aria-label") ?? "",
      currentBranch: currentBranch?.getAttribute("aria-label") ?? "",
      revisionId: selectedGraph?.getAttribute("data-revision-id") ?? "",
      revisionVisible: Boolean(listBounds && rowBounds) &&
        rowBounds.top >= listBounds.top && rowBounds.bottom <= listBounds.bottom,
      hasToast: Boolean(document.querySelector(".toast"))
    };
  })()`)
  assert(
    results.sidebarBranchRevisionReveal.historyVisible &&
      results.sidebarBranchRevisionReveal.selectedBranch === 'main' &&
      results.sidebarBranchRevisionReveal.currentBranch === 'world/lighting-pass' &&
      results.sidebarBranchRevisionReveal.revisionId === '5de935ea27ae40b0a6ba6df114dad190' &&
      results.sidebarBranchRevisionReveal.revisionVisible &&
      !results.sidebarBranchRevisionReveal.hasToast,
    `Clicking a sidebar branch did not reveal its exact latest revision without checkout: ${JSON.stringify(
      results.sidebarBranchRevisionReveal
    )}`
  )
  /*
   * 直接读取真实 SVG path 的端点，验证合并行展开的侧 lane 会在下一行
   * 进入侧线节点，并在共同父修订前回到主 lane。这里只比较横坐标，
   * 因为相邻行分别使用 y=50 与 y=0 表达同一条跨行边界。
   */
  results.revisionGraphTopology = await cdp.evaluate(`(() => {
    const mergeGraph = document.querySelector(
      '[data-revision-id="7aa51c94cf7d44e4a461c1a573f3c84d"]'
    );
    const sideGraph = document.querySelector(
      '[data-revision-id="1dd6e2a38c1d4719b9ce1156695ef1ca"]'
    );
    const parentGraph = document.querySelector(
      '[data-revision-id="f063298b851f44c6a9edc99df3bd1c60"]'
    );
    const secondSideGraph = document.querySelector(
      '[data-revision-id="0a9d82f37dfa4f3fb252f4f04669514c"]'
    );
    const ambientMergeGraph = document.querySelector(
      '[data-revision-id="ab18d30e5e134867b333d6e223be64ff"]'
    );
    const mergePath = mergeGraph?.querySelector(
      ".revision-graph__branch.is-merge"
    );
    const sidePath = sideGraph?.querySelector(".revision-graph__branch");
    const secondSidePath = secondSideGraph?.querySelector(
      ".revision-graph__branch"
    );
    const ambientMergePath = ambientMergeGraph?.querySelector(
      ".revision-graph__branch.is-merge"
    );
    const parentPath = parentGraph?.querySelector(".revision-graph__main");
    const mainPath = mergeGraph?.querySelector(".revision-graph__main");
    const pathPoint = (path, atEnd) => {
      if (!path) return null;
      const point = path.getPointAtLength(atEnd ? path.getTotalLength() : 0);
      return { x: point.x, y: point.y };
    };
    const pathStroke = (path) =>
      path ? getComputedStyle(path).stroke : "";

    return {
      mergeBranchPaths:
        mergeGraph?.querySelectorAll(".revision-graph__branch").length ?? -1,
      sideBranchPaths:
        sideGraph?.querySelectorAll(".revision-graph__branch").length ?? -1,
      secondSideBranchPaths:
        secondSideGraph?.querySelectorAll(".revision-graph__branch").length ??
        -1,
      ambientMergeBranchPaths:
        ambientMergeGraph?.querySelectorAll(".revision-graph__branch").length ??
        -1,
      sideNodeLane: sideGraph?.getAttribute("data-node-lane") ?? "",
      mergeEnd: pathPoint(mergePath, true),
      sideStart: pathPoint(sidePath, false),
      sideEnd: pathPoint(sidePath, true),
      parentStart: pathPoint(parentPath, false),
      /*
       * 第二父修订边和下一行延续段属于同一个源分支 lane，最终计算色必须
       * 完全一致；仅比较 class 无法捕获 CSS 再次把合并半段染黄的回归。
       */
      mergeStroke: pathStroke(mergePath),
      sideStroke: pathStroke(sidePath),
      secondSideStroke: pathStroke(secondSidePath),
      ambientStroke: pathStroke(ambientMergePath),
      mainStroke: pathStroke(mainPath),
      mergeColorIndex: mergePath?.getAttribute("data-color-index") ?? "",
      sideColorIndex: sidePath?.getAttribute("data-color-index") ?? "",
      secondSideColorIndex:
        secondSidePath?.getAttribute("data-color-index") ?? "",
      ambientColorIndex:
        ambientMergePath?.getAttribute("data-color-index") ?? ""
    };
  })()`)
  const distinctLaneStrokes = new Set([
    results.revisionGraphTopology.mainStroke,
    results.revisionGraphTopology.sideStroke,
    results.revisionGraphTopology.secondSideStroke,
    results.revisionGraphTopology.ambientStroke
  ])
  assert(
    results.revisionGraphTopology.mergeBranchPaths === 1 &&
      results.revisionGraphTopology.sideBranchPaths === 1 &&
      results.revisionGraphTopology.secondSideBranchPaths === 1 &&
      results.revisionGraphTopology.ambientMergeBranchPaths === 1 &&
      results.revisionGraphTopology.sideNodeLane === '1' &&
      Math.abs(results.revisionGraphTopology.mergeEnd.x - results.revisionGraphTopology.sideStart.x) < 0.01 &&
      Math.abs(results.revisionGraphTopology.sideEnd.x - results.revisionGraphTopology.parentStart.x) < 0.01 &&
      results.revisionGraphTopology.mergeStroke === results.revisionGraphTopology.sideStroke &&
      distinctLaneStrokes.size === 4 &&
      results.revisionGraphTopology.mergeColorIndex === '1' &&
      results.revisionGraphTopology.sideColorIndex === '1' &&
      results.revisionGraphTopology.secondSideColorIndex === '2' &&
      results.revisionGraphTopology.ambientColorIndex === '3',
    `Revision graph lanes are discontinuous, change color, or still contain duplicate branch paths: ${JSON.stringify(
      results.revisionGraphTopology
    )}`
  )

  /*
   * 显示选项必须通过真实单选控件在多道拓扑和平铺模式之间切换。
   * 平铺模式只保留当前 Branch 的第一父历史，所有节点回到 0 号 lane，
   * 分支路径消失；共享祖先行隐藏其他 Branch 指针，但继续保留精确 HEAD。
   */
  await cdp.evaluate(`document.querySelector('button[aria-label="显示选项"]')?.click()`)
  await delay(40)
  /*
   * checkbox 与 button 的键盘焦点必须同时染蓝实体 border 和 outline。这里主动
   * 聚焦两类真实控件，并把 CSS 令牌解析为计算色，避免只检查选择器是否存在。
   */
  results.focusVisibleControlBorders = await cdp.evaluate(`(() => {
    const checkbox = document.querySelector('.history-options input[type="checkbox"]');
    const button = document.querySelector('button[aria-label="显示选项"]');
    if (!(checkbox instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement)) {
      return null;
    }
    const probe = document.createElement("span");
    probe.style.color = "var(--accent-solid)";
    document.body.append(probe);
    const accentColor = getComputedStyle(probe).color;
    probe.remove();

    checkbox.focus();
    const checkboxStyle = getComputedStyle(checkbox);
    const checkboxState = {
      usesSharedPrimitive: checkbox.classList.contains("control-checkbox"),
      focusVisible: checkbox.matches(":focus-visible"),
      borderColor: checkboxStyle.borderTopColor,
      outlineColor: checkboxStyle.outlineColor,
      baseGeometry: {
        width: checkboxStyle.width,
        minWidth: checkboxStyle.minWidth,
        height: checkboxStyle.height,
        minHeight: checkboxStyle.minHeight,
        borderWidth: checkboxStyle.borderTopWidth,
        borderRadius: checkboxStyle.borderRadius,
        padding: checkboxStyle.padding,
        appearance: checkboxStyle.appearance
      }
    };
    button.focus();
    const buttonStyle = getComputedStyle(button);
    return {
      accentColor,
      checkbox: checkboxState,
      button: {
        focusVisible: button.matches(":focus-visible"),
        borderColor: buttonStyle.borderTopColor,
        outlineColor: buttonStyle.outlineColor
      }
    };
  })()`)
  assert(
    results.focusVisibleControlBorders?.checkbox.usesSharedPrimitive &&
      results.focusVisibleControlBorders?.checkbox.focusVisible &&
      results.focusVisibleControlBorders?.checkbox.borderColor === results.focusVisibleControlBorders?.accentColor &&
      results.focusVisibleControlBorders?.checkbox.outlineColor === results.focusVisibleControlBorders?.accentColor &&
      results.focusVisibleControlBorders?.button.focusVisible &&
      results.focusVisibleControlBorders?.button.borderColor === results.focusVisibleControlBorders?.accentColor &&
      results.focusVisibleControlBorders?.button.outlineColor === results.focusVisibleControlBorders?.accentColor,
    `Checkbox or button focus border did not use the accent color: ${JSON.stringify(
      results.focusVisibleControlBorders
    )}`
  )
  /*
   * 显示选项属于临时浮层：用户点击 Revision 列表时必须立即关闭，不能继续
   * 遮挡历史内容。使用真实鼠标事件覆盖外部 pointer/mouse 监听路径。
   */
  const historyOptionsOutsidePoint = await cdp.evaluate(`(() => {
    /*
     * 平铺模式的说明文案会让弹层在最小视口中向下覆盖历史首行，因此不能再
     * 把首行中心假定为弹层外部。侧栏左下边缘始终位于弹层之外且没有主操作。
     */
    const rect = document.querySelector(".sidebar")?.getBoundingClientRect();
    return rect ? {
      x: Math.round(rect.left + 4),
      y: Math.round(rect.bottom - 4)
    } : null;
  })()`)
  assert(historyOptionsOutsidePoint, 'Failed to locate an outside point for the display-options popover')
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: historyOptionsOutsidePoint.x,
    y: historyOptionsOutsidePoint.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: historyOptionsOutsidePoint.x,
    y: historyOptionsOutsidePoint.y,
    button: 'left',
    buttons: 0,
    clickCount: 1
  })
  await delay(40)
  results.historyOptionsOutsideDismiss = await cdp.evaluate(`({
    popoverVisible: Boolean(document.querySelector(".history-options")),
    expanded:
      document.querySelector('button[aria-label="显示选项"]')
        ?.getAttribute("aria-expanded") === "true"
  })`)
  assert(
    !results.historyOptionsOutsideDismiss.popoverVisible && !results.historyOptionsOutsideDismiss.expanded,
    `The display-options popover stayed open after an outside click: ${JSON.stringify(
      results.historyOptionsOutsideDismiss
    )}`
  )
  /*
   * 键盘用户把焦点移到浮层控制区外时也应关闭；这与鼠标外部点击共享同一
   * dismiss 语义，但需要独立覆盖 focusin 事件路径。
   */
  await cdp.evaluate(`document.querySelector('button[aria-label="显示选项"]')?.click()`)
  await delay(40)
  await cdp.evaluate(`(() => {
    document.querySelector('.history-options input[name="revision-lane-mode"]')?.focus();
    document.querySelector(".inline-search input")?.focus();
  })()`)
  await delay(40)
  results.historyOptionsFocusDismiss = await cdp.evaluate(`({
    popoverVisible: Boolean(document.querySelector(".history-options")),
    expanded:
      document.querySelector('button[aria-label="显示选项"]')
        ?.getAttribute("aria-expanded") === "true"
  })`)
  assert(
    !results.historyOptionsFocusDismiss.popoverVisible && !results.historyOptionsFocusDismiss.expanded,
    `The display-options popover stayed open after focus moved outside: ${JSON.stringify(
      results.historyOptionsFocusDismiss
    )}`
  )
  /*
   * Escape 是临时浮层的键盘兜底关闭入口；真实键盘事件必须同步清除 DOM 与
   * aria-expanded，防止只隐藏视觉内容。
   */
  await cdp.evaluate(`document.querySelector('button[aria-label="显示选项"]')?.click()`)
  await delay(40)
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  })
  await delay(40)
  results.historyOptionsEscapeDismiss = await cdp.evaluate(`({
    popoverVisible: Boolean(document.querySelector(".history-options")),
    expanded:
      document.querySelector('button[aria-label="显示选项"]')
        ?.getAttribute("aria-expanded") === "true"
  })`)
  assert(
    !results.historyOptionsEscapeDismiss.popoverVisible && !results.historyOptionsEscapeDismiss.expanded,
    `The display-options popover stayed open after Escape: ${JSON.stringify(results.historyOptionsEscapeDismiss)}`
  )
  await cdp.evaluate(`document.querySelector('button[aria-label="显示选项"]')?.click()`)
  await delay(40)
  results.revisionFlatLane = await cdp.evaluate(`(() => {
    const topologyInput = document.querySelector(
      'input[name="revision-lane-mode"][value="topology"]'
    );
    const flatInput = document.querySelector(
      'input[name="revision-lane-mode"][value="flat"]'
    );
    const rowCountBefore = document.querySelectorAll(".revision-row").length;
    const topologyInitiallyChecked = topologyInput?.checked === true;
    flatInput?.click();
    return {
      controlsFound: Boolean(topologyInput && flatInput),
      topologyInitiallyChecked,
      flatChecked: flatInput?.checked === true,
      flatLabel:
        flatInput?.closest(".history-lane-option")
          ?.querySelector("strong")
          ?.textContent?.trim() ?? "",
      rowCountBefore
    };
  })()`)
  await delay(60)
  Object.assign(
    results.revisionFlatLane,
    await cdp.evaluate(`(() => {
      const graphs = Array.from(document.querySelectorAll(".revision-graph"));
      return {
        mode: document.querySelector(".history-list")?.dataset.laneMode ?? "",
        rowCountAfter: document.querySelectorAll(".revision-row").length,
        visibleBranchPointers: Array.from(
          document.querySelectorAll(".revision-row__meta > em")
        ).map((pointer) => pointer.textContent?.trim() ?? ""),
        allNodesOnMainLane: graphs.every(
          (graph) => graph.getAttribute("data-node-lane") === "0"
        ),
        branchPathCount: document.querySelectorAll(
          ".revision-graph__branch"
        ).length,
        maximumPathsPerRow: Math.max(
          0,
          ...graphs.map((graph) => graph.querySelectorAll("path").length)
        )
      };
    })()`)
  )
  assert(
    results.revisionFlatLane.controlsFound &&
      results.revisionFlatLane.topologyInitiallyChecked &&
      results.revisionFlatLane.flatChecked &&
      results.revisionFlatLane.flatLabel === '平铺模式' &&
      results.revisionFlatLane.mode === 'flat' &&
      results.revisionFlatLane.rowCountAfter > 0 &&
      results.revisionFlatLane.rowCountAfter < results.revisionFlatLane.rowCountBefore &&
      results.revisionFlatLane.visibleBranchPointers.length > 0 &&
      results.revisionFlatLane.visibleBranchPointers.includes('world/lighting-pass') &&
      results.revisionFlatLane.visibleBranchPointers.includes('HEAD') &&
      results.revisionFlatLane.visibleBranchPointers.every(
        (pointer) => pointer === 'world/lighting-pass' || pointer === 'HEAD'
      ) &&
      results.revisionFlatLane.allNodesOnMainLane &&
      results.revisionFlatLane.branchPathCount === 0 &&
      results.revisionFlatLane.maximumPathsPerRow === 1,
    `Revision History did not switch to Flat mode: ${JSON.stringify(results.revisionFlatLane)}`
  )
  /*
   * 模式选择是持久偏好，不是待处理状态。关闭弹层后入口不能因为选择了
   * 平铺模式而持续高亮；重新打开后仍要保留单选状态。
   */
  await cdp.evaluate(`document.querySelector('button[aria-label="显示选项"]')?.click()`)
  await delay(40)
  results.revisionFlatLane.buttonInactiveWhenClosed = await cdp.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="显示选项"]');
    return Boolean(button && !button.classList.contains("is-active"));
  })()`)
  assert(
    results.revisionFlatLane.buttonInactiveWhenClosed,
    `The display-options button stayed highlighted in Flat mode: ${JSON.stringify(results.revisionFlatLane)}`
  )
  await cdp.evaluate(`document.querySelector('button[aria-label="显示选项"]')?.click()`)
  await delay(40)
  await cdp.evaluate(`document.querySelector('input[name="revision-lane-mode"][value="topology"]')?.click()`)
  await delay(40)
  await cdp.evaluate(`document.querySelector('button[aria-label="显示选项"]')?.click()`)
  await delay(40)

  results.kbdBadges = await cdp.evaluate(`document.querySelectorAll("kbd").length`)
  assert(results.kbdBadges === 0, `The interface still displays KBD badges or shortcut pills: ${results.kbdBadges}`)
  results.verticalResizerHandles = await cdp.evaluate(`document.querySelectorAll(".pane-resizer svg").length`)
  assert(
    results.verticalResizerHandles === 0,
    `Vertical resizers still render visible handles: ${results.verticalResizerHandles}`
  )

  /*
   * 作者列隐藏时会离开 CSS Grid 自动排布；这里必须经过真实列设置入口，
   * 才能捕获时间节点误入零宽作者轨道、继而逐字换行的完整回归路径。
   */
  await cdp.evaluate(`document.querySelector('button[aria-label="显示选项"]')?.click()`)
  await delay(40)
  results.revisionTimeOnly = await cdp.evaluate(`(() => {
    const labels = Array.from(document.querySelectorAll("label"));
    const authorToggle = labels
      .find((label) => label.textContent?.includes("显示作者"))
      ?.querySelector("input");
    const timeToggle = labels
      .find((label) => label.textContent?.includes("显示时间"))
      ?.querySelector("input");

    if (authorToggle?.checked) authorToggle.click();
    if (timeToggle && !timeToggle.checked) timeToggle.click();

    return {
      controlsFound: Boolean(authorToggle && timeToggle),
      authorVisible: authorToggle?.checked ?? null,
      timeVisible: timeToggle?.checked ?? null
    };
  })()`)
  await delay(60)
  results.revisionTimeOnly.layout = await cdp.evaluate(`(() => {
    const row = document.querySelector(".revision-row");
    const time = row?.querySelector(":scope > time");
    const timestamp = time?.querySelector("small");
    if (!row || !time || !timestamp) return null;
    const rowStyle = getComputedStyle(row);
    const timeStyle = getComputedStyle(time);
    return {
      rowWidth: Math.round(row.getBoundingClientRect().width),
      gridTemplateColumns: rowStyle.gridTemplateColumns,
      timeWidth: Math.round(time.getBoundingClientRect().width),
      timeHeight: Math.round(time.getBoundingClientRect().height),
      timeWhiteSpace: timeStyle.whiteSpace,
      timestampWidth: Math.round(timestamp.getBoundingClientRect().width),
      timestampHeight: Math.round(timestamp.getBoundingClientRect().height),
      timestampWhiteSpace: getComputedStyle(timestamp).whiteSpace
    };
  })()`)
  results.revisionTimeOnly.metrics = await cdp.evaluate(`(() => {
    const cells = Array.from(
      document.querySelectorAll(".revision-row > time small")
    ).map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize);
      const parsedLineHeight = Number.parseFloat(style.lineHeight);
      const lineHeight = Number.isFinite(parsedLineHeight)
        ? parsedLineHeight
        : fontSize * 1.2;
      return {
        text: element.textContent?.trim() ?? "",
        className: element.className,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        fontSize,
        lineHeight,
        wrapped: rect.height > lineHeight * 1.5
      };
    });
    return {
      total: cells.length,
      minimumWidth: cells.length
        ? Math.min(...cells.map((cell) => cell.width))
        : 0,
      maximumHeight: cells.length
        ? Math.max(...cells.map((cell) => cell.height))
        : 0,
      wrapped: cells.filter((cell) => cell.wrapped)
    };
  })()`)
  assert(
    results.revisionTimeOnly.controlsFound &&
      results.revisionTimeOnly.authorVisible === false &&
      results.revisionTimeOnly.timeVisible === true,
    'Failed to switch the revision columns to time-only mode'
  )
  assert(
    results.revisionTimeOnly.layout?.timeWidth >= 64,
    `The revision time column width is invalid in time-only mode: ${JSON.stringify(results.revisionTimeOnly.layout)}`
  )
  assert(
    results.revisionTimeOnly.metrics.total >= results.initial.revisionRows,
    'Complete revision time content was not found in time-only mode'
  )
  assert(
    results.revisionTimeOnly.metrics.wrapped.length === 0,
    `Revision time text wraps character by character in time-only mode: ${JSON.stringify({
      layout: results.revisionTimeOnly.layout,
      cells: results.revisionTimeOnly.metrics.wrapped
    })}`
  )

  // Revision 单击只选择并更新检查器，不应触发 Checkout 或显示操作通知。
  await cdp.evaluate(`document.querySelectorAll(".revision-row")[2]?.click()`)
  await delay(60)
  results.revisionSingleClick = await cdp.evaluate(`({
    selected: document.querySelectorAll(".revision-row")[2]
      ?.classList.contains("is-selected") ?? false,
    hasOperationToast: Boolean(document.querySelector(".toast"))
  })`)
  assert(
    results.revisionSingleClick.selected && !results.revisionSingleClick.hasOperationToast,
    `A single revision click must not perform checkout: ${JSON.stringify(results.revisionSingleClick)}`
  )

  // 双击同一 Revision 才触发 Checkout；浏览器演示必须明确说明桌面行为。
  await cdp.evaluate(`document.querySelectorAll(".revision-row")[2]
    ?.dispatchEvent(new MouseEvent("dblclick", {
      bubbles: true,
      cancelable: true
    }))`)
  await delay(60)
  results.revisionDoubleClick = await cdp.evaluate(`({
    title: document.querySelector(".toast strong")?.textContent?.trim() ?? "",
    detail: document.querySelector(".toast small")?.textContent?.trim() ?? ""
  })`)
  assert(
    results.revisionDoubleClick.title === '浏览器演示模式' &&
      results.revisionDoubleClick.detail.includes('检出') &&
      results.revisionDoubleClick.detail.includes('1dd6e2a3'),
    `Double-clicking a revision did not trigger the checkout entry point: ${JSON.stringify(results.revisionDoubleClick)}`
  )
  await cdp.evaluate(`document.querySelector(".toast > button")?.click()`)
  await delay(40)

  // 修订行直接显示附着标签；右击标签徽标必须进入标签修改菜单而不是修订菜单。
  results.revisionTagBadges = await cdp.evaluate(`({
    count: document.querySelectorAll(".revision-row__tag").length,
    names: Array.from(document.querySelectorAll(".revision-row__tag"))
      .map((element) => element.textContent?.trim())
  })`)
  assert(
    results.revisionTagBadges.count >= 4 && results.revisionTagBadges.names.includes('preview/terrain-v7'),
    `Attached revision tags were not displayed: ${JSON.stringify(results.revisionTagBadges)}`
  )
  await cdp.evaluate(`(() => {
    const badge = Array.from(document.querySelectorAll(".revision-row__tag"))
      .find((element) => element.textContent?.trim() === "preview/terrain-v7");
    const bounds = badge?.getBoundingClientRect();
    badge?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(bounds?.left ?? 500),
      clientY: Math.round(bounds?.bottom ?? 260)
    }));
  })()`)
  await delay(50)
  results.revisionTagMenu = await cdp.evaluate(`({
    tagMenuVisible: Boolean(document.querySelector(".tag-context-menu")),
    revisionMenuVisible: Boolean(
      document.querySelector(".version-context-menu:not(.tag-context-menu)")
    ),
    hasEdit: Array.from(document.querySelectorAll(".tag-context-menu > button"))
      .some((button) => button.textContent?.includes("修改标签"))
  })`)
  assert(
    results.revisionTagMenu.tagMenuVisible &&
      !results.revisionTagMenu.revisionMenuVisible &&
      results.revisionTagMenu.hasEdit,
    `The revision tag context menu is invalid: ${JSON.stringify(results.revisionTagMenu)}`
  )
  await cdp.evaluate(`Array.from(document.querySelectorAll(".tag-context-menu > button"))
    .find((button) => button.textContent?.includes("修改标签"))?.click()`)
  await delay(40)
  results.revisionTagEditDialog = await cdp.evaluate(`({
    visible: Boolean(document.querySelector(".tag-dialog")),
    name: document.querySelector(".tag-dialog input")?.value ?? "",
    revision:
      document.querySelector(".tag-source code")?.textContent?.trim() ?? ""
  })`)
  assert(
    results.revisionTagEditDialog.visible &&
      results.revisionTagEditDialog.name === 'preview/terrain-v7' &&
      results.revisionTagEditDialog.revision === '1dd6e2a3',
    `The target selected when editing a revision tag is invalid: ${JSON.stringify(results.revisionTagEditDialog)}`
  )
  await cdp.evaluate(`document.querySelector(".tag-dialog button[aria-label='关闭']")?.click()`)
  await delay(40)

  // Revision 行右击必须同步当前选择、限制菜单在视口内，并暴露真实 Lore 操作。
  await cdp.evaluate(`(() => {
    const row = document.querySelectorAll(".revision-row")[2];
    row?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: window.innerWidth - 2,
      clientY: window.innerHeight - 2
    }));
  })()`)
  await delay(80)
  results.revisionMenu = await cdp.evaluate(`(() => {
    const menu = document.querySelector(".version-context-menu");
    const selected = document.querySelectorAll(".revision-row")[2];
    if (!menu) return { visible: false };
    const bounds = menu.getBoundingClientRect();
    return {
      visible: true,
      selected: selected?.classList.contains("is-selected") ?? false,
      labels: Array.from(menu.querySelectorAll(":scope > button"))
        .map((button) => button.textContent?.replace(/\\s+/g, " ").trim()),
      withinViewport:
        bounds.left >= 0 &&
        bounds.top >= 0 &&
        bounds.right <= window.innerWidth &&
        bounds.bottom <= window.innerHeight
    };
  })()`)
  assert(
    results.revisionMenu.visible && results.revisionMenu.selected && results.revisionMenu.withinViewport,
    `The revision context-menu state is invalid: ${JSON.stringify(results.revisionMenu)}`
  )
  for (const label of ['在检查器中打开', '签出', '新建分支', '新建标签', '拣选到', '撤销', '复制 ID', '复制信息']) {
    assert(
      results.revisionMenu.labels.some((text) => text?.includes(label)),
      `The revision menu is missing "${label}"`
    )
  }

  // Revision 入口只打开命名对话框，并明确保留被右击的精确修订起点。
  await cdp.evaluate(`Array.from(
    document.querySelectorAll(".version-context-menu > button")
  ).find((button) => button.textContent?.includes("新建分支"))?.click()`)
  await delay(60)
  results.revisionBranchCreateDialog = await cdp.evaluate(`(() => {
    const source = document.querySelector(".branch-create-source");
    return {
      visible: Boolean(document.querySelector(".compact-dialog")),
      branch: source?.querySelector("strong")?.textContent?.trim() ?? "",
      revision: source?.querySelector("code")?.textContent?.trim() ?? "",
      description: source?.querySelector("em")?.textContent?.trim() ?? ""
    };
  })()`)
  assert(
    results.revisionBranchCreateDialog.visible &&
      results.revisionBranchCreateDialog.branch === 'world/terrain-v7' &&
      results.revisionBranchCreateDialog.revision === '1dd6e2a3' &&
      results.revisionBranchCreateDialog.description.includes('所选修订'),
    `The source for creating a branch from a revision is invalid: ${JSON.stringify(results.revisionBranchCreateDialog)}`
  )
  await cdp.evaluate(`document.querySelector(".compact-dialog button[aria-label='关闭']")?.click()`)
  await delay(50)

  // 同一 Revision 菜单创建 Tag 时也必须保留被右击对象的精确 Branch/Revision。
  await cdp.evaluate(`(() => {
    const row = document.querySelectorAll(".revision-row")[2];
    const bounds = row?.getBoundingClientRect();
    row?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(bounds?.left ?? 520),
      clientY: Math.round(bounds?.top ?? 260)
    }));
  })()`)
  await delay(50)
  await cdp.evaluate(`Array.from(
    document.querySelectorAll(".version-context-menu > button")
  ).find((button) => button.textContent?.includes("新建标签"))?.click()`)
  await delay(50)
  results.revisionTagCreateDialog = await cdp.evaluate(`(() => {
    const source = document.querySelector(".tag-source");
    return {
      visible: Boolean(document.querySelector(".tag-dialog")),
      branch: source?.querySelector("strong")?.textContent?.trim() ?? "",
      revision: source?.querySelector("code")?.textContent?.trim() ?? ""
    };
  })()`)
  assert(
    results.revisionTagCreateDialog.visible &&
      results.revisionTagCreateDialog.branch === 'world/terrain-v7' &&
      results.revisionTagCreateDialog.revision === '1dd6e2a3',
    `The source for creating a tag from a revision is invalid: ${JSON.stringify(results.revisionTagCreateDialog)}`
  )
  await cdp.evaluate(`document.querySelector(".tag-dialog button[aria-label='关闭']")?.click()`)
  await delay(50)

  // 后续文件多选基线依赖最新 Revision，菜单验收后恢复默认选择。
  await cdp.evaluate(`document.querySelectorAll(".revision-row")[0]?.click()`)
  await delay(50)

  // 侧栏 Branch 树与总览卡片必须共享同一菜单，而不是只在单一视图生效。
  await cdp.evaluate(`(() => {
    const row = document.querySelector(
      ".tree-row--local.tree-row--branch-node:not(.is-current)"
    );
    const bounds = row?.getBoundingClientRect();
    row?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(bounds?.right ?? 220),
      clientY: Math.round(bounds?.top ?? 300)
    }));
  })()`)
  await delay(60)
  results.sidebarBranchMenu = await cdp.evaluate(`({
    visible: Boolean(document.querySelector(".version-context-menu")),
    activeView: Boolean(document.querySelector(".history-panel"))
  })`)
  assert(
    results.sidebarBranchMenu.visible && results.sidebarBranchMenu.activeView,
    'Right-clicking a sidebar branch did not open its menu or unexpectedly changed the main view'
  )
  await cdp.evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true
  }))`)
  await delay(40)

  results.resizers = await cdp.evaluate(`(() => {
    const resizers = Array.from(document.querySelectorAll(".pane-resizer"));
    const workspace = document.querySelector(".workspace");
    const before = workspace?.style.gridTemplateColumns ?? "";
    resizers[0]?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true
    }));
    return {
      count: resizers.length,
      before
    };
  })()`)
  await delay(60)
  results.resizers.after = await cdp.evaluate(`document.querySelector(".workspace")?.style.gridTemplateColumns ?? ""`)
  assert(results.resizers.count === 2, 'The three-pane workspace did not render two resizers')
  assert(results.resizers.before !== results.resizers.after, 'The keyboard did not resize the pane')

  /*
   * 分别把左右纵向分割条推过最小/最大边界，再在同一边界附近固定指针
   * 连续采样。正确的吸附只能停在单一位置；若约束计算依赖已经变化的布局
   * 作为新基准，采样会在两个相距明显的位置之间反复横跳。
   */
  const stressPaneBoundary = async (index, delta, label) => {
    const start = await cdp.evaluate(`(() => {
      const bounds = document.querySelectorAll(".pane-resizer")[${index}]
        ?.getBoundingClientRect();
      return bounds
        ? {
            x: Math.round(bounds.left + bounds.width / 2),
            y: Math.round(bounds.top + bounds.height / 2)
          }
        : null;
    })()`)
    assert(Boolean(start), `Failed to locate the vertical resizer for ${label}`)
    const targetX = start.x + delta
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: start.x,
      y: start.y,
      button: 'left',
      buttons: 1,
      clickCount: 1
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: targetX,
      y: start.y,
      button: 'left',
      buttons: 1
    })
    await delay(30)

    const samples = []
    for (let sampleIndex = 0; sampleIndex < 16; sampleIndex += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: targetX + (sampleIndex % 2),
        y: start.y,
        button: 'left',
        buttons: 1
      })
      await delay(12)
      samples.push(
        await cdp.evaluate(`(() => {
          const divider = document.querySelectorAll(".pane-resizer")[${index}];
          return {
            left: divider?.getBoundingClientRect().left ?? 0,
            value: Number(divider?.getAttribute("aria-valuenow") ?? 0)
          };
        })()`)
      )
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: targetX,
      y: start.y,
      button: 'left',
      clickCount: 1
    })
    await delay(30)
    await cdp.evaluate(
      `document.querySelectorAll(".pane-resizer")[${index}]
        ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`
    )
    await delay(30)

    const leftValues = samples.map((sample) => sample.left)
    const widthValues = samples.map((sample) => sample.value)
    const leftSpread = Math.max(...leftValues) - Math.min(...leftValues)
    const widthSpread = Math.max(...widthValues) - Math.min(...widthValues)
    return { label, leftSpread, widthSpread, samples }
  }

  results.paneBoundaryStability = [
    await stressPaneBoundary(0, -200, 'minimum sidebar width'),
    await stressPaneBoundary(0, 500, 'maximum sidebar width'),
    await stressPaneBoundary(1, -600, 'maximum inspector width'),
    await stressPaneBoundary(1, 500, 'minimum inspector width')
  ]
  assert(
    results.paneBoundaryStability.every((result) => result.leftSpread <= 1 && result.widthSpread <= 1),
    `Vertical resizers oscillate after clamping to minimum or maximum width: ${JSON.stringify(
      results.paneBoundaryStability
    )}`
  )

  /*
   * Tauri WebView 中 viewport 宽度与 workspace.clientWidth 不保证只相差固定
   * 2px。这里主动制造 20px 差值：拖动边界与偏好回读若使用两套容器基准，
   * Inspector 会在到达真实最大值后又被回写到越界值，形成实际拖动中的横跳。
   */
  await cdp.evaluate(`(() => {
    const workspace = document.querySelector(".workspace");
    if (workspace) {
      workspace.style.width = "1000px";
      workspace.style.justifySelf = "start";
    }
  })()`)
  await delay(50)
  const mismatchedBoundaryStart = await cdp.evaluate(`(() => {
    const divider = document.querySelectorAll(".pane-resizer")[1]
      ?.getBoundingClientRect();
    return divider ? {
      x: Math.round(divider.left + divider.width / 2),
      y: Math.round(divider.top + divider.height / 2)
    } : null;
  })()`)
  assert(
    mismatchedBoundaryStart,
    'Failed to locate the inspector resizer required by the container/viewport width test'
  )
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: mismatchedBoundaryStart.x,
    y: mismatchedBoundaryStart.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: mismatchedBoundaryStart.x - 800,
    y: mismatchedBoundaryStart.y,
    button: 'left',
    buttons: 1
  })
  await delay(80)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: mismatchedBoundaryStart.x - 800,
    y: mismatchedBoundaryStart.y,
    button: 'left',
    buttons: 0,
    clickCount: 1
  })
  results.paneBoundaryContainerBasis = await cdp.evaluate(`(() => {
    const workspace = document.querySelector(".workspace");
    const dividers = document.querySelectorAll(".pane-resizer");
    const sidebarWidth = Number(dividers[0]?.getAttribute("aria-valuenow") ?? 0);
    const inspectorWidth = Number(dividers[1]?.getAttribute("aria-valuenow") ?? 0);
    const containerWidth = workspace?.clientWidth ?? 0;
    return {
      viewportWidth: document.documentElement.clientWidth,
      containerWidth,
      sidebarWidth,
      inspectorWidth,
      expectedMaximum:
        containerWidth - sidebarWidth - 340 - 10
    };
  })()`)
  assert(
    results.paneBoundaryContainerBasis.inspectorWidth <= results.paneBoundaryContainerBasis.expectedMaximum,
    `The inspector boundary was rewritten using viewport width and exceeded the actual workspace maximum: ${JSON.stringify(
      results.paneBoundaryContainerBasis
    )}`
  )
  await cdp.evaluate(`(() => {
    const workspace = document.querySelector(".workspace");
    if (workspace) {
      workspace.style.removeProperty("width");
      workspace.style.removeProperty("justify-self");
    }
    document.querySelectorAll(".pane-resizer")[1]
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  })()`)
  await delay(50)

  // 动态最大宽度在窄窗口下最容易与中栏最小宽度发生约束碰撞，因此额外在
  // 项目最低验收尺寸中重复极值压力测试。测试结束后恢复真实浏览器尺寸，
  // 避免影响后续专门面向宽窗口的 Inspector 可用范围检查。
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false
  })
  await delay(60)
  results.paneBoundaryStabilityAtMinimumViewport = [
    await stressPaneBoundary(0, -200, 'minimum sidebar width at the minimum viewport'),
    await stressPaneBoundary(0, 500, 'maximum sidebar width at the minimum viewport'),
    await stressPaneBoundary(1, -600, 'maximum inspector width at the minimum viewport'),
    await stressPaneBoundary(1, 500, 'minimum inspector width at the minimum viewport')
  ]
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await delay(60)
  assert(
    results.paneBoundaryStabilityAtMinimumViewport.every((result) => result.leftSpread <= 1 && result.widthSpread <= 1),
    `Vertical resizers oscillate after boundary clamping at the minimum viewport: ${JSON.stringify(
      results.paneBoundaryStabilityAtMinimumViewport
    )}`
  )

  // 在宽窗口中真实向左拖动 Inspector 分割线，捕获固定最大宽度提前截断的问题。
  const inspectorDragStart = await cdp.evaluate(`(() => {
    const resizers = document.querySelectorAll(".pane-resizer");
    const divider = resizers[1]?.getBoundingClientRect();
    const inspector = document.querySelector(".inspector")?.getBoundingClientRect();
    const center = resizers[0] && divider
      ? {
          width:
            divider.left -
            resizers[0].getBoundingClientRect().right
        }
      : null;
    return divider && inspector && center
      ? {
          x: Math.round(divider.left + divider.width / 2),
          y: Math.round(divider.top + divider.height / 2),
          dividerLeft: divider.left,
          inspectorWidth: inspector.width,
          centerWidth: center.width
        }
      : null;
  })()`)
  assert(Boolean(inspectorDragStart), 'Failed to locate the inspector vertical resizer')
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: inspectorDragStart.x,
    y: inspectorDragStart.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  const inspectorDragSamples = []
  for (const offset of [100, 200, 300]) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: inspectorDragStart.x - offset,
      y: inspectorDragStart.y,
      button: 'left',
      buttons: 1
    })
    await delay(20)
    inspectorDragSamples.push(
      await cdp.evaluate(`document.querySelectorAll(".pane-resizer")[1]?.getBoundingClientRect().left ?? 0`)
    )
  }
  assert(
    inspectorDragSamples.every((left, index) => index === 0 || left < inspectorDragSamples[index - 1]),
    `The inspector vertical resizer was not monotonic during one-way pointer movement: ${JSON.stringify(
      inspectorDragSamples
    )}`
  )
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: inspectorDragStart.x - 300,
    y: inspectorDragStart.y,
    button: 'left',
    clickCount: 1
  })
  await delay(60)
  const inspectorDividerAfterRelease = await cdp.evaluate(
    `document.querySelectorAll(".pane-resizer")[1]?.getBoundingClientRect().left ?? 0`
  )
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: inspectorDragStart.x - 150,
    y: inspectorDragStart.y,
    button: 'none',
    buttons: 0
  })
  await delay(60)
  const inspectorDividerAfterIdleMove = await cdp.evaluate(
    `document.querySelectorAll(".pane-resizer")[1]?.getBoundingClientRect().left ?? 0`
  )
  results.inspectorResizerRelease = {
    dragSamples: inspectorDragSamples,
    afterRelease: inspectorDividerAfterRelease,
    afterIdleMove: inspectorDividerAfterIdleMove
  }
  assert(
    Math.abs(inspectorDividerAfterIdleMove - inspectorDividerAfterRelease) <= 1,
    `The inspector vertical resizer continued moving after mouse release: ${JSON.stringify(
      results.inspectorResizerRelease
    )}`
  )
  results.inspectorResizerRange = await cdp.evaluate(`(() => {
    const resizers = document.querySelectorAll(".pane-resizer");
    const divider = resizers[1]?.getBoundingClientRect();
    const inspector = document.querySelector(".inspector")?.getBoundingClientRect();
    return divider && inspector
      ? {
          dividerLeft: divider.left,
          inspectorWidth: inspector.width,
          centerWidth:
            divider.left -
            resizers[0].getBoundingClientRect().right
        }
      : null;
  })()`)
  results.inspectorResizerRange.before = inspectorDragStart
  assert(
    inspectorDragStart.dividerLeft - results.inspectorResizerRange.dividerLeft >= 270 &&
      results.inspectorResizerRange.inspectorWidth - inspectorDragStart.inspectorWidth >= 270 &&
      results.inspectorResizerRange.centerWidth >= 340,
    `Dragging the inspector resizer left was prematurely limited by a fixed width: ${JSON.stringify(
      results.inspectorResizerRange
    )}`
  )

  /*
   * Windows WebView 在组件重渲染或指针离开窗口时可能丢失 pointerup。
   * 即使释放事件缺席，下一次 buttons=0 的移动也必须结束拖动，不能继续追鼠标。
   */
  const lostReleaseStart = await cdp.evaluate(`(() => {
    const bounds = document.querySelectorAll(".pane-resizer")[1]
      ?.getBoundingClientRect();
    return bounds
      ? {
          x: Math.round(bounds.left + bounds.width / 2),
          y: Math.round(bounds.top + bounds.height / 2)
        }
      : null;
  })()`)
  assert(Boolean(lostReleaseStart), 'Failed to locate the vertical resizer required by the lost-release test')
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: lostReleaseStart.x,
    y: lostReleaseStart.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: lostReleaseStart.x + 60,
    y: lostReleaseStart.y,
    button: 'left',
    buttons: 1
  })
  await delay(30)
  const lostReleaseSettledLeft = await cdp.evaluate(
    `document.querySelectorAll(".pane-resizer")[1]?.getBoundingClientRect().left ?? 0`
  )
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: lostReleaseStart.x + 160,
    y: lostReleaseStart.y,
    button: 'none',
    buttons: 0
  })
  await delay(30)
  const lostReleaseIdleLeft = await cdp.evaluate(
    `document.querySelectorAll(".pane-resizer")[1]?.getBoundingClientRect().left ?? 0`
  )
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: lostReleaseStart.x + 160,
    y: lostReleaseStart.y,
    button: 'left',
    clickCount: 1
  })
  results.inspectorResizerLostRelease = {
    afterPressedMove: lostReleaseSettledLeft,
    afterButtonsCleared: lostReleaseIdleLeft
  }
  assert(
    Math.abs(lostReleaseIdleLeft - lostReleaseSettledLeft) <= 1,
    `The inspector vertical resizer continued following the mouse after a lost pointerup: ${JSON.stringify(
      results.inspectorResizerLostRelease
    )}`
  )
  await cdp.evaluate(
    `document.querySelectorAll(".pane-resizer")[1]
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`
  )
  await delay(40)

  await cdp.evaluate(`document.querySelector('button[aria-label="切换到浅色主题"]')?.click()`)
  await delay(60)
  results.lightTheme = await cdp.evaluate(`({
    resolved: document.documentElement.dataset.theme,
    stored: localStorage.getItem("lore-client.theme")
  })`)
  assert(results.lightTheme.resolved === 'light', 'The light theme was not applied to the document')
  assert(results.lightTheme.stored === null, 'Theme preferences must no longer be written to browser localStorage')

  await cdp.evaluate(`
    Array.from(document.querySelectorAll(".inspector-tabs button"))
      .find((button) => button.textContent.includes("变更"))
      ?.click()
  `)
  await delay(60)
  results.inspectorChanges = await cdp.evaluate(`(() => {
    const browser = document.querySelector(".revision-change-browser");
    const header = document.querySelector(".revision-change-browser__header");
    const baseline = document.querySelector(".revision-change-browser__baseline");
    const filter = document.querySelector(".revision-change-browser__filter");
    const list = document.querySelector(".revision-change-browser__list");
    const browserHeight = browser?.getBoundingClientRect().height ?? 0;
    const occupiedHeight = [header, baseline, filter].reduce(
      (total, element) => total + (element?.getBoundingClientRect().height ?? 0),
      0
    );
    const listHeight = list?.getBoundingClientRect().height ?? 0;
    return {
      visible: Boolean(document.querySelector(".revision-changes-workspace")),
      files: document.querySelectorAll(".revision-change-row.is-file").length,
      treeActive:
        document.querySelector("button[aria-label='目录树视图']")
          ?.getAttribute("aria-pressed") === "true",
      hasDiffPane: Boolean(document.querySelector(".revision-diff-pane")),
      hasBaseline: Boolean(baseline),
      browserHeight: Math.round(browserHeight),
      listHeight: Math.round(listHeight),
      remainingHeightDelta: Math.round(
        Math.abs(browserHeight - occupiedHeight - listHeight)
      ),
      storedTab: localStorage.getItem("lore-client.inspector-tab")
    };
  })()`)
  assert(results.inspectorChanges.visible, 'The inspector changes tab did not activate')
  assert(results.inspectorChanges.files >= 2, 'The inspector file list is empty')
  assert(results.inspectorChanges.treeActive, 'Revision changes did not default to tree view')
  assert(results.inspectorChanges.hasDiffPane, 'The revision diff pane was not rendered')
  assert(
    !results.inspectorChanges.hasBaseline &&
      results.inspectorChanges.listHeight >= 160 &&
      results.inspectorChanges.remainingHeightDelta <= 1,
    `Revision tree list did not fill the no-baseline browser: ${JSON.stringify(results.inspectorChanges)}`
  )
  assert(
    results.inspectorChanges.storedTab === null,
    'Inspector tab preferences must no longer be written to browser localStorage'
  )

  // Revision Diff 隐藏时只保留文件浏览器；开关仍位于页签栏，可立即恢复右侧面板。
  await cdp.evaluate(`document.querySelector('.inspector-tabs button[aria-label="隐藏 Diff 视图"]')?.click()`)
  await delay(40)
  results.revisionDiffVisibilityToggle = await cdp.evaluate(`(() => {
    const workspace = document.querySelector(".revision-changes-workspace");
    const browser = document.querySelector(".revision-change-browser");
    return {
      hidden: !document.querySelector(".revision-diff-pane"),
      resizerHidden: !document.querySelector(".revision-changes-workspace > .pane-resizer"),
      browserFillsWorkspace: Boolean(workspace && browser) &&
        Math.abs(workspace.getBoundingClientRect().width - browser.getBoundingClientRect().width) <= 1,
      restoreLabel: document.querySelector('.inspector-tabs button[aria-label="显示 Diff 视图"]')
        ?.getAttribute("aria-label") ?? ""
    };
  })()`)
  assert(
    results.revisionDiffVisibilityToggle.hidden &&
      results.revisionDiffVisibilityToggle.resizerHidden &&
      results.revisionDiffVisibilityToggle.browserFillsWorkspace &&
      results.revisionDiffVisibilityToggle.restoreLabel === '显示 Diff 视图',
    `Revision Diff visibility toggle did not release the right pane: ${JSON.stringify(
      results.revisionDiffVisibilityToggle
    )}`
  )
  await cdp.evaluate(`document.querySelector('.inspector-tabs button[aria-label="显示 Diff 视图"]')?.click()`)
  await delay(40)
  results.revisionDiffVisibilityToggle.restored = await cdp.evaluate(
    `Boolean(document.querySelector(".revision-diff-pane")) &&
      Boolean(document.querySelector(".revision-changes-workspace > .pane-resizer"))`
  )
  assert(
    results.revisionDiffVisibilityToggle.restored,
    'Revision Diff visibility toggle did not restore the right pane'
  )

  await cdp.evaluate(`(() => {
    Array.from(document.querySelectorAll(".revision-change-row.is-file"))
      .find((row) => /\\.(?:json|ini|txt|md)$/i.test(
        row.querySelector("strong")?.textContent?.trim() ?? ""
      ))?.click();
  })()`)
  await delay(40)
  results.revisionTextDiff = await cdp.evaluate(`document.querySelectorAll(".revision-diff-pane__line").length`)
  assert(results.revisionTextDiff > 0, 'The revision text file did not display a unified diff')

  /*
   * Revision Diff 标题只保留文件信息、选项和有意义的统计。单选时不再输出
   * “Revision Diff”占位文字，所有显式标题子项也必须停留在同一网格行。
   */
  results.revisionDiffHeader = await cdp.evaluate(`(() => {
    const header = document.querySelector(".revision-diff-pane__header");
    if (!(header instanceof HTMLElement)) return null;
    const childRects = Array.from(header.children).map((child) => {
      const rect = child.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    });
    return {
      text: header.textContent ?? "",
      columns: getComputedStyle(header).gridTemplateColumns.split(" ").length,
      centerSpread: Math.max(...childRects.map((rect) => (rect.top + rect.bottom) / 2)) -
        Math.min(...childRects.map((rect) => (rect.top + rect.bottom) / 2))
    };
  })()`)
  assert(
    results.revisionDiffHeader &&
      !results.revisionDiffHeader.text.includes('Revision Diff') &&
      !results.revisionDiffHeader.text.includes('修订 Diff') &&
      results.revisionDiffHeader.columns === 4 &&
      results.revisionDiffHeader.centerSpread <= 1,
    `Revision Diff header still contains a wrapped label: ${JSON.stringify(results.revisionDiffHeader)}`
  )

  /*
   * Diff 选项按钮与同列的面板显隐按钮必须保持稳定的边框盒。控制器外层只是
   * 定位容器，不能被标题栏面向“文件图标”的宽泛子元素规则误加第二层边框；
   * 否则内层按钮悬停变色时，两层不同尺寸的边框会产生明显错位。
   */
  const diffOptionsButtonCenter = await cdp.evaluate(`(() => {
    const button = document.querySelector(".revision-diff-pane .diff-options-control > button");
    const rect = button?.getBoundingClientRect();
    return rect ? {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2)
    } : null;
  })()`)
  assert(diffOptionsButtonCenter, 'Failed to locate the revision Diff options button')
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 0,
    y: 0
  })
  await delay(30)
  const readDiffOptionsGeometry = () =>
    cdp.evaluate(`(() => {
      const button = document.querySelector(".revision-diff-pane .diff-options-control > button");
      const control = button?.parentElement;
      const icon = button?.querySelector("svg");
      if (!button || !control || !icon) return null;
      const buttonRect = button.getBoundingClientRect();
      const controlRect = control.getBoundingClientRect();
      const iconRect = icon.getBoundingClientRect();
      const style = getComputedStyle(button);
      const controlStyle = getComputedStyle(control);
      return {
        control: [controlRect.left, controlRect.top, controlRect.width, controlRect.height],
        button: [buttonRect.left, buttonRect.top, buttonRect.width, buttonRect.height],
        icon: [iconRect.left, iconRect.top, iconRect.width, iconRect.height],
        controlBorderWidths: [
          controlStyle.borderTopWidth,
          controlStyle.borderRightWidth,
          controlStyle.borderBottomWidth,
          controlStyle.borderLeftWidth
        ],
        borderWidths: [
          style.borderTopWidth,
          style.borderRightWidth,
          style.borderBottomWidth,
          style.borderLeftWidth
        ]
      };
    })()`)
  const diffOptionsBeforeHover = await readDiffOptionsGeometry()
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: diffOptionsButtonCenter.x,
    y: diffOptionsButtonCenter.y
  })
  await delay(30)
  const diffOptionsAfterHover = await readDiffOptionsGeometry()
  results.diffOptionsHoverStability = {
    before: diffOptionsBeforeHover,
    after: diffOptionsAfterHover
  }
  assert(
    diffOptionsBeforeHover &&
      diffOptionsAfterHover &&
      diffOptionsBeforeHover.controlBorderWidths.every((width) => width === '0px') &&
      diffOptionsAfterHover.controlBorderWidths.every((width) => width === '0px') &&
      JSON.stringify(diffOptionsBeforeHover.control) === JSON.stringify(diffOptionsAfterHover.control) &&
      JSON.stringify(diffOptionsBeforeHover.button) === JSON.stringify(diffOptionsAfterHover.button) &&
      JSON.stringify(diffOptionsBeforeHover.icon) === JSON.stringify(diffOptionsAfterHover.icon) &&
      JSON.stringify(diffOptionsBeforeHover.borderWidths) === JSON.stringify(diffOptionsAfterHover.borderWidths),
    `The Diff options button border or geometry moved on hover: ${JSON.stringify(results.diffOptionsHoverStability)}`
  )
  /*
   * Diff 选项同样是临时浮层。打开后点击左侧文件列表，浮层与入口的展开态
   * 必须同步清除，不能把过期面板留在 Diff 内容上方。
   */
  await cdp.evaluate(`document.querySelector(".revision-diff-pane .diff-options-control > button")?.click()`)
  await delay(40)
  /*
   * 历史筛选与 Diff 选项位于不同弹层，仍必须消费同一个 CheckboxInput。
   * 比较浏览器最终计算出的尺寸与外观，可防止任一面板重新引入原生方框或局部尺寸覆盖。
   */
  results.crossPanelCheckboxStyle = await cdp.evaluate(`(() => {
    const checkbox = document.querySelector(
      '.revision-diff-pane .diff-options-control__popover input[type="checkbox"]'
    );
    if (!(checkbox instanceof HTMLInputElement)) return null;
    const style = getComputedStyle(checkbox);
    return {
      usesSharedPrimitive: checkbox.classList.contains("control-checkbox"),
      baseGeometry: {
        width: style.width,
        minWidth: style.minWidth,
        height: style.height,
        minHeight: style.minHeight,
        borderWidth: style.borderTopWidth,
        borderRadius: style.borderRadius,
        padding: style.padding,
        appearance: style.appearance
      }
    };
  })()`)
  assert(
    results.crossPanelCheckboxStyle?.usesSharedPrimitive &&
      JSON.stringify(results.crossPanelCheckboxStyle?.baseGeometry) ===
        JSON.stringify(results.focusVisibleControlBorders?.checkbox.baseGeometry),
    `Checkbox styles diverged between History and Diff panels: ${JSON.stringify({
      history: results.focusVisibleControlBorders?.checkbox,
      diff: results.crossPanelCheckboxStyle
    })}`
  )
  const diffOptionsOutsidePoint = await cdp.evaluate(`(() => {
    const rect = document.querySelector(".revision-change-browser")?.getBoundingClientRect();
    return rect ? {
      x: Math.round(rect.left + Math.min(24, rect.width / 2)),
      y: Math.round(rect.top + Math.min(80, rect.height / 2))
    } : null;
  })()`)
  assert(diffOptionsOutsidePoint, 'Failed to locate an outside point for the Diff-options popover')
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: diffOptionsOutsidePoint.x,
    y: diffOptionsOutsidePoint.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: diffOptionsOutsidePoint.x,
    y: diffOptionsOutsidePoint.y,
    button: 'left',
    buttons: 0,
    clickCount: 1
  })
  await delay(40)
  results.diffOptionsOutsideDismiss = await cdp.evaluate(`({
    popoverVisible: Boolean(
      document.querySelector(".revision-diff-pane .diff-options-control__popover")
    ),
    expanded:
      document.querySelector(".revision-diff-pane .diff-options-control > button")
        ?.getAttribute("aria-expanded") === "true"
  })`)
  assert(
    !results.diffOptionsOutsideDismiss.popoverVisible && !results.diffOptionsOutsideDismiss.expanded,
    `The Diff-options popover stayed open after an outside click: ${JSON.stringify(results.diffOptionsOutsideDismiss)}`
  )

  // 切换 Revision 只能更新内容，不能把用户选择的 Inspector Tab 重置为概览。
  await cdp.evaluate(`document.querySelectorAll(".revision-row")[1]?.click()`)
  await delay(60)
  results.inspectorTabPersistence = await cdp.evaluate(`({
    changesActive: Array.from(document.querySelectorAll(".inspector-tabs button"))
      .find((button) => button.textContent?.includes("变更"))
      ?.classList.contains("is-active") ?? false,
    workspaceVisible: Boolean(
      document.querySelector(".revision-changes-workspace")
    ),
    stored: localStorage.getItem("lore-client.inspector-tab")
  })`)
  assert(
    results.inspectorTabPersistence.changesActive &&
      results.inspectorTabPersistence.workspaceVisible &&
      results.inspectorTabPersistence.stored === null,
    `The inspector tab was reset after switching revisions: ${JSON.stringify(results.inspectorTabPersistence)}`
  )
  await cdp.evaluate(`document.querySelectorAll(".revision-row")[0]?.click()`)
  await delay(60)

  // 目录对象可独立多选，不能自动高亮父目录、子目录或后代文件。
  await cdp.evaluate(`(() => {
    Array.from(document.querySelectorAll(".revision-change-row.is-directory"))
      .find((row) =>
        row.querySelector("strong")?.textContent?.trim() === "Content"
      )?.click();
  })()`)
  await delay(40)
  await cdp.evaluate(`(() => {
    Array.from(document.querySelectorAll(".revision-change-row.is-directory"))
      .find((row) =>
        row.querySelector("strong")?.textContent?.trim() === "Config"
      )?.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true
      }));
  })()`)
  await delay(50)
  results.revisionFolderSelection = await cdp.evaluate(`({
    directories:
      document.querySelectorAll(
        ".revision-change-row.is-directory.is-selected"
      ).length,
    files:
      document.querySelectorAll(
        ".revision-change-row.is-file.is-selected"
      ).length,
    folderEmpty: Boolean(
      document.querySelector(".revision-diff-pane__empty")
    )
  })`)
  assert(
    results.revisionFolderSelection.directories === 2 &&
      results.revisionFolderSelection.files === 0 &&
      results.revisionFolderSelection.folderEmpty,
    `Revision directory selection incorrectly propagated between parents and children: ${JSON.stringify(
      results.revisionFolderSelection
    )}`
  )

  // 平铺视图会把目录操作范围转换为可见文件对象，再验证文件连续多选。
  await cdp.evaluate(`document.querySelector("button[aria-label='平铺视图']")?.click()`)
  await delay(50)
  results.revisionFlatView = await cdp.evaluate(`({
    flatActive:
      document.querySelector("button[aria-label='平铺视图']")
        ?.getAttribute("aria-pressed") === "true",
    directories:
      document.querySelectorAll(".revision-change-row.is-directory").length,
    files: document.querySelectorAll(".revision-change-row.is-file").length,
    listHeight: Math.round(
      document.querySelector(".revision-change-browser__list")
        ?.getBoundingClientRect().height ?? 0
    )
  })`)
  assert(
    results.revisionFlatView.flatActive &&
      results.revisionFlatView.directories === 0 &&
      results.revisionFlatView.files >= 4 &&
      Math.abs(results.revisionFlatView.listHeight - results.inspectorChanges.listHeight) <= 1,
    `The revision flat view is invalid: ${JSON.stringify(results.revisionFlatView)}`
  )

  // 先用 Ctrl 增选，再用 Shift 从最新锚点连续选择，验证桌面列表的多选语义。
  await cdp.evaluate(`(() => {
    document.querySelectorAll(".revision-change-row.is-file")[0]?.click();
  })()`)
  await delay(30)
  await cdp.evaluate(`(() => {
    const rows = Array.from(
      document.querySelectorAll(".revision-change-row.is-file")
    );
    rows[1]?.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      ctrlKey: true
    }));
  })()`)
  await delay(30)
  await cdp.evaluate(`(() => {
    const rows = Array.from(
      document.querySelectorAll(".revision-change-row.is-file")
    );
    rows[3]?.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      shiftKey: true
    }));
  })()`)
  await delay(60)
  results.revisionFileSelection = await cdp.evaluate(`({
    selected:
      document.querySelectorAll(
        ".revision-change-row.is-file.is-selected"
      ).length,
    primary:
      document.querySelectorAll(
        ".revision-change-row.is-file.is-primary"
      ).length,
    badge:
      document.querySelector(".revision-change-browser__header")
        ?.textContent?.replace(/\\s+/g, " ").trim() ?? ""
  })`)
  assert(
    results.revisionFileSelection.selected === 3 &&
      results.revisionFileSelection.primary === 1 &&
      results.revisionFileSelection.badge.includes('已选 3'),
    `Revision file range selection is invalid: ${JSON.stringify(results.revisionFileSelection)}`
  )

  // 在视口右下角触发菜单，覆盖主菜单越界避让、子菜单、真实动作入口与文件树定位。
  await cdp.evaluate(`(() => {
    const row = document.querySelectorAll(".revision-change-row.is-file")[2];
    window.__revisionFileTreeTargetName =
      row?.querySelector("strong")?.textContent?.trim() ?? "";
    row?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: window.innerWidth - 2,
      clientY: window.innerHeight - 2
    }));
  })()`)
  await delay(80)
  results.revisionFileMenu = await cdp.evaluate(`(() => {
    const menu = document.querySelector(".revision-file-menu:not(.revision-file-menu--submenu)");
    if (!menu) return { visible: false };
    const bounds = menu.getBoundingClientRect();
    return {
      visible: true,
      labels: Array.from(menu.querySelectorAll(":scope > button"))
        .map((button) => button.textContent?.replace(/\\s+/g, " ").trim()),
      selectedCount:
        document.querySelectorAll(
          ".revision-change-row.is-file.is-selected"
        ).length,
      expectedPrimaryName: window.__revisionFileTreeTargetName ?? "",
      actualPrimaryName:
        document.querySelector(".revision-change-row.is-file.is-primary strong")
          ?.textContent?.trim() ?? "",
      withinViewport:
        bounds.left >= 0 &&
        bounds.top >= 0 &&
        bounds.right <= window.innerWidth &&
        bounds.bottom <= window.innerHeight
    };
  })()`)
  assert(results.revisionFileMenu.visible, 'The revision file context menu did not open')
  assert(
    results.revisionFileMenu.selectedCount === 3,
    'Right-clicking selected files incorrectly cleared the multi-selection'
  )
  assert(
    results.revisionFileMenu.actualPrimaryName === results.revisionFileMenu.expectedPrimaryName,
    `Right-clicking a selected non-primary file did not make the context target visually primary: ${JSON.stringify(
      results.revisionFileMenu
    )}`
  )
  assert(results.revisionFileMenu.withinViewport, 'The revision file context menu extends beyond the viewport')
  for (const label of [
    '打开主要文件的变更',
    '在文件树中显示 3 个文件',
    '主要文件的文件历史',
    '在文件资源管理器中显示主要文件',
    '还原 3 个文件到',
    '复制 3 条相对路径',
    '复制 3 条完整路径'
  ]) {
    assert(
      results.revisionFileMenu.labels.some((text) => text?.includes(label)),
      `The revision file menu is missing "${label}"`
    )
  }
  assert(
    !results.revisionFileMenu.labels.some((text) => text?.includes('外部 Diff')),
    'Browser demo exposed an External Diff tool that was not found on the system'
  )

  await cdp.evaluate(`(() => {
    const trigger = Array.from(
      document.querySelectorAll(".revision-file-menu:not(.revision-file-menu--submenu) > button")
    ).find((button) => button.textContent?.includes("还原"));
    trigger?.focus();
    trigger?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true
    }));
  })()`)
  await delay(80)
  results.revisionFileSubmenu = await cdp.evaluate(`(() => {
    const submenu = document.querySelector(".revision-file-menu--submenu");
    if (!submenu) return { visible: false };
    const bounds = submenu.getBoundingClientRect();
    return {
      visible: true,
      labels: Array.from(submenu.querySelectorAll(":scope > button"))
        .map((button) => button.textContent?.replace(/\\s+/g, " ").trim()),
      withinViewport:
        bounds.left >= 0 &&
        bounds.top >= 0 &&
        bounds.right <= window.innerWidth &&
        bounds.bottom <= window.innerHeight
    };
  })()`)
  assert(results.revisionFileSubmenu.visible, 'The file restore submenu did not open from the keyboard')
  assert(results.revisionFileSubmenu.withinViewport, 'The file restore submenu extends beyond the viewport')
  assert(
    results.revisionFileSubmenu.labels.some((text) => text?.includes('当前修订状态')) &&
      results.revisionFileSubmenu.labels.some((text) => text?.includes('父修订状态')),
    'The file restore submenu has incomplete targets'
  )

  await cdp.evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true
  }))`)
  await delay(50)
  assert(
    !(await cdp.evaluate(`Boolean(document.querySelector(".revision-file-menu"))`)),
    'Escape did not close the revision file menu'
  )

  await cdp.evaluate(`(() => {
    const row = document.querySelectorAll(".revision-change-row.is-file")[2];
    window.__revisionFileTreeTargetName =
      row?.querySelector("strong")?.textContent?.trim() ?? "";
    row?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 480,
      clientY: 300
    }));
  })()`)
  await delay(50)
  await cdp.evaluate(`Array.from(
    document.querySelectorAll(".revision-file-menu:not(.revision-file-menu--submenu) > button")
  ).find((button) => button.textContent?.includes("在文件树中显示"))?.click()`)
  await delay(80)
  results.revisionFileTreeLocate = await cdp.evaluate(`(() => {
    const primaryRow = document.querySelector(
      ".file-tree__row.is-file.is-primary-selected"
    );
    return {
      treeVisible: Boolean(document.querySelector(".file-tree-tab")),
      inspectorTabs: document.querySelectorAll(".inspector-tabs button").length,
      selectedRows:
        document.querySelectorAll(
          ".file-tree__row.is-file.is-selected"
        ).length,
      primaryRows:
        document.querySelectorAll(
          ".file-tree__row.is-file.is-primary-selected"
        ).length,
      expectedPrimaryName: window.__revisionFileTreeTargetName ?? "",
      actualPrimaryName: primaryRow?.querySelector("strong")?.textContent?.trim() ?? ""
    };
  })()`)
  assert(
    results.revisionFileTreeLocate.treeVisible &&
      results.revisionFileTreeLocate.inspectorTabs === 3 &&
      results.revisionFileTreeLocate.selectedRows === 3 &&
      results.revisionFileTreeLocate.primaryRows === 1 &&
      results.revisionFileTreeLocate.actualPrimaryName === results.revisionFileTreeLocate.expectedPrimaryName,
    `The context menu did not preserve the exact primary file in the standalone revision file tree: ${JSON.stringify(
      results.revisionFileTreeLocate
    )}`
  )

  // 独立文件树里的文件也必须复用同一套菜单能力；历史查询从当前 Revision
  // 开始，不能退回当前工作区分支的最新 Revision。
  await cdp.evaluate(`(() => {
    const row = document.querySelector(".file-tree__row.is-file.is-primary-selected");
    const bounds = row?.getBoundingClientRect();
    row?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(bounds?.right ?? 800),
      clientY: Math.round(bounds?.bottom ?? 260)
    }));
  })()`)
  await delay(70)
  results.revisionFileTreeMenu = await cdp.evaluate(`(() => {
    const menu = document.querySelector(".revision-file-menu:not(.revision-file-menu--submenu)");
    const labels = Array.from(menu?.querySelectorAll(":scope > button") ?? [])
      .map((button) => button.textContent?.replace(/\\s+/g, " ").trim());
    return {
      visible: Boolean(menu),
      labels,
      hasHistory: labels.some((text) => text?.includes("文件历史")),
      hasReset: labels.some((text) => text?.includes("还原"))
    };
  })()`)
  assert(
    results.revisionFileTreeMenu.visible &&
      results.revisionFileTreeMenu.hasHistory &&
      results.revisionFileTreeMenu.hasReset,
    `The revision file-tree menu is incomplete: ${JSON.stringify(results.revisionFileTreeMenu)}`
  )
  await cdp.evaluate(`Array.from(
    document.querySelectorAll(".revision-file-menu:not(.revision-file-menu--submenu) > button")
  ).find((button) => button.textContent?.includes("文件历史"))?.click()`)
  await delay(70)
  results.revisionFileHistory = await cdp.evaluate(`({
    visible: Boolean(document.querySelector(".file-history-dialog")),
    rows: document.querySelectorAll(".file-history-row").length,
    path:
      document.querySelector(".file-history-dialog__path small")
        ?.textContent?.trim() ?? ""
  })`)
  assert(
    results.revisionFileHistory.visible &&
      results.revisionFileHistory.rows > 0 &&
      results.revisionFileHistory.path.length > 0,
    `The revision file-history dialog is invalid: ${JSON.stringify(results.revisionFileHistory)}`
  )
  await cdp.evaluate(`document.querySelector(".file-history-dialog button[aria-label='关闭文件历史']")?.click()`)
  await delay(50)

  await cdp.evaluate(`document.querySelector(".file-tree__row.is-file.is-primary-selected")
    ?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "a",
      ctrlKey: true,
      bubbles: true
    }))`)
  await delay(50)
  results.revisionFileSelectAll = await cdp.evaluate(`({
    selectedRows:
      document.querySelectorAll(
        ".file-tree__row.is-file.is-selected"
      ).length,
    totalRows:
      document.querySelectorAll(".file-tree__row.is-file").length
  })`)
  assert(
    results.revisionFileSelectAll.selectedRows === results.revisionFileSelectAll.totalRows,
    'Ctrl+A did not select all changed files in the current revision'
  )

  // 独立文件树定位验证完成后回到变更工作区，继续检查文件/Diff 分割线。
  await cdp.evaluate(`
    Array.from(document.querySelectorAll(".inspector-tabs button"))
      .find((button) => button.textContent.includes("变更"))
      ?.click()
  `)
  await delay(50)
  await cdp.evaluate(`document.querySelector("button[aria-label='目录树视图']")?.click()`)
  await delay(30)

  // Revision 文件列表与 Diff 之间使用同款无手柄分割线，并持久化拖动宽度。
  const revisionSeparator = await cdp.evaluate(`(() => {
    const separator = document.querySelector(
      '[aria-label="调整 Revision 文件列表宽度"]'
    );
    const browser = document.querySelector(".revision-change-browser");
    const bounds = separator?.getBoundingClientRect();
    return bounds && browser ? {
      x: Math.round(bounds.left + bounds.width / 2),
      y: Math.round(bounds.top + Math.min(120, bounds.height / 2)),
      width: Math.round(browser.getBoundingClientRect().width),
      hasHandle: Boolean(separator.querySelector("svg"))
    } : null;
  })()`)
  assert(
    revisionSeparator && !revisionSeparator.hasHandle,
    `The revision vertical resizer is missing or still has a visible handle: ${JSON.stringify(revisionSeparator)}`
  )
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: revisionSeparator.x,
    y: revisionSeparator.y,
    button: 'left',
    clickCount: 1
  })
  const revisionSplitSamples = []
  for (const offset of [12, 24, 36]) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: revisionSeparator.x + offset,
      y: revisionSeparator.y,
      button: 'left',
      buttons: 1
    })
    await delay(20)
    revisionSplitSamples.push(
      await cdp.evaluate(`document.querySelector(".revision-change-browser")?.getBoundingClientRect().width ?? 0`)
    )
  }
  assert(
    revisionSplitSamples.at(-1) > revisionSplitSamples[0] &&
      revisionSplitSamples.every((width, index) => index === 0 || width >= revisionSplitSamples[index - 1] - 1),
    `The revision file/diff resizer was not monotonic during one-way pointer movement: ${JSON.stringify(
      revisionSplitSamples
    )}`
  )
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: revisionSeparator.x + 36,
    y: revisionSeparator.y,
    button: 'left',
    clickCount: 1
  })
  await delay(50)
  const revisionSplitWidthAfterRelease = await cdp.evaluate(
    `document.querySelector(".revision-change-browser")?.getBoundingClientRect().width ?? 0`
  )
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: revisionSeparator.x - 20,
    y: revisionSeparator.y,
    button: 'none',
    buttons: 0
  })
  await delay(50)
  const revisionSplitWidthAfterIdleMove = await cdp.evaluate(
    `document.querySelector(".revision-change-browser")?.getBoundingClientRect().width ?? 0`
  )
  results.revisionChangeSplit = await cdp.evaluate(`({
    width: Math.round(
      document.querySelector(".revision-change-browser")
        ?.getBoundingClientRect().width ?? 0
    ),
    stored:
      Number(
        localStorage.getItem(
          "lore-client.revision-changes-browser-width"
        )
      ),
    handleCount:
      document.querySelectorAll(
        '[aria-label="调整 Revision 文件列表宽度"] svg'
      ).length
  })`)
  results.revisionChangeSplit.dragSamples = revisionSplitSamples
  results.revisionChangeSplit.widthAfterRelease = revisionSplitWidthAfterRelease
  results.revisionChangeSplit.widthAfterIdleMove = revisionSplitWidthAfterIdleMove
  assert(
    results.revisionChangeSplit.width > revisionSeparator.width &&
      results.revisionChangeSplit.stored === 0 &&
      results.revisionChangeSplit.handleCount === 0 &&
      Math.abs(results.revisionChangeSplit.widthAfterIdleMove - results.revisionChangeSplit.widthAfterRelease) <= 1,
    `Dragging the revision file/diff resizer produced an invalid result: ${JSON.stringify(results.revisionChangeSplit)}`
  )

  // 持续把指针压在 Revision 文件列表的最小/最大边界外，确认边界钳制后不会
  // 因容器宽度、ResizeObserver 或持久化状态的反馈而在两个宽度之间反复横跳。
  const stressRevisionBoundary = async (delta, label) => {
    const start = await cdp.evaluate(`(() => {
      const separator = document.querySelector(
        '[aria-label="调整 Revision 文件列表宽度"]'
      );
      const bounds = separator?.getBoundingClientRect();
      return bounds ? {
        x: Math.round(bounds.left + bounds.width / 2),
        y: Math.round(bounds.top + Math.min(120, bounds.height / 2))
      } : null;
    })()`)
    assert(start, `Failed to locate the revision resizer for ${label}`)

    const targetX = start.x + delta
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: start.x,
      y: start.y,
      button: 'left',
      buttons: 1,
      clickCount: 1
    })

    const samples = []
    for (let index = 0; index < 16; index += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: targetX + (index % 2),
        y: start.y,
        button: 'left',
        buttons: 1
      })
      await delay(20)
      samples.push(
        await cdp.evaluate(`(() => {
          const browser = document.querySelector(".revision-change-browser");
          const separator = document.querySelector(
            '[aria-label="调整 Revision 文件列表宽度"]'
          );
          return {
            width: Math.round(browser?.getBoundingClientRect().width ?? 0),
            left: Math.round(separator?.getBoundingClientRect().left ?? 0),
            value: Number(separator?.getAttribute("aria-valuenow") ?? 0)
          };
        })()`)
      )
    }

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: targetX,
      y: start.y,
      button: 'left',
      buttons: 0,
      clickCount: 1
    })

    const widths = samples.map((sample) => sample.width)
    const lefts = samples.map((sample) => sample.left)
    const containment = await cdp.evaluate(`(() => {
      const browser = document.querySelector(".revision-change-browser");
      const header = document.querySelector(".revision-change-browser__header");
      const modes = document.querySelector(".revision-change-browser__modes");
      const title = header?.querySelector("strong");
      if (!browser || !header || !modes || !title) return null;
      /*
       * 用户截图来自英文界面，而中文标题的较短固有宽度不会稳定触发问题。
       * 在最小边界采样期间使用真实英文资源文本，确保回归覆盖同一布局压力。
       */
      const originalTitle = title.textContent;
      if (${JSON.stringify(label.startsWith('minimum'))}) {
        title.textContent = "Changed files";
      }
      const browserBounds = browser.getBoundingClientRect();
      const headerBounds = header.getBoundingClientRect();
      const modesBounds = modes.getBoundingClientRect();
      const browserStyle = getComputedStyle(browser);
      const headerStyle = getComputedStyle(header);
      const buttonBounds = Array.from(modes.querySelectorAll("button")).map((button) => {
        const bounds = button.getBoundingClientRect();
        return {
          left: Math.round(bounds.left),
          right: Math.round(bounds.right),
          width: Math.round(bounds.width)
        };
      });
      const result = {
        browserWidth: Math.round(browserBounds.width),
        browserRight: Math.round(browserBounds.right),
        headerRight: Math.round(headerBounds.right),
        modesRight: Math.round(modesBounds.right),
        browserOverflowX: browserStyle.overflowX,
        headerOverflowX: headerStyle.overflowX,
        buttonBounds,
        scrollWidth: browser.scrollWidth,
        clientWidth: browser.clientWidth,
        contained:
          headerBounds.right <= browserBounds.right + 0.5 &&
          modesBounds.right <= browserBounds.right + 0.5 &&
          buttonBounds.length === 4 &&
          buttonBounds.every((bounds) => bounds.right <= browserBounds.right + 0.5) &&
          browser.scrollWidth <= browser.clientWidth &&
          browserStyle.overflowX === "hidden" &&
          headerStyle.overflowX === "hidden"
      };
      title.textContent = originalTitle;
      return result;
    })()`)
    const result = {
      label,
      widthSpread: Math.max(...widths) - Math.min(...widths),
      leftSpread: Math.max(...lefts) - Math.min(...lefts),
      containment,
      samples
    }

    // 每轮恢复默认值，确保另一个边界从相同状态开始，避免前一轮状态污染结论。
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Math.round(samples.at(-1).left + 2),
      y: start.y,
      button: 'left',
      buttons: 1,
      clickCount: 2
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(samples.at(-1).left + 2),
      y: start.y,
      button: 'left',
      buttons: 0,
      clickCount: 2
    })
    await delay(30)

    return result
  }

  results.revisionChangeBoundaryStability = [
    await stressRevisionBoundary(-800, 'minimum revision file-list width'),
    await stressRevisionBoundary(800, 'maximum revision file-list width')
  ]
  assert(
    results.revisionChangeBoundaryStability.every(({ widthSpread, leftSpread }) => widthSpread <= 1 && leftSpread <= 1),
    `The revision file/diff resizer oscillates after clamping to minimum or maximum width: ${JSON.stringify(
      results.revisionChangeBoundaryStability
    )}`
  )
  assert(
    results.revisionChangeBoundaryStability[0].containment?.contained,
    `The compressed revision file browser crosses into the Diff pane: ${JSON.stringify(
      results.revisionChangeBoundaryStability[0]
    )}`
  )

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false
  })
  await delay(60)
  results.revisionChangeBoundaryStabilityAtMinimumViewport = [
    await stressRevisionBoundary(-800, 'minimum revision file-list width at the minimum viewport'),
    await stressRevisionBoundary(800, 'maximum revision file-list width at the minimum viewport')
  ]
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await delay(60)
  assert(
    results.revisionChangeBoundaryStabilityAtMinimumViewport.every(
      ({ widthSpread, leftSpread }) => widthSpread <= 1 && leftSpread <= 1
    ),
    `The revision file/diff resizer oscillates after boundary clamping at the minimum viewport: ${JSON.stringify(
      results.revisionChangeBoundaryStabilityAtMinimumViewport
    )}`
  )

  await cdp.evaluate(`
    Array.from(document.querySelectorAll(".sidebar__primary button"))
      .find((button) => button.textContent.includes("本地更改"))
      ?.click()
  `)
  await delay(60)

  // Fork 式变更工作区默认显示树视图，右侧应立即呈现主选中文本文件的真实补丁。
  results.localChangesInitial = await cdp.evaluate(`({
    treeActive:
      document.querySelector("button[aria-label='目录树视图']")
        ?.getAttribute("aria-pressed") === "true",
    directoryRows: document.querySelectorAll(".change-directory-row").length,
    fileRows: document.querySelectorAll(".change-file-row").length,
    selectedRows:
      document.querySelectorAll(".change-file-row.is-selected").length,
    hasWorkingDiff: Boolean(document.querySelector(".working-diff")),
    hasOldInspector: Boolean(document.querySelector(".inspector")),
    diffLines: document.querySelectorAll(".working-diff__line").length
  })`)
  assert(
    results.localChangesInitial.treeActive &&
      results.localChangesInitial.directoryRows > 0 &&
      results.localChangesInitial.fileRows > 0 &&
      results.localChangesInitial.selectedRows === 1 &&
      results.localChangesInitial.hasWorkingDiff &&
      !results.localChangesInitial.hasOldInspector &&
      results.localChangesInitial.diffLines > 0,
    `The initial local-changes workspace is invalid: ${JSON.stringify(results.localChangesInitial)}`
  )

  /*
   * Old Lines / New Lines 使用双轴居中，避免窄列中的两行文字贴住左上角；
   * Content 列继续保持左对齐，不改变代码正文的阅读起点。
   */
  results.localDiffColumnHeadingAlignment = await cdp.evaluate(`(() => {
    const headings = Array.from(document.querySelectorAll(".working-diff__columns > span"));
    return headings.map((heading) => {
      const style = getComputedStyle(heading);
      return {
        text: heading.textContent?.trim() ?? "",
        display: style.display,
        alignItems: style.alignItems,
        justifyItems: style.justifyItems,
        textAlign: style.textAlign
      };
    });
  })()`)
  assert(
    results.localDiffColumnHeadingAlignment.length === 3 &&
      results.localDiffColumnHeadingAlignment
        .slice(0, 2)
        .every(
          (heading) =>
            heading.display === 'grid' &&
            heading.alignItems === 'center' &&
            heading.justifyItems === 'center' &&
            heading.textAlign === 'center'
        ) &&
      results.localDiffColumnHeadingAlignment[2]?.textAlign === 'start',
    `Local Diff line headings are not centered independently: ${JSON.stringify(
      results.localDiffColumnHeadingAlignment
    )}`
  )

  /*
   * 二进制 Diff 开关由两个 Diff 面板共享。关闭后选择真实二进制文件时必须
   * 显示明确的隐藏状态，且不能继续挂载预览组件；随后恢复默认值供后续验收。
   */
  await cdp.evaluate(`document.querySelector(".working-diff .diff-options-control > button")?.click()`)
  await delay(30)
  results.binaryDiffToggle = await cdp.evaluate(`(() => {
    const label = Array.from(
      document.querySelectorAll(".working-diff .diff-options-control__popover label")
    ).find((candidate) => candidate.textContent?.includes("显示二进制 Diff"));
    const checkbox = label?.querySelector('input[type="checkbox"]');
    if (!(checkbox instanceof HTMLInputElement)) return { found: false };
    const initiallyChecked = checkbox.checked;
    if (checkbox.checked) checkbox.click();
    return {
      found: true,
      initiallyChecked,
      checkedAfterDisable: checkbox.checked
    };
  })()`)
  assert(
    results.binaryDiffToggle.found &&
      results.binaryDiffToggle.initiallyChecked &&
      !results.binaryDiffToggle.checkedAfterDisable,
    `Binary Diff toggle was not available or did not disable: ${JSON.stringify(results.binaryDiffToggle)}`
  )
  await cdp.evaluate(`(() => {
    Array.from(document.querySelectorAll(".change-file-row"))
      .find((row) => row.textContent?.includes(".uasset"))?.click();
  })()`)
  await delay(40)
  results.binaryDiffToggle.hiddenState = await cdp.evaluate(`({
    title: document.querySelector(".working-diff__empty strong")?.textContent?.trim() ?? "",
    previewMounted: Boolean(document.querySelector(".working-diff .binary-diff-preview"))
  })`)
  assert(
    results.binaryDiffToggle.hiddenState.title === '二进制 Diff 已隐藏' &&
      !results.binaryDiffToggle.hiddenState.previewMounted,
    `Binary Diff content remained visible after disabling it: ${JSON.stringify(results.binaryDiffToggle)}`
  )
  await cdp.evaluate(`document.querySelector(".working-diff .diff-options-control > button")?.click()`)
  await delay(30)
  await cdp.evaluate(`(() => {
    const label = Array.from(
      document.querySelectorAll(".working-diff .diff-options-control__popover label")
    ).find((candidate) => candidate.textContent?.includes("显示二进制 Diff"));
    const checkbox = label?.querySelector('input[type="checkbox"]');
    if (checkbox instanceof HTMLInputElement && !checkbox.checked) checkbox.click();
  })()`)
  await cdp.evaluate(`(() => {
    Array.from(document.querySelectorAll(".change-file-row"))
      .find((row) => /\\.(?:json|ini|txt|md)$/i.test(
        row.querySelector("strong")?.textContent?.trim() ?? ""
      ))?.click();
  })()`)
  await delay(40)

  /*
   * 外部打开与保存补丁统一由本地更改右键菜单承接，Diff 标题不得再渲染
   * 对应按钮；这同时避免窄面板把多余的第 5 个网格子项排到第二行。
   */
  results.localDiffHeaderActions = await cdp.evaluate(`(() => {
    const header = document.querySelector(".working-diff__header");
    const labels = Array.from(header?.querySelectorAll("button") ?? [])
      .map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "");
    return {
      headerFound: Boolean(header),
      labels,
      hasPatchActionGroup: Boolean(header?.querySelector(".working-diff__actions")),
      hasExternalOpen: labels.includes("在外部应用中打开补丁"),
      hasSavePatch: labels.includes("保存 unified patch")
    };
  })()`)
  assert(
    results.localDiffHeaderActions.headerFound &&
      !results.localDiffHeaderActions.hasPatchActionGroup &&
      !results.localDiffHeaderActions.hasExternalOpen &&
      !results.localDiffHeaderActions.hasSavePatch,
    `Local Diff header still exposes patch actions: ${JSON.stringify(results.localDiffHeaderActions)}`
  )

  /*
   * 展开/收起按钮的 SVG 必须以无内边距的块级图标居中。只写 place-items
   * 会继续受到浏览器原生按钮 padding 与行盒基线影响，肉眼会看到图标偏心。
   */
  results.localChangeBulkIconAlignment = await cdp.evaluate(`(() => {
    const labels = ["展开全部本地更改文件夹", "收起全部本地更改文件夹"];
    return labels.map((label) => {
      const button = document.querySelector(
        '.change-view-switch button[aria-label="' + label + '"]'
      );
      const icon = button?.querySelector("svg");
      if (!button || !icon) return { label, found: false };
      const buttonRect = button.getBoundingClientRect();
      const iconRect = icon.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        label,
        found: true,
        deltaX: Math.abs(
          buttonRect.left + buttonRect.width / 2 -
            (iconRect.left + iconRect.width / 2)
        ),
        deltaY: Math.abs(
          buttonRect.top + buttonRect.height / 2 -
            (iconRect.top + iconRect.height / 2)
        ),
        padding: [
          style.paddingTop,
          style.paddingRight,
          style.paddingBottom,
          style.paddingLeft
        ],
        iconDisplay: getComputedStyle(icon).display
      };
    });
  })()`)
  assert(
    results.localChangeBulkIconAlignment.length === 2 &&
      results.localChangeBulkIconAlignment.every(
        (item) =>
          item.found &&
          item.deltaX <= 0.5 &&
          item.deltaY <= 0.5 &&
          item.padding.every((value) => value === '0px') &&
          item.iconDisplay === 'block'
      ),
    `Local-change bulk folder icons are not centered: ${JSON.stringify(results.localChangeBulkIconAlignment)}`
  )

  /*
   * 用真实生产 CSS 构造单版本 CSV / 模型预览壳层，直接测量根预览、卡片、
   * 具体 Viewer 与各自 parent 的边界。单版本预览不得再保留 8px 外圈留白。
   */
  results.binaryPreviewParentFill = await cdp.evaluate(`(() => {
    const edgeDeltas = (child, parent) => {
      const childRect = child.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      return {
        left: Math.abs(childRect.left - parentRect.left),
        top: Math.abs(childRect.top - parentRect.top),
        right: Math.abs(childRect.right - parentRect.right),
        bottom: Math.abs(childRect.bottom - parentRect.bottom)
      };
    };
    const measure = (kind) => {
      const fixture = document.createElement("section");
      fixture.className = "working-diff";
      fixture.style.cssText =
        "position:fixed;left:-2000px;top:0;width:520px;height:420px;";
      fixture.innerHTML =
        '<header class="working-diff__header"><div><span>fixture</span></div></header>' +
        '<div class="binary-diff-preview">' +
          '<article class="binary-diff-preview__card is-' + kind + '">' +
            '<header><strong>After</strong><small>1 KB</small></header>' +
            '<div class="binary-diff-preview__canvas">' +
              (kind === "csv"
                ? '<div class="binary-diff-preview__csv-viewer"><div class="binary-diff-preview__csv-scroll"><table><tbody><tr><td>1</td></tr></tbody></table></div></div>'
                : '<div class="binary-diff-preview__model-viewer"><div class="binary-diff-preview__model-surface"><div class="binary-diff-preview__model-host"></div></div></div>') +
            '</div>' +
          '</article>' +
        '</div>';
      document.body.appendChild(fixture);
      const preview = fixture.querySelector(".binary-diff-preview");
      const card = fixture.querySelector(".binary-diff-preview__card");
      const canvas = fixture.querySelector(".binary-diff-preview__canvas");
      const viewer = fixture.querySelector(
        kind === "csv"
          ? ".binary-diff-preview__csv-viewer"
          : ".binary-diff-preview__model-viewer"
      );
      const result = {
        kind,
        previewToParent: edgeDeltas(preview, fixture),
        cardToPreview: edgeDeltas(card, preview),
        viewerToCanvas: edgeDeltas(viewer, canvas),
        cardBorderWidths: [
          getComputedStyle(card).borderTopWidth,
          getComputedStyle(card).borderRightWidth,
          getComputedStyle(card).borderBottomWidth,
          getComputedStyle(card).borderLeftWidth
        ],
        cardBorderRadius: getComputedStyle(card).borderRadius
      };
      fixture.remove();
      return result;
    };
    return [measure("csv"), measure("model")];
  })()`)
  assert(
    results.binaryPreviewParentFill.length === 2 &&
      results.binaryPreviewParentFill.every(
        (item) =>
          [item.previewToParent, item.cardToPreview, item.viewerToCanvas].every(
            (deltas) =>
              deltas.left <= 1 &&
              deltas.right <= 1 &&
              deltas.bottom <= 1 &&
              (deltas === item.previewToParent || deltas.top <= 1)
          ) &&
          item.cardBorderWidths.every((value) => value === '0px') &&
          item.cardBorderRadius === '0px'
      ),
    `Binary visualization previews do not fill their parents: ${JSON.stringify(results.binaryPreviewParentFill)}`
  )

  // 本地更改 Diff 隐藏时外层工作区移除 Inspector 分割线，主列表扩展到最右边。
  await cdp.evaluate(`document.querySelector('.local-changes button[aria-label="隐藏 Diff 视图"]')?.click()`)
  await delay(40)
  results.localDiffVisibilityToggle = await cdp.evaluate(`(() => {
    const workspace = document.querySelector(".workspace");
    const changes = document.querySelector(".local-changes");
    return {
      hidden: !document.querySelector(".working-diff"),
      outerResizers: document.querySelectorAll(".workspace > .pane-resizer").length,
      changesFillWorkspace: Boolean(workspace && changes) &&
        Math.abs(workspace.getBoundingClientRect().right - changes.getBoundingClientRect().right) <= 1,
      restoreLabel: document.querySelector('.local-changes button[aria-label="显示 Diff 视图"]')
        ?.getAttribute("aria-label") ?? ""
    };
  })()`)
  assert(
    results.localDiffVisibilityToggle.hidden &&
      results.localDiffVisibilityToggle.outerResizers === 1 &&
      results.localDiffVisibilityToggle.changesFillWorkspace &&
      results.localDiffVisibilityToggle.restoreLabel === '显示 Diff 视图',
    `Local Diff visibility toggle did not release the right pane: ${JSON.stringify(results.localDiffVisibilityToggle)}`
  )
  await cdp.evaluate(`document.querySelector('.local-changes button[aria-label="显示 Diff 视图"]')?.click()`)
  await delay(40)
  results.localDiffVisibilityToggle.restored = await cdp.evaluate(
    `Boolean(document.querySelector(".working-diff")) &&
      document.querySelectorAll(".workspace > .pane-resizer").length === 2`
  )
  assert(results.localDiffVisibilityToggle.restored, 'Local Diff visibility toggle did not restore the right pane')

  // 目录收起只改变可见投影，重新展开后原文件选区和右侧 Diff 都必须保留。
  results.localChangeTreeBeforeCollapse = await cdp.evaluate(`({
    files: document.querySelectorAll(".change-file-row").length,
    selectedName:
      document.querySelector(".change-file-row.is-selected strong")
        ?.textContent?.trim() ?? ""
  })`)
  await cdp.evaluate(`document.querySelector(".change-directory-row > button")?.click()`)
  await delay(50)
  results.localChangeTreeCollapsed = await cdp.evaluate(`({
    files: document.querySelectorAll(".change-file-row").length,
    expanded:
      document.querySelector(".change-directory-row")
        ?.getAttribute("aria-expanded") ?? ""
  })`)
  await cdp.evaluate(`document.querySelector(".change-directory-row > button")?.click()`)
  await delay(50)
  results.localChangeTreeExpanded = await cdp.evaluate(`({
    files: document.querySelectorAll(".change-file-row").length,
    selectedName:
      document.querySelector(".change-file-row.is-selected strong")
        ?.textContent?.trim() ?? "",
    diffLines: document.querySelectorAll(".working-diff__line").length
  })`)
  assert(
    results.localChangeTreeCollapsed.expanded === 'false' &&
      results.localChangeTreeCollapsed.files < results.localChangeTreeBeforeCollapse.files &&
      results.localChangeTreeExpanded.files === results.localChangeTreeBeforeCollapse.files &&
      results.localChangeTreeExpanded.selectedName === results.localChangeTreeBeforeCollapse.selectedName &&
      results.localChangeTreeExpanded.diffLines > 0,
    `Collapsing a local-changes directory did not preserve selection: ${JSON.stringify({
      before: results.localChangeTreeBeforeCollapse,
      collapsed: results.localChangeTreeCollapsed,
      expanded: results.localChangeTreeExpanded
    })}`
  )

  /*
   * 目录行上的 Stage 按钮必须真正移动全部后代文件，同时按钮点击不能选中目录。
   * 使用只含一个文件的 Config 目录往返，能够精确恢复演示数据的初始分区。
   */
  results.localChangeDirectoryStageBefore = await cdp.evaluate(`({
    unstaged: document.querySelectorAll(
      ".change-list-section:first-child .change-file-row"
    ).length,
    staged: document.querySelectorAll(
      ".change-list-section:last-child .change-file-row"
    ).length,
    selectedDirectories:
      document.querySelectorAll(".change-directory-row.is-selected").length
  })`)
  await cdp.evaluate(`document.querySelector("button[aria-label='暂存 Config']")?.click()`)
  await delay(60)
  results.localChangeDirectoryStaged = await cdp.evaluate(`({
    unstaged: document.querySelectorAll(
      ".change-list-section:first-child .change-file-row"
    ).length,
    staged: document.querySelectorAll(
      ".change-list-section:last-child .change-file-row"
    ).length,
    hasUnstageButton: Boolean(
      document.querySelector("button[aria-label='取消暂存 Config']")
    ),
    hasToast: Boolean(document.querySelector(".toast")),
    selectedDirectories:
      document.querySelectorAll(".change-directory-row.is-selected").length
  })`)
  assert(
    results.localChangeDirectoryStaged.unstaged === results.localChangeDirectoryStageBefore.unstaged - 1 &&
      results.localChangeDirectoryStaged.staged === results.localChangeDirectoryStageBefore.staged + 1 &&
      results.localChangeDirectoryStaged.hasUnstageButton &&
      !results.localChangeDirectoryStaged.hasToast &&
      results.localChangeDirectoryStaged.selectedDirectories === 0,
    `The directory stage button failed or changed selection: ${JSON.stringify(results.localChangeDirectoryStaged)}`
  )
  await cdp.evaluate(`document.querySelector("button[aria-label='取消暂存 Config']")?.click()`)
  await delay(60)
  results.localChangeDirectoryUnstaged = await cdp.evaluate(`({
    unstaged: document.querySelectorAll(
      ".change-list-section:first-child .change-file-row"
    ).length,
    staged: document.querySelectorAll(
      ".change-list-section:last-child .change-file-row"
    ).length,
    hasStageButton: Boolean(
      document.querySelector("button[aria-label='暂存 Config']")
    ),
    hasToast: Boolean(document.querySelector(".toast"))
  })`)
  assert(
    results.localChangeDirectoryUnstaged.unstaged === results.localChangeDirectoryStageBefore.unstaged &&
      results.localChangeDirectoryUnstaged.staged === results.localChangeDirectoryStageBefore.staged &&
      results.localChangeDirectoryUnstaged.hasStageButton &&
      !results.localChangeDirectoryUnstaged.hasToast,
    `The directory unstage button did not restore the initial sections: ${JSON.stringify(
      results.localChangeDirectoryUnstaged
    )}`
  )

  /*
   * 目录本身是可多选对象：Ctrl 点击第二个目录只高亮两个目录，
   * 不能为了批量操作而把父目录、子目录或后代文件提前绘制成选中状态。
   */
  await cdp.evaluate(`(() => {
    const group = document.querySelector(".change-group");
    const directories = Array.from(
      group?.querySelectorAll(".change-directory-row") ?? []
    );
    const content = directories.find((row) =>
      row.querySelector("strong")?.textContent?.trim() === "Content"
    );
    content?.click();
  })()`)
  await delay(40)
  await cdp.evaluate(`(() => {
    const config = Array.from(document.querySelectorAll(
      ".change-group .change-directory-row"
    )).find((row) =>
      row.querySelector("strong")?.textContent?.trim() === "Config"
    );
    config?.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true
    }));
  })()`)
  await delay(60)
  results.localChangeFolderMultiSelect = await cdp.evaluate(`({
    selectedFiles:
      document.querySelectorAll(".change-file-row.is-selected").length,
    selectedDirectories:
      document.querySelectorAll(".change-directory-row.is-selected").length,
    selectedDirectoryNames: Array.from(
      document.querySelectorAll(".change-directory-row.is-selected strong")
    ).map((element) => element.textContent?.trim() ?? ""),
    header:
      document.querySelector(".local-changes__header > div")
        ?.textContent?.replace(/\\s+/g, " ").trim() ?? ""
  })`)
  assert(
    results.localChangeFolderMultiSelect.selectedFiles === 0 &&
      results.localChangeFolderMultiSelect.selectedDirectories === 2 &&
      JSON.stringify([...results.localChangeFolderMultiSelect.selectedDirectoryNames].sort()) ===
        JSON.stringify(['Config', 'Content']) &&
      results.localChangeFolderMultiSelect.header.includes('已选 2'),
    `Local-changes folder multi-selection is invalid: ${JSON.stringify(results.localChangeFolderMultiSelect)}`
  )
  await cdp.evaluate(`(() => {
    const content = Array.from(document.querySelectorAll(
      ".change-group .change-directory-row"
    )).find((row) =>
      row.querySelector("strong")?.textContent?.trim() === "Content"
    );
    const bounds = content?.getBoundingClientRect();
    content?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(bounds?.right ?? 800),
      clientY: Math.round(bounds?.bottom ?? 260)
    }));
  })()`)
  await delay(60)
  results.localChangeFolderBatchMenu = await cdp.evaluate(`({
    title:
      document.querySelector(".change-context-menu header strong")
        ?.textContent?.trim() ?? "",
    selectedFiles:
      document.querySelectorAll(".change-file-row.is-selected").length,
    selectedDirectories:
      document.querySelectorAll(".change-directory-row.is-selected").length
  })`)
  assert(
    results.localChangeFolderBatchMenu.title === '4 个文件' &&
      results.localChangeFolderBatchMenu.selectedFiles === 0 &&
      results.localChangeFolderBatchMenu.selectedDirectories === 2,
    `Right-clicking a folder did not preserve the aggregated selection: ${JSON.stringify(
      results.localChangeFolderBatchMenu
    )}`
  )
  await cdp.evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true
  }))`)
  await delay(40)

  // 使用真实鼠标输入拖动横向分隔条，并验证比例和持久化值均发生变化。
  const stageSplitBefore = await cdp.evaluate(`(() => {
    const separator = document.querySelector(".stage-split-resizer");
    const bounds = separator?.getBoundingClientRect();
    return {
      value: Number(separator?.getAttribute("aria-valuenow") ?? 0),
      x: Math.round((bounds?.left ?? 0) + (bounds?.width ?? 0) / 2),
      y: Math.round((bounds?.top ?? 0) + (bounds?.height ?? 0) / 2)
    };
  })()`)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: stageSplitBefore.x,
    y: stageSplitBefore.y,
    button: 'left',
    clickCount: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: stageSplitBefore.x,
    y: stageSplitBefore.y + 48,
    button: 'left',
    buttons: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: stageSplitBefore.x,
    y: stageSplitBefore.y + 48,
    button: 'left',
    clickCount: 1
  })
  await delay(60)
  results.localChangeStageSplit = await cdp.evaluate(`(() => {
    const separator = document.querySelector(".stage-split-resizer");
    return {
      before: ${stageSplitBefore.value},
      after: Number(separator?.getAttribute("aria-valuenow") ?? 0),
      stored: Number(localStorage.getItem("lore-client.local-changes-stage-split")),
      rows: document.querySelector(".local-changes__lists")?.style
        .gridTemplateRows ?? ""
    };
  })()`)
  assert(
    results.localChangeStageSplit.after > results.localChangeStageSplit.before &&
      results.localChangeStageSplit.stored === 0 &&
      results.localChangeStageSplit.rows.includes('6px'),
    `Dragging the staging resizer with the mouse had no effect: ${JSON.stringify(results.localChangeStageSplit)}`
  )
  await cdp.evaluate(
    `document.querySelector(".stage-split-resizer")
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`
  )
  await delay(40)
  results.localChangeStageSplitReset = await cdp.evaluate(
    `Number(document.querySelector(".stage-split-resizer")
      ?.getAttribute("aria-valuenow") ?? 0)`
  )
  assert(
    results.localChangeStageSplitReset === 58,
    `Double-clicking the staging resizer did not restore the default ratio: ${results.localChangeStageSplitReset}`
  )
  // 拖动结束后先移开真实鼠标，避免拿横线的 :hover 状态与纵线默认状态比较。
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await delay(30)
  results.resizerVisualConsistency = await cdp.evaluate(`(() => {
    const vertical = document.querySelector(".pane-resizer");
    const horizontal = document.querySelector(".stage-split-resizer");
    if (!vertical || !horizontal) return null;
    horizontal.blur();
    const defaultVerticalBackground = getComputedStyle(vertical).backgroundColor;
    const defaultHorizontalBackground =
      getComputedStyle(horizontal).backgroundColor;
    const defaultVerticalLine =
      getComputedStyle(vertical, "::before").backgroundColor;
    const defaultHorizontalLine =
      getComputedStyle(horizontal, "::before").backgroundColor;

    vertical.focus();
    const activeVerticalBackground = getComputedStyle(vertical).backgroundColor;
    const activeVerticalLine =
      getComputedStyle(vertical, "::before").backgroundColor;
    horizontal.focus();
    const activeHorizontalBackground =
      getComputedStyle(horizontal).backgroundColor;
    const activeHorizontalLine =
      getComputedStyle(horizontal, "::before").backgroundColor;
    horizontal.blur();
    return {
      defaultVerticalBackground,
      defaultHorizontalBackground,
      defaultVerticalLine,
      defaultHorizontalLine,
      activeVerticalBackground,
      activeHorizontalBackground,
      activeVerticalLine,
      activeHorizontalLine
    };
  })()`)
  assert(
    results.resizerVisualConsistency &&
      results.resizerVisualConsistency.defaultVerticalBackground ===
        results.resizerVisualConsistency.defaultHorizontalBackground &&
      results.resizerVisualConsistency.defaultVerticalLine === results.resizerVisualConsistency.defaultHorizontalLine &&
      results.resizerVisualConsistency.activeVerticalBackground ===
        results.resizerVisualConsistency.activeHorizontalBackground &&
      results.resizerVisualConsistency.defaultVerticalBackground ===
        results.resizerVisualConsistency.activeVerticalBackground &&
      results.resizerVisualConsistency.defaultHorizontalBackground ===
        results.resizerVisualConsistency.activeHorizontalBackground &&
      results.resizerVisualConsistency.activeVerticalLine === results.resizerVisualConsistency.activeHorizontalLine,
    `Horizontal and vertical resizer styles differ or still show a filled handle on focus: ${JSON.stringify(
      results.resizerVisualConsistency
    )}`
  )

  // 平铺/文件夹树共用同一选择模型，切换视图不能丢失主选择。
  await cdp.evaluate(`document.querySelector("button[title='平铺视图']")?.click()`)
  await delay(50)
  results.localChangesFlat = await cdp.evaluate(`({
    flatActive:
      document.querySelector("button[title='平铺视图']")
        ?.getAttribute("aria-pressed") === "true",
    directoryRows: document.querySelectorAll(".change-directory-row").length,
    fileRows: document.querySelectorAll(".change-file-row").length,
    selectedRows:
      document.querySelectorAll(".change-file-row.is-selected").length
  })`)
  assert(
    results.localChangesFlat.flatActive &&
      results.localChangesFlat.directoryRows === 0 &&
      results.localChangesFlat.fileRows === 6 &&
      results.localChangesFlat.selectedRows === 4,
    `The local-changes flat view is invalid: ${JSON.stringify(results.localChangesFlat)}`
  )

  // 单文件右击菜单提供历史入口，文件时间线来自独立的文件历史数据。
  await cdp.evaluate(`(() => {
    const row = document.querySelector(".change-file-row");
    row?.click();
  })()`)
  await delay(40)
  await cdp.evaluate(`(() => {
    const row = document.querySelector(".change-file-row.is-selected");
    const bounds = row?.getBoundingClientRect();
    row?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(bounds?.right ?? 800),
      clientY: Math.round(bounds?.bottom ?? 260)
    }));
  })()`)
  await delay(70)
  results.localChangeSingleMenu = await cdp.evaluate(`(() => {
    const menu = document.querySelector(".change-context-menu");
    return {
      visible: Boolean(menu),
      hasHistory: Array.from(menu?.querySelectorAll("button") ?? [])
        .some((button) => button.textContent?.includes("文件历史"))
    };
  })()`)
  assert(
    results.localChangeSingleMenu.visible && results.localChangeSingleMenu.hasHistory,
    `The local-changes single-file menu is missing the history entry: ${JSON.stringify(results.localChangeSingleMenu)}`
  )
  await cdp.evaluate(`Array.from(
    document.querySelectorAll(".change-context-menu button")
  ).find((button) => button.textContent?.includes("文件历史"))?.click()`)
  await delay(60)
  results.localFileHistory = await cdp.evaluate(`({
    visible: Boolean(document.querySelector(".file-history-dialog")),
    rows: document.querySelectorAll(".file-history-row").length,
    path:
      document.querySelector(".file-history-dialog__path small")
        ?.textContent?.trim() ?? ""
  })`)
  assert(
    results.localFileHistory.visible &&
      results.localFileHistory.rows === 6 &&
      results.localFileHistory.path.includes('Meridian_Lighting.layer.json'),
    `The file-history dialog is invalid: ${JSON.stringify(results.localFileHistory)}`
  )
  await cdp.evaluate(`document.querySelector(".file-history-dialog button[aria-label='关闭文件历史']")?.click()`)
  await delay(50)

  // 普通点击只选择，Ctrl 点击扩展选区；右击已选文件必须冻结整个批量选区。
  await cdp.evaluate(`(() => {
    const rows = document.querySelectorAll(".change-file-row");
    rows[0]?.click();
  })()`)
  await delay(40)
  await cdp.evaluate(`(() => {
    const row = document.querySelectorAll(".change-file-row")[1];
    row?.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true
    }));
  })()`)
  await delay(60)
  results.localChangeMultiSelect = await cdp.evaluate(`({
    selectedRows:
      document.querySelectorAll(".change-file-row.is-selected").length,
    header:
      document.querySelector(".local-changes__header > div")
        ?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
    diffSelection:
      document.querySelector(".working-diff__selection")
        ?.textContent?.trim() ?? ""
  })`)
  assert(
    results.localChangeMultiSelect.selectedRows === 2 &&
      results.localChangeMultiSelect.header.includes('已选 2') &&
      results.localChangeMultiSelect.diffSelection.includes('已选 2'),
    `Local-changes Ctrl multi-selection is invalid: ${JSON.stringify(results.localChangeMultiSelect)}`
  )

  await cdp.evaluate(`(() => {
    const row = document.querySelectorAll(".change-file-row.is-selected")[1];
    row?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: window.innerWidth - 2,
      clientY: window.innerHeight - 2
    }));
  })()`)
  await delay(80)
  results.localChangeBatchMenu = await cdp.evaluate(`(() => {
    const menu = document.querySelector(".change-context-menu");
    if (!menu) return { visible: false, labels: [] };
    const bounds = menu.getBoundingClientRect();
    const buttons = Array.from(menu.querySelectorAll("button"));
    return {
      visible: true,
      title: menu.querySelector("header strong")?.textContent?.trim() ?? "",
      labels: buttons.map((button) =>
        button.textContent?.replace(/\\s+/g, " ").trim()
      ),
      stashDisabled: buttons.find((button) =>
        button.textContent?.includes("文件暂存架")
      )?.disabled ?? false,
      stashReason: buttons.find((button) =>
        button.textContent?.includes("文件暂存架")
      )?.textContent?.includes("Lore 当前没有可恢复的文件级 Stash") ?? false,
      withinViewport:
        bounds.left >= 0 &&
        bounds.top >= 0 &&
        bounds.right <= window.innerWidth &&
        bounds.bottom <= window.innerHeight
    };
  })()`)
  for (const label of [
    '打开',
    '在文件管理器中显示',
    '文件历史',
    '暂存 2 个文件',
    '丢弃 2 个文件的更改',
    '全部暂存',
    '忽略',
    '保存为补丁',
    '复制路径',
    '复制完整路径'
  ]) {
    assert(
      results.localChangeBatchMenu.labels.some((text) => text?.includes(label)),
      `The local-changes batch menu is missing "${label}"`
    )
  }
  assert(
    !results.localChangeBatchMenu.labels.some((text) => text?.includes('外部 Diff')),
    'Browser demo exposed an External Diff tool that was not found on the system'
  )
  assert(
    results.localChangeBatchMenu.visible &&
      results.localChangeBatchMenu.title === '2 个文件' &&
      results.localChangeBatchMenu.withinViewport,
    `The local-changes batch-menu state is invalid: ${JSON.stringify(results.localChangeBatchMenu)}`
  )

  // 协作锁是当前工作区文件的右键子菜单；浏览器演示模式不能伪造真实写入，
  // 但状态、禁用原因和全局管理入口仍需完整可达。
  await cdp.evaluate(`Array.from(
    document.querySelectorAll(".change-context-menu button")
  ).find((button) => button.textContent?.includes("协作文件锁"))?.click()`)
  await delay(50)
  results.localChangeLockMenu = await cdp.evaluate(`(() => {
    const submenu = document.querySelector(".context-submenu--locks");
    if (!submenu) return { visible: false, labels: [] };
    const bounds = submenu.getBoundingClientRect();
    const buttons = Array.from(submenu.querySelectorAll(":scope > button"));
    return {
      visible: true,
      labels: buttons.map((button) =>
        button.textContent?.replace(/\\s+/g, " ").trim()
      ),
      acquireDisabled: buttons.find((button) =>
        button.textContent?.includes("获取协作锁")
      )?.disabled ?? false,
      releaseDisabled: buttons.find((button) =>
        button.textContent?.includes("释放我的协作锁")
      )?.disabled ?? false,
      withinViewport:
        bounds.left >= 0 &&
        bounds.top >= 0 &&
        bounds.right <= window.innerWidth &&
        bounds.bottom <= window.innerHeight
    };
  })()`)
  for (const label of ['获取协作锁', '释放我的协作锁', '打开协作锁管理器']) {
    assert(
      results.localChangeLockMenu.labels.some((text) => text?.includes(label)),
      `The local-changes lock submenu is missing "${label}"`
    )
  }
  assert(
    results.localChangeLockMenu.visible &&
      results.localChangeLockMenu.acquireDisabled &&
      results.localChangeLockMenu.releaseDisabled &&
      results.localChangeLockMenu.withinViewport,
    `The local-changes lock submenu is invalid: ${JSON.stringify(results.localChangeLockMenu)}`
  )
  await cdp.evaluate(`Array.from(
    document.querySelectorAll(".change-context-menu button")
  ).find((button) => button.textContent?.includes("协作文件锁"))?.click()`)
  await delay(30)

  // 菜单批量暂存必须让两个文件同时跨分区移动，且单击本身不能提前改变 Stage。
  results.stageBefore = await cdp.evaluate(
    `Array.from(document.querySelectorAll(".change-group"))
      .map((group) => group.querySelectorAll(".change-file-row").length)`
  )
  await cdp.evaluate(`Array.from(
    document.querySelectorAll(".change-context-menu button")
  ).find((button) => button.textContent?.includes("暂存 2 个文件"))?.click()`)
  await delay(70)
  results.stageAfter = await cdp.evaluate(
    `({
      counts: Array.from(document.querySelectorAll(".change-group"))
        .map((group) => group.querySelectorAll(".change-file-row").length),
      hasToast: Boolean(document.querySelector(".toast"))
    })`
  )
  assert(
    results.stageBefore[0] === results.stageAfter.counts[0] + 2 &&
      results.stageBefore[1] === results.stageAfter.counts[1] - 2 &&
      !results.stageAfter.hasToast,
    `Section counts were not updated after batch staging: ${JSON.stringify({
      before: results.stageBefore,
      after: results.stageAfter
    })}`
  )
  await cdp.evaluate(`document.querySelector(".toast > button")?.click()`)
  await delay(40)

  await cdp.evaluate(`document.querySelector("button[title='文件夹树视图']")?.click()`)
  await delay(50)

  await cdp.evaluate(`
    Array.from(document.querySelectorAll(".sidebar__primary button"))
      .find((button) => button.textContent.includes("分支总览"))
      ?.click()
  `)
  await delay(60)
  results.branches = await cdp.evaluate(`document.querySelectorAll(".branch-card").length`)
  assert(results.branches >= 6, 'The branch overview card count is invalid')
  results.branchColumns = await cdp.evaluate(`(() => {
    const localColumn = document.querySelector(".branch-overview__column--local");
    const remoteColumn = document.querySelector(".branch-overview__column--remote");
    const names = (column) => Array.from(
      column?.querySelectorAll(".branch-card > strong") ?? []
    ).map((element) => element.textContent?.trim() ?? "");
    const states = (column) => Object.fromEntries(Array.from(
      column?.querySelectorAll(".branch-card") ?? []
    ).map((card) => [
      card.querySelector(":scope > strong")?.textContent?.trim() ?? "",
      card.querySelector(".branch-sync-state")?.textContent?.trim() ?? ""
    ]));
    const localBounds = localColumn?.getBoundingClientRect();
    const remoteBounds = remoteColumn?.getBoundingClientRect();
    return {
      localNames: names(localColumn),
      remoteNames: names(remoteColumn),
      localStates: states(localColumn),
      remoteStates: states(remoteColumn),
      localIsLeft: Boolean(localBounds && remoteBounds) &&
        localBounds.left < remoteBounds.left && localBounds.right <= remoteBounds.left
    };
  })()`)
  assert(
    results.branchColumns.localIsLeft &&
      JSON.stringify(results.branchColumns.localNames) === JSON.stringify([
        'audio/ambient-remix',
        'cinematic/prologue',
        'world/lighting-pass',
        'world/terrain-v7',
        'main'
      ]) &&
      JSON.stringify(results.branchColumns.remoteNames) === JSON.stringify([
        'origin/cinematic/prologue',
        'origin/release/0.8',
        'origin/main'
      ]) &&
      results.branchColumns.localStates['world/lighting-pass'] === '领先 2' &&
      results.branchColumns.localStates.main === '已同步' &&
      results.branchColumns.localStates['audio/ambient-remix'] === '仅本地' &&
      Object.values(results.branchColumns.remoteStates).every((state) => state === '远程指针'),
    `The branch overview columns or hierarchical ordering are invalid: ${JSON.stringify(
      results.branchColumns
    )}`
  )

  /*
   * 分支卡片继承自原生 button，但它的卡片边界只表达对象与选中状态；
   * 真实鼠标 hover 不得把四边切换成普通按钮的品牌蓝边界。
   */
  results.branchHoverBefore = await cdp.evaluate(`(() => {
    const card = document.querySelector(".branch-overview__column--remote .branch-card");
    if (!card) return null;
    const bounds = card.getBoundingClientRect();
    const style = getComputedStyle(card);
    return {
      point: {
        x: Math.round(bounds.left + bounds.width / 2),
        y: Math.round(bounds.top + bounds.height / 2)
      },
      borderColors: [
        style.borderTopColor,
        style.borderRightColor,
        style.borderBottomColor,
        style.borderLeftColor
      ]
    };
  })()`)
  assert(Boolean(results.branchHoverBefore), 'Failed to locate the branch-card hover test point')
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: results.branchHoverBefore.point.x,
    y: results.branchHoverBefore.point.y
  })
  await delay(40)
  results.branchHoverAfter = await cdp.evaluate(`(() => {
    const card = document.querySelector(".branch-overview__column--remote .branch-card:hover");
    if (!card) return null;
    const style = getComputedStyle(card);
    return {
      borderColors: [
        style.borderTopColor,
        style.borderRightColor,
        style.borderBottomColor,
        style.borderLeftColor
      ],
      outlineStyle: style.outlineStyle
    };
  })()`)
  assert(
    results.branchHoverAfter &&
      JSON.stringify(results.branchHoverAfter.borderColors) ===
        JSON.stringify(results.branchHoverBefore.borderColors) &&
      results.branchHoverAfter.outlineStyle === 'none',
    `Branch-card hover changes the neutral card boundary: ${JSON.stringify({
      before: results.branchHoverBefore,
      after: results.branchHoverAfter
    })}`
  )
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })

  // Branch 单击只改变选择边框，不能改变当前工作区附着 Branch 或跳转视图。
  await cdp.evaluate(`(() => {
    const card = Array.from(document.querySelectorAll(".branch-card"))
      .find((element) =>
        element.querySelector(":scope > strong")?.textContent?.trim() === "main");
    card?.click();
  })()`)
  await delay(60)
  results.branchSingleClick = await cdp.evaluate(`(() => {
    const selected = document.querySelector(".branch-card.is-selected");
    const current = document.querySelector(".branch-card.is-current");
    return {
      selectedName: selected?.querySelector(":scope > strong")?.textContent?.trim() ?? "",
      currentName: current?.querySelector(":scope > strong")?.textContent?.trim() ?? "",
      currentSummary:
        document.querySelector(".current-branch-card h2")?.textContent?.trim() ?? "",
      hasOperationToast: Boolean(document.querySelector(".toast"))
    };
  })()`)
  assert(
    results.branchSingleClick.selectedName === 'main' &&
      results.branchSingleClick.currentName === 'world/lighting-pass' &&
      results.branchSingleClick.currentSummary === 'world/lighting-pass' &&
      !results.branchSingleClick.hasOperationToast,
    `A single branch click incorrectly triggered checkout: ${JSON.stringify(results.branchSingleClick)}`
  )

  // 双击已选 Branch 才进入统一 Checkout 路径；浏览器演示不伪造切换成功。
  await cdp.evaluate(`document.querySelector(".branch-card.is-selected")
    ?.dispatchEvent(new MouseEvent("dblclick", {
      bubbles: true,
      cancelable: true
    }))`)
  await delay(60)
  results.branchDoubleClick = await cdp.evaluate(`({
    title: document.querySelector(".toast strong")?.textContent?.trim() ?? "",
    detail: document.querySelector(".toast small")?.textContent?.trim() ?? ""
  })`)
  assert(
    results.branchDoubleClick.title === '浏览器演示模式' &&
      results.branchDoubleClick.detail.includes('工作区切换到 main'),
    `Double-clicking a branch did not trigger the checkout entry point: ${JSON.stringify(results.branchDoubleClick)}`
  )
  await cdp.evaluate(`document.querySelector(".toast > button")?.click()`)
  await delay(40)

  // 本地 Branch 菜单包含切换、推送、合并、归档。
  await cdp.evaluate(`(() => {
    const card = Array.from(document.querySelectorAll(".branch-card"))
      .find((element) =>
        element.querySelector(":scope > strong")?.textContent?.trim() === "main");
    const bounds = card?.getBoundingClientRect();
    card?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(bounds?.left ?? 400),
      clientY: Math.round(bounds?.top ?? 300)
    }));
  })()`)
  await delay(70)
  results.localBranchMenu = await cdp.evaluate(`(() => {
    const menu = document.querySelector(".version-context-menu");
    return {
      visible: Boolean(menu),
      labels: Array.from(menu?.querySelectorAll(":scope > button") ?? [])
        .map((button) => button.textContent?.replace(/\\s+/g, " ").trim())
    };
  })()`)
  for (const label of ['切换到此分支', '新建分支', '新建标签', '推送', '合并到', '归档分支', '复制分支名称']) {
    assert(
      results.localBranchMenu.labels.some((text) => text?.includes(label)),
      `The local branch menu is missing "${label}"`
    )
  }

  // 分支入口使用分支自身的最新 Revision，而不是当前工作区历史顶部。
  await cdp.evaluate(`Array.from(
    document.querySelectorAll(".version-context-menu > button")
  ).find((button) => button.textContent?.includes("新建分支"))?.click()`)
  await delay(60)
  results.branchSourceCreateDialog = await cdp.evaluate(`(() => {
    const source = document.querySelector(".branch-create-source");
    return {
      visible: Boolean(document.querySelector(".compact-dialog")),
      branch: source?.querySelector("strong")?.textContent?.trim() ?? "",
      revision: source?.querySelector("code")?.textContent?.trim() ?? "",
      description: source?.querySelector("em")?.textContent?.trim() ?? ""
    };
  })()`)
  assert(
    results.branchSourceCreateDialog.visible &&
      results.branchSourceCreateDialog.branch === 'main' &&
      results.branchSourceCreateDialog.revision === '5de935ea' &&
      results.branchSourceCreateDialog.description.includes('所选分支'),
    `The source for creating a branch from a branch is invalid: ${JSON.stringify(results.branchSourceCreateDialog)}`
  )
  await cdp.evaluate(`document.querySelector(".compact-dialog button[aria-label='关闭']")?.click()`)
  await delay(40)

  // Branch 菜单创建 Tag 必须使用该分支自身的 latest，而不是当前历史选区。
  await cdp.evaluate(`(() => {
    const card = Array.from(document.querySelectorAll(".branch-card"))
      .find((element) =>
        element.querySelector(":scope > strong")?.textContent?.trim() === "main");
    const bounds = card?.getBoundingClientRect();
    card?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(bounds?.left ?? 520),
      clientY: Math.round(bounds?.top ?? 300)
    }));
  })()`)
  await delay(50)
  await cdp.evaluate(`Array.from(
    document.querySelectorAll(".version-context-menu > button")
  ).find((button) => button.textContent?.includes("新建标签"))?.click()`)
  await delay(50)
  results.branchTagCreateDialog = await cdp.evaluate(`(() => {
    const source = document.querySelector(".tag-source");
    return {
      visible: Boolean(document.querySelector(".tag-dialog")),
      branch: source?.querySelector("strong")?.textContent?.trim() ?? "",
      revision: source?.querySelector("code")?.textContent?.trim() ?? ""
    };
  })()`)
  assert(
    results.branchTagCreateDialog.visible &&
      results.branchTagCreateDialog.branch === 'main' &&
      results.branchTagCreateDialog.revision === '5de935ea',
    `The source for creating a tag from a branch is invalid: ${JSON.stringify(results.branchTagCreateDialog)}`
  )
  await cdp.evaluate(`document.querySelector(".tag-dialog button[aria-label='关闭']")?.click()`)
  await delay(40)

  // 当前 Branch 仍允许 Push，但切换、合并自身和归档必须给出明确禁用原因。
  await cdp.evaluate(`(() => {
    const card = document.querySelector(".branch-card.is-current");
    const bounds = card?.getBoundingClientRect();
    card?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(bounds?.left ?? 400),
      clientY: Math.round(bounds?.top ?? 300)
    }));
  })()`)
  await delay(70)
  results.currentBranchMenu = await cdp.evaluate(`(() => {
    const buttons = Array.from(
      document.querySelectorAll(".version-context-menu > button")
    );
    return buttons.map((button) => ({
      label: button.textContent?.replace(/\\s+/g, " ").trim() ?? "",
      disabled: button.disabled
    }));
  })()`)
  const currentSwitch = results.currentBranchMenu.find((item) => item.label.includes('切换到此分支'))
  const currentPush = results.currentBranchMenu.find((item) => item.label.includes('推送'))
  const currentMerge = results.currentBranchMenu.find((item) => item.label.includes('合并到'))
  const currentArchive = results.currentBranchMenu.find((item) => item.label.includes('归档分支'))
  assert(
    currentSwitch?.disabled &&
      !currentPush?.disabled &&
      currentMerge?.disabled &&
      currentArchive?.disabled &&
      currentSwitch.label.includes('已经是当前分支') &&
      currentMerge.label.includes('不能把当前分支合并到自身') &&
      currentArchive.label.includes('当前分支不能归档'),
    `The current-branch menu has invalid disabled-state boundaries: ${JSON.stringify(results.currentBranchMenu)}`
  )
  await cdp.evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true
  }))`)
  await delay(40)

  // 远程 Branch 不能错误暴露本地 Push / Archive，但应支持附着与合并。
  await cdp.evaluate(`(() => {
    const card = Array.from(document.querySelectorAll(".branch-card"))
      .find((element) =>
        element.querySelector(".branch-card__top small")
          ?.textContent?.trim() === "远程");
    const bounds = card?.getBoundingClientRect();
    card?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(bounds?.left ?? 400),
      clientY: Math.round(bounds?.top ?? 300)
    }));
  })()`)
  await delay(70)
  results.remoteBranchMenu = await cdp.evaluate(`(() => {
    const menu = document.querySelector(".version-context-menu");
    return {
      visible: Boolean(menu),
      labels: Array.from(menu?.querySelectorAll(":scope > button") ?? [])
        .map((button) => button.textContent?.replace(/\\s+/g, " ").trim())
    };
  })()`)
  assert(
    results.remoteBranchMenu.visible &&
      results.remoteBranchMenu.labels.some((text) => text?.includes('切换并附着远程分支')) &&
      results.remoteBranchMenu.labels.some((text) => text?.includes('新建分支')) &&
      results.remoteBranchMenu.labels.some((text) => text?.includes('合并到')) &&
      !results.remoteBranchMenu.labels.some((text) => text?.includes('推送')) &&
      !results.remoteBranchMenu.labels.some((text) => text?.includes('归档')),
    `The remote-branch menu boundary is invalid: ${JSON.stringify(results.remoteBranchMenu)}`
  )
  await cdp.evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true
  }))`)
  await delay(40)

  // 侧栏一级、二级与空归档分组都应使用真实可切换的 aria-expanded 状态。
  results.sidebarTree = await cdp.evaluate(`(async () => {
    const waitForRender = () =>
      new Promise((resolve) => window.setTimeout(resolve, 30));
    const findSection = (title) =>
      Array.from(document.querySelectorAll(".sidebar-section"))
        .find((section) =>
          section.querySelector(":scope > .sidebar-section__title")
            ?.textContent?.trim() === title);
    const branchSection = findSection("分支");
    const branchToggle = branchSection
      ?.querySelector(":scope > .sidebar-section__title");
    branchToggle?.click();
    await waitForRender();
    const branchCollapsed =
      branchToggle?.getAttribute("aria-expanded") === "false" &&
      !branchSection?.querySelector(".tree-group-label");
    branchToggle?.click();
    await waitForRender();

    const localToggle = Array.from(
      branchSection?.querySelectorAll(".tree-group-label") ?? []
    ).find((button) => button.textContent?.trim() === "本地");
    localToggle?.click();
    await waitForRender();
    const localCollapsed =
      localToggle?.getAttribute("aria-expanded") === "false" &&
      !branchSection?.querySelector(".tree-row--local");
    localToggle?.click();
    await waitForRender();

    /*
     * 演示数据覆盖根目录、多层目录和根叶子：目录必须优先且逐层按英文名称排序。
     * 折叠 world 目录后只隐藏其后代叶子，重新展开以免影响后续 Branch 流程。
     */
    const localFolders = Array.from(
      branchSection?.querySelectorAll(
        ".sidebar-path-folder--local > .tree-row--folder"
      ) ?? []
    ).map((button) => button.getAttribute("aria-label") ?? "");
    const remoteFolders = Array.from(
      branchSection?.querySelectorAll(
        ".sidebar-path-folder--remote > .tree-row--folder"
      ) ?? []
    ).map((button) => button.getAttribute("aria-label") ?? "");
    const localBranches = Array.from(
      branchSection?.querySelectorAll(".tree-row--local") ?? []
    ).map((button) => button.getAttribute("aria-label") ?? "");
    const worldFolder = branchSection?.querySelector(
      '.tree-row--folder[aria-label="world"]'
    );
    worldFolder?.click();
    await waitForRender();
    const pathFolderCollapsed =
      worldFolder?.getAttribute("aria-expanded") === "false" &&
      !branchSection?.querySelector('.tree-row--local[aria-label^="world/"]');
    worldFolder?.click();
    await waitForRender();

    const loreSection = findSection("LORE");
    const loreToggle = loreSection
      ?.querySelector(":scope > .sidebar-section__title");
    loreToggle?.click();
    await waitForRender();
    const loreCollapsed =
      loreToggle?.getAttribute("aria-expanded") === "false" &&
      !loreSection?.querySelector(".tree-row--root");
    loreToggle?.click();
    await waitForRender();
    const loreEntries = Array.from(
      loreSection?.querySelectorAll(".tree-row--root") ?? [],
    ).map((button) => button.textContent?.trim() ?? "");

    const tagSection = findSection("标签");
    const tagToggle = tagSection
      ?.querySelector(":scope > .sidebar-section__title");
    tagToggle?.click();
    await waitForRender();
    const tagCollapsed =
      tagToggle?.getAttribute("aria-expanded") === "false" &&
      !tagSection?.querySelector(".tree-row--tag");
    tagToggle?.click();
    await waitForRender();

    // 标签与 Branch 使用同一目录优先规则，但折叠状态和真实叶子动作必须彼此隔离。
    const tagFolders = Array.from(
      tagSection?.querySelectorAll(
        ".sidebar-path-folder--tag > .tree-row--folder"
      ) ?? []
    ).map((button) => button.getAttribute("aria-label") ?? "");
    const sidebarTags = Array.from(
      tagSection?.querySelectorAll(".tree-row--tag") ?? []
    ).map((button) => button.getAttribute("aria-label") ?? "");
    const releaseTagFolder = tagSection?.querySelector(
      '.tree-row--folder[aria-label="release"]'
    );
    releaseTagFolder?.click();
    await waitForRender();
    const tagFolderCollapsed =
      releaseTagFolder?.getAttribute("aria-expanded") === "false" &&
      !tagSection?.querySelector('.tree-row--tag[aria-label^="release/"]');
    releaseTagFolder?.click();
    await waitForRender();

    const archivedToggle = document.querySelector(".sidebar__collapsed-row");
    const loreToggleLeft =
      loreToggle?.querySelector("svg")?.getBoundingClientRect().left ?? -1;
    const archivedToggleLeft =
      archivedToggle?.querySelector("svg")?.getBoundingClientRect().left ?? -2;
    const archivedAligned =
      Math.abs(loreToggleLeft - archivedToggleLeft) <= 0.5;
    archivedToggle?.click();
    await waitForRender();
    const archivedExpanded =
      archivedToggle?.getAttribute("aria-expanded") === "true" &&
      Boolean(document.querySelector(".sidebar__empty-tree-row"));
    archivedToggle?.click();
    await waitForRender();

    return {
      branchCollapsed,
      localCollapsed,
      localFolders,
      remoteFolders,
      localBranches,
      pathFolderCollapsed,
      tagCollapsed,
      tagFolders,
      sidebarTags,
      tagFolderCollapsed,
      loreCollapsed,
      loreEntries,
      archivedAligned,
      archivedExpanded
    };
  })()`)
  assert(
    results.sidebarTree.branchCollapsed &&
      results.sidebarTree.localCollapsed &&
      results.sidebarTree.pathFolderCollapsed &&
      results.sidebarTree.tagCollapsed &&
      results.sidebarTree.tagFolderCollapsed &&
      results.sidebarTree.loreCollapsed &&
      results.sidebarTree.archivedExpanded &&
      results.sidebarTree.archivedAligned &&
      JSON.stringify(results.sidebarTree.localFolders) ===
        JSON.stringify(['audio', 'cinematic', 'world']) &&
      JSON.stringify(results.sidebarTree.remoteFolders) ===
        JSON.stringify(['origin', 'origin/cinematic', 'origin/release']) &&
      JSON.stringify(results.sidebarTree.localBranches) ===
        JSON.stringify([
          'audio/ambient-remix',
          'cinematic/prologue',
          'world/lighting-pass',
          'world/terrain-v7',
          'main'
        ]) &&
      JSON.stringify(results.sidebarTree.tagFolders) ===
        JSON.stringify(['cinematic', 'lighting', 'preview', 'release']) &&
      JSON.stringify(results.sidebarTree.sidebarTags) ===
        JSON.stringify([
          'cinematic/prologue-preview',
          'lighting/review-2',
          'preview/terrain-v7',
          'release/meridian-0.8'
        ]) &&
      JSON.stringify(results.sidebarTree.loreEntries) ===
        JSON.stringify(['克隆 / 选择性同步', '仓库配置', '账户', '仓库工具']),
    `Sidebar tree-group expansion, collapse, compact Lore entries, or archived alignment are invalid: ${JSON.stringify(results.sidebarTree)}`
  )
  await delay(50)

  await cdp.evaluate(
    `Array.from(document.querySelectorAll(".branch-overview__header button"))
      .find((button) => button.textContent.includes("新建分支"))
      ?.click()`
  )
  await delay(60)
  results.branchDialog = await cdp.evaluate(`(() => {
    const source = document.querySelector(".branch-create-source");
    return {
      visible: Boolean(document.querySelector(
        ".compact-dialog input[placeholder='feature/scene-streaming']"
      )),
      branch: source?.querySelector("strong")?.textContent?.trim() ?? "",
      revision: source?.querySelector("code")?.textContent?.trim() ?? "",
      description: source?.querySelector("em")?.textContent?.trim() ?? ""
    };
  })()`)
  assert(
    results.branchDialog.visible &&
      results.branchDialog.branch === 'world/lighting-pass' &&
      results.branchDialog.revision === 'c7f3a81d' &&
      results.branchDialog.description.includes('当前工作区'),
    `The create-branch dialog for the current workspace is invalid: ${JSON.stringify(results.branchDialog)}`
  )
  await cdp.evaluate(`document.querySelector(".compact-dialog .task-dialog__header > button")?.click()`)
  await delay(40)

  // Tag 主视图必须提供真实列表、单击选择、双击定位以及完整上下文菜单。
  await cdp.evaluate(`Array.from(document.querySelectorAll(".sidebar__primary button"))
    .find((button) => button.textContent?.includes("标签列表"))?.click()`)
  await delay(60)
  results.tags = await cdp.evaluate(`({
    rows: document.querySelectorAll(".tag-row").length,
    tableNames: Array.from(document.querySelectorAll(".tag-row .tag-row__identity strong"))
      .map((element) => element.textContent?.trim() ?? ""),
    sidebarRows: document.querySelectorAll(".tree-row--tag").length,
    sidebarNames: Array.from(document.querySelectorAll(".tree-row--tag"))
      .map((element) => element.getAttribute("aria-label") ?? ""),
    primaryHasCount: Boolean(Array.from(
      document.querySelectorAll(".sidebar__primary button")
    ).find((button) => button.textContent?.includes("标签列表"))?.querySelector("b")),
    columns: Array.from(document.querySelectorAll(".tag-table__columns > span"))
      .map((element) => element.textContent?.trim())
  })`)
  assert(
    results.tags.rows >= 4 &&
      JSON.stringify(results.tags.tableNames) ===
        JSON.stringify([
          'cinematic/prologue-preview',
          'lighting/review-2',
          'preview/terrain-v7',
          'release/meridian-0.8'
        ]) &&
      results.tags.sidebarRows >= 4 &&
      JSON.stringify(results.tags.sidebarNames) ===
        JSON.stringify([
          'cinematic/prologue-preview',
          'lighting/review-2',
          'preview/terrain-v7',
          'release/meridian-0.8'
        ]) &&
      !results.tags.primaryHasCount &&
      results.tags.columns.includes('目标') &&
      results.tags.columns.includes('说明'),
    `The tag-list view is invalid: ${JSON.stringify(results.tags)}`
  )
  results.tagTableLayout = await cdp.evaluate(`(() => {
    const overview = document.querySelector(".tag-overview");
    const table = document.querySelector(".tag-table");
    const header = document.querySelector(".tag-table__columns");
    const row = document.querySelector(".tag-row");
    if (!overview || !table || !header || !row) return null;
    const headerCells = Array.from(header.children);
    const rowCells = Array.from(row.children);
    return {
      overviewRight: Math.round(overview.getBoundingClientRect().right),
      tableRight: Math.round(table.getBoundingClientRect().right),
      headerRight: Math.round(header.getBoundingClientRect().right),
      rowRight: Math.round(row.getBoundingClientRect().right),
      rightGap: Math.round(
        overview.getBoundingClientRect().right -
          table.getBoundingClientRect().right
      ),
      headerRowRightDelta: Math.round(
        header.getBoundingClientRect().right -
          row.getBoundingClientRect().right
      ),
      clientWidth: table.clientWidth,
      scrollWidth: table.scrollWidth,
      headerTemplate: getComputedStyle(header).gridTemplateColumns,
      rowTemplate: getComputedStyle(row).gridTemplateColumns,
      columnLeftDeltas: headerCells.map((cell, index) =>
        Math.round(
          (rowCells[index]?.getBoundingClientRect().left ?? 0) -
            cell.getBoundingClientRect().left
        )
      )
    };
  })()`)
  assert(
    results.tagTableLayout &&
      Math.abs(results.tagTableLayout.rightGap) <= 1 &&
      Math.abs(results.tagTableLayout.headerRowRightDelta) <= 1 &&
      results.tagTableLayout.scrollWidth >= results.tagTableLayout.clientWidth &&
      results.tagTableLayout.headerTemplate === results.tagTableLayout.rowTemplate &&
      results.tagTableLayout.columnLeftDeltas.every((delta) => Math.abs(delta) <= 1),
    `The tag table does not fill the available width or has misaligned column boundaries: ${JSON.stringify(
      results.tagTableLayout
    )}`
  )

  // 使用真实鼠标位置触发 :hover，避免仅派发 DOM 事件却没有进入 CSS 悬停状态。
  results.tagHoverBefore = await cdp.evaluate(`(() => {
    const row = document.querySelectorAll(".tag-row")[2];
    if (!row) return null;
    const style = getComputedStyle(row);
    return {
      borderBottomColor: style.borderBottomColor,
      borderBottomWidth: style.borderBottomWidth,
      outlineStyle: style.outlineStyle
    };
  })()`)
  const tagHoverPoint = await cdp.evaluate(`(() => {
    const bounds = document.querySelectorAll(".tag-row")[2]?.getBoundingClientRect();
    return bounds ? {
      x: Math.round(bounds.left + bounds.width / 2),
      y: Math.round(bounds.top + bounds.height / 2)
    } : null;
  })()`)
  assert(Boolean(tagHoverPoint), 'Failed to locate the tag-row hover test point')
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: tagHoverPoint.x,
    y: tagHoverPoint.y
  })
  await delay(40)

  results.tagHoverAfter = await cdp.evaluate(`(() => {
    const row = document.querySelectorAll(".tag-row")[2];
    if (!row || !row.matches(":hover")) return null;
    const style = getComputedStyle(row);
    return {
      borderBottomColor: style.borderBottomColor,
      borderBottomWidth: style.borderBottomWidth,
      outlineStyle: style.outlineStyle
    };
  })()`)
  assert(
    results.tagHoverBefore &&
      results.tagHoverAfter &&
      results.tagHoverAfter.borderBottomColor === results.tagHoverBefore.borderBottomColor &&
      results.tagHoverAfter.borderBottomWidth === results.tagHoverBefore.borderBottomWidth &&
      results.tagHoverAfter.outlineStyle === results.tagHoverBefore.outlineStyle,
    `Tag-row hover changes the neutral bottom divider: ${JSON.stringify({
      before: results.tagHoverBefore,
      after: results.tagHoverAfter
    })}`
  )

  // 分割线在默认、悬停与选中背景上都必须拥有实际宽度和可感知色差。
  const collectTagDividerState = (rowIndex) =>
    cdp.evaluate(`(() => {
      const row = document.querySelectorAll(".tag-row")[${rowIndex}];
      if (!row) return null;
      const rowStyle = getComputedStyle(row);
      const luminance = (value) => {
        const channels = value.match(/[\\d.]+/g)?.slice(0, 3).map(Number) ?? [
          0, 0, 0
        ];
        const linear = channels.map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const backgroundLuminance = luminance(rowStyle.backgroundColor);
      const rowHeight = row.getBoundingClientRect().height;
      return {
        rowBackground: rowStyle.backgroundColor,
        rowHeight,
        dividers: Array.from(row.children).slice(1).map((cell) => {
          const style = getComputedStyle(cell);
          const dividerLuminance = luminance(style.borderLeftColor);
          return {
            height: cell.getBoundingClientRect().height,
            width: Number.parseFloat(style.borderLeftWidth),
            style: style.borderLeftStyle,
            color: style.borderLeftColor,
            contrast:
              (Math.max(backgroundLuminance, dividerLuminance) + 0.05) /
              (Math.min(backgroundLuminance, dividerLuminance) + 0.05)
          };
        })
      };
    })()`)
  results.tagHoverDividers = await collectTagDividerState(2)

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await cdp.evaluate(`document.querySelectorAll(".tag-row")[1]?.click()`)
  await delay(40)
  results.tagSelectedDividers = await collectTagDividerState(1)
  const tagDividerIsVisible = (divider) =>
    divider.width >= 1 && divider.style !== 'none' && !divider.color.includes(', 0)') && divider.contrast >= 1.18
  assert(
    results.tagHoverDividers?.dividers.every(tagDividerIsVisible) &&
      results.tagSelectedDividers?.dividers.every(tagDividerIsVisible),
    `Tag rows lose column dividers when hovered or selected: ${JSON.stringify({
      hover: results.tagHoverDividers,
      selected: results.tagSelectedDividers
    })}`
  )
  const tagDividerFillsRow = (state) =>
    state.dividers.every((divider) => Math.abs(divider.height - state.rowHeight) <= 1)
  assert(
    tagDividerFillsRow(results.tagHoverDividers) && tagDividerFillsRow(results.tagSelectedDividers),
    `Tag-row divider heights differ between columns: ${JSON.stringify({
      hover: results.tagHoverDividers,
      selected: results.tagSelectedDividers
    })}`
  )

  results.tagSingleClick = await cdp.evaluate(`({
    selected:
      document.querySelector(".tag-row.is-selected .tag-row__identity strong")
        ?.textContent?.trim() ?? "",
    stillInTagView: Boolean(document.querySelector(".tag-overview")),
    hasToast: Boolean(document.querySelector(".toast"))
  })`)
  assert(
    results.tagSingleClick.selected === 'lighting/review-2' &&
      results.tagSingleClick.stillInTagView &&
      !results.tagSingleClick.hasToast,
    `A single tag click must not navigate to a revision: ${JSON.stringify(results.tagSingleClick)}`
  )

  await cdp.evaluate(`document.querySelector(".tag-row.is-selected")
    ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`)
  await delay(50)
  results.tagDoubleClick = await cdp.evaluate(`({
    historyVisible: Boolean(document.querySelector(".history-panel")),
    selectedRevision:
      document.querySelector(".revision-row.is-selected .revision-row__meta code")
        ?.textContent?.trim() ?? ""
  })`)
  assert(
    results.tagDoubleClick.historyVisible && results.tagDoubleClick.selectedRevision === '7aa51c94',
    `Double-clicking a tag did not locate the exact revision: ${JSON.stringify(results.tagDoubleClick)}`
  )

  await cdp.evaluate(`Array.from(document.querySelectorAll(".sidebar__primary button"))
    .find((button) => button.textContent?.includes("标签列表"))?.click()`)
  await delay(40)
  await cdp.evaluate(`(() => {
    const row = Array.from(document.querySelectorAll(".tag-row")).find((element) =>
      element.querySelector(".tag-row__identity strong")
        ?.textContent?.trim() === "release/meridian-0.8"
    );
    const bounds = row?.getBoundingClientRect();
    row?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: window.innerWidth - 2,
      clientY: Math.round(bounds?.bottom ?? 260)
    }));
  })()`)
  await delay(60)
  results.tagMenu = await cdp.evaluate(`(() => {
    const menu = document.querySelector(".tag-context-menu");
    const bounds = menu?.getBoundingClientRect();
    return {
      visible: Boolean(menu),
      labels: Array.from(menu?.querySelectorAll(":scope > button") ?? [])
        .map((button) => button.textContent?.replace(/\\s+/g, " ").trim()),
      withinViewport: Boolean(bounds) &&
        bounds.left >= 0 && bounds.top >= 0 &&
        bounds.right <= window.innerWidth && bounds.bottom <= window.innerHeight
    };
  })()`)
  for (const label of [
    '查看标签详情',
    '定位到修订',
    '修改标签',
    '删除标签',
    '复制标签名称',
    '复制修订 ID',
    '复制标签信息'
  ]) {
    assert(
      results.tagMenu.labels.some((text) => text?.includes(label)),
      `The tag menu is missing "${label}"`
    )
  }
  assert(
    results.tagMenu.visible && results.tagMenu.withinViewport,
    `The tag menu is not constrained to the viewport: ${JSON.stringify(results.tagMenu)}`
  )

  await cdp.evaluate(`Array.from(document.querySelectorAll(".tag-context-menu > button"))
    .find((button) => button.textContent?.includes("查看标签详情"))?.click()`)
  await delay(50)
  results.tagDetails = await cdp.evaluate(`({
    visible: Boolean(document.querySelector(".tag-details-dialog")),
    title:
      document.querySelector(".tag-details-dialog h2")?.textContent?.trim() ?? "",
    hasStableId:
      document.querySelector(".tag-details-id code")?.textContent
        ?.includes("tag-release") ?? false
  })`)
  assert(
    results.tagDetails.visible && results.tagDetails.title === 'release/meridian-0.8' && results.tagDetails.hasStableId,
    `The tag-details dialog is invalid: ${JSON.stringify(results.tagDetails)}`
  )
  await cdp.evaluate(`document.querySelector(".tag-details-dialog button[aria-label='关闭']")?.click()`)
  await delay(40)

  await cdp.evaluate(`(() => {
    const row = Array.from(document.querySelectorAll(".tag-row")).find((element) =>
      element.querySelector(".tag-row__identity strong")
        ?.textContent?.trim() === "release/meridian-0.8"
    );
    row?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: 700, clientY: 260
    }));
  })()`)
  await delay(40)
  await cdp.evaluate(`Array.from(document.querySelectorAll(".tag-context-menu > button"))
    .find((button) => button.textContent?.includes("修改标签"))?.click()`)
  await delay(40)
  results.tagEditDialog = await cdp.evaluate(`({
    visible: Boolean(document.querySelector(".tag-dialog")),
    name: document.querySelector(".tag-dialog input")?.value ?? "",
    message: document.querySelector(".tag-dialog textarea")?.value ?? "",
    targetLocked:
      document.querySelector(".tag-source em")?.textContent
        ?.includes("不会移动标签的目标修订") ?? false
  })`)
  assert(
    results.tagEditDialog.visible &&
      results.tagEditDialog.name === 'release/meridian-0.8' &&
      results.tagEditDialog.message.length > 0 &&
      results.tagEditDialog.targetLocked,
    `The tag-edit dialog is invalid: ${JSON.stringify(results.tagEditDialog)}`
  )
  await cdp.evaluate(`document.querySelector(".tag-dialog button[aria-label='关闭']")?.click()`)
  await delay(40)

  await cdp.evaluate(`Array.from(document.querySelectorAll(".tag-overview__actions > button"))
    .find((button) => button.textContent?.includes("新建标签"))?.click()`)
  await delay(40)
  results.workspaceTagDialog = await cdp.evaluate(`(() => {
    const source = document.querySelector(".tag-source");
    return {
      visible: Boolean(document.querySelector(".tag-dialog")),
      branch: source?.querySelector("strong")?.textContent?.trim() ?? "",
      revision: source?.querySelector("code")?.textContent?.trim() ?? "",
      sharedNotice:
        document.querySelector(".tag-dialog__persistence")?.textContent
          ?.includes("Lore 仓库共享元数据") ?? false
    };
  })()`)
  assert(
    results.workspaceTagDialog.visible &&
      results.workspaceTagDialog.branch === 'world/lighting-pass' &&
      results.workspaceTagDialog.revision === 'c7f3a81d' &&
      results.workspaceTagDialog.sharedNotice,
    `The workspace create-tag dialog is invalid: ${JSON.stringify(results.workspaceTagDialog)}`
  )
  await cdp.evaluate(`document.querySelector(".tag-dialog button[aria-label='关闭']")?.click()`)
  await delay(40)

  await cdp.evaluate(`
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      bubbles: true
    }))
  `)
  await delay(60)
  results.commandPalette = await cdp.evaluate(`Boolean(document.querySelector(".command-palette"))`)
  assert(results.commandPalette, 'Ctrl+K did not open the command palette')

  await cdp.evaluate(`
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true
    }));
    document.querySelector('button[aria-label="服务器设置"]')?.click()
  `)
  await delay(60)
  results.serverDialog = await cdp.evaluate(`({
    visible: Boolean(document.querySelector(".server-dialog")),
    serverUrl: document.querySelector("#lore-server-url")?.value ?? "",
    hasReadableError: Boolean(document.querySelector(".server-dialog__empty.is-error"))
  })`)
  assert(results.serverDialog.visible, 'The server repository panel did not open')
  assert(
    results.serverDialog.hasReadableError,
    'Browser demo mode did not display an explicit server-connection limitation'
  )
  /*
   * 服务器仓库地址是临时浏览草稿。先改成与仓库配置不同的值，后续打开
   * Shared Store 时验证该草稿不会再通过 App 共享状态泄漏过去。
   */
  await cdp.evaluate(`(() => {
    const input = document.querySelector("#lore-server-url");
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, "lore://temporary-browser:41337");
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  })()`)
  await cdp.evaluate(`document.querySelector(".server-dialog__header .icon-button")?.click()`)
  await delay(40)

  await cdp.evaluate(`document.querySelector('button[aria-label="全局搜索"]')?.click()`)
  await delay(50)
  results.search = await cdp.evaluate(`(() => {
    const input = document.querySelector(".search-dialog input");
    if (!input) return { visible: false, results: 0 };
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, "lighting");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return { visible: true };
  })()`)
  await delay(50)
  results.search.results = await cdp.evaluate(`document.querySelectorAll(".search-results > button").length`)
  assert(results.search.visible && results.search.results > 0, 'Repository search returned no matching results')
  await cdp.evaluate(`document.querySelector(".search-dialog__input > button")?.click()`)
  await delay(40)

  await cdp.evaluate(`document.querySelector('button[aria-label="客户端设置"]')?.click()`)
  await delay(50)
  results.settings = await cdp.evaluate(`({
    visible: Boolean(document.querySelector(".settings-dialog")),
    categories: document.querySelectorAll(
      ".settings-categories > button[role=\\"tab\\"]"
    ).length,
    activePanel: document.querySelector(
      '.settings-page[role="tabpanel"]:not([hidden])'
    )?.id ?? null,
    themeOptions: document.querySelectorAll(
      ".theme-options:not(.language-options) button"
    ).length
  })`)
  assert(
    results.settings.visible &&
      results.settings.categories === 5 &&
      results.settings.activePanel === 'settings-panel-general' &&
      results.settings.themeOptions === 3,
    `The settings panel category workspace is invalid: ${JSON.stringify(results.settings)}`
  )
  await cdp.evaluate(`(() => {
    const activeTab = document.querySelector(
      '.settings-categories > button[aria-selected="true"]'
    );
    activeTab?.focus();
    activeTab?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true
    }));
  })()`)
  await delay(40)
  Object.assign(
    results.settings,
    await cdp.evaluate(`({
    identityPanelVisible: !document.querySelector(
      "#settings-panel-identity"
    )?.hidden,
    defaultIdentityAuthor: Boolean(
      document.querySelector('input[aria-label="默认提交作者名"]')
    ),
    defaultIdentityEmail: Boolean(
      document.querySelector('input[aria-label="默认提交邮箱"]')
    ),
    defaultIdentityAvatar: Boolean(
      document.querySelector(
        "#settings-panel-identity .revision-author-avatar"
      )
    )
  })`)
  )
  assert(
    results.settings.identityPanelVisible &&
      results.settings.defaultIdentityAuthor &&
      results.settings.defaultIdentityEmail &&
      results.settings.defaultIdentityAvatar,
    `The settings panel cannot switch to default commit identity: ${JSON.stringify(results.settings)}`
  )
  await cdp.evaluate(`Array.from(document.querySelectorAll(".settings-categories > button"))
    .find((button) => button.textContent.includes("集成"))
    ?.click()`)
  await delay(40)
  Object.assign(
    results.settings,
    await cdp.evaluate(`(() => {
      const panel = document.querySelector("#settings-panel-integrations");
      return {
        integrationsPanelVisible: panel instanceof HTMLElement && !panel.hidden,
        externalToolGroups: panel?.querySelectorAll(".settings-external-tools").length ?? 0,
        configuredToolRows: panel?.querySelectorAll(".settings-external-tools__list > button").length ?? 0
      };
    })()`)
  )
  await delay(40)
  Object.assign(
    results.settings,
    await cdp.evaluate(`({
      externalDiffNameInput: Boolean(
        document.querySelector("#settings-panel-integrations .settings-external-diff__field input")
      ),
      externalDiffExecutableInput: document.querySelectorAll(
        "#settings-panel-integrations .settings-external-diff__field input"
      ).length >= 2,
      externalDiffArgumentTemplate:
        document.querySelectorAll("#settings-panel-integrations textarea").length >= 2
    })`)
  )
  assert(
    results.settings.integrationsPanelVisible &&
      results.settings.externalToolGroups === 2 &&
      results.settings.configuredToolRows >= 8 &&
      results.settings.externalDiffNameInput &&
      results.settings.externalDiffExecutableInput &&
      results.settings.externalDiffArgumentTemplate,
    `The external Diff integration editor is incomplete: ${JSON.stringify(results.settings)}`
  )
  await cdp.evaluate(`Array.from(document.querySelectorAll(".settings-categories > button"))
    .find((button) => button.textContent.includes("存储"))
    ?.click()`)
  await delay(40)
  results.sharedStoreEndpointRoles = await cdp.evaluate(`(() => {
    const panel = document.querySelector("#settings-panel-storage");
    const input = panel?.querySelector(".settings-shared-store__create input");
    const label = input?.closest("label");
    return {
      visible: panel instanceof HTMLElement && !panel.hidden,
      value: input instanceof HTMLInputElement ? input.value : "",
      label: label?.querySelector(":scope > span")?.textContent?.trim() ?? "",
      hint: label?.querySelector(":scope > small")?.textContent?.trim() ?? ""
    };
  })()`)
  assert(
    results.sharedStoreEndpointRoles.visible &&
      results.sharedStoreEndpointRoles.value === results.serverDialog.serverUrl &&
      results.sharedStoreEndpointRoles.value !== 'lore://temporary-browser:41337' &&
      results.sharedStoreEndpointRoles.label === 'Shared Store 目标服务器' &&
      results.sharedStoreEndpointRoles.hint.includes('仅用于本次创建'),
    `Shared Store unexpectedly reused the temporary server-browser draft: ${JSON.stringify(results.sharedStoreEndpointRoles)}`
  )
  await cdp.evaluate(`Array.from(document.querySelectorAll(".settings-categories > button"))
    .find((button) => button.textContent.includes("维护"))
    ?.click()`)
  await delay(40)
  results.automaticUpdateCheck = await cdp.evaluate(`(() => {
    const panel = document.querySelector("#settings-panel-maintenance");
    const preference = panel?.querySelector(".settings-update-preference");
    const preferenceCopy = preference?.querySelector(":scope > span");
    const checkbox = panel?.querySelector(
      '.settings-update-preference input[type="checkbox"]'
    );
    const updateRow = panel?.querySelector(".settings-update");
    const manualButton = Array.from(panel?.querySelectorAll(".settings-update button") ?? [])
      .find((button) => button.textContent?.includes("检查更新"));
    if (
      !(preference instanceof HTMLElement) ||
      !(preferenceCopy instanceof HTMLElement) ||
      !(checkbox instanceof HTMLInputElement)
    ) {
      return { visible: false };
    }
    const checkboxRect = checkbox.getBoundingClientRect();
    const preferenceCopyRect = preferenceCopy.getBoundingClientRect();
    const preferenceRect = preference.getBoundingClientRect();
    const initiallyChecked = checkbox.checked;
    checkbox.click();
    const checkedAfterDisable = checkbox.checked;
    checkbox.click();
    return {
      visible: panel instanceof HTMLElement && !panel.hidden,
      initiallyChecked,
      checkedAfterDisable,
      checkedAfterRestore: checkbox.checked,
      manualActionPresent: Boolean(manualButton),
      checkboxAfterCopy: Boolean(
        preferenceCopy.compareDocumentPosition(checkbox) & Node.DOCUMENT_POSITION_FOLLOWING
      ),
      checkboxAtRowEnd:
        checkboxRect.left > preferenceCopyRect.right &&
        Math.abs(preferenceRect.right - checkboxRect.right) <= 1,
      decorativeUpdateIconRemoved: !updateRow?.querySelector(".settings-update__icon")
    };
  })()`)
  assert(
    results.automaticUpdateCheck.visible &&
      results.automaticUpdateCheck.initiallyChecked &&
      !results.automaticUpdateCheck.checkedAfterDisable &&
      results.automaticUpdateCheck.checkedAfterRestore &&
      results.automaticUpdateCheck.manualActionPresent &&
      results.automaticUpdateCheck.checkboxAfterCopy &&
      results.automaticUpdateCheck.checkboxAtRowEnd &&
      results.automaticUpdateCheck.decorativeUpdateIconRemoved,
    `Automatic update preference is not wired to the settings UI: ${JSON.stringify(results.automaticUpdateCheck)}`
  )
  await cdp.evaluate(`(() => {
    const authorInput = document.querySelector(
      'input[aria-label="默认提交作者名"]'
    );
    const emailInput = document.querySelector(
      'input[aria-label="默认提交邮箱"]'
    );
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(authorInput, "Client Default");
    authorInput?.dispatchEvent(new Event("input", { bubbles: true }));
    setter?.call(emailInput, "client-default@example.com");
    emailInput?.dispatchEvent(new Event("input", { bubbles: true }));
  })()`)
  await cdp.evaluate(`document.querySelector(".settings-dialog .task-dialog__header > button")?.click()`)
  await delay(40)

  await cdp.evaluate(`Array.from(document.querySelectorAll(".tree-row"))
    .find((button) => button.textContent.includes("账户"))
    ?.click()`)
  await delay(50)
  results.sidebarAccountShortcut = await cdp.evaluate(
    `document.querySelector('#repository-tool-tab-accounts[aria-selected="true"]')?.textContent?.trim() ?? ""`
  )
  assert(
    results.sidebarAccountShortcut === '账户',
    `The sidebar account shortcut did not open the Accounts tool: ${results.sidebarAccountShortcut}`
  )
  // 窄窗口会让远端服务器帮助文字换行，曾因此把相邻登录按钮向下推移。
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 650,
    deviceScaleFactor: 1,
    mobile: false
  })
  await delay(40)
  results.accountCenter = await cdp.evaluate(`(() => {
    const input = document.querySelector(
      ".auth-account-manager__remote-controls input"
    );
    const browserSignInButton = document.querySelector(
      ".auth-account-manager__remote-controls > button"
    );
    const manager = document.querySelector(".auth-account-manager");
    const sidebar = document.querySelector(".auth-account-manager__sidebar");
    const detail = document.querySelector(".auth-account-manager__detail");
    const addButton = document.querySelector(
      '.auth-account-manager__sidebar button[aria-label="添加账户"]'
    );
    const inputRect = input?.getBoundingClientRect();
    const browserSignInButtonRect =
      browserSignInButton?.getBoundingClientRect();
    return {
      editable: input instanceof HTMLInputElement && !input.readOnly,
      value: input instanceof HTMLInputElement ? input.value : "",
      hasDeviceHint:
        input?.closest(".auth-account-manager__login")?.textContent?.includes("登录不依赖本地仓库") ??
        false,
      hasTwoPaneLayout:
        manager instanceof HTMLElement &&
        sidebar instanceof HTMLElement &&
        detail instanceof HTMLElement,
      hasAddAccount: addButton instanceof HTMLButtonElement,
      // 浏览器登录按钮与服务器输入框属于同一操作行，必须同时对齐上下边缘。
      browserSignInAligned:
        inputRect !== undefined &&
        browserSignInButtonRect !== undefined &&
        Math.abs(inputRect.top - browserSignInButtonRect.top) <= 1 &&
        Math.abs(inputRect.bottom - browserSignInButtonRect.bottom) <= 1,
      browserSignInOffset:
        inputRect !== undefined && browserSignInButtonRect !== undefined
          ? {
              top: browserSignInButtonRect.top - inputRect.top,
              bottom: browserSignInButtonRect.bottom - inputRect.bottom
            }
          : null
    };
  })()`)
  assert(
    results.accountCenter.editable &&
      results.accountCenter.hasDeviceHint &&
      results.accountCenter.hasTwoPaneLayout &&
      results.accountCenter.hasAddAccount &&
      results.accountCenter.browserSignInAligned,
    `Accounts did not expose the device-level account center: ${JSON.stringify(results.accountCenter)}`
  )
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await delay(40)
  await cdp.evaluate(`document.querySelector('button[aria-label="关闭仓库工具"]')?.click()`)
  await delay(40)
  await cdp.evaluate(`Array.from(document.querySelectorAll(".tree-row"))
    .find((button) => button.textContent.includes("仓库配置"))
    ?.click()`)
  await delay(50)
  results.repositoryConfiguration = await cdp.evaluate(`(() => {
    const identityAuthor = document.querySelector(
      'input[aria-label="仓库提交作者名"]'
    );
    const identityEmail = document.querySelector(
      'input[aria-label="仓库提交邮箱"]'
    );
    const remoteUrl = document.querySelector(
      'input[aria-label="Lore 服务器根地址"]'
    );
    const publishButtons = Array.from(
      document.querySelectorAll(".repository-publish footer button")
    );
    return {
      visible: Boolean(document.querySelector(".repository-configuration")),
      hasIdentity: Boolean(identityAuthor && identityEmail),
      hasRemoteUrl: Boolean(remoteUrl),
      settingsContainsSubmit: Boolean(
        document.querySelector(
          '.repository-configuration__settings button[type="submit"]'
        )
      ),
      settingsBeforePublish:
        Boolean(document.querySelector(".repository-configuration__settings")) &&
        Boolean(document.querySelector(".repository-publish")) &&
        Boolean(
          document
            .querySelector(".repository-configuration__settings")
            ?.compareDocumentPosition(
              document.querySelector(".repository-publish")
            ) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
      hasPublishSection: Boolean(document.querySelector(".repository-publish")),
      publishActions: publishButtons.map((button) => ({
        text: button.textContent?.trim() ?? "",
        disabled: button.disabled
      })),
      resolution:
        document.querySelector(".repository-configuration__resolution")
          ?.textContent ?? ""
    };
  })()`)
  assert(
    results.repositoryConfiguration.visible &&
      results.repositoryConfiguration.hasIdentity &&
      results.repositoryConfiguration.hasRemoteUrl &&
      results.repositoryConfiguration.settingsContainsSubmit &&
      results.repositoryConfiguration.settingsBeforePublish &&
      results.repositoryConfiguration.hasPublishSection &&
      results.repositoryConfiguration.publishActions.length === 2 &&
      results.repositoryConfiguration.publishActions.every((button) => button.disabled) &&
      results.repositoryConfiguration.resolution.includes('client-default@example.com'),
    `Repository configuration did not display the client default identity fallback correctly: ${JSON.stringify(
      results.repositoryConfiguration
    )}`
  )
  await cdp.evaluate(`(() => {
    const identityAuthor = document.querySelector(
      'input[aria-label="仓库提交作者名"]'
    );
    const identityEmail = document.querySelector(
      'input[aria-label="仓库提交邮箱"]'
    );
    const remoteUrl = document.querySelector(
      'input[aria-label="Lore 服务器根地址"]'
    );
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(identityAuthor, "Repository Author");
    identityAuthor?.dispatchEvent(new Event("input", { bubbles: true }));
    setter?.call(identityEmail, "repository@example.com");
    identityEmail?.dispatchEvent(new Event("input", { bubbles: true }));
    setter?.call(remoteUrl, "lore://127.0.0.1:41337");
    remoteUrl?.dispatchEvent(new Event("input", { bubbles: true }));
  })()`)
  await delay(40)
  Object.assign(
    results.repositoryConfiguration,
    await cdp.evaluate(`(() => {
      const button = document.querySelector(
        '.repository-configuration__settings button[type="submit"]'
      );
      return {
        saveActionEnabled: button instanceof HTMLButtonElement && !button.disabled,
        saveActionBackground:
          button instanceof HTMLElement
            ? getComputedStyle(button).backgroundColor
            : ""
      };
    })()`)
  )
  assert(
    results.repositoryConfiguration.saveActionEnabled &&
      results.repositoryConfiguration.saveActionBackground === 'rgb(120, 164, 255)',
    `The repository configuration primary action does not use the brand blue style: ${JSON.stringify(
      results.repositoryConfiguration
    )}`
  )
  await cdp.evaluate(`document.querySelector('.repository-configuration button[type="submit"]')?.click()`)
  await delay(50)
  results.repositoryConfigurationSaved = await cdp.evaluate(`({
    identityAuthor:
      document.querySelector('input[aria-label="仓库提交作者名"]')?.value ?? "",
    identityEmail:
      document.querySelector('input[aria-label="仓库提交邮箱"]')?.value ?? "",
    remoteUrl:
      document.querySelector('input[aria-label="Lore 服务器根地址"]')?.value ?? "",
    resolution:
      document.querySelector(".repository-configuration__resolution")
        ?.textContent ?? ""
  })`)
  assert(
    results.repositoryConfigurationSaved.identityAuthor === 'Repository Author' &&
      results.repositoryConfigurationSaved.identityEmail === 'repository@example.com' &&
      results.repositoryConfigurationSaved.remoteUrl === 'lore://127.0.0.1:41337' &&
      results.repositoryConfigurationSaved.resolution.includes('（仓库）'),
    `Repository configuration did not refresh the effective source after saving: ${JSON.stringify(
      results.repositoryConfigurationSaved
    )}`
  )
  await cdp.evaluate(`(() => {
    const identityAuthor = document.querySelector(
      'input[aria-label="仓库提交作者名"]'
    );
    const identityEmail = document.querySelector(
      'input[aria-label="仓库提交邮箱"]'
    );
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(identityAuthor, "");
    identityAuthor?.dispatchEvent(new Event("input", { bubbles: true }));
    setter?.call(identityEmail, "");
    identityEmail?.dispatchEvent(new Event("input", { bubbles: true }));
  })()`)
  await delay(40)
  await cdp.evaluate(`document.querySelector('.repository-configuration button[type="submit"]')?.click()`)
  await delay(50)
  results.repositoryIdentityCleared = await cdp.evaluate(
    `document.querySelector(".repository-configuration__resolution")?.textContent ?? ""`
  )
  assert(
    results.repositoryIdentityCleared.includes('client-default@example.com') &&
      results.repositoryIdentityCleared.includes('（客户端默认）'),
    `Clearing the repository identity did not fall back to the client default: ${results.repositoryIdentityCleared}`
  )
  await cdp.evaluate(`document.querySelector('button[aria-label="关闭仓库工具"]')?.click()`)
  await delay(40)

  // 操作记录已从侧栏主导航收敛到命令面板；通过当前真实入口打开，
  // 避免继续依赖已经移除的“操作队列”按钮。
  await cdp.evaluate(`document.querySelector(".toolbar-action--compact")?.click()`)
  await delay(40)
  await cdp.evaluate(
    `Array.from(document.querySelectorAll(".command-palette button"))
      .find((button) => button.textContent?.includes("查看操作记录"))
      ?.click()`
  )
  await delay(50)
  results.operations = await cdp.evaluate(`(() => {
    const dialog = document.querySelector(".operation-dialog");
    return {
      visible: Boolean(dialog),
      streamRecords: dialog?.querySelectorAll(".operation-streams > article").length ?? 0,
      streamExplanationHeader: Boolean(dialog?.querySelector(".operation-streams > header")),
      containsRemovedExplanation:
        dialog?.textContent?.includes("实时 Lore 事件流") ||
        dialog?.textContent?.includes("Live Lore Event Stream") ||
        false
    };
  })()`)
  assert(
    results.operations.visible &&
      !results.operations.streamExplanationHeader &&
      !results.operations.containsRemovedExplanation,
    `The operation history stream explanation was not removed: ${JSON.stringify(results.operations)}`
  )

  await cdp.evaluate(`document.querySelector('button[aria-label="关闭操作记录"]')?.click()`)
  await delay(40)
  await cdp.evaluate(`document.querySelector('button[aria-label="关于 Lore Client"]')?.click()`)
  await delay(50)
  results.aboutBranding = await cdp.evaluate(`({
    visible: Boolean(document.querySelector('#about-title')),
    operationVisible: Boolean(document.querySelector(".operation-dialog")),
    triggerPresent: Boolean(
      document.querySelector('button[aria-label="关于 Lore Client"]')
    ),
    appIcon: Boolean(
      document.querySelector(
        'section[aria-labelledby="about-title"] img[data-app-icon="true"]'
      )
    )
  })`)
  assert(
    results.aboutBranding.visible && results.aboutBranding.appIcon,
    `The About page did not use the application icon: ${JSON.stringify(results.aboutBranding)}`
  )
  await cdp.evaluate(`document.querySelector('button[aria-label="关闭关于"]')?.click()`)
  await delay(40)

  // 逐个关闭仓库标签，进入真正的空工作区，而不是构造脱离 React 的测试节点。
  for (let index = 0; index < 6; index += 1) {
    const closed = await cdp.evaluate(`(() => {
      const button = document.querySelector(
        '.repository-tab button[aria-label^="关闭仓库"]'
      );
      if (!button) return false;
      button.click();
      return true;
    })()`)
    if (!closed) break
    await delay(35)
  }
  results.repositoryWelcome = await cdp.evaluate(`(() => {
    // Chromium 可能按 rgb(...) 或 CSS Color 4 的 color(srgb ...) 返回计算色值；
    // 统一归一化到 0~1，避免把合法的浅色 srgb 数值再次除以 255。
    const parseNormalizedRgb = (value) => {
      const channels = value.match(/[\\d.]+/g)?.slice(0, 3).map(Number) ?? [
        0, 0, 0
      ];
      return value.startsWith("color(srgb")
        ? channels
        : channels.map((channel) => channel / 255);
    };
    const luminance = (value) => {
      const [red, green, blue] = parseNormalizedRgb(value).map((channel) => {
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    const welcome = document.querySelector(".repository-welcome");
    const mark = document.querySelector(".repository-welcome__mark");
    const markIcon = document.querySelector(
      '.repository-welcome__mark img[data-app-icon="true"]'
    );
    const buttons = Array.from(
      document.querySelectorAll(".repository-welcome__actions button")
    );
    const markStyle = mark ? getComputedStyle(mark) : null;
    const markBackground = markStyle?.backgroundColor ?? "";
    const markBounds = mark?.getBoundingClientRect();
    const markIconBounds = markIcon?.getBoundingClientRect();
    const buttonBackgrounds = buttons.map(
      (button) => getComputedStyle(button).backgroundColor
    );
    const buttonAudits = buttons.map((button) => {
      const background = getComputedStyle(button).backgroundColor;
      const channels = parseNormalizedRgb(background);
      const expectedAccent = [120 / 255, 164 / 255, 255 / 255];
      return {
        // 欢迎页以默认按钮为主操作、is-secondary 为次操作，不额外重复 is-primary。
        primary: !button.classList.contains("is-secondary"),
        luminance: luminance(background),
        // 浅色主题允许明确的主操作使用品牌蓝，其他操作仍必须保留浅色表面。
        usesBrandBlue: channels.every(
          (channel, index) =>
            Math.abs(channel - expectedAccent[index]) <= 0.01
        )
      };
    });
    return {
      visible: Boolean(welcome),
      appIcon: Boolean(markIcon),
      theme: document.documentElement.dataset.theme ?? "",
      markBackground,
      // 欢迎页直接展示透明 SVG；容器不得重新添加卡片边框、表面色或阴影。
      markTransparent: markBackground === "rgba(0, 0, 0, 0)",
      markBorderWidths: markStyle
        ? [
            markStyle.borderTopWidth,
            markStyle.borderRightWidth,
            markStyle.borderBottomWidth,
            markStyle.borderLeftWidth
          ]
        : [],
      markBoxShadow: markStyle?.boxShadow ?? "",
      markWidth: markBounds?.width ?? 0,
      markIconWidth: markIconBounds?.width ?? 0,
      buttonBackgrounds,
      buttonAudits
    };
  })()`)
  assert(
    results.repositoryWelcome.visible &&
      results.repositoryWelcome.theme === 'light' &&
      results.repositoryWelcome.appIcon &&
      results.repositoryWelcome.markTransparent &&
      results.repositoryWelcome.markBorderWidths.every((width) => width === '0px') &&
      results.repositoryWelcome.markBoxShadow === 'none' &&
      results.repositoryWelcome.markWidth >= 96 &&
      results.repositoryWelcome.markIconWidth >= 88 &&
      results.repositoryWelcome.buttonAudits.every((button) =>
        button.primary ? button.usesBrandBlue : button.luminance >= 0.55
      ),
    `The empty light-theme page still uses a decorated, undersized, or placeholder icon: ${JSON.stringify(
      results.repositoryWelcome
    )}`
  )

  /*
   * 纯前端依赖图夹具必须复用 browser-demo 环境边界。重新导航后仍通过真实
   * “仓库工具 → 依赖”入口进入，避免测试直接写 DOM 或调用内部 state 伪造图。
   * 真实 Lore 写按钮必须继续保持禁用。
   */
  await cdp.send('Page.navigate', { url: applicationUrl })
  await waitForApplication(cdp)
  await cdp.evaluate(`document.querySelector('button[aria-label="切换到深色主题"]')?.click()`)
  await delay(40)
  await cdp.evaluate(`Array.from(
    document.querySelectorAll(".sidebar__scroll .tree-row--root")
  ).find((button) => button.textContent?.includes("仓库工具"))?.click()`)
  await delay(50)
  await cdp.evaluate(`Array.from(
    document.querySelectorAll(".tools-dialog__nav button")
  ).find((button) => button.textContent?.includes("依赖"))?.click()`)
  await delay(60)
  results.dependencyGraphFixture = await cdp.evaluate(`(() => {
    const selectedTab = document.querySelector(
      '.tools-dialog__nav button[aria-selected="true"]'
    );
    const queryButton = Array.from(
      document.querySelectorAll(".dependency-query button")
    ).find((button) => button.textContent?.includes("查询依赖"));
    const cycleWarning = document.querySelector(".dependency-cycle-warning");
    return {
      url: location.href,
      dialogVisible: Boolean(document.querySelector(".tools-dialog")),
      selectedTab: selectedTab?.textContent?.trim() ?? "",
      nodeCount: document.querySelectorAll(
        ".dependency-visualizer__node"
      ).length,
      edgeCount: document.querySelectorAll(
        ".dependency-visualizer__edge"
      ).length,
      cycleVisible: Boolean(cycleWarning),
      cycleText: cycleWarning?.textContent?.trim() ?? "",
      selectedPath:
        document.querySelector(
          ".dependency-visualizer__selected-path"
        )?.textContent?.trim() ?? "",
      queryDisabled: queryButton instanceof HTMLButtonElement
        ? queryButton.disabled
        : null,
      documentOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth
    };
  })()`)
  assert(
    results.dependencyGraphFixture.url === applicationUrl &&
      results.dependencyGraphFixture.dialogVisible &&
      results.dependencyGraphFixture.selectedTab === '依赖' &&
      results.dependencyGraphFixture.nodeCount === 6 &&
      results.dependencyGraphFixture.edgeCount === 7 &&
      results.dependencyGraphFixture.cycleVisible &&
      results.dependencyGraphFixture.cycleText.includes('Terrain.material') &&
      results.dependencyGraphFixture.selectedPath === 'Content/Maps/Meridian.umap' &&
      results.dependencyGraphFixture.queryDisabled === true &&
      !results.dependencyGraphFixture.documentOverflow,
    `The browser dependency graph fixture did not render safely: ${JSON.stringify(results.dependencyGraphFixture)}`
  )

  /*
   * 用真实 CDP 鼠标事件覆盖画布交互。从不命中节点或边的空白处开始拖拽，在同一次
   * Pointer Capture 内分别向右下与左上移动，验证二维自由平移不受内容尺寸限制；
   * 随后滚轮放大，并确认鼠标下的横纵图坐标均保持稳定。
   */
  results.dependencyGraphInteractionBefore = await cdp.evaluate(`(() => {
    const viewport = document.querySelector(".dependency-visualizer__viewport");
    const canvas = document.querySelector(".dependency-visualizer__canvas");
    const line = document.querySelector(
      ".dependency-visualizer__edge:not(.is-cycle):not(.is-selected) .dependency-visualizer__edge-line"
    );
    const markerPath = document.querySelector("#dependency-graph-arrow path");
    if (
      !(viewport instanceof HTMLElement) ||
      !(canvas instanceof HTMLElement) ||
      !(line instanceof SVGPathElement)
    ) return null;
    viewport.scrollIntoView({ block: "center", inline: "nearest" });
    const bounds = viewport.getBoundingClientRect();
    const candidates = [];
    for (let y = bounds.top + 90; y <= bounds.bottom - 90; y += 24) {
      for (let x = bounds.left + 90; x <= bounds.right - 90; x += 28) {
        const target = document.elementFromPoint(x, y);
        if (
          target instanceof Element &&
          viewport.contains(target) &&
          !target.closest(
            ".dependency-visualizer__node, .dependency-visualizer__edge"
          )
        ) {
          candidates.push({ x: Math.round(x), y: Math.round(y) });
        }
      }
    }
    const panPoint = candidates.at(-1);
    const cameraStyle = getComputedStyle(canvas);
    const themeProbe = document.createElement("span");
    themeProbe.style.color = "var(--text-dim)";
    document.body.append(themeProbe);
    const themeEdgeColor = getComputedStyle(themeProbe).color;
    themeProbe.remove();
    return {
      panPointFound: Boolean(panPoint),
      x: panPoint?.x ?? Math.round(bounds.left + bounds.width / 2),
      y: panPoint?.y ?? Math.round(bounds.top + bounds.height / 2),
      wheelX: Math.round(bounds.left + bounds.width * 0.55),
      wheelY: Math.round(bounds.top + bounds.height * 0.5),
      pointerOffsetX: bounds.width * 0.55,
      pointerOffsetY: bounds.height * 0.5,
      panX: Number.parseFloat(
        cameraStyle.getPropertyValue("--dependency-graph-pan-x")
      ),
      panY: Number.parseFloat(
        cameraStyle.getPropertyValue("--dependency-graph-pan-y")
      ),
      zoom: Number(cameraStyle.getPropertyValue("--dependency-graph-zoom")),
      willChange: cameraStyle.willChange,
      edgeStroke: getComputedStyle(line).stroke,
      themeEdgeColor,
      markerFill: markerPath?.getAttribute("fill") ?? ""
    };
  })()`)
  assert(
    results.dependencyGraphInteractionBefore &&
      results.dependencyGraphInteractionBefore.panPointFound &&
      results.dependencyGraphInteractionBefore.willChange === 'auto' &&
      results.dependencyGraphInteractionBefore.markerFill === 'context-stroke' &&
      results.dependencyGraphInteractionBefore.edgeStroke === results.dependencyGraphInteractionBefore.themeEdgeColor,
    `The dependency graph canvas still forces blurry compositing or its arrow did not inherit the dark-theme edge color: ${JSON.stringify(
      results.dependencyGraphInteractionBefore
    )}`
  )
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: results.dependencyGraphInteractionBefore.x,
    y: results.dependencyGraphInteractionBefore.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: results.dependencyGraphInteractionBefore.x + 70,
    y: results.dependencyGraphInteractionBefore.y + 50,
    button: 'left',
    buttons: 1
  })
  await delay(40)
  results.dependencyGraphPanPositive = await cdp.evaluate(`(() => {
    const canvas = document.querySelector(".dependency-visualizer__canvas");
    if (!(canvas instanceof HTMLElement)) return null;
    const style = getComputedStyle(canvas);
    return {
      panX: Number.parseFloat(style.getPropertyValue("--dependency-graph-pan-x")),
      panY: Number.parseFloat(style.getPropertyValue("--dependency-graph-pan-y"))
    };
  })()`)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: results.dependencyGraphInteractionBefore.x - 50,
    y: results.dependencyGraphInteractionBefore.y - 40,
    button: 'left',
    buttons: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: results.dependencyGraphInteractionBefore.x - 50,
    y: results.dependencyGraphInteractionBefore.y - 40,
    button: 'left',
    buttons: 0,
    clickCount: 1
  })
  await delay(40)
  results.dependencyGraphPan = await cdp.evaluate(`(() => {
    const viewport = document.querySelector(".dependency-visualizer__viewport");
    const canvas = document.querySelector(".dependency-visualizer__canvas");
    if (!(viewport instanceof HTMLElement) || !(canvas instanceof HTMLElement)) return null;
    const style = getComputedStyle(canvas);
    return {
      panX: Number.parseFloat(style.getPropertyValue("--dependency-graph-pan-x")),
      panY: Number.parseFloat(style.getPropertyValue("--dependency-graph-pan-y")),
      panning: viewport.classList.contains("is-panning")
    };
  })()`)
  assert(
    results.dependencyGraphPanPositive &&
      results.dependencyGraphPanPositive.panX > 50 &&
      results.dependencyGraphPanPositive.panY > 35 &&
      results.dependencyGraphPan &&
      results.dependencyGraphPan.panX < -35 &&
      results.dependencyGraphPan.panY < -25 &&
      !results.dependencyGraphPan.panning,
    `Dragging the dependency graph canvas did not pan in both axes: ${JSON.stringify({
      positive: results.dependencyGraphPanPositive,
      negative: results.dependencyGraphPan
    })}`
  )

  results.dependencyGraphWheelBefore = await cdp.evaluate(`(() => {
    const viewport = document.querySelector(".dependency-visualizer__viewport");
    const canvas = document.querySelector(".dependency-visualizer__canvas");
    if (!(viewport instanceof HTMLElement) || !(canvas instanceof HTMLElement)) return null;
    const zoom = Number(getComputedStyle(canvas).getPropertyValue("--dependency-graph-zoom"));
    const panX = Number.parseFloat(
      getComputedStyle(canvas).getPropertyValue("--dependency-graph-pan-x")
    );
    const panY = Number.parseFloat(
      getComputedStyle(canvas).getPropertyValue("--dependency-graph-pan-y")
    );
    return {
      panX,
      panY,
      zoom,
      graphX: (${JSON.stringify(results.dependencyGraphInteractionBefore.pointerOffsetX)} - panX) / zoom,
      graphY: (${JSON.stringify(results.dependencyGraphInteractionBefore.pointerOffsetY)} - panY) / zoom
    };
  })()`)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: results.dependencyGraphInteractionBefore.wheelX,
    y: results.dependencyGraphInteractionBefore.wheelY,
    deltaX: 0,
    deltaY: -120
  })
  await delay(80)
  results.dependencyGraphWheelAfter = await cdp.evaluate(`(() => {
    const viewport = document.querySelector(".dependency-visualizer__viewport");
    const canvas = document.querySelector(".dependency-visualizer__canvas");
    if (!(viewport instanceof HTMLElement) || !(canvas instanceof HTMLElement)) return null;
    const zoom = Number(getComputedStyle(canvas).getPropertyValue("--dependency-graph-zoom"));
    const panX = Number.parseFloat(
      getComputedStyle(canvas).getPropertyValue("--dependency-graph-pan-x")
    );
    const panY = Number.parseFloat(
      getComputedStyle(canvas).getPropertyValue("--dependency-graph-pan-y")
    );
    return {
      panX,
      panY,
      zoom,
      graphX: (${JSON.stringify(results.dependencyGraphInteractionBefore.pointerOffsetX)} - panX) / zoom,
      graphY: (${JSON.stringify(results.dependencyGraphInteractionBefore.pointerOffsetY)} - panY) / zoom
    };
  })()`)
  assert(
    results.dependencyGraphWheelBefore &&
      results.dependencyGraphWheelAfter &&
      results.dependencyGraphWheelAfter.zoom > results.dependencyGraphWheelBefore.zoom &&
      Math.abs(results.dependencyGraphWheelAfter.graphX - results.dependencyGraphWheelBefore.graphX) < 2 &&
      Math.abs(results.dependencyGraphWheelAfter.graphY - results.dependencyGraphWheelBefore.graphY) < 2,
    `The dependency graph wheel zoom did not preserve the pointer anchor: ${JSON.stringify({
      before: results.dependencyGraphWheelBefore,
      after: results.dependencyGraphWheelAfter
    })}`
  )

  assert(cdp.runtimeErrors.length === 0, 'Runtime errors were captured during interaction')

  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: results,
        runtimeErrors: cdp.runtimeErrors
      },
      null,
      2
    )
  )
  cdp.socket.close()
} catch (error) {
  if (browserDiagnostic) {
    console.error(`Browser diagnostic:\n${browserDiagnostic}`)
  }
  throw error
} finally {
  await terminateOwnedProcess(browserProcess)
  // 只关闭本脚本启动的 Vite；复用用户现有开发服务时不得改变其生命周期。
  await closeOwnedApplicationServer()
  // 清理失败必须可见，否则连续运行会在系统临时目录中累积浏览器资料。
  try {
    await removeOwnedTemporaryDirectory(profilePath)
  } catch (error) {
    console.error(`Temporary browser profile cleanup failed: ${error.message}`)
    process.exitCode = 1
  }
}
