import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { resolveBrowserExecutable } from './browser-path.mjs'
import { removeOwnedTemporaryDirectory, terminateOwnedProcess } from './temporary-resources.mjs'

// 与冒烟测试共享三平台浏览器发现逻辑；非标准安装仍可通过环境变量覆盖。
const chromePath = resolveBrowserExecutable()
const debugPort = 9325
const debugBaseUrl = `http://127.0.0.1:${debugPort}`
const applicationUrl = 'http://127.0.0.1:1420/'
/*
 * 默认仍把视觉证据写入项目笔记；本地审阅未提交改动时可覆盖到临时目录，
 * 避免一次全量审计改写其他任务已经生成但尚未提交的截图。
 */
const outputDirectory = process.env.LORE_CLIENT_VISUAL_OUTPUT_DIRECTORY
  ? pathToFileURL(`${resolve(process.env.LORE_CLIENT_VISUAL_OUTPUT_DIRECTORY)}/`)
  : new URL('../docs/note/', import.meta.url)
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const transientWindowsWriteErrors = new Set(['EUNKNOWN', 'EBUSY', 'EPERM'])
let applicationServer = null

async function writeVisualEvidence(target, data, encoding) {
  /*
   * Windows 的索引器、图片预览器或实时防护可能在截图刚被覆盖时短暂持有文件，
   * Bun 会把这类共享冲突报告为 EUNKNOWN。这里只重试明确的瞬时占用错误；
   * 路径不存在、磁盘空间不足等真实故障仍会立即暴露。
   */
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await writeFile(target, data, encoding)
      return
    } catch (error) {
      const canRetry = process.platform === 'win32' && transientWindowsWriteErrors.has(error?.code) && attempt < 6
      if (!canRetry) {
        throw error
      }
      await delay(attempt * 75)
    }
  }
}

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
   * Vite 已关闭监听端口后，Bun 下的 close() 偶尔仍会等待内部监听句柄。
   * 给正常清理保留两秒；超时后由脚本末尾在其他资源清理完成后结束进程。
   */
  await Promise.race([server.close().catch(() => {}), delay(2_000)])
}

async function ensureApplicationServer() {
  if (await applicationServerIsReady()) {
    return
  }

  /*
   * 视觉验收必须能够独立执行；没有现成开发服务时直接启动项目内 Vite。
   * 若开发者已运行 1420 服务则只复用，测试结束时不会改变其生命周期。
   * 使用 Vite 的程序化生命周期可避免 Windows 上 Bun 启动器与实际 Node
   * 服务分属不同进程，导致父进程退出后仍遗留端口或后台进程。
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
    throw new Error('The Lore Client visual-test server did not respond after startup')
  }
}

await ensureApplicationServer()
// 与冒烟测试保持一致：浏览器资料避开 Vite 的项目文件监视范围。
const profilePath = resolve(tmpdir(), `lore-client-visual-audit-profile-${process.pid}-${Date.now()}`)

// 使用独立无头实例执行可重复的像素级复核，不接触用户正在使用的浏览器资料。
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
    // 视觉脚本只访问本机页面并使用一次性资料目录；受限 Windows 环境无法
    // 创建 Chromium 沙箱子进程时，允许这个隔离的测试实例无沙箱运行。
    '--no-sandbox',
    '--no-default-browser-check',
    '--no-first-run',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profilePath}`,
    '--window-size=1920,1080',
    applicationUrl
  ],
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
)
let browserDiagnostic = ''
browserProcess.stderr?.on('data', (chunk) => {
  // 仅保留尾部诊断，失败时帮助区分视觉断言与浏览器进程限制。
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
      // Chrome 启动初期调试端口可能尚未监听，短暂重试即可。
    }

    await delay(100)
  }

  throw new Error('No Lore Client debugging target appeared before the timeout')
}

function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl)
  const commandTimeoutMilliseconds = 15_000
  const opened = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The CDP WebSocket did not connect before the timeout')), 5_000)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true }
    )
    socket.addEventListener(
      'error',
      (event) => {
        clearTimeout(timeout)
        reject(event)
      },
      { once: true }
    )
  })
  const pendingCommands = new Map()
  let commandId = 0

  const rejectPendingCommands = (reason) => {
    for (const { method, reject, timeout } of pendingCommands.values()) {
      clearTimeout(timeout)
      reject(new Error(`CDP command ${method} failed: ${reason}`))
    }
    pendingCommands.clear()
  }

  socket.addEventListener('close', () => rejectPendingCommands('The browser target was closed'))
  socket.addEventListener('error', () => rejectPendingCommands('The CDP WebSocket connection failed'))

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pendingCommands.has(message.id)) {
      return
    }

    const { method, resolve, reject, timeout } = pendingCommands.get(message.id)
    pendingCommands.delete(message.id)
    clearTimeout(timeout)
    if (message.error) {
      reject(new Error(`CDP command ${method} failed: ${message.error.message}`))
    } else {
      resolve(message.result)
    }
  })

  async function send(method, params = {}) {
    await opened
    commandId += 1

    return new Promise((resolve, reject) => {
      const currentCommandId = commandId
      const timeout = setTimeout(() => {
        if (!pendingCommands.has(currentCommandId)) {
          return
        }
        pendingCommands.delete(currentCommandId)
        reject(new Error(`CDP command ${method} did not return within ${commandTimeoutMilliseconds}ms`))
      }, commandTimeoutMilliseconds)
      pendingCommands.set(currentCommandId, {
        method,
        resolve,
        reject,
        timeout
      })
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

  return { socket, send, evaluate }
}

async function waitForApplication(cdp) {
  // Vite 首次依赖优化可能跨越数百毫秒，等待明确的挂载标记比固定延时稳定。
  let lastContextError = ''
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const mounted = await cdp.evaluate(`Boolean(document.querySelector(".app-shell"))`)
      if (mounted) {
        return
      }
    } catch (error) {
      // 调试 Target 可能先于页面执行上下文出现，下一轮会重新探测。
      lastContextError = error instanceof Error ? error.message : String(error)
    }
    await delay(100)
  }
  throw new Error(
    `Lore Client did not finish mounting React before the timeout${lastContextError ? ` (${lastContextError})` : ''}`
  )
}

/**
 * 校验大面积入口和摘要卡的最终计算样式确实为纯色。
 *
 * 仅检查源码中的 `linear-gradient` 不够：浏览器默认按钮外观、主题覆盖或
 * `inset` 内高光都可能在最终渲染中重新制造渐变错觉，因此这里直接读取
 * 浏览器计算后的背景图与阴影。
 */
async function assertFlatSurfaces(cdp, selectors) {
  const surfaceStyles = await cdp.evaluate(`(() => {
    const selectors = ${JSON.stringify(selectors)};
    return Object.fromEntries(selectors.map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return [selector, null];
      const style = getComputedStyle(element);
      return [selector, {
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        boxShadow: style.boxShadow
      }];
    }));
  })()`)

  const failures = Object.entries(surfaceStyles).filter(
    ([, style]) => !style || style.backgroundImage !== 'none' || style.boxShadow !== 'none'
  )
  if (failures.length > 0) {
    throw new Error(`Neutral surfaces still contain background images or shadows: ${JSON.stringify(failures)}`)
  }
  return surfaceStyles
}

/**
 * Toast 可以保留用于悬浮层级的外部投影，但背景必须是纯色，且不得重新
 * 引入任何内阴影。Toast 还必须真实位于对话框模糊遮罩之上，不能只依赖
 * DOM 顺序碰巧在某个弹层中可见。
 */
async function assertPlainToastSurface(cdp) {
  const toastStyle = await cdp.evaluate(`(() => {
    const toast = document.querySelector(".toast");
    if (!toast) return null;
    const style = getComputedStyle(toast);
    const backdrop = document.querySelector(".dialog-backdrop");
    const backdropStyle = backdrop ? getComputedStyle(backdrop) : null;
    const rect = toast.getBoundingClientRect();
    const stackedElements = document.elementsFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    const toastStackIndex = stackedElements.findIndex(
      (element) => element === toast || toast.contains(element)
    );
    const backdropStackIndex = stackedElements.findIndex((element) => element === backdrop);
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      boxShadow: style.boxShadow,
      zIndex: Number(style.zIndex),
      backdropZIndex: backdropStyle ? Number(backdropStyle.zIndex) : null,
      aboveBackdrop:
        !backdrop ||
        (toastStackIndex >= 0 &&
          backdropStackIndex >= 0 &&
          toastStackIndex < backdropStackIndex)
    };
  })()`)
  if (
    !toastStyle ||
    toastStyle.backgroundImage !== 'none' ||
    toastStyle.boxShadow.includes('inset') ||
    toastStyle.aboveBackdrop !== true ||
    (toastStyle.backdropZIndex !== null && toastStyle.zIndex <= toastStyle.backdropZIndex)
  ) {
    throw new Error(`The toast surface or stacking order is invalid: ${JSON.stringify(toastStyle)}`)
  }
  return toastStyle
}

/**
 * 纯图标按钮不能只靠肉眼判断居中。这里同时验证按钮有可计算的边框，
 * 并把 SVG 与按钮的几何中心差限制在半像素内。
 */
async function assertInteractiveIconButton(cdp, selector, label, referenceSelector = null) {
  const result = await cdp.evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    const icon = button?.querySelector("svg");
    if (!(button instanceof HTMLButtonElement) || !(icon instanceof SVGElement)) return null;
    const buttonRect = button.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    const style = getComputedStyle(button);
    const reference = ${JSON.stringify(referenceSelector)} === null
      ? null
      : document.querySelector(${JSON.stringify(referenceSelector)});
    const referenceRect = reference?.getBoundingClientRect();
    const referenceStyle = reference ? getComputedStyle(reference) : null;
    return {
      borderWidth: style.borderTopWidth,
      borderColor: style.borderTopColor,
      background: style.backgroundColor,
      opacity: Number(style.opacity),
      iconCenterDeltaX:
        Math.abs((buttonRect.left + buttonRect.right) / 2 -
          (iconRect.left + iconRect.right) / 2),
      iconCenterDeltaY:
        Math.abs((buttonRect.top + buttonRect.bottom) / 2 -
          (iconRect.top + iconRect.bottom) / 2),
      matchesReference:
        reference === null ||
        (referenceRect &&
          referenceStyle &&
          Math.abs(buttonRect.width - referenceRect.width) <= 0.5 &&
          Math.abs(buttonRect.height - referenceRect.height) <= 0.5 &&
          style.borderRadius === referenceStyle.borderRadius &&
          style.borderColor === referenceStyle.borderColor &&
          style.backgroundColor === referenceStyle.backgroundColor &&
          style.color === referenceStyle.color &&
          style.boxShadow === referenceStyle.boxShadow)
    };
  })()`)
  if (
    !result ||
    result.borderWidth === '0px' ||
    result.borderColor === 'rgba(0, 0, 0, 0)' ||
    result.background === 'rgba(0, 0, 0, 0)' ||
    result.opacity < 0.65 ||
    result.iconCenterDeltaX > 0.5 ||
    result.iconCenterDeltaY > 0.5 ||
    !result.matchesReference
  ) {
    throw new Error(`${label} is missing interaction feedback or icon centering: ${JSON.stringify(result)}`)
  }
  return result
}

/**
 * 使用真实指针事件验证下拉选择的 hover 边框。计算色必须与主题令牌完全一致，
 * 同时要求页面消费共享 SelectInput，避免局部原生 select 再次分叉箭头和状态样式。
 */
async function assertSelectHoverBorder(cdp, selector, label) {
  const point = await cdp.evaluate(`(() => {
    const candidates = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const select = candidates.find((candidate) => {
      if (!(candidate instanceof HTMLSelectElement) || candidate.disabled) return false;
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!(select instanceof HTMLSelectElement)) return null;
    select.blur();
    const rect = select.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2)
    };
  })()`)
  if (!point) {
    throw new Error(`${label} did not expose an enabled select`)
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y
  })
  await delay(30)
  const state = await cdp.evaluate(`(() => {
    const candidates = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const select = candidates.find((candidate) => candidate.matches(":hover"));
    if (!(select instanceof HTMLSelectElement)) return null;
    const accentProbe = document.createElement("span");
    accentProbe.style.color = "var(--accent-solid)";
    document.body.append(accentProbe);
    const accentColor = getComputedStyle(accentProbe).color;
    accentProbe.remove();
    return {
      shared: Boolean(select.closest(".control-select")),
      hovered: select.matches(":hover"),
      focused: select.matches(":focus"),
      disabled: select.disabled,
      borderColor: getComputedStyle(select).borderTopColor,
      accentColor
    };
  })()`)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 1,
    y: 1
  })
  if (!state?.shared || !state.hovered || state.focused || state.disabled || state.borderColor !== state.accentColor) {
    throw new Error(`${label} hover border is not the theme blue: ${JSON.stringify(state)}`)
  }
  return state
}

async function auditViewport(cdp, width, height, theme) {
  // 通过设备指标覆盖精确复核低分辨率和常用桌面分辨率，而不是依赖宿主窗口大小。
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: width,
    screenHeight: height
  })
  await delay(120)
  await cdp.evaluate(`(() => {
    document.documentElement.dataset.theme = ${JSON.stringify(theme)};
    document.documentElement.style.colorScheme = ${JSON.stringify(theme)};
  })()`)
  await delay(80)

  let flatSurfaceStyles = await assertFlatSurfaces(cdp, ['.repository-switcher'])
  if (theme === 'dark' && width === 1280) {
    // 深色模式额外进入分支总览，覆盖用户指出的当前分支摘要。
    await clickMatchingButton(cdp, '.sidebar__primary button', '分支总览')
    flatSurfaceStyles = await assertFlatSurfaces(cdp, ['.repository-switcher', '.current-branch-card'])
    const branchScreenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true
    })
    await writeVisualEvidence(new URL('ui-dark-branches.png', outputDirectory), branchScreenshot.data, 'base64')
    await clickMatchingButton(cdp, '.sidebar__primary button', '修订历史')
    await delay(50)
  }

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 1,
    y: 1
  })
  const headRelativeRows = await cdp.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll(".revision-row"));
    const headIndex = rows.findIndex((row) => row.querySelector(".revision-row__meta em.is-head"));
    const expectedAhead = rows.slice(0, Math.max(0, headIndex));
    const rowDividerWidths = rows.map((row) => getComputedStyle(row).borderBottomWidth);
    /*
     * 默认演示仓库的 HEAD 在首行，使用屏幕外生产样式夹具验证正向背景，
     * 同时让真实历史行继续覆盖“不误标”边界。
     */
    const fixture = document.createElement("div");
    fixture.style.cssText = "position:fixed;left:-2000px;top:0;width:600px;";
    fixture.innerHTML =
      '<div class="revision-row is-ahead-of-head"><span>ahead</span></div>' +
      '<div class="revision-row"><span>normal</span></div>' +
      '<div class="revision-row is-ahead-of-head is-selected"><span>selected ahead</span></div>' +
      '<div class="revision-row is-selected"><span>selected</span></div>';
    document.body.append(fixture);
    const aheadRow = fixture.children[0];
    const normalRow = fixture.children[1];
    const selectedAheadRow = fixture.children[2];
    const selectedRow = fixture.children[3];
    const probe = document.createElement("span");
    probe.style.background = "var(--revision-ahead-of-head-bg)";
    probe.style.opacity = "var(--revision-ahead-of-head-content-opacity)";
    document.body.append(probe);
    const tokenBackground = getComputedStyle(probe).backgroundColor;
    const tokenContentOpacity = Number.parseFloat(getComputedStyle(probe).opacity);
    probe.remove();
    const aheadBackground = getComputedStyle(aheadRow).backgroundColor;
    const normalBackground = getComputedStyle(normalRow).backgroundColor;
    const selectedAheadBackground = getComputedStyle(selectedAheadRow).backgroundColor;
    const selectedBackground = getComputedStyle(selectedRow).backgroundColor;
    const aheadContentOpacity = Number.parseFloat(getComputedStyle(aheadRow.firstElementChild).opacity);
    const normalContentOpacity = Number.parseFloat(getComputedStyle(normalRow.firstElementChild).opacity);
    const selectedAheadContentOpacity = Number.parseFloat(
      getComputedStyle(selectedAheadRow.firstElementChild).opacity
    );
    const selectedContentOpacity = Number.parseFloat(
      getComputedStyle(selectedRow.firstElementChild).opacity
    );
    fixture.remove();
    return {
      headIndex,
      expectedAheadCount: expectedAhead.length,
      markedAheadCount: expectedAhead.filter((row) => row.classList.contains("is-ahead-of-head")).length,
      headMarked: headIndex >= 0 && rows[headIndex].classList.contains("is-ahead-of-head"),
      olderMarked: headIndex >= 0 && rows.slice(headIndex + 1).some((row) =>
        row.classList.contains("is-ahead-of-head")
      ),
      rowDividerWidths,
      tokenBackground,
      tokenContentOpacity,
      selectedBackground,
      aheadBackground,
      normalBackground,
      selectedAheadBackground,
      aheadContentOpacity,
      normalContentOpacity,
      selectedAheadContentOpacity,
      selectedContentOpacity
    };
  })()`)
  if (
    headRelativeRows.headIndex < 0 ||
    headRelativeRows.markedAheadCount !== headRelativeRows.expectedAheadCount ||
    headRelativeRows.headMarked ||
    headRelativeRows.olderMarked ||
    headRelativeRows.rowDividerWidths.some((width) => width !== '0px') ||
    !headRelativeRows.aheadBackground ||
    !headRelativeRows.normalBackground ||
    headRelativeRows.aheadBackground !== headRelativeRows.tokenBackground ||
    headRelativeRows.aheadBackground === headRelativeRows.normalBackground ||
    headRelativeRows.selectedAheadBackground !== headRelativeRows.selectedBackground ||
    headRelativeRows.aheadContentOpacity !== headRelativeRows.tokenContentOpacity ||
    headRelativeRows.aheadContentOpacity >= headRelativeRows.normalContentOpacity ||
    headRelativeRows.selectedAheadContentOpacity <= headRelativeRows.aheadContentOpacity ||
    headRelativeRows.selectedAheadContentOpacity >= headRelativeRows.selectedContentOpacity
  ) {
    throw new Error(
      `Revision rows lack a continuous Lane or subdued ${theme} HEAD-relative styling: ${JSON.stringify(headRelativeRows)}`
    )
  }

  const metrics = await cdp.evaluate(`(() => {
    const visibleTextElements = Array.from(document.querySelectorAll("body *"))
      .filter((element) => {
        const style = getComputedStyle(element);
        const text = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join("")
          .trim();
        return text && style.display !== "none" && style.visibility !== "hidden";
      });
    const fontSizes = visibleTextElements.map((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize)
    );

    return {
      viewport: { width: innerWidth, height: innerHeight },
      minimumVisibleFontSize: Math.min(...fontSizes),
      elementsBelowNinePixels: fontSizes.filter((size) => size < 9).length,
      elementsBelowTenPixels: fontSizes.filter((size) => size < 10).length,
      horizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
      verticalOverflow:
        document.documentElement.scrollHeight > document.documentElement.clientHeight,
      revisionRows: document.querySelectorAll(".revision-row").length,
      theme: document.documentElement.dataset.theme,
    };
  })()`)

  const screenshot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true
  })
  const fileName = `ui-font-audit-${theme}-${width}x${height}.png`
  await writeVisualEvidence(new URL(fileName, outputDirectory), screenshot.data, 'base64')

  return { fileName, ...metrics, flatSurfaceStyles, headRelativeRows }
}

