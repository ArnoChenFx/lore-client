#!/usr/bin/env node
// Drives a built Lore Client binary through tauri-driver (WebDriver) and checks
// runtime behaviour that unit tests cannot reach: removed IPC commands, command
// wiring between the frontend and the Rust handler list, patch export writes
// through the real IPC handler (extension, no silent overwrite, symbolic links),
// lazily loaded dialogs from the bundled assets, and the stalled-progress warning.
// It does not sign in or open a repository; the live Rust tests cover those.
//
// Usage: start `tauri-driver --port 4444` (with DISPLAY set), then run
//   node scripts/e2e/packaged-app-check.mjs
// Environment:
//   LORE_CLIENT_APP     path to the built binary (default: src-tauri/target/debug/lore-client)
//   TAURI_DRIVER_URL    WebDriver endpoint (default: http://127.0.0.1:4444)
//   E2E_EVIDENCE_DIR    where screenshots are written (default: a temp directory)

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const appPath = process.env.LORE_CLIENT_APP ?? join(repoRoot, 'src-tauri', 'target', 'debug', 'lore-client')
const driverUrl = (process.env.TAURI_DRIVER_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '')
const evidenceDir = process.env.E2E_EVIDENCE_DIR ?? join(tmpdir(), 'lore-e2e-evidence')
const STALL_MS = 15_000
const results = []

