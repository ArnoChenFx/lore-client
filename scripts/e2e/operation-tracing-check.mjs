#!/usr/bin/env node
// Real Linux desktop checks; run against an already-built app and tauri-driver.
// Required: LORE_CLIENT_APP=/absolute/path/to/lore-client
// Optional: TAURI_DRIVER_URL=http://127.0.0.1:4444, E2E_EVIDENCE_DIR=/path,
// LORE_EXPECTED_APP_SHA256=<sha256>, LORE_TRACE_FILE_COUNT=20000,
// LORE_TRACE_UI=0 (only run the native protocol checks).
// Every repository, preference and Lore store belongs to this run. HOME is untouched.
// No native responses or operation-stream events are fabricated.

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync, constants, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, statSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const appPath = process.env.LORE_CLIENT_APP
const driverUrl = (process.env.TAURI_DRIVER_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '')
const evidenceDir = process.env.E2E_EVIDENCE_DIR
  ? resolve(process.env.E2E_EVIDENCE_DIR)
  : mkdtempSync(join(tmpdir(), 'lore-operation-tracing-evidence-'))
const fileCount = Number(process.env.LORE_TRACE_FILE_COUNT ?? 20_000)
const results = []
const startedAt = new Date().toISOString()
const identity = 'Operation Tracing Check <operation-tracing@example.invalid>'
let temporaryRoot
let launcherPath
let sessionId
let appSha256
let cleanupComplete = false
let retainedWorkspace = false

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const contextFor = (workspaceKey) => ({ requestId: randomUUID(), workspaceKey })

function record(name, detail) {
  results.push({ name, status: 'pass', detail })
  console.log(`[PASS] ${name}: ${JSON.stringify(detail)}`)
}

async function webdriver(method, path, body) {
  const response = await fetch(`${driverUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000)
  })
  const json = await response.json()
  if (!response.ok || json.value?.error) {
    throw new Error(json.value?.message ?? `WebDriver ${method} ${path}: ${response.status}`)
  }
  return json.value
}

const execute = (script, args = []) =>
  webdriver('POST', `/session/${sessionId}/execute/sync`, { script, args })

async function waitFor(run, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  do {
    const value = await run()
    if (value) return value
    await sleep(200)
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${description}`)
}

async function invokeDetailed(command, args) {
  return execute(`
    return window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1])
      .then(value => ({ ok: true, value }))
      .catch(error => ({
        ok: false, code: error && error.code,
        message: String((error && error.message) || error)
      }))
  `, [command, args])
}

async function invoke(command, args, context) {
  const result = await invokeDetailed(command, { ...args, operationContext: context })
  assert.equal(result.ok, true, `${command}: ${result.code ?? ''} ${result.message ?? ''}`)
  return result.value
}

function checkResult(result, context, command) {
  assert.equal(result.status, 0, `${command}: ${JSON.stringify(result.events ?? result.eventTags)}`)
  assert.equal(result.requestId, context.requestId, `${command} requestId`)
  assert.equal(result.workspaceKey, context.workspaceKey, `${command} workspaceKey`)
  assert.equal(Object.hasOwn(result, 'operationId'), false, 'Results must not invent a child operationId')
}

function seedPreferences(paths = []) {
  assert.equal(sessionId, undefined, 'Only write the owned profile while its app is closed')
  const directory = join(temporaryRoot, 'xdg-config', 'com.lore.client')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'client-preferences.json'), JSON.stringify({
    version: 5,
    language: 'en-US',
    automaticallyCheckForUpdates: false,
    repositoryPaths: paths,
    activeRepositoryPath: paths[0] ?? null,
    authAccountBindings: [],
    repositoryTabCustomizations: []
  }, null, 2))
}