/**
 * 收集浅色模式下仍占据明显面积的深色表面。
 *
 * 这里检查计算后的颜色而不是 CSS 源码，因此能够捕获选择器优先级、背景简写
 * 和弹层子元素遗漏。资产预览与代码差异属于内容本身，允许保留深色画布。
 */
async function collectUnexpectedDarkSurfaces(cdp, checkpoint) {
  const surfaces = await cdp.evaluate(`(() => {
    const contentExcluded = [
      ".binary-preview",
      ".code-diff"
    ].join(",");
    const backdropExcluded = ".command-backdrop,.dialog-backdrop";
    /*
     * 明确的危险操作允许使用受控红色表面。范围只覆盖带 is-danger 语义的
     * 凭据清理容器，不豁免普通按钮、面板或其他浅色主题表面。
     */
    const semanticDangerExcluded = ".composition-removal.is-danger";

    const parseColor = (color) => {
      const channels = color.match(/[\\d.]+/g)?.map(Number) ?? [];
      if (color.startsWith("color(srgb")) {
        return {
          red: (channels[0] ?? 1) * 255,
          green: (channels[1] ?? 1) * 255,
          blue: (channels[2] ?? 1) * 255,
          alpha: channels[3] ?? 1
        };
      }
      return {
        red: channels[0] ?? 255,
        green: channels[1] ?? 255,
        blue: channels[2] ?? 255,
        alpha: channels[3] ?? 1
      };
    };
    const luminance = ({ red, green, blue }) => {
      const linear = [red, green, blue].map((channel) => {
        const value = channel / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const describeElement = (element) => {
      if (element.id) return "#" + element.id;
      if (element.classList.length) {
        return "." + Array.from(element.classList).join(".");
      }
      const parent = element.parentElement;
      const parentSelector = parent?.classList.length
        ? "." + Array.from(parent.classList).join(".")
        : parent?.tagName.toLowerCase();
      return parentSelector + " > " + element.tagName.toLowerCase();
    };

    const visibleElements = Array.from(document.querySelectorAll("body *"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (
          rect.width < 8 ||
          rect.height < 8 ||
          rect.width * rect.height < 50 ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          element.matches(backdropExcluded) ||
          element.matches(contentExcluded) ||
          element.closest(contentExcluded) ||
          element.closest(semanticDangerExcluded)
        ) {
          return false;
        }
        const color = parseColor(style.backgroundColor);
        return color.alpha >= 0.5 && luminance(color) < 0.22;
      });

    const darkBackgrounds = visibleElements
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          selector: describeElement(element),
          background: getComputedStyle(element).backgroundColor,
          size: Math.round(rect.width) + "×" + Math.round(rect.height)
        };
      });

    const heavyBorders = Array.from(document.querySelectorAll("body *"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        /*
         * Branch 的独立选中态刻意使用主题青色边框，帮助用户区分“已选中”
         * 与“当前工作区 Branch”。它属于交互反馈，不是浅色主题残留的深色分隔线。
         */
        const isIntentionalSelectionBorder = element.matches(
          ".branch-card.is-selected",
        );
        if (
          rect.width < 180 ||
          rect.height < 20 ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          isIntentionalSelectionBorder ||
          element.matches(backdropExcluded) ||
          element.matches(contentExcluded) ||
          element.closest(contentExcluded) ||
          element.closest(semanticDangerExcluded) ||
          Number.parseFloat(style.borderBottomWidth) < 1
        ) {
          return false;
        }
        const color = parseColor(style.borderBottomColor);
        return color.alpha >= 0.5 && luminance(color) < 0.16;
      })
      .map((element) => ({
        selector: describeElement(element),
        border: getComputedStyle(element).borderBottomColor
      }));

    const darkVectorPaints = Array.from(
      document.querySelectorAll(".revision-graph circle")
    )
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const color = parseColor(getComputedStyle(element).fill);
        return (
          rect.width >= 8 &&
          rect.height >= 8 &&
          color.alpha >= 0.5 &&
          luminance(color) < 0.16
        );
      })
      .map((element) => ({
        selector: describeElement(element),
        fill: getComputedStyle(element).fill
      }));

    const opaquePanelSections = [
      ".revision-summary",
      ".activity-section"
    ]
      .map((selector) => document.querySelector(selector))
      .filter((element) => {
        if (!element || element.getBoundingClientRect().width === 0) return false;
        return parseColor(getComputedStyle(element).backgroundColor).alpha > 0.01;
      })
      .map((element) => ({
        selector: describeElement(element),
        background: getComputedStyle(element).backgroundColor
      }));

    /*
     * “本地更改”的左右列表拥有各自的行尾基准线，因此需要分组比较。
     * 同组内可选标签是否出现，都不应改变统计数字和操作按钮的右边缘。
     */
    const misalignedChangeGroups = Array.from(
      document.querySelectorAll(
        ".local-changes__lists > .change-list-section"
      )
    )
      .map((group, index) => {
        const collectRightEdges = (selector) =>
          Array.from(group.querySelectorAll(selector))
            .filter((element) => element.getBoundingClientRect().width > 0)
            .map((element) => Math.round(element.getBoundingClientRect().right));
        const actionEdges = collectRightEdges(".change-file-row__action");
        const deltaEdges = collectRightEdges(".change-file-row__delta");
        const spread = (edges) =>
          edges.length > 1 ? Math.max(...edges) - Math.min(...edges) : 0;

        return {
          group: index,
          actionEdges,
          deltaEdges,
          actionSpread: spread(actionEdges),
          deltaSpread: spread(deltaEdges)
        };
      })
      .filter(
        ({ actionSpread, deltaSpread }) =>
          actionSpread > 1 || deltaSpread > 1
      );

    /*
     * 侧栏与 Inspector 标签中的数字属于 10px 紧凑文本，不能仅凭“不是深色”
     * 判定可读。这里按实际计算颜色寻找最近的不透明背景，并执行 4.5:1
     * 的正文对比度下限，精确覆盖用户指出的两个计数徽标。
     */
    const lowContrastCounters = [
      ".sidebar__primary",
      ".inspector-tabs"
    ].flatMap((rootSelector) => {
      const root = document.querySelector(rootSelector);
      if (!root) return [];
      return Array.from(root.querySelectorAll("*"))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return element.children.length === 0 &&
            /^\\d+$/.test(element.textContent?.trim() ?? "") &&
            rect.width > 0 &&
            rect.height > 0;
        })
        .map((element) => {
          let backgroundElement = element;
          let background = parseColor("rgb(255 255 255)");
          while (backgroundElement) {
            const candidate = parseColor(
              getComputedStyle(backgroundElement).backgroundColor
            );
            if (candidate.alpha >= 0.95) {
              background = candidate;
              break;
            }
            backgroundElement = backgroundElement.parentElement;
          }
          const foreground = parseColor(getComputedStyle(element).color);
          const foregroundLuminance = luminance(foreground);
          const backgroundLuminance = luminance(background);
          const contrast =
            (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
            (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
          return {
            selector: describeElement(element),
            text: element.textContent?.trim() ?? "",
            foreground: getComputedStyle(element).color,
            background: getComputedStyle(backgroundElement ?? document.body)
              .backgroundColor,
            contrast: Number(contrast.toFixed(2))
          };
        })
        .filter(({ contrast }) => contrast < 4.5);
    });

    return {
      darkBackgrounds,
      heavyBorders,
      darkVectorPaints,
      opaquePanelSections,
      misalignedChangeGroups,
      lowContrastCounters
    };
  })()`)
  return {
    checkpoint,
    surfaces: surfaces.darkBackgrounds,
    borders: surfaces.heavyBorders,
    vectors: surfaces.darkVectorPaints,
    continuity: surfaces.opaquePanelSections,
    alignment: surfaces.misalignedChangeGroups,
    contrast: surfaces.lowContrastCounters
  }
}

async function clickMatchingButton(cdp, selector, text) {
  const clicked = await cdp.evaluate(`(() => {
    const target = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      .find((element) => element.textContent?.includes(${JSON.stringify(text)}));
    target?.click();
    return Boolean(target);
  })()`)
  if (!clicked) {
    throw new Error(`Visual audit could not find button: ${text}`)
  }
  await delay(70)
}

/** 通过无障碍名称触发纯图标按钮，测试路径与真实键盘/读屏入口保持一致。 */
async function clickButtonByAriaLabel(cdp, label) {
  const clicked = await cdp.evaluate(`(() => {
    const target = document.querySelector(
      'button[aria-label="${label.replaceAll('"', '\\"')}"]'
    );
    target?.click();
    return Boolean(target);
  })()`)
  if (!clicked) {
    throw new Error(`Visual audit could not find accessible button: ${label}`)
  }
  await delay(70)
}

/**
 * 通过真实列设置复选框切换 Revision 列，覆盖隐藏列后 CSS Grid 重新排布的路径。
 * 直接点击 input 能触发 React 的 onChange，同时避免依赖弹层内部的视觉坐标。
 */
