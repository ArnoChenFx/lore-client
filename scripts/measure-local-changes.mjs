import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build, preview } from 'vite'

import { resolveBrowserExecutable } from './browser-path.mjs'
import { createCdpClient } from './cdp-client.mjs'
import { removeOwnedTemporaryDirectory, terminateOwnedProcess } from './temporary-resources.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const option = (name, fallback) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=') ?? fallback
const sizes = [...new Set(option('sizes', '1000,10000,20000').split(',').map(Number))].sort((a, b) => a - b)
const repeats = Number(option('repeats', '3'))
const maxRssBytes = Number(option('max-rss-mib', '1536')) * 1024 * 1024
const output = resolve(option('output', resolve(tmpdir(), `lore-local-changes-${Date.now()}.json`)))
if (sizes.some((size) => !Number.isInteger(size) || size < 2 || size > 30_000))
  throw new Error('Sizes must be between 2 and 30,000')
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('Repeats must be between 1 and 10')
if (!Number.isFinite(maxRssBytes) || maxRssBytes < 256 * 1024 * 1024)
  throw new Error('RSS budget must be at least 256 MiB')
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
let temporary
let server
let browser
let cdp
let sampling = false
let peakRss = 0
let sampleTask
let budgetError
let activeAttempt
const results = {
  metadata: {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceChanges: execFileSync('git', ['status', '--short', '--', 'src'], { cwd: root, encoding: 'utf8' }).trim(),
    startedAt: new Date().toISOString(),
    platform: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    hostMemoryBytes: totalmem(),
    build: 'production Vite build, repository React Compiler configuration',
    viewport: { width: 1440, height: 900, componentWidth: 720 },
    repeats,
    maxSampledBrowserTreeRssBytes: maxRssBytes,
    warmup: 'Fresh browser/profile per measured repetition; 100-file mount and selection before each recorded fixture',
    limitations: [
      'Real LocalChanges component with synthetic changes; no repository loading, Diff panel or native calls.',
      'Timing starts at browser click/input capture or root.render and ends two animation frames after the expected DOM state. It includes polling/frame cadence and is not INP or a physical display measurement.',
      'Heap is retained JavaScript heap after forced GC, not peak native memory.',
      'Linux RSS is sampled every 100 ms by scanning /proc/*/status PPid relationships for the owned browser. Shared pages can be counted repeatedly and short peaks may be missed.',
      'No CPU throttling. Results depend on host contention and are diagnostic, not CI pass thresholds.'
    ]
  },
  measurements: [],
  omitted: []
}

async function waitFor(check, timeoutMs = 60_000) {
  const deadline = performance.now() + timeoutMs
  let lastError
  while (performance.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(25)
  }
  throw new Error(`Measurement timed out${lastError ? `: ${lastError.message}` : ''}`)
}

async function processTreeRss(pid) {
  if (platform() !== 'linux') return null
  const entries = await readdir('/proc')
  const processes = (
    await Promise.all(
      entries
        .filter((name) => /^\d+$/.test(name))
        .map(async (name) => {
          try {
            const status = await readFile(`/proc/${name}/status`, 'utf8')
            return {
              pid: Number(name),
              parent: Number(status.match(/^PPid:\s+(\d+)/m)?.[1]),
              rss: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024
            }
          } catch {
            return null // A process can exit between readdir and readFile.
          }
        })
    )
  ).filter(Boolean)
  if (!processes.some((process) => process.pid === pid)) return null
  const owned = new Set([pid])
  let size
  do {
    size = owned.size
    for (const process of processes) {
      if (owned.has(process.parent)) owned.add(process.pid)
    }
  } while (owned.size !== size)
  return processes.reduce((sum, process) => sum + (owned.has(process.pid) ? process.rss : 0), 0)
}