function prepareLauncher() {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'lore-operation-tracing-'))
  const environment = {
    XDG_CONFIG_HOME: join(temporaryRoot, 'xdg-config'),
    XDG_DATA_HOME: join(temporaryRoot, 'xdg-data'),
    XDG_CACHE_HOME: join(temporaryRoot, 'xdg-cache'),
    XDG_STATE_HOME: join(temporaryRoot, 'xdg-state'),
    LORE_GLOBAL_PATH: join(temporaryRoot, 'lore-global'),
    LORE_AUTH_PATH: join(temporaryRoot, 'lore-auth'),
    LORE_AUTH_STORE: 'fallback'
  }
  for (const [name, value] of Object.entries(environment)) {
    if (name !== 'LORE_AUTH_STORE') mkdirSync(value, { recursive: true })
  }
  launcherPath = join(temporaryRoot, 'launch-isolated-lore-client.sh')
  writeFileSync(launcherPath, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    ...Object.entries(environment).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    `exec ${shellQuote(appPath)} "$@"`,
    ''
  ].join('\n'), { mode: 0o700 })
  seedPreferences()
}

async function openSession() {
  assert.equal(sessionId, undefined)
  const created = await webdriver('POST', '/session', {
    capabilities: { alwaysMatch: { 'tauri:options': { application: launcherPath } } }
  })
  sessionId = created.sessionId
  assert.equal(typeof sessionId, 'string')
  await webdriver('POST', `/session/${sessionId}/timeouts`, { script: 120_000, pageLoad: 60_000 })
  await waitFor(() => execute(`return Boolean(
    window.__TAURI_INTERNALS__ &&
    document.querySelector('button[aria-label="Client Settings"]')
  )`), 'the bundled application shell')
}

async function closeSession() {
  if (!sessionId) return
  await webdriver('DELETE', `/session/${sessionId}`)
  sessionId = undefined
}

async function screenshot(name) {
  const png = await webdriver('GET', `/session/${sessionId}/screenshot`)
  writeFileSync(join(evidenceDir, `${name}.png`), Buffer.from(png, 'base64'))
}

async function listenToNativeStreams() {
  await execute(`
    window.__operationTracingEvents = []
    const handler = window.__TAURI_INTERNALS__.transformCallback(event => {
      window.__operationTracingEvents.push({ ...event.payload, receivedAt: Date.now() })
    })
    return window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
      event: 'lore://operation-stream', target: { kind: 'Any' }, handler
    }).then(eventId => { window.__operationTracingListener = eventId; return true })
  `)
}

function writeWorkload(directory, label) {
  const paths = []
  for (let index = 0; index < fileCount; index += 1) {
    const group = `files-${index % 100}`
    if (index < 100) mkdirSync(join(directory, group), { recursive: true })
    const path = `${group}/entry-${index}.txt`
    // Distinct, deterministic content exercises actual hashing, not sparse files.
    const digest = createHash('sha256').update(`${label}:${index}`).digest('hex')
    writeFileSync(join(directory, path), `${digest.repeat(32)}\n`)
    paths.push(path)
  }
  return paths
}

async function prepareRepository(name) {
  const directory = join(temporaryRoot, name)
  mkdirSync(directory)
  const context = contextFor(null)
  const initialized = await invoke('lore_repository_initialize', {
    directoryPath: directory, repositoryName: name.trim().replaceAll(' ', '-'), description: 'Disposable tracing verification',
    repositoryIdentity: '', defaultIdentity: null, useSharedStore: false, sharedStorePath: null
  }, context)
  checkResult(initialized.result, context, 'initialize')
  const repositoryPath = realpathSync(directory)
  assert.equal(initialized.repositoryPath, repositoryPath)
  const configuration = await invoke('lore_repository_config_update', {
    repositoryPath, identity, remoteUrl: ''
  }, contextFor(repositoryPath))
  assert.equal(configuration.identity, identity)
  return { repositoryPath, paths: writeWorkload(directory, name), context: contextFor(repositoryPath) }
}