async function setRevisionColumns(cdp, { author, time }) {
  await clickButtonByAriaLabel(cdp, '显示选项')
  const updated = await cdp.evaluate(`(() => {
    const labels = Array.from(document.querySelectorAll(".history-options label"));
    const findInput = (text) =>
      labels.find((label) => label.textContent?.includes(text))
        ?.querySelector("input");
    const authorInput = findInput("显示作者");
    const timeInput = findInput("显示时间");
    if (!authorInput || !timeInput) return false;
    if (authorInput.checked !== ${author}) authorInput.click();
    if (timeInput.checked !== ${time}) timeInput.click();
    return true;
  })()`)
  if (!updated) {
    throw new Error('Visual audit could not switch revision display columns')
  }
  await delay(70)
  await clickButtonByAriaLabel(cdp, '显示选项')
}

/** 保存指定视觉证据；是否执行主题审计由调用方决定。 */
async function captureScreenshotEvidence(cdp, fileName) {
  const screenshot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true
  })
  await writeVisualEvidence(new URL(fileName, outputDirectory), screenshot.data, 'base64')
}

async function captureCheckpoint(cdp, name) {
  await captureScreenshotEvidence(cdp, `ui-light-${name}.png`)
  return collectUnexpectedDarkSurfaces(cdp, name)
}

/** 在最低桌面尺寸逐类记录深色 Settings，并验证弹层与活动内容没有横向越界。 */
async function auditDarkSettingsCategories(cdp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: 1280,
    screenHeight: 720
  })
  await cdp.evaluate(`(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  })()`)
  await delay(80)
  await clickButtonByAriaLabel(cdp, '客户端设置')

  const checkpoints = []
  const categories = [
    { label: null, name: 'settings' },
    { label: '默认提交身份', name: 'settings-identity' },
    { label: '集成', name: 'settings-integrations' },
    { label: '存储', name: 'settings-storage' },
    { label: '维护', name: 'settings-maintenance' }
  ]
  for (const category of categories) {
    if (category.label) {
      await clickMatchingButton(cdp, '.settings-categories > button', category.label)
    }
    await delay(40)
    const layout = await cdp.evaluate(`(() => {
      const dialog = document.querySelector(".settings-dialog");
      const body = document.querySelector(".settings-dialog__body");
      const navigation = document.querySelector(".settings-categories");
      const content = document.querySelector(".settings-content");
      const panel = document.querySelector(".settings-page:not([hidden])");
      if (!(dialog instanceof HTMLElement) ||
          !(body instanceof HTMLElement) ||
          !(navigation instanceof HTMLElement) ||
          !(content instanceof HTMLElement) ||
          !(panel instanceof HTMLElement)) return null;
      const bounds = dialog.getBoundingClientRect();
      const bodyBounds = body.getBoundingClientRect();
      const navigationBounds = navigation.getBoundingClientRect();
      const createButton = panel.querySelector(".settings-shared-store__create > button.is-primary");
      const accentProbe = document.createElement("span");
      accentProbe.style.color = "var(--accent-solid)";
      document.body.append(accentProbe);
      const accentColor = getComputedStyle(accentProbe).color;
      accentProbe.remove();
      return {
        activePanel: panel.id,
        withinViewport:
          bounds.left >= 0 &&
          bounds.top >= 0 &&
          bounds.right <= innerWidth &&
          bounds.bottom <= innerHeight,
        horizontalOverflow: content.scrollWidth > content.clientWidth,
        navigationFillsBody:
          Math.abs(navigationBounds.top - bodyBounds.top) <= 1 &&
          Math.abs(navigationBounds.bottom - bodyBounds.bottom) <= 1,
        primaryActionMatchesAccent:
          !(createButton instanceof HTMLElement) ||
          getComputedStyle(createButton).backgroundColor === accentColor,
        identityAvatarPresent:
          panel.id !== "settings-panel-identity" ||
          Boolean(panel.querySelector(".revision-author-avatar"))
      };
    })()`)
    if (
      !layout?.withinViewport ||
      layout.horizontalOverflow ||
      !layout.navigationFillsBody ||
      !layout.primaryActionMatchesAccent ||
      !layout.identityAvatarPresent
    ) {
      throw new Error(`Dark Settings layout audit failed: ${JSON.stringify({ category, layout })}`)
    }
    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true
    })
    const fileName = `ui-dark-${category.name}.png`
    await writeVisualEvidence(new URL(fileName, outputDirectory), screenshot.data, 'base64')
    checkpoints.push({ fileName, ...layout })
  }
  await clickButtonByAriaLabel(cdp, '关闭设置')
  return checkpoints
}