async function click(selector, index = 0) {
  const point = await cdp.evaluate(`(() => {
    const element = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (!element) throw new Error('Missing click target');
    element.scrollIntoView({block: 'center'});
    const rect = element.getBoundingClientRect();
    return {x: rect.x + Math.min(100, rect.width / 2), y: rect.y + rect.height / 2};
  })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

async function actionResult() {
  return waitFor(() => cdp.evaluate('window.localChangesBenchmark.result()'))
}

async function clearSearch(count) {
  await click('.local-changes .inline-search input')
  // Prepare the selection outside the timed input event. CDP key maps differ
  // between platforms; the actual deletion still goes through Chromium input.
  await cdp.evaluate('document.querySelector(".local-changes .inline-search input").select()')
  await cdp.evaluate(`window.localChangesBenchmark.armFilter(${count})`)
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8
  })
  return actionResult()
}

let browserSequence = 0
async function closeBrowser() {
  sampling = false
  await sampleTask
  sampleTask = undefined
  cdp?.socket.close()
  await terminateOwnedProcess(browser)
  cdp = undefined
  browser = undefined
}

async function launchBrowser(executable, url) {
  const profile = resolve(temporary, `profile-${++browserSequence}`)
  peakRss = 0
  await mkdir(profile)
  browser = spawn(
    executable,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--window-size=1440,900',
      url
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  let launchError
  let diagnostics = ''
  browser.once('error', (error) => {
    launchError = error
  })
  browser.stderr.on('data', (chunk) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-4000)
  })
  const debugPort = await waitFor(async () => {
    if (launchError) throw launchError
    if (browser.exitCode !== null) throw new Error(`Chromium exited: ${diagnostics}`)
    return (await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
  })
  const target = await waitFor(async () => {
    const targets = await (
      await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
        signal: AbortSignal.timeout(1000)
      })
    ).json()
    return targets.find((item) => item.type === 'page' && item.url.startsWith(url))
  })
  cdp = createCdpClient(target.webSocketDebuggerUrl, { commandTimeoutMilliseconds: 60_000 })
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  results.metadata.browser = (await cdp.send('Browser.getVersion')).product
  await waitFor(() => cdp.evaluate('window.localChangesBenchmark?.ready'))
  const baselineRss = await processTreeRss(browser.pid)
  sampling = true
  sampleTask = (async () => {
    while (sampling) {
      peakRss = Math.max(peakRss, (await processTreeRss(browser.pid)) ?? 0)
      if (peakRss > maxRssBytes) {
        budgetError = new Error(`The owned browser exceeded its sampled RSS budget (${maxRssBytes} bytes)`)
        results.interruptedAttempt = { ...activeAttempt, sampledBrowserTreePeakRssBytes: peakRss }
        browser.kill()
        return
      }
      await delay(100)
    }
  })()
  await cdp.evaluate('window.localChangesBenchmark.mount(100, "tree")')
  await cdp.evaluate('window.localChangesBenchmark.armSelection("asset-000000.txt")')
  await click('.change-file-row')
  await actionResult()

  return baselineRss
}

try {
  const executable = resolveBrowserExecutable()
  results.metadata.measurementSourcesSha256 = createHash('sha256')
    .update(await readFile(fileURLToPath(import.meta.url)))
    .update(await readFile(resolve(root, 'scripts/performance/local-changes.tsx')))
    .update(await readFile(resolve(root, 'scripts/performance/local-changes.html')))
    .digest('hex')
  temporary = await mkdtemp(resolve(tmpdir(), 'lore-local-changes-benchmark-'))
  const outDir = resolve(temporary, 'dist')
  await build({
    root,
    logLevel: 'warn',
    build: {
      outDir,
      emptyOutDir: true,
      rolldownOptions: { input: resolve(root, 'scripts/performance/local-changes.html') }
    }
  })
  server = await preview({
    root,
    logLevel: 'warn',
    build: { outDir },
    preview: { host: '127.0.0.1', port: 0, strictPort: true }
  })
  const port = server.httpServer.address().port
  const url = `http://127.0.0.1:${port}/scripts/performance/local-changes.html`

  for (const mode of ['tree', 'flat']) {
    let stopLargerSizes = false
    for (const count of sizes) {
      if (stopLargerSizes) {
        results.omitted.push({
          mode,
          count,
          reason:
            'The preceding size exceeded a 2-second mount, 500-ms selection or 1-GiB sampled browser RSS; larger fixtures were not attempted.'
        })
        continue
      }
      const runs = []
      results.measurements.push({ mode, count, runs })
      for (let iteration = 0; iteration < repeats; iteration++) {
        const baselineRss = await launchBrowser(executable, url)
        peakRss = 0
        activeAttempt = { mode, count, iteration: iteration + 1, phase: 'mount' }
        const mount = await cdp.evaluate(`window.localChangesBenchmark.mount(${count}, ${JSON.stringify(mode)})`)
        const run = { mount, browserTreeRssBeforeFixtureBytes: baselineRss }
        runs.push(run)
        activeAttempt.phase = 'retained-heap'
        await cdp.send('HeapProfiler.collectGarbage')
        const heap = await cdp.send('Runtime.getHeapUsage')
        const dom = await cdp.send('Memory.getDOMCounters')
        Object.assign(run, { retainedJsHeapBytes: heap.usedSize, domCounters: dom })
        activeAttempt.phase = 'selection'
        await cdp.evaluate('window.localChangesBenchmark.armSelection("asset-000001.txt")')
        await click('.change-file-row', 1)
        const selection = await actionResult()
        run.selection = selection
        activeAttempt.phase = 'filter'
        await click('.local-changes .inline-search input')
        await cdp.evaluate('window.localChangesBenchmark.armFilter(1)')
        await cdp.send('Input.insertText', { text: 'asset-000001.txt' })
        const filter = await actionResult()
        run.filter = filter
        activeAttempt.phase = 'clear-filter'
        const clearFilter = await clearSearch(count)
        Object.assign(run, {
          clearFilter,
          sampledBrowserTreePeakRssBytes: platform() === 'linux' ? peakRss : null
        })
        activeAttempt.phase = 'complete'
        console.log(JSON.stringify({ mode, count, iteration: iteration + 1, ...run }))
        if (cdp.runtimeErrors.length) throw new Error(`Browser runtime errors: ${cdp.runtimeErrors.join('; ')}`)
        if (!results.rowGeometry) {
          results.rowGeometry = {
            tree: await cdp.evaluate('window.localChangesBenchmark.geometry("tree")'),
            flat: await cdp.evaluate('window.localChangesBenchmark.geometry("flat")')
          }
        }
        await closeBrowser()
      }
      stopLargerSizes = runs.some(
        (run) =>
          run.mount.durationMs > 2000 ||
          run.selection.durationMs > 500 ||
          run.sampledBrowserTreePeakRssBytes > 1024 ** 3
      )
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, JSON.stringify(results, null, 2) + '\n')
    }
  }
  results.completedAt = new Date().toISOString()
  results.passed = true
} catch (error) {
  results.passed = false
  results.error = (budgetError ?? error).stack ?? String(budgetError ?? error)
  process.exitCode = 1
} finally {
  await closeBrowser()
  if (server) await new Promise((resolveClose) => server.httpServer.close(resolveClose))
  await removeOwnedTemporaryDirectory(temporary)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(results, null, 2) + '\n')
  console.log(`LocalChanges measurement: ${output}`)
  if (!results.passed) console.error(results.error)
}