async function checkConcurrentNativeWorkflows(workspaces) {
  await listenToNativeStreams()
  const missing = await invokeDetailed('lore_repository_status', { repositoryPath: workspaces[0].repositoryPath })
  assert.equal(missing.ok, false, 'Native commands must reject a missing operationContext')
  assert.match(missing.message, /operation_?context/i, 'Missing-context rejection must identify the missing key')
  record('native commands reject missing context', missing)

  // Both async functions dispatch their first native stage before either awaits it.
  // Within each workflow the same explicit context crosses stage, commit and history.
  const workflows = await execute(`
    const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__)
    const summary = result => ({
      requestId: result.requestId, workspaceKey: result.workspaceKey,
      operation: result.operation, status: result.status, durationMs: result.durationMs,
      ...(Object.hasOwn(result, 'operationId') ? { operationId: result.operationId } : {}),
      eventTags: [...new Set(result.events.map(event => event.tagName))],
      ...(result.entries ? { entries: result.entries } : {})
    })
    return Promise.all(arguments[0].map(async workspace => {
      const startedAt = Date.now()
      const operationContext = workspace.context
      const repositoryPath = workspace.repositoryPath
      const stage = await invoke('lore_stage', { repositoryPath, paths: workspace.paths, operationContext })
      if (stage.status !== 0) throw new Error('Stage failed: ' + JSON.stringify(stage))
      const commit = await invoke('lore_commit', {
        repositoryPath, message: 'Tracing baseline', defaultIdentity: null, operationContext
      })
      if (commit.status !== 0) throw new Error('Commit failed: ' + JSON.stringify(commit))
      const history = await invoke('lore_revision_history', {
        repositoryPath, limit: 100, revision: null, branch: null,
        date: null, onlyBranch: false, operationContext
      })
      return { startedAt, finishedAt: Date.now(), stage: summary(stage),
        commit: summary(commit), history: summary(history) }
    }))
  `, [workspaces])
  for (const [index, workflow] of workflows.entries()) {
    for (const name of ['stage', 'commit', 'history']) {
      checkResult(workflow[name], workspaces[index].context, name)
    }
    assert.equal(workflow.history.entries.length, 1)
    assert.equal(workflow.history.entries[0].message, 'Tracing baseline')
  }
  assert.ok(Math.max(...workflows.map(item => item.startedAt)) < Math.min(...workflows.map(item => item.finishedAt)),
    'The two actual native workflows must have overlapping lifetimes')

  // Result delivery and native event delivery have independent queues.
  const events = await waitFor(async () => {
    const captured = await execute('return window.__operationTracingEvents')
    return workspaces.every(workspace => {
      const terminal = captured.filter(event => event.requestId === workspace.context.requestId &&
        event.phase === 'succeeded')
      return terminal.some(event => event.operation === 'file.stage') &&
        terminal.some(event => event.operation === 'revision.commit')
    }) ? captured : null
  }, 'real stage and commit progress streams (increase LORE_TRACE_FILE_COUNT if work is too short)')

  const expected = new Map(workspaces.map(workspace => [workspace.context.requestId, workspace.context]))
  const children = new Map()
  for (const event of events) {
    const context = expected.get(event.requestId)
    assert.ok(context, `Unexpected request in isolated native stream: ${event.requestId}`)
    assert.equal(event.workspaceKey, context.workspaceKey)
    assert.equal(typeof event.operationId, 'string')
    assert.ok(event.operationId.length > 0)
    const child = children.get(event.operationId) ?? { context, operation: event.operation, phases: [] }
    assert.deepEqual(child.context, context, 'A native operationId cannot belong to two requests')
    assert.equal(child.operation, event.operation)
    assert.ok(!child.phases.some(phase => ['succeeded', 'failed'].includes(phase)), 'No events after child terminal')
    child.phases.push(event.phase)
    children.set(event.operationId, child)
  }
  for (const [operationId, child] of children) {
    assert.deepEqual(child.phases.slice(0, 2), ['queued', 'running'], `${operationId} opens once`)
    assert.equal(child.phases.at(-1), 'succeeded', `${operationId} has one terminal`)
    assert.equal(child.phases.filter(phase => phase === 'queued').length, 1)
  }
  for (const workspace of workspaces) {
    const owned = [...children].filter(([, child]) => child.context.requestId === workspace.context.requestId)
    assert.ok(owned.length >= 2, 'Each root request must own multiple distinct native children')
  }
  writeFileSync(join(evidenceDir, 'native-streams.json'), JSON.stringify(events, null, 2))
  writeFileSync(join(evidenceDir, 'native-results.json'), JSON.stringify(workflows, null, 2))
  record('concurrent native workflows preserve result and stream ownership across multiple children', {
    requests: workspaces.map(workspace => workspace.context),
    children: [...children].map(([operationId, child]) => ({ operationId, ...child })),
    fileCount
  })
}