/** 主动遍历用户会进入的备用视图和弹层，防止只验收默认首屏。 */
async function auditLightThemeComponents(cdp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: 1600,
    screenHeight: 900
  })
  await cdp.evaluate(`(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
  })()`)
  await delay(80)

  const checkpoints = []
  /*
   * 侧栏和历史筛选都是外层负责边界的复合输入框。两种主题下聚焦内部 input，
   * 必须只看到外层品牌蓝边框，内部 border/outline 均保持为零。
   */
  for (const theme of ['light', 'dark']) {
    await cdp.evaluate(`(() => {
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      document.documentElement.style.colorScheme = ${JSON.stringify(theme)};
    })()`)
    await delay(40)
    for (const selector of ['.sidebar__filter.composite-input', '.inline-search.composite-input']) {
      const compositeInputState = await cdp.evaluate(`(() => {
        const shell = document.querySelector(${JSON.stringify(selector)});
        const input = shell?.querySelector(":scope > input");
        if (!(shell instanceof HTMLElement) ||
            !(input instanceof HTMLInputElement)) return null;
        input.focus();
        const shellStyle = getComputedStyle(shell);
        const inputStyle = getComputedStyle(input);
        const accentProbe = document.createElement("span");
        accentProbe.style.color = "var(--accent-solid)";
        document.body.append(accentProbe);
        const accentColor = getComputedStyle(accentProbe).color;
        accentProbe.remove();
        return {
          focusWithin: shell.matches(":focus-within"),
          shellBorderColor: shellStyle.borderTopColor,
          inputBorderWidths: [
            inputStyle.borderTopWidth,
            inputStyle.borderRightWidth,
            inputStyle.borderBottomWidth,
            inputStyle.borderLeftWidth
          ],
          inputOutlineStyle: inputStyle.outlineStyle,
          inputOutlineWidth: inputStyle.outlineWidth,
          accentColor
        };
      })()`)
      if (
        !compositeInputState?.focusWithin ||
        compositeInputState.shellBorderColor !== compositeInputState.accentColor ||
        compositeInputState.inputBorderWidths.some((width) => width !== '0px') ||
        (compositeInputState.inputOutlineStyle !== 'none' && compositeInputState.inputOutlineWidth !== '0px')
      ) {
        throw new Error(
          `Composite input boundary audit failed for ${selector} in ${theme} theme: ${JSON.stringify(compositeInputState)}`
        )
      }
    }
  }
  await cdp.evaluate(`(() => {
    document.activeElement?.blur();
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
  })()`)
  await delay(40)

  checkpoints.push(await captureCheckpoint(cdp, 'revision-history'))
  // 显示选项弹层和 Lore 单道投影都必须在浅色主题中进入真实状态验收；
  // 同一真实弹层会切到深色主题复核，再恢复多道拓扑，避免影响后续检查点。
  await clickButtonByAriaLabel(cdp, '显示选项')
  checkpoints.push(await captureCheckpoint(cdp, 'revision-history-display-options'))
  await cdp.evaluate(`(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  })()`)
  await delay(40)
  await captureScreenshotEvidence(cdp, 'ui-dark-revision-history-display-options.png')
  const flatLaneSelected = await cdp.evaluate(`(() => {
    const input = document.querySelector(
      'input[name="revision-lane-mode"][value="flat"]'
    );
    input?.click();
    return Boolean(input);
  })()`)
  if (!flatLaneSelected) {
    throw new Error('Visual audit could not select the Lore flat revision lane')
  }
  await delay(70)
  await captureScreenshotEvidence(cdp, 'ui-dark-revision-history-flat-lane.png')
  await cdp.evaluate(`(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
  })()`)
  await delay(40)
  checkpoints.push(await captureCheckpoint(cdp, 'revision-history-flat-lane'))
  await cdp.evaluate(`document.querySelector('input[name="revision-lane-mode"][value="topology"]')?.click()`)
  await delay(40)
  await clickButtonByAriaLabel(cdp, '显示选项')
  // History 的 Lore 参数筛选位于独立弹层；必须在真实展开态同时审计日期、
  // Branch、only_branch 与数量控件，避免默认首屏掩盖弹层溢出或主题回归。
  await clickButtonByAriaLabel(cdp, '筛选选项')
  checkpoints.push(await captureCheckpoint(cdp, 'revision-history-filters'))
  /*
   * 主操作按钮默认使用品牌蓝，hover 提亮，按住阶段保持提亮背景且只继续改变边框。
   * 真实派发鼠标事件，避免静态选择器存在但被级联覆盖。
   */
  const historyPrimaryButtonPoint = await cdp.evaluate(`(() => {
    const button = document.querySelector(".history-options__apply.control-button.is-primary");
    const rect = button?.getBoundingClientRect();
    const style = button ? getComputedStyle(button) : null;
    return rect && style ? {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      defaultBackground: style.backgroundColor,
      defaultBorder: style.borderTopColor
    } : null;
  })()`)
  if (!historyPrimaryButtonPoint) {
    throw new Error('History primary action was not found')
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: historyPrimaryButtonPoint.x,
    y: historyPrimaryButtonPoint.y
  })
  await delay(30)
  const historyPrimaryHover = await cdp.evaluate(`(() => {
    const button = document.querySelector(".history-options__apply.control-button.is-primary");
    const style = button ? getComputedStyle(button) : null;
    return style ? {
      background: style.backgroundColor,
      border: style.borderTopColor
    } : null;
  })()`)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: historyPrimaryButtonPoint.x,
    y: historyPrimaryButtonPoint.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  const historyPrimaryActive = await cdp.evaluate(`(() => {
    const button = document.querySelector(".history-options__apply.control-button.is-primary");
    const style = button ? getComputedStyle(button) : null;
    return style ? {
      active: button.matches(":active"),
      background: style.backgroundColor,
      border: style.borderTopColor
    } : null;
  })()`)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 1,
    y: 1,
    button: 'left',
    buttons: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: 1,
    y: 1,
    button: 'left',
    buttons: 0,
    clickCount: 1
  })
  if (
    historyPrimaryHover?.background === historyPrimaryButtonPoint.defaultBackground ||
    !historyPrimaryActive?.active ||
    historyPrimaryActive?.background !== historyPrimaryHover?.background ||
    historyPrimaryActive?.border === historyPrimaryButtonPoint.defaultBorder
  ) {
    throw new Error(
      `Primary button lost its stable fill or active border feedback: ${JSON.stringify({
        initial: historyPrimaryButtonPoint,
        hover: historyPrimaryHover,
        active: historyPrimaryActive
      })}`
    )
  }
  await cdp.evaluate(`(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  })()`)
  await delay(40)
  await captureScreenshotEvidence(cdp, 'ui-dark-revision-history-filters.png')
  await cdp.evaluate(`(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
  })()`)
  await delay(40)
  await clickButtonByAriaLabel(cdp, '筛选选项')

  // 宽窗口中把 Inspector 分割线显著向左拖动，验证动态上限下两侧内容仍可用。
  const inspectorSeparator = await cdp.evaluate(`(() => {
    const bounds = document.querySelectorAll(".pane-resizer")[1]
      ?.getBoundingClientRect();
    return bounds ? {
      x: Math.round(bounds.left + bounds.width / 2),
      y: Math.round(bounds.top + bounds.height / 2)
    } : null;
  })()`)
  if (!inspectorSeparator) {
    throw new Error('Visual audit could not locate the inspector resizer')
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: inspectorSeparator.x,
    y: inspectorSeparator.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: inspectorSeparator.x - 360,
    y: inspectorSeparator.y,
    button: 'left',
    buttons: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: inspectorSeparator.x - 360,
    y: inspectorSeparator.y,
    button: 'left',
    clickCount: 1
  })
  await delay(60)
  checkpoints.push(await captureCheckpoint(cdp, 'inspector-expanded'))
  await cdp.evaluate(
    `document.querySelectorAll(".pane-resizer")[1]
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`
  )
  await delay(45)

  await cdp.evaluate(`(() => {
    const badge = document.querySelector(".revision-row__tag");
    const bounds = badge?.getBoundingClientRect();
    badge?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(bounds?.left ?? 500),
      clientY: Math.round(bounds?.bottom ?? 210)
    }));
  })()`)
  await delay(60)
  checkpoints.push(await captureCheckpoint(cdp, 'revision-tag-menu'))
  await clickMatchingButton(cdp, '.tag-context-menu > button', '修改标签')
  await delay(50)
  checkpoints.push(await captureCheckpoint(cdp, 'revision-tag-edit'))
  await clickButtonByAriaLabel(cdp, '关闭')
  await delay(50)

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
  await delay(70)
  checkpoints.push(await captureCheckpoint(cdp, 'revision-menu'))
  await clickMatchingButton(cdp, '.version-context-menu > button', '新建分支')
  await delay(50)
  checkpoints.push(await captureCheckpoint(cdp, 'branch-create-from-revision'))
  await clickButtonByAriaLabel(cdp, '关闭')
  await delay(50)

  await setRevisionColumns(cdp, { author: false, time: true })
  checkpoints.push(await captureCheckpoint(cdp, 'revision-time-only'))
  await setRevisionColumns(cdp, { author: true, time: true })

  await clickMatchingButton(cdp, '.inspector-tabs > button', '变更')
  await cdp.evaluate(`(() => {
    Array.from(document.querySelectorAll(".revision-change-row.is-file"))
      .find((row) => /\\.(?:json|ini|txt|md)$/i.test(
        row.querySelector("strong")?.textContent?.trim() ?? ""
      ))?.click();
  })()`)
  await delay(40)
  /*
   * 真实桌面壳中的 Inspector 中间层不保证把 Grid 子项继续拉伸到完整块高度。
   * 这个离屏夹具显式关闭父级拉伸，验证文件浏览器仍有确定高度，并把最后一条
   * `minmax(0, 1fr)` 轨道分配给列表，而不是按单个目录行的固有高度收缩。
   */
  const revisionTreeHeightFixture = await cdp.evaluate(`(() => {
    const measureVariant = (includeBaseline) => {
      const host = document.createElement("div");
      host.style.cssText = [
        "position: fixed",
        "left: -2000px",
        "top: 0",
        "display: grid",
        "align-items: start",
        "width: 220px",
        "height: 320px"
      ].join(";");

      const browser = document.createElement("aside");
      browser.className = "revision-change-browser";

      const header = document.createElement("header");
      header.className = "revision-change-browser__header";
      const baseline = document.createElement("div");
      baseline.className = "revision-change-browser__baseline";
      const filter = document.createElement("label");
      filter.className = "revision-change-browser__filter";
      const list = document.createElement("div");
      list.className = "revision-change-browser__list";
      const row = document.createElement("div");
      row.className = "revision-change-row";
      row.textContent = "sc";
      list.append(row);
      browser.append(header);
      if (includeBaseline) browser.append(baseline);
      browser.append(filter, list);
      host.append(browser);
      document.body.append(host);

      const hostBounds = host.getBoundingClientRect();
      const browserBounds = browser.getBoundingClientRect();
      const listBounds = list.getBoundingClientRect();
      const result = {
        hostHeight: Math.round(hostBounds.height),
        browserHeight: Math.round(browserBounds.height),
        listHeight: Math.round(listBounds.height),
        fillsHost: Math.abs(hostBounds.height - browserBounds.height) <= 1
      };
      host.remove();
      return result;
    };

    return {
      withBaseline: measureVariant(true),
      withoutBaseline: measureVariant(false)
    };
  })()`)
  if (
    !revisionTreeHeightFixture.withBaseline.fillsHost ||
    revisionTreeHeightFixture.withBaseline.listHeight < 160 ||
    !revisionTreeHeightFixture.withoutBaseline.fillsHost ||
    revisionTreeHeightFixture.withoutBaseline.listHeight < 160
  ) {
    throw new Error(`Revision tree list collapses without parent stretch: ${JSON.stringify(revisionTreeHeightFixture)}`)
  }
  checkpoints.push(await captureCheckpoint(cdp, 'revision-changes-tree'))
  await assertInteractiveIconButton(
    cdp,
    '.revision-change-browser__modes button:nth-child(1)',
    'Revision change expand-all button'
  )
  await assertInteractiveIconButton(
    cdp,
    '.revision-change-browser__modes button:nth-child(2)',
    'Revision change collapse-all button'
  )
  await assertInteractiveIconButton(
    cdp,
    '.inspector-tabs__diff-toggle',
    'Revision Diff visibility toggle',
    '.revision-change-browser__modes button.is-active'
  )
  /*
   * 把内部文件列表真实拖到 150px 最小边界，覆盖英文标题与四按钮曾经穿过
   * 分割线的布局压力。窄态应把标题和工具组分成两行，且所有子项留在左栏。
   */
  const compressedRevisionSeparator = await cdp.evaluate(`(() => {
    const separator = document.querySelector(
      '[aria-label="调整 Revision 文件列表宽度"]'
    );
    const bounds = separator?.getBoundingClientRect();
    return bounds ? {
      x: Math.round(bounds.left + bounds.width / 2),
      y: Math.round(bounds.top + Math.min(120, bounds.height / 2))
    } : null;
  })()`)
  if (!compressedRevisionSeparator) {
    throw new Error('Visual audit could not locate the revision file-list resizer')
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: compressedRevisionSeparator.x,
    y: compressedRevisionSeparator.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: compressedRevisionSeparator.x - 800,
    y: compressedRevisionSeparator.y,
    button: 'left',
    buttons: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: compressedRevisionSeparator.x - 800,
    y: compressedRevisionSeparator.y,
    button: 'left',
    buttons: 0,
    clickCount: 1
  })
  await delay(50)
  const compressedRevisionLayout = await cdp.evaluate(`(() => {
    const browser = document.querySelector(".revision-change-browser");
    const header = document.querySelector(".revision-change-browser__header");
    const title = header?.querySelector(":scope > span");
    const modes = document.querySelector(".revision-change-browser__modes");
    if (!browser || !header || !title || !modes) return null;
    const browserBounds = browser.getBoundingClientRect();
    const headerBounds = header.getBoundingClientRect();
    const titleBounds = title.getBoundingClientRect();
    const modesBounds = modes.getBoundingClientRect();
    const buttonBounds = Array.from(modes.querySelectorAll("button")).map((button) =>
      button.getBoundingClientRect()
    );
    return {
      browserWidth: Math.round(browserBounds.width),
      browserOverflowX: getComputedStyle(browser).overflowX,
      headerOverflowX: getComputedStyle(header).overflowX,
      headerHeight: Math.round(headerBounds.height),
      buttonCount: buttonBounds.length,
      stacked: modesBounds.top >= titleBounds.bottom - 0.5,
      contained:
        headerBounds.right <= browserBounds.right + 0.5 &&
        modesBounds.right <= browserBounds.right + 0.5 &&
        buttonBounds.every((bounds) => bounds.right <= browserBounds.right + 0.5)
    };
  })()`)
  if (
    !compressedRevisionLayout ||
    compressedRevisionLayout.browserWidth !== 150 ||
    compressedRevisionLayout.browserOverflowX !== 'hidden' ||
    compressedRevisionLayout.headerOverflowX !== 'hidden' ||
    compressedRevisionLayout.buttonCount !== 4 ||
    !compressedRevisionLayout.stacked ||
    !compressedRevisionLayout.contained
  ) {
    throw new Error(
      `Compressed revision file browser crosses into the Diff pane: ${JSON.stringify(compressedRevisionLayout)}`
    )
  }
  checkpoints.push(await captureCheckpoint(cdp, 'revision-changes-compressed'))
  await cdp.evaluate(
    `document.querySelector('[aria-label="调整 Revision 文件列表宽度"]')
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`
  )
  await delay(40)
  await assertInteractiveIconButton(
    cdp,
    '.diff-options-control > button',
    'Revision Diff options toggle',
    '.revision-change-browser__modes button:not(.is-active):not(:disabled)'
  )
  // Diff 偏好由工作区与 Revision 共用；这里打开一次真实弹层，覆盖二进制
  // 预览开关、上下文行数和两类空白策略的排版、对比度与视口边缘避让。
  await clickButtonByAriaLabel(cdp, 'Diff 选项')
  checkpoints.push(await captureCheckpoint(cdp, 'revision-diff-options'))
  const binaryDiffOption = await cdp.evaluate(`(() => {
    const label = Array.from(
      document.querySelectorAll(".diff-options-control__popover label")
    ).find((candidate) => candidate.textContent?.includes("显示二进制 Diff"));
    const checkbox = label?.querySelector('input[type="checkbox"]');
    return checkbox instanceof HTMLInputElement
      ? { found: true, checked: checkbox.checked }
      : { found: false, checked: false };
  })()`)
  if (!binaryDiffOption.found || !binaryDiffOption.checked) {
    throw new Error(`Binary Diff option is missing or disabled by default: ${JSON.stringify(binaryDiffOption)}`)
  }
  const diffOptionsButtonFeedback = await cdp.evaluate(`(() => {
    const button = document.querySelector(
      '.diff-options-control > button[aria-expanded="true"]'
    );
    const icon = button?.querySelector("svg");
    const popover = document.querySelector(".diff-options-control__popover");
    const reference = document.querySelector(".revision-change-browser__modes button.is-active");
    if (!(button instanceof HTMLButtonElement) ||
        !(icon instanceof SVGElement) ||
        !(popover instanceof HTMLElement) ||
        !(reference instanceof HTMLButtonElement)) return null;
    const buttonRect = button.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    const style = getComputedStyle(button);
    const referenceRect = reference.getBoundingClientRect();
    const referenceStyle = getComputedStyle(reference);
    return {
      active: button.classList.contains("is-active"),
      popoverVisible: popover.getBoundingClientRect().width > 0,
      borderWidth: style.borderTopWidth,
      background: style.backgroundColor,
      iconCenterDeltaX:
        Math.abs((buttonRect.left + buttonRect.right) / 2 -
          (iconRect.left + iconRect.right) / 2),
      iconCenterDeltaY:
        Math.abs((buttonRect.top + buttonRect.bottom) / 2 -
          (iconRect.top + iconRect.bottom) / 2),
      matchesReference:
        Math.abs(buttonRect.width - referenceRect.width) <= 0.5 &&
        Math.abs(buttonRect.height - referenceRect.height) <= 0.5 &&
        style.borderRadius === referenceStyle.borderRadius &&
        style.borderColor === referenceStyle.borderColor &&
        style.backgroundColor === referenceStyle.backgroundColor &&
        style.color === referenceStyle.color &&
        style.boxShadow === referenceStyle.boxShadow
    };
  })()`)
  if (
    !diffOptionsButtonFeedback?.active ||
    !diffOptionsButtonFeedback?.popoverVisible ||
    diffOptionsButtonFeedback?.borderWidth === '0px' ||
    diffOptionsButtonFeedback?.background === 'rgba(0, 0, 0, 0)' ||
    diffOptionsButtonFeedback?.iconCenterDeltaX > 0.5 ||
    diffOptionsButtonFeedback?.iconCenterDeltaY > 0.5 ||
    !diffOptionsButtonFeedback?.matchesReference
  ) {
    throw new Error(`Diff options button feedback is incomplete: ${JSON.stringify(diffOptionsButtonFeedback)}`)
  }
  await cdp.evaluate(`(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  })()`)
  await delay(40)
  await captureScreenshotEvidence(cdp, 'ui-dark-revision-diff-options.png')
  await cdp.evaluate(`(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
  })()`)
  await delay(40)
  await clickButtonByAriaLabel(cdp, 'Diff 选项')

  // Revision 目录多选同样只高亮目录对象，右侧显示明确的文件夹上下文。
  await cdp.evaluate(`(() => {
    document.querySelectorAll(".revision-change-row.is-directory")[0]?.click();
  })()`)
  await delay(40)
  await cdp.evaluate(`(() => {
    document.querySelectorAll(".revision-change-row.is-directory")[1]
      ?.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true
      }));
  })()`)
  await delay(50)
  const revisionFolderSelection = await cdp.evaluate(`({
    directories:
      document.querySelectorAll(
        ".revision-change-row.is-directory.is-selected"
      ).length,
    files:
      document.querySelectorAll(
        ".revision-change-row.is-file.is-selected"
      ).length
  })`)
  if (revisionFolderSelection.directories !== 2 || revisionFolderSelection.files !== 0) {
    throw new Error(
      `Revision directory multi-selection does not have independent visual state: ${JSON.stringify(
        revisionFolderSelection
      )}`
    )
  }
  checkpoints.push(await captureCheckpoint(cdp, 'revision-changes-folder-multiselect'))

  await clickButtonByAriaLabel(cdp, '平铺视图')
  checkpoints.push(await captureCheckpoint(cdp, 'revision-changes-flat'))

  await clickMatchingButton(cdp, '.inspector-tabs > button', '文件树')
  if (!(await cdp.evaluate(`Boolean(document.querySelector(".file-tree-tab"))`))) {
    throw new Error('The standalone revision file-tree panel was not rendered')
  }
  checkpoints.push(await captureCheckpoint(cdp, 'revision-file-tree'))

  // 文件树中的文件必须能直接打开与变更视图一致的上下文菜单，并可从当前
  // Revision 起点进入真实文件历史弹层。
  await cdp.evaluate(`(() => {
    const row = document.querySelector(".file-tree__row.is-file");
    const bounds = row?.getBoundingClientRect();
    row?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(bounds?.right ?? 900),
      clientY: Math.round(bounds?.bottom ?? 300)
    }));
  })()`)
  await delay(70)
  checkpoints.push(await captureCheckpoint(cdp, 'revision-file-tree-menu'))
  await clickMatchingButton(cdp, '.revision-file-menu:not(.revision-file-menu--submenu) > button', '文件历史')
  checkpoints.push(await captureCheckpoint(cdp, 'revision-file-history'))
  await clickButtonByAriaLabel(cdp, '关闭文件历史')

  await clickMatchingButton(cdp, '.sidebar__primary button', '本地更改')
  checkpoints.push(await captureCheckpoint(cdp, 'local-changes-tree'))
  await assertInteractiveIconButton(
    cdp,
    '.local-changes__tools .diff-visibility-toggle',
    'Local changes Diff visibility toggle',
    '.change-view-switch button.is-active'
  )

  // 目录多选必须只高亮目录对象，截图同时覆盖右侧“文件夹没有单一 Diff”的提示。
  await cdp.evaluate(`(() => {
    Array.from(document.querySelectorAll(".change-directory-row"))
      .find((row) =>
      row.querySelector("strong")?.textContent?.trim() === "Content"
    )?.click();
  })()`)
  await delay(40)
  await cdp.evaluate(`(() => {
    Array.from(document.querySelectorAll(".change-directory-row"))
      .find((row) =>
      row.querySelector("strong")?.textContent?.trim() === "Config"
    )?.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true
    }));
  })()`)
  await delay(60)
  const folderSelectionVisualState = await cdp.evaluate(`({
    directories:
      document.querySelectorAll(".change-directory-row.is-selected").length,
    files: document.querySelectorAll(".change-file-row.is-selected").length
  })`)
  if (folderSelectionVisualState.directories !== 2 || folderSelectionVisualState.files !== 0) {
    throw new Error(
      `Directory multi-selection does not have independent visual state: ${JSON.stringify(folderSelectionVisualState)}`
    )
  }
  checkpoints.push(await captureCheckpoint(cdp, 'local-changes-folder-multiselect'))

  // 用真实鼠标输入移动 Stage 分隔条，保留一张上下列表比例改变后的视觉证据。
  const stageSeparator = await cdp.evaluate(`(() => {
    const bounds = document.querySelector(".stage-split-resizer")
      ?.getBoundingClientRect();
    return bounds ? {
      x: Math.round(bounds.left + bounds.width / 2),
      y: Math.round(bounds.top + bounds.height / 2)
    } : null;
  })()`)
  if (!stageSeparator) {
    throw new Error('Visual audit could not find the staging resizer')
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: stageSeparator.x,
    y: stageSeparator.y,
    button: 'left',
    clickCount: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: stageSeparator.x,
    y: stageSeparator.y + 72,
    button: 'left',
    buttons: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: stageSeparator.x,
    y: stageSeparator.y + 72,
    button: 'left',
    clickCount: 1
  })
  await delay(60)
  checkpoints.push(await captureCheckpoint(cdp, 'local-changes-stage-split'))
  await cdp.evaluate(
    `document.querySelector(".stage-split-resizer")
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`
  )
  await delay(40)

  // 平铺视图仍保留当前选区，并让右侧 Diff 继续显示主选择。
  await clickButtonByAriaLabel(cdp, '平铺视图')
  checkpoints.push(await captureCheckpoint(cdp, 'local-changes-flat'))

  // 两个未暂存文件组成批量选区，右键菜单应在浅色主题下保持清晰且不越界。
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
  await delay(40)
  await cdp.evaluate(`(() => {
    const row = document.querySelectorAll(".change-file-row.is-selected")[1];
    const bounds = row?.getBoundingClientRect();
    row?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(bounds?.right ?? 900),
      clientY: Math.round((bounds?.bottom ?? 300) + 2)
    }));
  })()`)
  await delay(70)
  checkpoints.push(await captureCheckpoint(cdp, 'local-changes-menu'))

  await cdp.evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true
  }))`)
  await delay(50)

  // 单选文本文件后，从右键菜单进入真实文件历史弹层。
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
      clientX: Math.round(bounds?.right ?? 900),
      clientY: Math.round(bounds?.bottom ?? 300)
    }));
  })()`)
  await delay(60)
  await clickMatchingButton(cdp, '.change-context-menu button', '文件历史')
  await delay(50)
  checkpoints.push(await captureCheckpoint(cdp, 'local-file-history'))
  await clickButtonByAriaLabel(cdp, '关闭文件历史')
  await delay(50)

  await clickMatchingButton(cdp, '.sidebar__primary button', '分支总览')
  await assertFlatSurfaces(cdp, ['.repository-switcher', '.current-branch-card'])
  checkpoints.push(await captureCheckpoint(cdp, 'branches'))

  // 侧栏二级分组收起后仍需保留明确的树层级和可点击标题。
  await cdp.evaluate(`Array.from(document.querySelectorAll(".tree-group-label"))
    .find((button) => button.textContent?.trim() === "本地")?.click()`)
  await delay(50)
  checkpoints.push(await captureCheckpoint(cdp, 'sidebar-branch-collapsed'))
  await cdp.evaluate(`Array.from(document.querySelectorAll(".tree-group-label"))
    .find((button) => button.textContent?.trim() === "本地")?.click()`)
  await delay(50)

  await cdp.evaluate(`(() => {
    const card = Array.from(document.querySelectorAll(".branch-card"))
      .find((element) => !element.classList.contains("is-current") &&
        element.querySelector(".branch-card__top small")
          ?.textContent?.trim() === "本地");
    const bounds = card?.getBoundingClientRect();
    card?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(bounds?.left ?? 520),
      clientY: Math.round(bounds?.top ?? 300)
    }));
  })()`)
  await delay(70)
  checkpoints.push(await captureCheckpoint(cdp, 'local-branch-menu'))
  await clickMatchingButton(cdp, '.version-context-menu > button', '新建分支')
  await delay(50)
  checkpoints.push(await captureCheckpoint(cdp, 'branch-create-from-branch'))
  await clickButtonByAriaLabel(cdp, '关闭')
  await delay(50)

  await cdp.evaluate(`(() => {
    const card = document.querySelector(".branch-card.is-current");
    const bounds = card?.getBoundingClientRect();
    card?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(bounds?.left ?? 520),
      clientY: Math.round(bounds?.top ?? 300)
    }));
  })()`)
  await delay(70)
  checkpoints.push(await captureCheckpoint(cdp, 'current-branch-menu'))
  await cdp.evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true
  }))`)
  await delay(50)

  await cdp.evaluate(`(() => {
    const card = Array.from(document.querySelectorAll(".branch-card"))
      .find((element) =>
        element.querySelector(".branch-card__top small")
          ?.textContent?.trim() === "远程");
    const bounds = card?.getBoundingClientRect();
    card?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(bounds?.left ?? 520),
      clientY: Math.round(bounds?.top ?? 300)
    }));
  })()`)
  await delay(70)
  checkpoints.push(await captureCheckpoint(cdp, 'remote-branch-menu'))
  await cdp.evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true
  }))`)
  await delay(50)

  await clickMatchingButton(cdp, '.sidebar__primary button', '标签列表')
  // 同一张截图同时覆盖选中行和悬停行，确保状态背景不会吞没列分割线。
  const tagRowsVisualState = await cdp.evaluate(`(() => {
    const rows = document.querySelectorAll(".tag-row");
    rows[1]?.click();
    const hoverBounds = rows[2]?.getBoundingClientRect();
    return hoverBounds ? {
      x: Math.round(hoverBounds.left + hoverBounds.width / 2),
      y: Math.round(hoverBounds.top + hoverBounds.height / 2)
    } : null;
  })()`)
  if (!tagRowsVisualState) {
    throw new Error('Visual audit could not locate an interactive tag-list row')
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: tagRowsVisualState.x,
    y: tagRowsVisualState.y
  })
  await delay(45)
  checkpoints.push(await captureCheckpoint(cdp, 'tags'))

  await cdp.evaluate(`(() => {
    const row = document.querySelector(".tag-row");
    const bounds = row?.getBoundingClientRect();
    row?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(bounds?.left ?? 520),
      clientY: Math.round(bounds?.bottom ?? 260)
    }));
  })()`)
  await delay(60)
  checkpoints.push(await captureCheckpoint(cdp, 'tag-menu'))
  await clickMatchingButton(cdp, '.tag-context-menu > button', '查看标签详情')
  await delay(50)
  checkpoints.push(await captureCheckpoint(cdp, 'tag-details'))
  await clickButtonByAriaLabel(cdp, '关闭')
  await delay(50)

  await cdp.evaluate(`(() => {
    const row = document.querySelector(".tag-row");
    row?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 620,
      clientY: 260
    }));
  })()`)
  await delay(50)
  await clickMatchingButton(cdp, '.tag-context-menu > button', '修改标签')
  await delay(50)
  checkpoints.push(await captureCheckpoint(cdp, 'tag-edit'))
  await clickButtonByAriaLabel(cdp, '关闭')
  await delay(50)

  await clickMatchingButton(cdp, '.tag-overview__actions > button', '新建标签')
  await delay(50)
  checkpoints.push(await captureCheckpoint(cdp, 'tag-create'))
  await clickButtonByAriaLabel(cdp, '关闭')
  await delay(50)

  await clickMatchingButton(cdp, '.toolbar button', '命令')
  const commandInputBoundary = await cdp.evaluate(`(() => {
    const input = document.querySelector(
      ".command-palette > header.composite-input > input"
    );
    const shell = input?.parentElement;
    if (!(input instanceof HTMLInputElement) || !(shell instanceof HTMLElement)) return null;
    input.focus();
    const style = getComputedStyle(input);
    const shellStyle = getComputedStyle(shell);
    const probe = document.createElement("span");
    document.body.append(probe);
    probe.style.color = "var(--line)";
    const lineColor = getComputedStyle(probe).color;
    probe.style.color = "var(--accent-solid)";
    const accentColor = getComputedStyle(probe).color;
    probe.remove();
    return {
      borderWidths: [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth
      ],
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
      shellBorderBottomColor: shellStyle.borderBottomColor,
      lineColor,
      accentColor
    };
  })()`)
  if (
    !commandInputBoundary ||
    commandInputBoundary.borderWidths.some((width) => width !== '0px') ||
    (commandInputBoundary.outlineStyle !== 'none' && commandInputBoundary.outlineWidth !== '0px') ||
    commandInputBoundary.boxShadow !== 'none' ||
    commandInputBoundary.shellBorderBottomColor !== commandInputBoundary.lineColor ||
    commandInputBoundary.shellBorderBottomColor === commandInputBoundary.accentColor
  ) {
    throw new Error(
      `Command palette input retained an inner boundary or blue divider: ${JSON.stringify(commandInputBoundary)}`
    )
  }
  checkpoints.push(await captureCheckpoint(cdp, 'commands'))
  await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true
  }))`)
  await delay(50)

  await cdp.evaluate(`document.querySelector('button[aria-label="服务器设置"]')?.click()`)
  await delay(70)
  checkpoints.push(await captureCheckpoint(cdp, 'server'))
  await clickButtonByAriaLabel(cdp, '关闭服务器面板')

  await clickButtonByAriaLabel(cdp, '客户端设置')
  checkpoints.push(await captureCheckpoint(cdp, 'settings'))
  // 设置弹层改为单类内容工作区后，每个分类都必须真实切换并进入浅色审计；
  // 只截默认“常规”页会漏掉输入框、Shared Store 长内容和维护操作区。
  await clickMatchingButton(cdp, '.settings-categories > button', '默认提交身份')
  checkpoints.push(await captureCheckpoint(cdp, 'settings-identity'))
  await clickMatchingButton(cdp, '.settings-categories > button', '集成')
  checkpoints.push(await captureCheckpoint(cdp, 'settings-integrations'))
  await clickMatchingButton(cdp, '.settings-categories > button', '存储')
  checkpoints.push(await captureCheckpoint(cdp, 'settings-storage'))
  await clickMatchingButton(cdp, '.settings-categories > button', '维护')
  checkpoints.push(await captureCheckpoint(cdp, 'settings-maintenance'))
  await clickMatchingButton(cdp, '.settings-row button', '恢复默认')
  await assertPlainToastSurface(cdp)
  checkpoints.push(await captureCheckpoint(cdp, 'toast'))
  await clickButtonByAriaLabel(cdp, '关闭设置')

  await clickButtonByAriaLabel(cdp, '全局搜索')
  const searchInputBoundary = await cdp.evaluate(`(() => {
    const input = document.querySelector(
      ".search-dialog__input.composite-input > input"
    );
    const shell = input?.parentElement;
    if (!(input instanceof HTMLInputElement) || !(shell instanceof HTMLElement)) return null;
    input.focus();
    const style = getComputedStyle(input);
    const shellStyle = getComputedStyle(shell);
    const probe = document.createElement("span");
    document.body.append(probe);
    probe.style.color = "var(--line)";
    const lineColor = getComputedStyle(probe).color;
    probe.style.color = "var(--accent-solid)";
    const accentColor = getComputedStyle(probe).color;
    probe.remove();
    return {
      borderWidths: [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth
      ],
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
      shellBorderBottomColor: shellStyle.borderBottomColor,
      lineColor,
      accentColor
    };
  })()`)
  if (
    !searchInputBoundary ||
    searchInputBoundary.borderWidths.some((width) => width !== '0px') ||
    (searchInputBoundary.outlineStyle !== 'none' && searchInputBoundary.outlineWidth !== '0px') ||
    searchInputBoundary.boxShadow !== 'none' ||
    searchInputBoundary.shellBorderBottomColor !== searchInputBoundary.lineColor ||
    searchInputBoundary.shellBorderBottomColor === searchInputBoundary.accentColor
  ) {
    throw new Error(
      `Search dialog input retained an inner boundary or blue divider: ${JSON.stringify(searchInputBoundary)}`
    )
  }
  checkpoints.push(await captureCheckpoint(cdp, 'search'))
  await clickButtonByAriaLabel(cdp, '关闭搜索')

  // 低频 Lore 能力已收敛到单一仓库工具入口；视觉审计通过真实导航打开，
  // 同时覆盖精简侧栏与完整竖向工具导航的衔接。
  // 三个密度优化面板必须在最低验收尺寸检查，否则 1600×900 会掩盖配置页纵向溢出。
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: 1280,
    screenHeight: 720
  })
  await clickMatchingButton(cdp, '.sidebar__scroll .tree-row--root', '仓库工具')
  checkpoints.push(await captureCheckpoint(cdp, 'repository-tools'))
  const repositoryToolsLayout = await cdp.evaluate(`(() => {
    const navigation = document.querySelector(".tools-dialog__nav");
    const content = document.querySelector(".tools-dialog__body");
    if (!(navigation instanceof HTMLElement) || !(content instanceof HTMLElement)) {
      return null;
    }
    const navigationRect = navigation.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return {
      vertical: navigationRect.right <= contentRect.left + 1,
      activeTab:
        document.querySelector('.tools-dialog__nav [aria-selected="true"]')
          ?.id ?? null,
      navigationOverflow: navigation.scrollWidth > navigation.clientWidth,
      contentOverflow: content.scrollWidth > content.clientWidth
    };
  })()`)
  if (
    !repositoryToolsLayout?.vertical ||
    repositoryToolsLayout.activeTab !== 'repository-tool-tab-maintenance' ||
    repositoryToolsLayout.navigationOverflow ||
    repositoryToolsLayout.contentOverflow
  ) {
    throw new Error(`Repository Tools vertical layout overflowed: ${JSON.stringify(repositoryToolsLayout)}`)
  }
  await clickMatchingButton(cdp, '.tools-dialog__nav button', '分支协作')
  const branchLatestHistoryHeadingLayout = await cdp.evaluate(`(() => {
    const heading = document.querySelector(".branch-collaboration__reset > header");
    const icon = heading?.querySelector(":scope > svg");
    const copy = heading?.querySelector(":scope > span");
    if (!(heading instanceof HTMLElement) ||
        !(icon instanceof SVGElement) ||
        !(copy instanceof HTMLElement)) return null;
    const headingRect = heading.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    const copyRect = copy.getBoundingClientRect();
    return {
      flexDirection: getComputedStyle(heading).flexDirection,
      iconPrecedesCopy: iconRect.right <= copyRect.left + 1,
      centersAligned:
        Math.abs(
          (iconRect.top + iconRect.bottom) / 2 -
          (copyRect.top + copyRect.bottom) / 2
        ) <= 1,
      compactHeight: headingRect.height <= copyRect.height + 1
    };
  })()`)
  if (
    branchLatestHistoryHeadingLayout?.flexDirection !== 'row' ||
    !branchLatestHistoryHeadingLayout?.iconPrecedesCopy ||
    !branchLatestHistoryHeadingLayout?.centersAligned ||
    !branchLatestHistoryHeadingLayout?.compactHeight
  ) {
    throw new Error(
      `Branch Latest history heading layout regressed: ${JSON.stringify(branchLatestHistoryHeadingLayout)}`
    )
  }
  checkpoints.push(await captureCheckpoint(cdp, 'repository-branch-collaboration'))
  await assertSelectHoverBorder(cdp, '.branch-collaboration select', 'Repository Branch Collaboration select')
  await cdp.evaluate(`document.documentElement.dataset.theme = "dark"`)
  await delay(40)
  await captureScreenshotEvidence(cdp, 'ui-dark-repository-branch-collaboration.png')
  await cdp.evaluate(`document.documentElement.dataset.theme = "light"`)
  await delay(40)
  await clickMatchingButton(cdp, '.tools-dialog__nav button', '依赖')
  await cdp.evaluate(`document.documentElement.dataset.theme = "dark"`)
  await delay(40)
  await captureScreenshotEvidence(cdp, 'ui-dark-repository-dependencies.png')
  await cdp.evaluate(`document.documentElement.dataset.theme = "light"`)
  await delay(40)
  checkpoints.push(await captureCheckpoint(cdp, 'repository-dependencies'))
  /*
   * 依赖面板同时包含文本输入和复选框，宽泛的 input 规则最容易把 14px 方框
   * 拉成输入框高度。直接校验最终边框盒为正方形，覆盖查询区与编辑区两个上下文。
   */
  const dependencyCheckboxGeometry = await cdp.evaluate(`(() => {
    const checkboxes = Array.from(
      document.querySelectorAll(
        '.dependency-query .control-checkbox, .dependency-editor .control-checkbox'
      )
    );
    return checkboxes.map((checkbox) => {
      const rect = checkbox.getBoundingClientRect();
      const style = getComputedStyle(checkbox);
      return {
        width: rect.width,
        height: rect.height,
        minWidth: style.minWidth,
        minHeight: style.minHeight,
        padding: style.padding,
        appearance: style.appearance
      };
    });
  })()`)
  if (
    dependencyCheckboxGeometry.length < 3 ||
    dependencyCheckboxGeometry.some(
      (geometry) =>
        geometry.width !== 14 ||
        geometry.height !== 14 ||
        geometry.minWidth !== '14px' ||
        geometry.minHeight !== '14px' ||
        geometry.padding !== '0px' ||
        geometry.appearance !== 'none'
    )
  ) {
    throw new Error(
      `Dependency checkboxes are not square shared controls: ${JSON.stringify(dependencyCheckboxGeometry)}`
    )
  }
  await clickMatchingButton(cdp, '.tools-dialog__nav button', '配置')
  checkpoints.push(await captureCheckpoint(cdp, 'repository-configuration'))
  const repositoryConfigurationDensity = await cdp.evaluate(`(() => {
    const content = document.querySelector(".tools-dialog__body");
    const action = document.querySelector(
      ".repository-publish > footer button.is-primary"
    );
    if (!(content instanceof HTMLElement) || !(action instanceof HTMLElement)) {
      return null;
    }
    const contentRect = content.getBoundingClientRect();
    const actionRect = action.getBoundingClientRect();
    return {
      verticalOverflow: content.scrollHeight > content.clientHeight + 1,
      horizontalOverflow: content.scrollWidth > content.clientWidth + 1,
      finalActionVisible:
        actionRect.top >= contentRect.top && actionRect.bottom <= contentRect.bottom + 1
    };
  })()`)
  if (
    repositoryConfigurationDensity?.verticalOverflow ||
    repositoryConfigurationDensity?.horizontalOverflow ||
    !repositoryConfigurationDensity?.finalActionVisible
  ) {
    throw new Error(`Repository Configuration density audit failed: ${JSON.stringify(repositoryConfigurationDensity)}`)
  }
  await cdp.evaluate(`document.documentElement.dataset.theme = "dark"`)
  await delay(40)
  await captureScreenshotEvidence(cdp, 'ui-dark-repository-configuration.png')
  await cdp.evaluate(`document.documentElement.dataset.theme = "light"`)
  await delay(40)

  /*
   * Accounts 是设备级双栏中心：远端地址只服务于本次登录，不能再依赖当前仓库。
   * 该页单独遍历双主题，避免只验收默认 Maintenance。
   */
  await clickMatchingButton(cdp, '.tools-dialog__nav button', '账户')
  checkpoints.push(await captureCheckpoint(cdp, 'repository-accounts'))
  const repositoryAccountCenter = await cdp.evaluate(`(() => {
    const content = document.querySelector(".tools-dialog__body");
    const remote = document.querySelector(
      ".auth-account-manager__remote-controls input"
    );
    const browserSignInButton = document.querySelector(
      ".auth-account-manager__remote-controls > button"
    );
    const manager = document.querySelector(
      ".auth-account-manager"
    );
    if (!(content instanceof HTMLElement) ||
        !(remote instanceof HTMLInputElement) ||
        !(browserSignInButton instanceof HTMLButtonElement) ||
        !(manager instanceof HTMLElement)) return null;
    const remoteRect = remote.getBoundingClientRect();
    const browserSignInButtonRect = browserSignInButton.getBoundingClientRect();
    return {
      editable: !remote.readOnly,
      hasDeviceHint:
        remote.closest(".auth-account-manager__login")?.textContent?.includes("登录不依赖本地仓库") ?? false,
      browserSignInAligned:
        Math.abs(remoteRect.top - browserSignInButtonRect.top) <= 1 &&
        Math.abs(remoteRect.bottom - browserSignInButtonRect.bottom) <= 1,
      horizontalOverflow: content.scrollWidth > content.clientWidth + 1,
      verticalOverflow: manager.scrollHeight > manager.clientHeight + 1,
      twoPaneColumns: getComputedStyle(manager).gridTemplateColumns.split(" ").length === 2,
      minimumHeight: manager.getBoundingClientRect().height >= 400
    };
  })()`)
  if (
    !repositoryAccountCenter?.editable ||
    !repositoryAccountCenter?.hasDeviceHint ||
    !repositoryAccountCenter?.browserSignInAligned ||
    repositoryAccountCenter?.horizontalOverflow ||
    repositoryAccountCenter?.verticalOverflow ||
    !repositoryAccountCenter?.twoPaneColumns ||
    !repositoryAccountCenter?.minimumHeight
  ) {
    throw new Error(`Repository Accounts center audit failed: ${JSON.stringify(repositoryAccountCenter)}`)
  }
  await cdp.evaluate(`document.documentElement.dataset.theme = "dark"`)
  await delay(40)
  await captureScreenshotEvidence(cdp, 'ui-dark-repository-accounts.png')
  await cdp.evaluate(`document.documentElement.dataset.theme = "light"`)
  await delay(40)

  await clickMatchingButton(cdp, '.tools-dialog__nav button', '协作文件锁')
  checkpoints.push(await captureCheckpoint(cdp, 'repository-locks'))
  const collaborativeLocksDensity = await cdp.evaluate(`(() => {
    const filter = document.querySelector(".lock-management__filter");
    const input = document.querySelector(".lock-management__acquire input");
    const button = document.querySelector(".lock-management__acquire button");
    if (!(filter instanceof HTMLElement) ||
        !(input instanceof HTMLElement) ||
        !(button instanceof HTMLElement)) return null;
    const inputRect = input.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const buttonStyle = getComputedStyle(button);
    const buttonIcon = button.querySelector("svg");
    const buttonIconRect = buttonIcon?.getBoundingClientRect();
    const lockRows = Array.from(document.querySelectorAll(".lock-list li"));
    const releaseButtons = lockRows
      .map((row) => row.querySelector(":scope > button"))
      .filter((item) => item instanceof HTMLButtonElement);
    const releaseButtonRects = releaseButtons.map((item) => item.getBoundingClientRect());
    const releaseButtonStyles = releaseButtons.map((item) => getComputedStyle(item));
    return {
      filterHasDecorativeIcon: Boolean(filter.querySelector("svg")),
      filterOverflow: filter.scrollWidth > filter.clientWidth + 1,
      equalControlHeight: Math.abs(inputRect.height - buttonRect.height) <= 0.5,
      alignedBottom: Math.abs(inputRect.bottom - buttonRect.bottom) <= 0.5,
      buttonDisplay: buttonStyle.display,
      buttonAlignItems: buttonStyle.alignItems,
      buttonJustifyContent: buttonStyle.justifyContent,
      buttonGap: buttonStyle.gap,
      buttonBorderWidth: buttonStyle.borderTopWidth,
      buttonBackground: buttonStyle.backgroundColor,
      iconCentered: buttonIconRect
        ? Math.abs((buttonIconRect.top + buttonIconRect.bottom) / 2 - (buttonRect.top + buttonRect.bottom) / 2) <= 0.5
        : false,
      hasLockRows: lockRows.length > 0,
      releaseButtonsVisible: lockRows.length === 0 || releaseButtons.length === lockRows.length,
      releaseButtonsHaveIcons: releaseButtons.every((item) => Boolean(item.querySelector("svg"))),
      releaseButtonsHaveBorders: releaseButtonStyles.every((style) => style.borderTopWidth !== "0px"),
      releaseButtonsAligned:
        lockRows.length === 0 ||
        (releaseButtonRects.length > 0 &&
        releaseButtonRects.every((rect) =>
          Math.abs(rect.left - releaseButtonRects[0].left) <= 0.5 &&
          Math.abs(rect.width - releaseButtonRects[0].width) <= 0.5
        )),
      exposesUnknownOwnerSentinel: lockRows.some((row) =>
        row.textContent?.includes("<unknown>")
      ),
      ownerDisplayLocalized:
        lockRows.length === 0 ||
        lockRows.every((row) => !row.textContent?.includes("<unknown>"))
    };
  })()`)
  if (
    collaborativeLocksDensity?.filterHasDecorativeIcon ||
    collaborativeLocksDensity?.filterOverflow ||
    !collaborativeLocksDensity?.equalControlHeight ||
    !collaborativeLocksDensity?.alignedBottom ||
    !['flex', 'inline-flex'].includes(collaborativeLocksDensity?.buttonDisplay) ||
    collaborativeLocksDensity?.buttonAlignItems !== 'center' ||
    collaborativeLocksDensity?.buttonJustifyContent !== 'center' ||
    collaborativeLocksDensity?.buttonGap !== '6px' ||
    collaborativeLocksDensity?.buttonBorderWidth === '0px' ||
    collaborativeLocksDensity?.buttonBackground !== 'rgb(120, 164, 255)' ||
    !collaborativeLocksDensity?.iconCentered ||
    !collaborativeLocksDensity?.releaseButtonsVisible ||
    !collaborativeLocksDensity?.releaseButtonsHaveIcons ||
    !collaborativeLocksDensity?.releaseButtonsHaveBorders ||
    !collaborativeLocksDensity?.releaseButtonsAligned ||
    collaborativeLocksDensity?.exposesUnknownOwnerSentinel ||
    !collaborativeLocksDensity?.ownerDisplayLocalized
  ) {
    throw new Error(`Collaborative Locks density audit failed: ${JSON.stringify(collaborativeLocksDensity)}`)
  }
  await cdp.evaluate(`document.documentElement.dataset.theme = "dark"`)
  await delay(40)
  await captureScreenshotEvidence(cdp, 'ui-dark-repository-locks.png')
  await cdp.evaluate(`document.documentElement.dataset.theme = "light"`)
  await delay(40)

  // 新增 P2 工具页属于仓库工具的一级工作区，必须分别遍历并确认内容只在
  // 右侧滚动区域内布局，不能因导航项增加而产生主文档横向溢出。
  await cdp.evaluate(`(() => {
    // 浏览器视觉环境没有 Tauri IPC；只为元数据只读命令安装确定性桩，
    // 以便验证“进入页面自动读取”和“参数变化自动重读”的真实组件状态流。
    window.__metadataAuditRequests = [];
    window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ ?? {};
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command !== "lore_metadata_list") {
        throw new Error("Unexpected visual-audit IPC command: " + command);
      }
      window.__metadataAuditRequests.push(args);
      return {
        operation: args.scope + ".metadata-list",
        status: 0,
        durationMs: 1,
        events: [{
          tagName: "metadata",
          data: {
            key: "visual-audit-scope",
            value: { tagName: "String", data: args.scope }
          }
        }]
      };
    };
  })()`)
  await clickMatchingButton(cdp, '.tools-dialog__nav button', '元数据')
  const initialMetadataAutoLoad = await cdp.evaluate(`(() => ({
    requests: window.__metadataAuditRequests ?? [],
    value: document.querySelector(".metadata-browser__result tbody td:last-child code")
      ?.textContent?.trim() ?? "",
    error: document.querySelector(".metadata-browser__result .tool-inline-error")
      ?.textContent?.trim() ?? ""
  }))()`)
  if (
    initialMetadataAutoLoad.requests.length !== 1 ||
    initialMetadataAutoLoad.requests[0]?.scope !== 'repository' ||
    initialMetadataAutoLoad.value !== 'repository' ||
    initialMetadataAutoLoad.error
  ) {
    throw new Error(`Metadata did not load automatically on entry: ${JSON.stringify(initialMetadataAutoLoad)}`)
  }

  /*
   * 使用真实鼠标位置触发 hover，再主动聚焦同一个原生 select。回归条件刻意检查
   * hover 与 focus 同时成立，防止中性亮边框再次盖过品牌蓝焦点边框。
   */
  const metadataSelectBounds = await cdp.evaluate(`(() => {
    const bounds = document.querySelector(".metadata-browser__controls .control-select select")
      ?.getBoundingClientRect();
    return bounds ? {
      x: Math.round(bounds.left + bounds.width / 2),
      y: Math.round(bounds.top + bounds.height / 2)
    } : null;
  })()`)
  if (!metadataSelectBounds) {
    throw new Error('Visual audit could not locate the metadata scope select')
  }

  for (const theme of ['light', 'dark']) {
    await cdp.evaluate(`(() => {
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      document.documentElement.style.colorScheme = ${JSON.stringify(theme)};
    })()`)
    await delay(40)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: metadataSelectBounds.x,
      y: metadataSelectBounds.y
    })
    await delay(40)
    const selectFocusRing = await cdp.evaluate(`(() => {
      const select = document.querySelector(".metadata-browser__controls .control-select select");
      if (!(select instanceof HTMLSelectElement)) return null;
      select.focus();
      const style = getComputedStyle(select);
      const accentProbe = document.createElement("span");
      accentProbe.style.color = "var(--accent-solid)";
      document.body.append(accentProbe);
      const accentColor = getComputedStyle(accentProbe).color;
      accentProbe.remove();
      return {
        hovered: select.matches(":hover"),
        focused: select.matches(":focus"),
        borderColor: style.borderTopColor,
        outlineColor: style.outlineColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineOffset: style.outlineOffset,
        accentColor
      };
    })()`)
    if (
      !selectFocusRing?.hovered ||
      !selectFocusRing?.focused ||
      selectFocusRing.borderColor !== selectFocusRing.accentColor ||
      selectFocusRing.outlineColor !== selectFocusRing.accentColor ||
      selectFocusRing.outlineStyle === 'none' ||
      selectFocusRing.outlineWidth !== '1px' ||
      selectFocusRing.outlineOffset !== '-1px'
    ) {
      throw new Error(`Select hover/focus ring audit failed in ${theme} theme: ${JSON.stringify(selectFocusRing)}`)
    }

    /*
     * 原生弹出菜单不进入页面截图；把同一组选项临时投影为 listbox，才能使用
     * 真实鼠标命中 option 并验证 WebView 实际消费的 hover 背景，而非只查样式表。
     */
    const optionHoverBounds = await cdp.evaluate(`(() => {
      document.querySelector("#visual-audit-option-hover-probe")?.remove();
      const source = document.querySelector(".metadata-browser__controls .control-select select");
      if (!(source instanceof HTMLSelectElement)) return null;
      const probe = source.cloneNode(true);
      probe.id = "visual-audit-option-hover-probe";
      probe.size = Math.min(4, probe.options.length);
      probe.style.cssText =
        "position:fixed;left:8px;top:8px;width:180px;height:104px;z-index:2147483647";
      document.body.append(probe);
      const option = probe.options[Math.min(2, probe.options.length - 1)];
      const bounds = option?.getBoundingClientRect();
      return bounds && bounds.width > 0 && bounds.height > 0 ? {
        x: Math.round(bounds.left + bounds.width / 2),
        y: Math.round(bounds.top + bounds.height / 2)
      } : null;
    })()`)
    if (!optionHoverBounds) {
      throw new Error(`Visual audit could not render the option hover probe in ${theme} theme`)
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: optionHoverBounds.x,
      y: optionHoverBounds.y
    })
    await delay(40)
    const optionHoverSurface = await cdp.evaluate(`(() => {
      const probe = document.querySelector("#visual-audit-option-hover-probe");
      if (!(probe instanceof HTMLSelectElement)) return null;
      const option = probe.options[Math.min(2, probe.options.length - 1)];
      const tokenProbe = document.createElement("span");
      tokenProbe.style.backgroundColor = "var(--select-option-hover-bg)";
      document.body.append(tokenProbe);
      const tokenColor = getComputedStyle(tokenProbe).backgroundColor;
      tokenProbe.remove();
      return {
        hovered: option?.matches(":hover") ?? false,
        backgroundColor: option ? getComputedStyle(option).backgroundColor : "",
        tokenColor
      };
    })()`)
    await cdp.evaluate(`document.querySelector("#visual-audit-option-hover-probe")?.remove()`)
    if (!optionHoverSurface?.hovered || optionHoverSurface.backgroundColor !== optionHoverSurface.tokenColor) {
      throw new Error(
        `Select option hover surface audit failed in ${theme} theme: ${JSON.stringify(optionHoverSurface)}`
      )
    }
  }
  await cdp.evaluate(`(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
  })()`)
  await delay(40)

  await cdp.evaluate(`(() => {
    const scope = document.querySelector(".metadata-browser__controls select");
    if (!(scope instanceof HTMLSelectElement)) return;
    scope.value = "revision";
    scope.dispatchEvent(new Event("change", { bubbles: true }));
  })()`)
  await delay(80)
  const metadataParameterReload = await cdp.evaluate(`(() => {
    const requests = window.__metadataAuditRequests ?? [];
    const latest = requests.at(-1);
    return {
      requestCount: requests.length,
      scope: latest?.scope ?? "",
      target: latest?.target ?? "",
      revision: latest?.revision ?? "",
      value: document.querySelector(".metadata-browser__result tbody td:last-child code")
        ?.textContent?.trim() ?? "",
      userSelect: getComputedStyle(
        document.querySelector(".metadata-browser__result table")
      ).userSelect
    };
  })()`)
  if (
    metadataParameterReload.requestCount !== 2 ||
    metadataParameterReload.scope !== 'revision' ||
    !metadataParameterReload.target ||
    metadataParameterReload.revision !== metadataParameterReload.target ||
    metadataParameterReload.value !== 'revision' ||
    metadataParameterReload.userSelect !== 'text'
  ) {
    throw new Error(`Metadata did not reload after parameter change: ${JSON.stringify(metadataParameterReload)}`)
  }
  checkpoints.push(await captureCheckpoint(cdp, 'repository-metadata'))
  await assertSelectHoverBorder(cdp, '.metadata-browser select', 'Repository Metadata select')
  await cdp.evaluate(`(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  })()`)
  await delay(40)
  await captureScreenshotEvidence(cdp, 'ui-dark-repository-metadata.png')
  await cdp.evaluate(`(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
  })()`)
  await delay(40)
  await clickMatchingButton(cdp, '.tools-dialog__nav button', '高级诊断')

  /*
   * 高级诊断同时覆盖共享 control-input 与 control-button。输入框验证 hover 与
   * focus 都是品牌蓝；按钮使用真实指针点击，并阻止本次审计触发业务动作，验证
   * 鼠标 focus 不会残留蓝色高亮。
   */
  const diagnosticFocusTargetsReady = await cdp.evaluate(`(() => {
    const fields = document.querySelector(".diagnostic-module__fields--dump");
    const input = fields?.querySelector(".control-input");
    const button = fields?.closest(".diagnostic-module")
      ?.querySelector("footer .control-button");
    if (!(input instanceof HTMLInputElement) ||
        !(button instanceof HTMLButtonElement)) return false;
    input.dataset.visualAuditFocusKind = "input";
    button.dataset.visualAuditFocusKind = "button";
    return true;
  })()`)
  if (!diagnosticFocusTargetsReady) {
    throw new Error('Visual audit could not locate the diagnostic focus controls')
  }

  for (const theme of ['light', 'dark']) {
    await cdp.evaluate(`(() => {
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      document.documentElement.style.colorScheme = ${JSON.stringify(theme)};
    })()`)
    await delay(40)

    const inputBounds = await cdp.evaluate(`(() => {
      const control = document.querySelector(
        '[data-visual-audit-focus-kind="input"]'
      );
      const bounds = control?.getBoundingClientRect();
      return bounds ? {
        x: Math.round(bounds.left + bounds.width / 2),
        y: Math.round(bounds.top + bounds.height / 2)
      } : null;
    })()`)
    if (!inputBounds) {
      throw new Error('Visual audit could not measure the diagnostic input')
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: inputBounds.x,
      y: inputBounds.y
    })
    await delay(40)
    const inputState = await cdp.evaluate(`(() => {
      const control = document.querySelector(
        '[data-visual-audit-focus-kind="input"]'
      );
      if (!(control instanceof HTMLInputElement)) return null;
      const accentProbe = document.createElement("span");
      accentProbe.style.color = "var(--accent-solid)";
      document.body.append(accentProbe);
      const accentColor = getComputedStyle(accentProbe).color;
      accentProbe.remove();
      const hoverBorderColor = getComputedStyle(control).borderTopColor;
      control.focus();
      const style = getComputedStyle(control);
      return {
        hovered: control.matches(":hover"),
        focused: control.matches(":focus"),
        hoverBorderColor,
        borderColor: style.borderTopColor,
        outlineColor: style.outlineColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineOffset: style.outlineOffset,
        accentColor
      };
    })()`)
    if (
      !inputState?.hovered ||
      !inputState?.focused ||
      inputState.hoverBorderColor !== inputState.accentColor ||
      inputState.borderColor !== inputState.accentColor ||
      inputState.outlineColor !== inputState.accentColor ||
      inputState.outlineStyle === 'none' ||
      inputState.outlineWidth !== '1px' ||
      inputState.outlineOffset !== '-1px'
    ) {
      throw new Error(`Diagnostic input interaction audit failed in ${theme} theme: ${JSON.stringify(inputState)}`)
    }

    const buttonBounds = await cdp.evaluate(`(() => {
        const control = document.querySelector(
          '[data-visual-audit-focus-kind="button"]'
        );
        const bounds = control?.getBoundingClientRect();
        return bounds ? {
          x: Math.round(bounds.left + bounds.width / 2),
          y: Math.round(bounds.top + bounds.height / 2)
        } : null;
      })()`)
    if (!buttonBounds) {
      throw new Error('Visual audit could not measure the diagnostic button')
    }
    await cdp.evaluate(`(() => {
      const control = document.querySelector(
        '[data-visual-audit-focus-kind="button"]'
      );
      control?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      }, { capture: true, once: true });
    })()`)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: buttonBounds.x,
      y: buttonBounds.y
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      x: buttonBounds.x,
      y: buttonBounds.y
    })
    await delay(40)
    const pressedButtonState = await cdp.evaluate(`(() => {
      const control = document.querySelector(
        '[data-visual-audit-focus-kind="button"]'
      );
      if (!(control instanceof HTMLButtonElement)) return null;
      const accentProbe = document.createElement("span");
      accentProbe.style.color = "var(--accent-solid)";
      const accentPressedProbe = document.createElement("span");
      accentPressedProbe.style.color = "var(--accent-muted)";
      const activeBackgroundProbe = document.createElement("span");
      activeBackgroundProbe.style.backgroundColor = "var(--button-neutral-active-bg)";
      document.body.append(accentProbe);
      document.body.append(accentPressedProbe);
      document.body.append(activeBackgroundProbe);
      const accentColor = getComputedStyle(accentProbe).color;
      const accentPressedColor = getComputedStyle(accentPressedProbe).color;
      const activeBackgroundColor = getComputedStyle(activeBackgroundProbe).backgroundColor;
      accentProbe.remove();
      accentPressedProbe.remove();
      activeBackgroundProbe.remove();
      return {
        active: control.matches(":active"),
        borderColor: getComputedStyle(control).borderTopColor,
        backgroundColor: getComputedStyle(control).backgroundColor,
        accentColor,
        accentPressedColor,
        activeBackgroundColor
      };
    })()`)
    if (
      !pressedButtonState?.active ||
      pressedButtonState.borderColor !== pressedButtonState.accentPressedColor ||
      pressedButtonState.backgroundColor !== pressedButtonState.activeBackgroundColor
    ) {
      throw new Error(
        `Diagnostic button pressed-state audit failed in ${theme} theme: ${JSON.stringify(pressedButtonState)}`
      )
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      x: buttonBounds.x,
      y: buttonBounds.y
    })
    await delay(40)
    const hoveredButtonState = await cdp.evaluate(`(() => {
      const control = document.querySelector(
        '[data-visual-audit-focus-kind="button"]'
      );
      if (!(control instanceof HTMLButtonElement)) return null;
      const accentProbe = document.createElement("span");
      accentProbe.style.color = "var(--accent-solid)";
      document.body.append(accentProbe);
      const accentColor = getComputedStyle(accentProbe).color;
      accentProbe.remove();
      return {
        hovered: control.matches(":hover"),
        borderColor: getComputedStyle(control).borderTopColor,
        backgroundColor: getComputedStyle(control).backgroundColor,
        accentColor
      };
    })()`)
    if (
      !hoveredButtonState?.hovered ||
      hoveredButtonState.borderColor !== hoveredButtonState.accentColor ||
      hoveredButtonState.backgroundColor === pressedButtonState?.backgroundColor
    ) {
      throw new Error(
        `Diagnostic button hover-state audit failed in ${theme} theme: ${JSON.stringify(hoveredButtonState)}`
      )
    }
    /*
     * 移开指针后再检查鼠标点击留下的 focus。hover 蓝边框是预期反馈，不能把它
     * 误判为焦点残留；真正需要消失的是既非 hover 也非 focus-visible 时的蓝框。
     */
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 1,
      y: 1
    })
    await delay(40)
    const buttonState = await cdp.evaluate(`(() => {
      const control = document.querySelector(
        '[data-visual-audit-focus-kind="button"]'
      );
      if (!(control instanceof HTMLButtonElement)) return null;
      const style = getComputedStyle(control);
      const accentProbe = document.createElement("span");
      accentProbe.style.color = "var(--accent-solid)";
      document.body.append(accentProbe);
      const accentColor = getComputedStyle(accentProbe).color;
      accentProbe.remove();
      return {
        hovered: control.matches(":hover"),
        focused: control.matches(":focus"),
        focusVisible: control.matches(":focus-visible"),
        borderColor: style.borderTopColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        accentColor
      };
    })()`)
    if (
      buttonState?.hovered ||
      !buttonState?.focused ||
      buttonState.focusVisible ||
      buttonState.borderColor === buttonState.accentColor ||
      (buttonState.outlineStyle !== 'none' && buttonState.outlineWidth !== '0px')
    ) {
      throw new Error(`Diagnostic button click-focus audit failed in ${theme} theme: ${JSON.stringify(buttonState)}`)
    }

    /*
     * 从按钮前最后一个输入框按 Tab 进入同一按钮，确认只对键盘模态恢复品牌蓝
     * focus-visible；这与上面的真实鼠标点击共同锁定两种输入来源的差异。
     */
    await cdp.evaluate(`(() => {
      const button = document.querySelector(
        '[data-visual-audit-focus-kind="button"]'
      );
      const inputs = button?.closest(".diagnostic-module")
        ?.querySelectorAll(".diagnostic-module__fields input");
      inputs?.item(inputs.length - 1)?.focus();
    })()`)
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9
    })
    await delay(40)
    const keyboardButtonState = await cdp.evaluate(`(() => {
      const control = document.querySelector(
        '[data-visual-audit-focus-kind="button"]'
      );
      if (!(control instanceof HTMLButtonElement)) return null;
      const style = getComputedStyle(control);
      const accentProbe = document.createElement("span");
      accentProbe.style.color = "var(--accent-solid)";
      document.body.append(accentProbe);
      const accentColor = getComputedStyle(accentProbe).color;
      accentProbe.remove();
      return {
        focused: control.matches(":focus"),
        focusVisible: control.matches(":focus-visible"),
        outlineColor: style.outlineColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineOffset: style.outlineOffset,
        accentColor
      };
    })()`)
    if (
      !keyboardButtonState?.focused ||
      !keyboardButtonState?.focusVisible ||
      keyboardButtonState.outlineColor !== keyboardButtonState.accentColor ||
      keyboardButtonState.outlineStyle === 'none' ||
      keyboardButtonState.outlineWidth !== '1px' ||
      keyboardButtonState.outlineOffset !== '-1px'
    ) {
      throw new Error(
        `Diagnostic button keyboard-focus audit failed in ${theme} theme: ${JSON.stringify(keyboardButtonState)}`
      )
    }
  }
  await cdp.evaluate(`(() => {
    document.querySelectorAll("[data-visual-audit-focus-kind]").forEach((control) => {
      control.removeAttribute("data-visual-audit-focus-kind");
      control.blur();
    });
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
  })()`)
  await delay(40)

  /*
   * 高级诊断的卡片会在英文长标签下暴露两类布局问题：同一字段行的输入框
   * 失去基线，以及相邻卡片的底部操作区错位。这里直接检查真实几何位置，
   * 同时确认应用外壳的禁选规则没有吞掉诊断日志的原生文本选择能力。
   */
  const diagnosticLayout = await cdp.evaluate(`(() => {
    const dumpFields = document.querySelector(".diagnostic-module__fields--dump");
    const dumpModule = dumpFields?.closest(".diagnostic-module");
    const instanceModule = Array.from(document.querySelectorAll(".diagnostic-module")).at(3);
    const report = document.querySelector(".diagnostic-report");
    const dumpInputs = Array.from(dumpFields?.querySelectorAll("input") ?? []);
    const dumpFooter = dumpModule?.querySelector(":scope > footer");
    const instanceFooter =
      instanceModule?.querySelector(":scope > footer") ??
      instanceModule?.querySelector(":scope > .diagnostic-module__instance-actions");
    if (!(dumpFields instanceof HTMLElement) ||
        !(dumpFooter instanceof HTMLElement) ||
        !(instanceFooter instanceof HTMLElement) ||
        !(report instanceof HTMLElement) ||
        dumpInputs.length !== 3) return null;
    const inputTops = dumpInputs.map((input) => input.getBoundingClientRect().top);
    const dumpFooterRect = dumpFooter.getBoundingClientRect();
    const instanceFooterRect = instanceFooter.getBoundingClientRect();
    return {
      inputTopSpread: Math.max(...inputTops) - Math.min(...inputTops),
      footerTopDelta: Math.abs(dumpFooterRect.top - instanceFooterRect.top),
      footerHeightDelta: Math.abs(dumpFooterRect.height - instanceFooterRect.height),
      reportUserSelect: getComputedStyle(report).userSelect
    };
  })()`)
  if (
    !(diagnosticLayout?.inputTopSpread <= 0.5) ||
    !(diagnosticLayout?.footerTopDelta <= 0.5) ||
    !(diagnosticLayout?.footerHeightDelta <= 0.5) ||
    diagnosticLayout?.reportUserSelect !== 'text'
  ) {
    throw new Error(`Diagnostic layout and selection audit failed: ${JSON.stringify(diagnosticLayout)}`)
  }

  checkpoints.push(await captureCheckpoint(cdp, 'repository-diagnostics'))
  await cdp.evaluate(`(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  })()`)
  await delay(40)
  await captureScreenshotEvidence(cdp, 'ui-dark-repository-diagnostics.png')
  await cdp.evaluate(`(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
  })()`)
  await delay(40)
  const repositoryP2Layout = await cdp.evaluate(`(() => {
    const body = document.querySelector(".tools-dialog__body");
    const diagnostics = document.querySelector(".repository-diagnostics");
    if (!(body instanceof HTMLElement) ||
        !(diagnostics instanceof HTMLElement)) return null;
    return {
      bodyHorizontalOverflow: body.scrollWidth > body.clientWidth + 1,
      diagnosticsHorizontalOverflow:
        diagnostics.scrollWidth > diagnostics.clientWidth + 1
    };
  })()`)
  if (repositoryP2Layout?.bodyHorizontalOverflow || repositoryP2Layout?.diagnosticsHorizontalOverflow) {
    throw new Error(`Repository P2 layout overflowed: ${JSON.stringify(repositoryP2Layout)}`)
  }

  await clickMatchingButton(cdp, '.tools-dialog__nav button', '修订发现与恢复')
  checkpoints.push(await captureCheckpoint(cdp, 'repository-revision-discovery'))
  await assertSelectHoverBorder(cdp, '.revision-recovery select', 'Repository Revision Recovery select')
  const revisionFindDensity = await cdp.evaluate(`(() => {
    const find = document.querySelector(".revision-recovery__find");
    const numberForm = document.querySelector(".revision-recovery__query--number");
    const metadataForm = document.querySelector(".revision-recovery__query--metadata");
    const buttons = Array.from(
      document.querySelectorAll(".revision-recovery__find button")
    );
    const metadataLabels = Array.from(
      document.querySelectorAll(".revision-recovery__query--metadata label")
    );
    if (!(find instanceof HTMLElement) ||
        !(numberForm instanceof HTMLElement) ||
        !(metadataForm instanceof HTMLElement) ||
        buttons.length !== 2 ||
        metadataLabels.length !== 2) return null;
    const numberRect = numberForm.getBoundingClientRect();
    const metadataRect = metadataForm.getBoundingClientRect();
    const buttonRects = buttons.map((button) => button.getBoundingClientRect());
    const labelRects = metadataLabels.map((label) => label.getBoundingClientRect());
    return {
      horizontalOverflow: find.scrollWidth > find.clientWidth + 1,
      numberFormWidth: numberRect.width,
      metadataFormWidth: metadataRect.width,
      compactHeight: Math.max(numberRect.height, metadataRect.height),
      equalButtonWidth: Math.abs(buttonRects[0].width - buttonRects[1].width) <= 0.5,
      equalButtonHeight: Math.abs(buttonRects[0].height - buttonRects[1].height) <= 0.5,
      metadataFieldsAligned: Math.abs(labelRects[0].top - labelRects[1].top) <= 0.5
    };
  })()`)
  if (
    revisionFindDensity?.horizontalOverflow ||
    !(revisionFindDensity?.metadataFormWidth > revisionFindDensity?.numberFormWidth) ||
    !(revisionFindDensity?.compactHeight <= 70) ||
    !revisionFindDensity?.equalButtonWidth ||
    !revisionFindDensity?.equalButtonHeight ||
    !revisionFindDensity?.metadataFieldsAligned
  ) {
    throw new Error(`Revision Find density audit failed: ${JSON.stringify(revisionFindDensity)}`)
  }
  await cdp.evaluate(`document.documentElement.dataset.theme = "dark"`)
  await delay(40)
  await captureScreenshotEvidence(cdp, 'ui-dark-repository-revision-discovery.png')
  await cdp.evaluate(`document.documentElement.dataset.theme = "light"`)
  await delay(40)
  await clickButtonByAriaLabel(cdp, '关闭仓库工具')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: 1600,
    screenHeight: 900
  })

  // 操作记录已收敛到命令面板，不再提供独立的 aria-label 按钮。
  // 先打开命令面板再选择命令，确保审计覆盖的也是用户实际使用路径。
  await clickMatchingButton(cdp, '.toolbar button', '命令')
  await clickMatchingButton(cdp, '.command-palette button', '查看操作记录')
  const operationStreamHeader = await cdp.evaluate(`({
    headerVisible: Boolean(document.querySelector(".operation-streams > header")),
    removedTextVisible:
      document.querySelector(".operation-dialog")?.textContent?.includes("实时 Lore 事件流") ||
      document.querySelector(".operation-dialog")?.textContent?.includes("Live Lore Event Stream") ||
      false
  })`)
  if (operationStreamHeader.headerVisible || operationStreamHeader.removedTextVisible) {
    throw new Error(`Operation stream explanation is still visible: ${JSON.stringify(operationStreamHeader)}`)
  }
  checkpoints.push(await captureCheckpoint(cdp, 'operations'))
  await clickButtonByAriaLabel(cdp, '关闭操作记录')

  await clickButtonByAriaLabel(cdp, '关于 Lore Client')
  checkpoints.push(await captureCheckpoint(cdp, 'about'))
  await clickButtonByAriaLabel(cdp, '关闭关于')

  await clickMatchingButton(cdp, '.sidebar__primary button', '分支总览')
  await clickMatchingButton(cdp, '.branch-overview__header button', '新建分支')
  checkpoints.push(await captureCheckpoint(cdp, 'branch-create'))
  await clickButtonByAriaLabel(cdp, '关闭')

  // 最后依次关闭当前仓库标签，保留真正空工作区的亮色主题视觉证据。
  // 每次关闭后应用会自动激活下一仓库，因此重复点击当前可见的关闭按钮即可。
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
    await delay(45)
  }
  checkpoints.push(await captureCheckpoint(cdp, 'repository-welcome'))

  const failures = checkpoints.filter(
    (checkpoint) =>
      checkpoint.surfaces.length > 0 ||
      checkpoint.borders.length > 0 ||
      checkpoint.vectors.length > 0 ||
      checkpoint.continuity.length > 0 ||
      checkpoint.alignment.length > 0 ||
      checkpoint.contrast.length > 0
  )
  if (failures.length > 0) {
    throw new Error(`Light-theme component visual audit failed: ${JSON.stringify(failures, null, 2)}`)
  }
  return checkpoints
}

/**
 * 用显式浏览器夹具覆盖真实认证恢复弹层。
 *
 * 认证失效依赖 Lore Status，纯前端审计无法自然制造；查询参数只在 browser-demo
 * 生效，使这里能够同时验证深浅主题、最低分辨率、文本尺寸和跳过后的离线投影。
 */
async function auditRemoteAuthenticationDialog(cdp) {
  const fixtureUrl = `${applicationUrl}?remote-authentication-fixture=1`
  await cdp.send('Page.navigate', { url: fixtureUrl })
  await waitForApplication(cdp)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: 1280,
    screenHeight: 720
  })

  const checkpoints = []
  for (const theme of ['dark', 'light']) {
    await cdp.evaluate(`(() => {
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      document.documentElement.style.colorScheme = ${JSON.stringify(theme)};
    })()`)
    await delay(60)
    const layout = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('.remote-authentication-dialog');
      if (!(dialog instanceof HTMLElement)) return null;
      const bounds = dialog.getBoundingClientRect();
      const visibleTextSizes = [...dialog.querySelectorAll('*')]
        .filter((element) => {
          const style = getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden' && element.textContent?.trim();
        })
        .map((element) => Number.parseFloat(getComputedStyle(element).fontSize))
        .filter(Number.isFinite);
      return {
        theme: document.documentElement.dataset.theme,
        withinViewport:
          bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
        horizontalOverflow: document.body.scrollWidth > innerWidth,
        minimumFontSize: Math.min(...visibleTextSizes),
        buttonCount: dialog.querySelectorAll('footer button').length,
        repositoryNamesVisible:
          dialog.textContent?.includes('meridian-world') && dialog.textContent?.includes('solstice-tools')
      };
    })()`)
    if (
      !layout?.withinViewport ||
      layout.horizontalOverflow ||
      layout.minimumFontSize < 10 ||
      layout.buttonCount !== 2 ||
      !layout.repositoryNamesVisible
    ) {
      throw new Error(`Remote authentication dialog visual audit failed: ${JSON.stringify(layout)}`)
    }
    await captureScreenshotEvidence(cdp, `ui-${theme}-remote-authentication.png`)
    checkpoints.push(layout)
  }

  await clickMatchingButton(cdp, '.remote-authentication-dialog footer button', '跳过并离线使用')
  await delay(60)
  const offlineResult = await cdp.evaluate(`({
    dialogVisible: Boolean(document.querySelector('.remote-authentication-dialog')),
    statusShowsOffline: document.querySelector('.statusbar')?.textContent?.includes('离线') ?? false
  })`)
  if (offlineResult.dialogVisible || !offlineResult.statusShowsOffline) {
    throw new Error(`Remote authentication offline fallback failed: ${JSON.stringify(offlineResult)}`)
  }
  return { checkpoints, offlineResult }
}

