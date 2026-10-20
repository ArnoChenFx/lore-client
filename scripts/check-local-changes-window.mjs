import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build, preview } from 'vite'

import { resolveBrowserExecutable } from './browser-path.mjs'
import { createCdpClient } from './cdp-client.mjs'
import { removeOwnedTemporaryDirectory, terminateOwnedProcess } from './temporary-resources.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = resolve(process.env.LORE_WINDOW_EVIDENCE ?? '/tmp/lore-change-list-window.json')
const results = { checks: [], startedAt: new Date().toISOString() }
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
let temporary
let server
let browser
let cdp

async function waitFor(check) {
  const deadline = Date.now() + 20_000
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch (error) {
      lastError = error
    }
    await delay(30)
  }
  throw new Error(`Browser condition timed out${lastError ? `: ${lastError.message}` : ''}`)
}

async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  const args = { key, code, windowsVirtualKeyCode, modifiers }
  const text = modifiers === 0 && key === 'Enter' ? '\r' : modifiers === 0 && key === ' ' ? ' ' : undefined
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...args, text })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...args })
}

async function click(selector, { name, modifiers = 0, button = 'left', index = 0 } = {}) {
  const point = await cdp.evaluate(`(() => {
    const elements = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const target = ${name ? `elements.find(element => element.textContent.includes(${JSON.stringify(name)}))` : `elements[${index}]`};
    if (!target) throw new Error('Missing click target ' + ${JSON.stringify(name ?? selector)});
    // Menus already clamp themselves to the viewport; scrolling a menu item
    // would intentionally dismiss the menu through its scroll listener.
    if (!target.closest('[role="menu"]')) target.scrollIntoView({ block: 'nearest' });
    const rect = target.getBoundingClientRect();
    const point = { x: rect.x + Math.min(100, rect.width / 2), y: rect.y + rect.height / 2 };
    if (!target.contains(document.elementFromPoint(point.x, point.y))) {
      throw new Error('Click target is not visible: ' + target.outerHTML.slice(0, 250));
    }
    return point;
  })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, modifiers, ...point })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, modifiers, ...point })
}

const state = () => cdp.evaluate('window.changeListFixture.state()')
const scroll = (fraction) =>
  cdp.evaluate(`(() => {
  const list = document.querySelector('.change-group__body');
  list.scrollTop = (list.scrollHeight - list.clientHeight) * ${fraction};
})()`)
const focusName = () => cdp.evaluate('document.activeElement?.closest("[role=option]")?.textContent ?? ""')
async function mount(count, mode, decorated = false) {
  await cdp.evaluate(`window.changeListFixture.mount(${count}, ${JSON.stringify(mode)}, ${decorated})`)
  await waitFor(() => cdp.evaluate('document.querySelectorAll(".change-file-row").length > 0'))
}
function record(name, detail = {}) {
  results.checks.push({ name, status: 'pass', ...detail })
  console.log(`[PASS] ${name}`)
}

try {
  temporary = await mkdtemp(resolve(tmpdir(), 'lore-window-check-'))
  const outDir = resolve(temporary, 'dist')
  await build({
    root,
    logLevel: 'warn',
    build: {
      outDir,
      emptyOutDir: true,
      rolldownOptions: { input: resolve(root, 'scripts/performance/change-list-window.html') }
    }
  })
  server = await preview({
    root,
    logLevel: 'warn',
    build: { outDir },
    preview: { host: '127.0.0.1', port: 0, strictPort: true }
  })
  const url = `http://127.0.0.1:${server.httpServer.address().port}/scripts/performance/change-list-window.html`
  const profile = resolve(temporary, 'profile')
  await mkdir(profile)
  browser = spawn(
    resolveBrowserExecutable(),
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--window-size=1440,900',
      url
    ],
    { stdio: 'ignore' }
  )
  let port
  await waitFor(async () => {
    port = (await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
    return port
  })
  let target
  await waitFor(async () => {
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()
    target = tabs.find((tab) => tab.url.startsWith(url))
    return target
  })
  cdp = createCdpClient(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await waitFor(() => cdp.evaluate('window.changeListFixture?.ready'))
  results.viewport = await cdp.evaluate(`({
    rootWidth: document.getElementById('root').getBoundingClientRect().width,
    rootHeight: document.getElementById('root').getBoundingClientRect().height
  })`)

  await mount(5000, 'flat')
  const mounted = await cdp.evaluate('document.querySelectorAll(".change-file-row").length')
  assert.ok(mounted < 100, `${mounted} rows should remain bounded`)
  await click('.change-file-row', { name: 'asset-000000.txt' })
  await scroll(1)
  await waitFor(() =>
    cdp.evaluate('document.querySelector(".change-group__body").textContent.includes("asset-004999.txt")')
  )
  assert.match(await focusName(), /asset-000000\.txt/, 'The focused row stays mounted while scrolling away')
  await click('.change-file-row', { name: 'asset-004999.txt', modifiers: 8 })
  await waitFor(async () => (await state()).selected.length === 5000)
  record('offscreen Shift range preserves all 5,000 files and focused row', { mounted })

  await cdp.evaluate('document.querySelector(".local-changes").focus()')
  await key('a', 'KeyA', 65, 2)
  assert.equal((await state()).selected.length, 5000)
  await key('Delete', 'Delete', 46)
  assert.equal((await state()).actions.at(-1).ids.length, 5000)
  record('Ctrl+A and Delete act on the complete model')

  await mount(1000, 'flat')
  await click('.change-file-row', { name: 'asset-000000.txt' })
  await scroll(1)
  await waitFor(() =>
    cdp.evaluate('document.querySelector(".change-group__body").textContent.includes("asset-000999.txt")')
  )
  await click('.change-file-row', { name: 'asset-000999.txt', modifiers: 2 })
  await scroll(0.5)
  // Enter the list from the preceding real toolbar, then from the splitter below.
  await cdp.evaluate('document.querySelector(".change-group-toolbar button").focus()')
  await key('Tab', 'Tab', 9)
  await waitFor(async () => /asset-000000\.txt/.test(await focusName()))
  await key('Tab', 'Tab', 9)
  await waitFor(async () => /asset-000999\.txt/.test(await focusName()))
  await key('Tab', 'Tab', 9)
  assert.equal(await cdp.evaluate('document.activeElement.className'), 'stage-split-resizer')
  await key('Tab', 'Tab', 9, 8)
  await waitFor(async () => /asset-000999\.txt/.test(await focusName()))
  await key('Tab', 'Tab', 9, 8)
  await waitFor(async () => /asset-000000\.txt/.test(await focusName()))
  await key(' ', 'Space', 32)
  assert.deepEqual((await state()).selected, ['file:file-0'])
  await key('Enter', 'Enter', 13)
  await waitFor(async () => (await state()).actions.length === 1)
  assert.deepEqual((await state()).actions[0], { kind: 'stage', ids: ['file-0'], staged: true })
  record('external and internal Tab traversal, Space and Enter retain exact targets')

  await mount(1000, 'tree')
  await click('.change-directory-row', { name: 'group-0000' })
  await key('Enter', 'Enter', 13)
  await waitFor(async () => (await state()).actions.length === 1)
  assert.deepEqual(
    (await state()).actions[0].ids,
    Array.from({ length: 100 }, (_, index) => `file-${index}`)
  )
  await waitFor(() => cdp.evaluate('document.querySelectorAll(".change-group")[1].textContent.includes("100")'))
  record('directory stage includes all descendants beyond the mounted window')

  await mount(1000, 'tree')
  await cdp.evaluate('document.querySelector(".change-directory-row__toggle").focus()')
  await key('Enter', 'Enter', 13)
  await waitFor(() => cdp.evaluate('document.querySelectorAll(".change-file-row").length === 0'))
  assert.equal((await state()).actions.length, 0, 'Directory toggle Enter must not stage files')
  await key(' ', 'Space', 32)
  await waitFor(() => cdp.evaluate('document.querySelectorAll(".change-file-row").length > 0'))
  assert.equal((await state()).actions.length, 0)
  await scroll(0.5)
  await cdp.evaluate('document.querySelector(".change-group-toolbar button").focus()')
  await key('Tab', 'Tab', 9)
  assert.equal(await cdp.evaluate('document.activeElement.getAttribute("aria-label")'), 'Collapse Content')
  await cdp.evaluate('document.querySelector(".stage-split-resizer").focus()')
  await key('Tab', 'Tab', 9, 8)
  assert.equal(await cdp.evaluate('document.activeElement.getAttribute("aria-label")'), 'Collapse group-0009')
  record('tree toggles preserve keyboard behavior and external tab boundaries')

  await mount(210, 'tree')
  await scroll(0.5)
  await waitFor(() => cdp.evaluate('Boolean(document.querySelector(\'button[aria-label="Collapse group-0001"]\'))'))
  await cdp.evaluate('document.querySelector(\'button[aria-label="Collapse group-0001"]\').focus()')
  await key('Enter', 'Enter', 13)
  await waitFor(() => cdp.evaluate('document.activeElement.getAttribute("aria-label") === "Expand group-0001"'))
  assert.equal(await cdp.evaluate('Boolean(document.querySelector(".change-list-window"))'), false)
  await key(' ', 'Space', 32)
  await waitFor(() => cdp.evaluate('document.activeElement.getAttribute("aria-label") === "Collapse group-0001"'))
  assert.equal(await cdp.evaluate('Boolean(document.querySelector(".change-list-window"))'), true)
  assert.equal((await state()).actions.length, 0)
  record('crossing the window threshold preserves the focused directory toggle')

  await mount(1000, 'flat')
  await scroll(1)
  await click('.inline-search input')
  await cdp.send('Input.insertText', { text: 'asset-000001.txt' })
  await waitFor(() => cdp.evaluate('document.querySelectorAll(".change-file-row").length === 1'))
  assert.match(await cdp.evaluate('document.querySelector(".change-file-row").textContent'), /asset-000001/)
  await key('a', 'KeyA', 65, 2)
  await key('Backspace', 'Backspace', 8)
  await waitFor(() => cdp.evaluate('document.querySelectorAll(".change-file-row").length > 1'))
  await cdp.evaluate('document.getElementById("root").style.height = "650px"')
  await delay(100)
  await scroll(1)
  await waitFor(() =>
    cdp.evaluate('document.querySelector(".change-group__body").textContent.includes("asset-000999.txt")')
  )
  const countAfterResize = await cdp.evaluate('document.querySelectorAll(".change-file-row").length')
  assert.ok(countAfterResize < 100)
  record('filtering and resizing preserve reachable rows and bounded mounting', { countAfterResize })

  await scroll(0)
  await waitFor(() =>
    cdp.evaluate('document.querySelector(".change-group__body").textContent.includes("asset-000000.txt")')
  )
  await click('.change-file-row', { name: 'asset-000000.txt' })
  await click('.revision-composer textarea')
  await cdp.send('Input.insertText', { text: 'A message to edit' })
  await key('a', 'KeyA', 65, 2)
  await key('Delete', 'Delete', 46)
  assert.equal(await cdp.evaluate('document.querySelector(".revision-composer textarea").value'), '')
  assert.equal((await state()).actions.length, 0, 'Deleting message text must not discard the selected file')
  assert.deepEqual((await state()).selected, ['file:file-0'])
  record('filter and commit text editing keep ownership of Ctrl+A and Delete')

  await click('.change-file-row', { name: 'asset-000000.txt', button: 'right' })
  await waitFor(() => cdp.evaluate('Boolean(document.querySelector(".change-context-menu"))'))
  await scroll(0.5)
  await waitFor(() => cdp.evaluate('!document.querySelector(".change-context-menu")'))
  assert.equal(await cdp.evaluate('document.activeElement.isConnected'), true)
  record('scroll closes the context menu without leaving detached focus')

  await scroll(0)
  await waitFor(() =>
    cdp.evaluate('document.querySelector(".change-group__body").textContent.includes("asset-000000.txt")')
  )
  await cdp.evaluate('window.previousChangeList = document.querySelector(".change-group__body"); true')
  await click('.change-file-row', { name: 'asset-000000.txt', button: 'right' })
  await waitFor(() => cdp.evaluate('Boolean(document.querySelector(".change-context-menu"))'))
  await click('.change-context-menu > button[role="menuitem"]', { name: 'Stage' })
  await waitFor(async () => (await state()).actions.length === 1)
  assert.deepEqual((await state()).actions[0].ids, ['file-0'])
  await waitFor(() => cdp.evaluate('document.activeElement === window.previousChangeList'))
  await key('Tab', 'Tab', 9)
  assert.ok(
    await cdp.evaluate('document.activeElement !== window.previousChangeList && document.activeElement.isConnected')
  )
  record('menu stage restores the old list focus after its anchor moves to another partition')

  for (const mode of ['tree', 'flat']) {
    await mount(1000, mode, true)
    await cdp.evaluate(`(() => {
      const style = document.createElement('style');
      style.id = 'large-row-font';
      style.textContent = '.change-file-row__name strong {font-size:24px} .change-file-row__name small {font-size:20px}';
      document.head.append(style);
    })()`)
    await waitFor(() =>
      cdp.evaluate(
        '[...document.querySelectorAll(".change-file-row")].some(row => row.getBoundingClientRect().height > 36)'
      )
    )
    await delay(100)
    const geometry = await cdp.evaluate(`(() => {
      const rows = [...document.querySelector('.change-group__body').querySelectorAll('[data-change-window-row]')];
      return rows.map(wrapper => ({ top: wrapper.offsetTop, height: wrapper.getBoundingClientRect().height,
        overflow: wrapper.firstElementChild.scrollHeight > Math.ceil(wrapper.firstElementChild.getBoundingClientRect().height) }));
    })()`)
    for (let index = 1; index < geometry.length; index++) {
      assert.ok(
        geometry[index].top + 0.5 >= geometry[index - 1].top + geometry[index - 1].height,
        `${mode}: measured rows must not overlap`
      )
    }
    assert.ok(
      geometry.every((row) => !row.overflow),
      `${mode}: larger text must not be cropped`
    )
    await cdp.evaluate('document.getElementById("large-row-font").remove()')
    record(`${mode} natural row heights support rename, lock/conflict badges and enlarged fonts`)
  }
  assert.deepEqual(cdp.runtimeErrors, [])
  results.passed = true
} catch (error) {
  results.passed = false
  results.error = error.stack ?? String(error)
  if (cdp) {
    try {
      results.failureState = await cdp.evaluate(`({
        selected: window.changeListFixture?.state().selected.length,
        actions: window.changeListFixture?.state().actions.map(action => ({kind: action.kind, count: action.ids.length})),
        rows: [...document.querySelectorAll('.change-file-row')].map(row => row.textContent),
        lists: [...document.querySelectorAll('.change-group__body')].map(list => ({ top: list.scrollTop, height: list.clientHeight, total: list.scrollHeight })),
        focus: document.activeElement?.outerHTML.slice(0, 500)
      })`)
      results.runtimeErrors = cdp.runtimeErrors
    } catch {}
  }
  process.exitCode = 1
} finally {
  cdp?.socket.close()
  await terminateOwnedProcess(browser)
  await server?.close()
  await removeOwnedTemporaryDirectory(temporary)
  results.finishedAt = new Date().toISOString()
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(results, null, 2) + '\n')
  console.log(`LocalChanges window checks: ${output}`)
  if (!results.passed) console.error(results.error)
}