async function checkUiWorkflow(workspaces) {
  await closeSession()
  writeFileSync(join(workspaces[0].repositoryPath, 'ui-stage.txt'), 'A real UI mutation\n')
  seedPreferences(workspaces.map(workspace => workspace.repositoryPath))
  await openSession()
  await waitFor(() => execute(`
    return document.querySelectorAll('.repository-tab__select').length === 2 &&
      document.querySelector('.sidebar__repo-heading small')?.title === arguments[0]
  `, [workspaces[0].repositoryPath]), 'both canonical workspace tabs and active A')
  await execute(`
    const button = [...document.querySelectorAll('.sidebar__primary button')]
      .find(element => element.textContent.includes('Local Changes'))
    if (!button) throw new Error('Local Changes navigation not found')
    button.click()
  `)
  await waitFor(() => execute(`return document.querySelector('.local-changes')?.textContent.includes('ui-stage.txt')`),
    'the real unstaged UI file')
  await waitFor(() => execute(`
    const button = document.querySelector('button[aria-label="Operation History"]')
    return button && !/[1-9]/.test(button.textContent)
  `), 'startup requests to finish')

  await execute(`
    const original = window.__TAURI_INTERNALS__.invoke
    const trace = window.__uiOperationTrace = {
      calls: [], stageContext: null, stageHeld: false, snapshotHeld: false,
      releaseStage: null, releaseSnapshot: null, stageReleased: false, snapshotReleased: false
    }
    window.__TAURI_INTERNALS__.invoke = async function(command, args, options) {
      const call = { command, context: args?.operationContext ?? null, startedAt: Date.now() }
      trace.calls.push(call)
      try {
        const value = await original.call(this, command, args, options)
        call.nativeFinishedAt = Date.now()
        if (command === 'lore_stage' && args.repositoryPath === argumentsWorkspace) {
          trace.stageContext = args.operationContext
          trace.stageHeld = true
          await new Promise(resolve => { trace.releaseStage = resolve })
          trace.stageReleased = true
        } else if (command === 'lore_repository_status' && trace.stageReleased &&
          args.repositoryPath === argumentsWorkspace &&
          args.operationContext?.requestId === trace.stageContext?.requestId && !trace.snapshotHeld) {
          trace.snapshotHeld = true
          await new Promise(resolve => { trace.releaseSnapshot = resolve })
          trace.snapshotReleased = true
        }
        call.deliveredAt = Date.now()
        return value
      } catch (error) {
        call.error = String(error?.message ?? error)
        throw error
      }
    }
    const argumentsWorkspace = arguments[0]
    const stage = [...document.querySelectorAll('.change-group-toolbar button')]
      .find(element => element.textContent.trim() === 'Stage All')
    if (!stage || stage.disabled) throw new Error('Stage All is not enabled')
    stage.click()
    return true
  `, [workspaces[0].repositoryPath])
  await waitFor(() => execute('return window.__uiOperationTrace.stageHeld'), 'real native stage result')
  const stageContext = await execute('return window.__uiOperationTrace.stageContext')
  assert.equal(stageContext.workspaceKey, workspaces[0].repositoryPath)
  assert.equal(typeof stageContext.requestId, 'string')
  assert.ok(stageContext.requestId.length > 0)
  const activeCount = () => execute(`
    const button = document.querySelector('button[aria-label="Operation History"]')
    return Number(button?.textContent.match(/\\d+/)?.[0] ?? 0)
  `)
  assert.equal(await activeCount(), 1, 'One UI workflow, including its native children, counts once')
  await execute('window.__uiOperationTrace.releaseStage(); return true')
  await waitFor(() => execute('return window.__uiOperationTrace.snapshotHeld'), 'authoritative post-stage snapshot')
  const snapshot = await execute(`return window.__uiOperationTrace.calls.find(call =>
    call.command === 'lore_repository_status' && call.nativeFinishedAt &&
    call.context?.workspaceKey === arguments[0] &&
    call.context?.requestId === window.__uiOperationTrace.stageContext?.requestId)`, [workspaces[0].repositoryPath])
  assert.deepEqual(snapshot.context, stageContext, 'Mutation and authoritative refresh must share context')
  assert.equal(await activeCount(), 1, 'The root remains active between child commands')
  await execute(`
    const tab = [...document.querySelectorAll('.repository-tab__select')]
      .find(element => element.title.includes(arguments[0]))
    if (!tab) throw new Error('Workspace B tab not found')
    tab.click()
    return true
  `, [workspaces[1].repositoryPath])
  await waitFor(() => execute(`return document.querySelector('.sidebar__repo-heading small')?.title === arguments[0]`,
    [workspaces[1].repositoryPath]), 'workspace B to open')
  await waitFor(async () => await activeCount() === 1, 'B startup reads to finish while A remains active')
  assert.equal(await execute('return Boolean(document.querySelector(".statusbar__progress"))'), false,
    'Completed native progress from A must not appear as B progress')
  await screenshot('ui-workspace-b-with-a-pending')
  await execute('window.__uiOperationTrace.releaseSnapshot(); return true')
  await waitFor(async () => await activeCount() === 0, 'the retained A workflow to complete after its real refresh')
  const trace = await execute('return window.__uiOperationTrace.calls')
  writeFileSync(join(evidenceDir, 'ui-invoke-trace.json'), JSON.stringify(trace, null, 2))
  record('real UI stage and refresh share one context and remain counted across workspace switches', {
    stageContext, snapshotContext: snapshot.context, calls: trace.length
  })
}