try {
  await mkdir(outputDirectory, { recursive: true })
  const target = await waitForDebugTarget()
  const cdp = createCdpClient(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  // 显式导航保证新版 Chromium 已为页面 Target 建立可执行的主 Frame。
  await cdp.send('Page.navigate', { url: applicationUrl })
  await waitForApplication(cdp)

  const results = []
  results.push(await auditViewport(cdp, 1280, 720, 'dark'))
  results.push(await auditViewport(cdp, 1920, 1080, 'dark'))
  results.push(await auditViewport(cdp, 1280, 720, 'light'))
  results.push(await auditViewport(cdp, 1920, 1080, 'light'))
  const darkSettingsCheckpoints = await auditDarkSettingsCategories(cdp)
  const componentCheckpoints = await auditLightThemeComponents(cdp)
  const remoteAuthenticationCheckpoints = await auditRemoteAuthenticationDialog(cdp)
  console.log(
    JSON.stringify(
      { passed: true, results, darkSettingsCheckpoints, componentCheckpoints, remoteAuthenticationCheckpoints },
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
  // 只关闭本脚本启动的 Vite，复用用户现有服务时不改变其生命周期。
  await closeOwnedApplicationServer()
  try {
    await removeOwnedTemporaryDirectory(profilePath)
  } catch (error) {
    console.error(`Temporary browser profile cleanup failed: ${error.message}`)
    process.exitCode = 1
  }
}

/*
 * Bun 运行期在 Vite 服务关闭后仍可能保留内部监听句柄。此处只位于成功路径，
 * 且浏览器、Vite 与临时目录均已完成清理，因此显式退出不会截断失败或资源回收。
 */
process.exit(process.exitCode ?? 0)