function record(name, status, detail) {
  results.push({ name, status, detail })
  console.log(`[${status.toUpperCase()}] ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

async function webdriver(method, path, body) {
  const response = await fetch(`${driverUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const json = await response.json()
  if (!response.ok) throw new Error(json?.value?.message ?? `WebDriver ${method} ${path} failed`)
  return json.value
}

function staticCommandWiring() {
  const libSource = readFileSync(join(repoRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8')
  const handlerBlock = libSource.match(/generate_handler!\[([\s\S]*?)\]\)/)?.[1] ?? ''
  const registered = new Set(
    [...handlerBlock.matchAll(/([a-z_][a-z0-9_:]*)\s*,/g)].map((match) => match[1].split('::').pop())
  )
  const frontendFiles = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) frontendFiles.push(full)
    }
  }
  walk(join(repoRoot, 'src'))
  const referenced = new Map()
  for (const file of frontendFiles) {
    for (const match of readFileSync(file, 'utf8').matchAll(/(?:invokeCommand|invokeLogged|runOperation|invoke)(?:<[^>(]*>)?\(\s*['"`](lore_[a-z0-9_]+)['"`]/g)) {
      const names = referenced.get(match[1]) ?? new Set()
      names.add(relative(repoRoot, file))
      referenced.set(match[1], names)
    }
  }
  const missing = [...referenced.keys()].filter((name) => !registered.has(name))
  return { registeredCount: registered.size, referencedCount: referenced.size, missing }
}

async function waitFor(run, timeoutMs, intervalMs = 250) {
  const started = Date.now()
  for (;;) {
    const value = await run()
    if (value) return { value, elapsedMs: Date.now() - started }
    if (Date.now() - started > timeoutMs) return null
    await sleep(intervalMs)
  }
}

async function checkPatchWrites(invokeDetailed) {
  const directory = mkdtempSync(join(tmpdir(), 'lore-e2e-patch-'))
  const writePatch = (destinationPath, patch, replaceExisting = false) =>
    invokeDetailed('lore_write_patch_file', { destinationPath, patch, replaceExisting })
  const first = '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+first\n'
  const second = '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+second\n'
  try {
    const notes = join(directory, 'notes.txt')
    const wrongExtension = await writePatch(notes, first)
    record(
      'patch export refuses a name without a .patch or .diff extension',
      wrongExtension.code === 'invalid_patch_destination' && !existsSync(notes) ? 'pass' : 'fail',
      wrongExtension
    )

    const review = join(directory, 'review.patch')
    const created = await writePatch(review, first)
    record(
      'patch export writes a new .patch file',
      created.ok && readFileSync(review, 'utf8') === first ? 'pass' : 'fail',
      created
    )

    const unconfirmed = await writePatch(review, second, false)
    record(
      'patch export does not overwrite an existing file without confirmation',
      unconfirmed.code === 'patch_destination_exists' && readFileSync(review, 'utf8') === first ? 'pass' : 'fail',
      unconfirmed
    )

    const confirmed = await writePatch(review, second, true)
    record(
      'confirmed patch export replaces the existing file',
      confirmed.ok && readFileSync(review, 'utf8') === second ? 'pass' : 'fail',
      confirmed
    )

    const victim = join(directory, 'victim.txt')
    writeFileSync(victim, 'victim-original')
    const linked = join(directory, 'linked.patch')
    symlinkSync(victim, linked)
    const throughLink = await writePatch(linked, second, true)
    record(
      'confirmed patch export refuses a symbolic link and leaves its target untouched',
      throughLink.code === 'patch_destination_is_link' &&
        readFileSync(victim, 'utf8') === 'victim-original' &&
        lstatSync(linked).isSymbolicLink()
        ? 'pass'
        : 'fail',
      throughLink
    )

    const ghost = join(directory, 'ghost.txt')
    const dangling = join(directory, 'dangling.patch')
    symlinkSync(ghost, dangling)
    const danglingUnconfirmed = await writePatch(dangling, second, false)
    const danglingConfirmed = await writePatch(dangling, second, true)
    record(
      'patch export never creates the target of a dangling symbolic link',
      !existsSync(ghost) &&
        danglingUnconfirmed.code === 'patch_destination_exists' &&
        danglingConfirmed.code === 'patch_destination_is_link'
        ? 'pass'
        : 'fail',
      { unconfirmed: danglingUnconfirmed.code, confirmed: danglingConfirmed.code, ghostCreated: existsSync(ghost) }
    )

    const empty = await writePatch(join(directory, 'empty.patch'), '   ')
    record(
      'an empty patch is refused before any file is written',
      empty.code === 'empty_patch' && !existsSync(join(directory, 'empty.patch')) ? 'pass' : 'fail',
      empty
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

async function main() {
  mkdirSync(evidenceDir, { recursive: true })

  const wiring = staticCommandWiring()
  record(
    'frontend command names are registered in the Rust handler list',
    wiring.missing.length === 0 ? 'pass' : 'fail',
    { registered: wiring.registeredCount, referenced: wiring.referencedCount, missing: wiring.missing }
  )

  const created = await webdriver('POST', '/session', {
    capabilities: { alwaysMatch: { 'tauri:options': { application: appPath } } }
  })
  const sessionId = created.sessionId
  const execute = async (script, args = []) => webdriver('POST', `/session/${sessionId}/execute/sync`, { script, args })
  const screenshot = async (name) => {
    const shot = await webdriver('GET', `/session/${sessionId}/screenshot`)
    writeFileSync(join(evidenceDir, `${name}.png`), Buffer.from(shot, 'base64'))
  }
  const withOperationContext = (args) => ({
    ...args,
    operationContext: {
      requestId: randomUUID(),
      workspaceKey: typeof args?.repositoryPath === 'string' ? args.repositoryPath : null
    }
  })
  const invokeFromWebview = (command, args) =>
    execute(
      `return window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1])
        .then(() => 'resolved')
        .catch((error) => 'rejected: ' + String((error && error.message) || error))`,
      [command, withOperationContext(args)]
    )
  const invokeDetailed = (command, args) =>
    execute(
      `return window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1])
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, code: error && error.code, message: String((error && error.message) || error) }))`,
      [command, withOperationContext(args)]
    )
  const emitOperationStream = (payload) =>
    execute(
      `return window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'lore://operation-stream', payload: arguments[0] })
        .then(() => 'emitted').catch((error) => 'failed: ' + String((error && error.message) || error))`,
      [payload]
    )

  try {
    const ready = await waitFor(
      () =>
        execute(
          `return Boolean(document.querySelector('button[aria-label="Client Settings"], button[aria-label="客户端设置"]'))`
        ),
      30_000
    )
    if (!ready) throw new Error('the application shell did not render within 30 seconds')
    await screenshot('01-shell')

    for (const command of ['lore_file_preview', 'lore_open_patch']) {
      const outcome = await invokeFromWebview(command, {})
      record(
        `removed IPC command ${command} is not registered`,
        /not found/i.test(outcome) ? 'pass' : 'fail',
        outcome
      )
    }

    await checkPatchWrites(invokeDetailed)

    await execute(`document.querySelector('button[aria-label="Client Settings"], button[aria-label="客户端设置"]').click()`)
    const settings = await waitFor(() => execute(`return Boolean(document.querySelector('.settings-dialog'))`), 15_000)
    record(
      'Settings dialog loads from the bundled lazy chunk',
      settings ? 'pass' : 'fail',
      settings ? `visible after ${settings.elapsedMs} ms` : 'the dialog never appeared'
    )
    if (settings) await screenshot('02-settings-dialog')
    await execute(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await sleep(300)

    const toolsButton = await execute(`return Array.from(document.querySelectorAll('button, [role="menuitem"], [role="button"]'))
      .find((element) => /^(Repository|仓库)$/.test((element.textContent || '').trim())) ? true : false`)
    const palette = await execute(`const trigger = Array.from(document.querySelectorAll('button')).find((element) => /^(Command|命令)$/.test((element.textContent || '').trim()))
      if (trigger) trigger.click()
      return Boolean(trigger)`)
    if (palette) {
      await sleep(300)
      const paletteItem = await execute(`const item = Array.from(document.querySelectorAll('button, [role="option"], [role="menuitem"], li, div'))
        .find((element) => /^(Repository Tools|仓库工具)$/.test((element.textContent || '').trim()))
        if (item) item.click()
        return Boolean(item)`)
      if (paletteItem) {
        const paletteDialog = await waitFor(() => execute(`return Boolean(document.querySelector('.tools-dialog'))`), 15_000)
        record(
          'Repository Tools dialog loads from the bundled lazy chunk',
          paletteDialog ? 'pass' : 'fail',
          paletteDialog ? `opened from the command palette after ${paletteDialog.elapsedMs} ms` : 'the dialog never appeared'
        )
        if (paletteDialog) await screenshot('03-repository-tools')
        await execute(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      }
      await execute(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      await sleep(300)
    }

    if (toolsButton) {
      await execute(`Array.from(document.querySelectorAll('button, [role="menuitem"], [role="button"]'))
        .find((element) => /^(Repository|仓库)$/.test((element.textContent || '').trim())).click()`)
      await sleep(300)
      const tools = await execute(`const item = Array.from(document.querySelectorAll('button, [role="menuitem"], div, span'))
        .find((element) => /^(Repository Tools|仓库工具)$/.test((element.textContent || '').trim()))
        if (item) item.click()
        return Boolean(item)`)
      if (tools) {
        const dialog = await waitFor(() => execute(`return Boolean(document.querySelector('.tools-dialog'))`), 15_000)
        record(
          'Repository Tools dialog loads from the bundled lazy chunk',
          dialog ? 'pass' : 'fail',
          dialog ? `visible after ${dialog.elapsedMs} ms` : 'the dialog never appeared'
        )
        if (dialog) await screenshot('03-repository-tools')
        await execute(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      } else {
        record('Repository Tools dialog loads from the bundled lazy chunk', 'skip', 'no Repository Tools entry in the Repository menu without an open repository')
      }
    } else {
      record('Repository Tools dialog loads from the bundled lazy chunk', 'skip', 'no Repository menu entry')
    }
    await sleep(300)

    const readActiveCount = () => execute(`
      const button = document.querySelector('button[aria-label="Operation History"], button[aria-label="操作记录"]')
      if (!button) throw new Error('Operation History button is missing')
      return Number(button.querySelector('.icon-button__badge')?.textContent ?? 0)
    `)
    if (!await waitFor(async () => await readActiveCount() === 0, 5_000)) {
      throw new Error('startup requests did not settle before the stall check')
    }
    const operationId = `e2e-stall-${Date.now()}`
    // Unknown native events (including events from an old page) must not create tasks.
    await emitOperationStream({
      requestId: randomUUID(), workspaceKey: null, operationId: `${operationId}-unknown`,
      operation: 'shared_store.info', phase: 'streaming',
      event: { tagName: 'fileStageProgress', data: { unit: 'files', current: 1200, elapsedMs: 900 } },
      cancellable: false
    })
    await sleep(300)
    record('unknown request progress is ignored',
      await execute(`return !document.querySelector('.statusbar__progress')`) ? 'pass' : 'fail',
      'progress requires a request admitted by this page')

    // Exercise admission through a real app-generated IPC call. Hold delivery of its
    // genuine native result while testing event transport/stall rendering; never fake
    // a business response or add a production-only test entry point.
    await execute(`
      const original = window.__TAURI_INTERNALS__.invoke
      const state = { original, context: null, held: false, release: null }
      window.__loreE2EStall = state
      window.__TAURI_INTERNALS__.invoke = function (command, args, options) {
        const result = original.call(this, command, args, options)
        if (command !== 'lore_shared_store_info' || state.held) return result
        state.held = true
        state.context = args.operationContext
        const released = new Promise(resolve => { state.release = resolve })
        return result.then(
          value => released.then(() => value),
          error => released.then(() => { throw error })
        )
      }
      document.querySelector('button[aria-label="Client Settings"], button[aria-label="客户端设置"]').click()
    `)
    const storageTab = await waitFor(
      () => execute(`return Boolean(document.querySelector('#settings-tab-storage'))`), 5_000)
    if (!storageTab) throw new Error('settings storage tab did not render')
    await execute(`document.querySelector('#settings-tab-storage').click()`)
    const admitted = await waitFor(() => execute(`return window.__loreE2EStall.context`), 5_000)
    if (!admitted) throw new Error('the app did not issue a traced Shared Store request')
    const operationContext = admitted.value
    if (!operationContext.requestId || operationContext.workspaceKey !== null) {
      throw new Error('the device-level request must have its own ID and an explicit global scope')
    }
    await execute(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    const emitted = await emitOperationStream({
      ...operationContext,
      operationId,
      operation: 'shared_store.info',
      phase: 'streaming',
      event: { tagName: 'fileStageProgress', data: { unit: 'files', current: 1200, elapsedMs: 900 } },
      cancellable: false
    })
    if (!/^emitted/.test(emitted)) throw new Error(`the progress event was not delivered: ${emitted}`)
    const bar = await waitFor(() => execute(`return Boolean(document.querySelector('.statusbar__progress'))`), 5_000)
    record('an admitted request progress snapshot shows in the status bar', bar ? 'pass' : 'fail', bar ? `after ${bar.elapsedMs} ms` : 'no progress element')
    await sleep(2_000)
    const early = await execute(`return document.querySelector('.statusbar__progress')?.classList.contains('is-stalled') ?? null`)
    record('no stall warning within the first 2 seconds', early === false ? 'pass' : 'fail', { isStalled: early })
    await sleep(STALL_MS)
    const stalled = await waitFor(
      () => execute(`return document.querySelector('.statusbar__progress')?.classList.contains('is-stalled') === true`),
      5_000
    )
    const warningText = await execute(`return (document.querySelector('.statusbar') || document.body).innerText.match(/No progress for \\d+s|已 \\d+ 秒无进展/)?.[0] ?? null`)
    record(
      'stall warning appears after 15 seconds without a new snapshot',
      stalled && warningText ? 'pass' : 'fail',
      { isStalled: Boolean(stalled), warningText }
    )
    await screenshot('04-stall-warning')
    await emitOperationStream({ ...operationContext, operationId, operation: 'shared_store.info', phase: 'succeeded', status: 0, durationMs: 17_000, cancellable: false })
    await execute(`window.__loreE2EStall.release()`)
    const ended = await waitFor(async () =>
      await readActiveCount() === 0 && await execute(`return !document.querySelector('.statusbar__progress')`), 5_000)
    record('completed request releases its last lease and leaves the status bar',
      ended ? 'pass' : 'fail', { activeCount: await readActiveCount() })
    await execute(`document.querySelector('button[aria-label="Operation History"], button[aria-label="操作记录"]').click()`)
    if (!await waitFor(() => execute(`return Boolean(document.querySelector('.operation-dialog'))`), 5_000)) {
      throw new Error('operation history did not open')
    }
    const previousRows = await execute(`return document.querySelectorAll('.operation-list article').length`)
    await emitOperationStream({
      ...operationContext, operationId: `${operationId}-late-new-child`, operation: 'shared_store.info', phase: 'streaming',
      event: { tagName: 'fileStageProgress', data: { unit: 'files', current: 1300, elapsedMs: 18000 } },
      cancellable: false
    })
    await sleep(300)
    const lateRows = await execute(`return document.querySelectorAll('.operation-list article').length`)
    record('late progress cannot create a new child for a completed request',
      await readActiveCount() === 0 && lateRows === previousRows &&
        await execute(`return !document.querySelector('.statusbar__progress')`) ? 'pass' : 'fail',
      { previousRows, lateRows, activeCount: await readActiveCount() })
  } finally {
    await execute(`
      const state = window.__loreE2EStall
      if (state) {
        window.__TAURI_INTERNALS__.invoke = state.original
        state.release?.()
        delete window.__loreE2EStall
      }
    `).catch(() => {})
    await webdriver('DELETE', `/session/${sessionId}`).catch(() => {})
  }
}

main()
  .catch((error) => {
    record('packaged app check ran to completion', 'fail', error.message)
  })
  .finally(() => {
    const failed = results.filter((item) => item.status === 'fail')
    console.log(JSON.stringify({ evidenceDir, results }, null, 2))
    process.exitCode = failed.length > 0 ? 1 : 0
  })