async function main() {
  assert.equal(process.platform, 'linux', 'The isolated XDG launcher requires Linux')
  assert.ok(appPath && isAbsolute(appPath), 'Set LORE_CLIENT_APP to the absolute built executable path')
  assert.ok(statSync(appPath).isFile())
  accessSync(appPath, constants.X_OK)
  assert.ok(Number.isSafeInteger(fileCount) && fileCount >= 100, 'LORE_TRACE_FILE_COUNT must be an integer >= 100')
  appSha256 = createHash('sha256').update(readFileSync(appPath)).digest('hex')
  if (process.env.LORE_EXPECTED_APP_SHA256) assert.equal(appSha256, process.env.LORE_EXPECTED_APP_SHA256)
  prepareLauncher()
  await openSession()
  const workspaces = [await prepareRepository('Workspace A '), await prepareRepository('Workspace B')]
  await checkConcurrentNativeWorkflows(workspaces)
  if (process.env.LORE_TRACE_UI !== '0') await checkUiWorkflow(workspaces)
}

mkdirSync(evidenceDir, { recursive: true })
try {
  await main()
} catch (error) {
  results.push({ name: 'desktop operation tracing', status: 'fail', detail: error.stack ?? String(error) })
  console.error(error)
  if (sessionId) {
    await screenshot('failure').catch(() => {})
    const diagnostics = await execute(`return {
      events: window.__operationTracingEvents ?? [],
      uiCalls: window.__uiOperationTrace?.calls ?? [],
      body: document.body.textContent.slice(0, 16000)
    }`).catch(() => null)
    writeFileSync(join(evidenceDir, 'failure-diagnostics.json'), JSON.stringify(diagnostics, null, 2))
  }
} finally {
  try {
    await closeSession()
    if (temporaryRoot && !results.some(result => result.status === 'fail')) {
      rmSync(temporaryRoot, { recursive: true })
      cleanupComplete = true
    } else {
      retainedWorkspace = Boolean(temporaryRoot)
    }
  } catch (error) {
    retainedWorkspace = Boolean(temporaryRoot)
    results.push({ name: 'close owned session before cleanup', status: 'fail', detail: String(error) })
  }
  const summary = {
    startedAt, completedAt: new Date().toISOString(), appPath, appSha256, driverUrl,
    evidenceDir, temporaryRoot, cleanupComplete, retainedWorkspace,
    uiCheckEnabled: process.env.LORE_TRACE_UI !== '0', results
  }
  writeFileSync(join(evidenceDir, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  process.exitCode = results.some(result => result.status === 'fail') ? 1 : 0
}
