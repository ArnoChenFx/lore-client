#!/usr/bin/env node
// Real Linux desktop regression and preview measurements. See file-path-check.md.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync, constants, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync
} from 'node:fs'
import { cpus, release, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const appPath = process.env.LORE_CLIENT_APP
const driverUrl = (process.env.TAURI_DRIVER_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '')
const evidenceDir = process.env.E2E_EVIDENCE_DIR
  ? resolve(process.env.E2E_EVIDENCE_DIR)
  : mkdtempSync(join(tmpdir(), 'lore-file-path-evidence-'))
const measurePreviews = process.env.LORE_PATH_CHECK_PREVIEWS !== '0'
const checkFilePaths = process.env.LORE_PATH_CHECK_PATHS !== '0'
const repetitions = Number(process.env.LORE_PREVIEW_REPETITIONS ?? 3)
const results = []
const startedAt = new Date().toISOString()
let temporaryRoot
let launcherPath
let sessionId
let appSha256
let appPid
let cleanupComplete = false
let retainedWorkspace = false

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const contextFor = (repositoryPath = null) => ({ requestId: randomUUID(), workspaceKey: repositoryPath })
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

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
      .catch(error => ({ ok: false, code: error && error.code,
        message: String((error && error.message) || error) }))
  `, [command, { ...args, operationContext: contextFor(args.repositoryPath) }])
}

async function invoke(command, args) {
  const response = await invokeDetailed(command, args)
  assert.equal(response.ok, true, `${command}: ${response.code ?? ''} ${response.message ?? ''}`)
  if (Object.hasOwn(response.value ?? {}, 'status')) {
    assert.equal(response.value.status, 0, `${command}: ${JSON.stringify(response.value)}`)
  }
  return response.value
}

function prepareLauncher() {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'lore-file-path-check-'))
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
  const preferences = join(environment.XDG_CONFIG_HOME, 'com.lore.client')
  mkdirSync(preferences, { recursive: true })
  writeFileSync(join(preferences, 'client-preferences.json'), JSON.stringify({
    version: 5, language: 'en-US', automaticallyCheckForUpdates: false,
    repositoryPaths: [], activeRepositoryPath: null,
    authAccountBindings: [], repositoryTabCustomizations: []
  }))
  launcherPath = join(temporaryRoot, 'launch-isolated-lore-client.sh')
  writeFileSync(launcherPath, [
    '#!/usr/bin/env bash', 'set -euo pipefail',
    ...Object.entries(environment).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    `printf '%s\\n' "$$" > ${shellQuote(join(temporaryRoot, 'app.pid'))}`,
    `exec ${shellQuote(appPath)} "$@"`, ''
  ].join('\n'), { mode: 0o700 })
}

async function openSession() {
  const created = await webdriver('POST', '/session', {
    capabilities: { alwaysMatch: { 'tauri:options': { application: launcherPath } } }
  })
  sessionId = created.sessionId
  assert.equal(typeof sessionId, 'string')
  await webdriver('POST', `/session/${sessionId}/timeouts`, { script: 120_000, pageLoad: 60_000 })
  await waitFor(() => execute(`return Boolean(window.__TAURI_INTERNALS__ &&
    document.querySelector('button[aria-label="Client Settings"]'))`), 'the bundled application shell')
  appPid = Number(readFileSync(join(temporaryRoot, 'app.pid'), 'utf8').trim())
  assert.ok(Number.isSafeInteger(appPid) && appPid > 0)
  const commandLine = readFileSync(`/proc/${appPid}/cmdline`, 'utf8')
  assert.ok(commandLine.includes(appPath), 'The RSS root must be the owned app process')

  // Use the installed Tauri Channel implementation, including its ordering and
  // callback cleanup. This temporary test bundle never changes product assets.
  const entry = join(temporaryRoot, 'channel-entry.js')
  const bundle = join(temporaryRoot, 'channel-bundle.js')
  const coreModule = join(sourceRoot, 'node_modules/@tauri-apps/api/core.js')
  writeFileSync(entry, `import { Channel } from ${JSON.stringify(coreModule)};
    window.__filePathCheckApi = { Channel };`)
  execFileSync(process.env.BUN_BIN ?? 'bun', [
    'build', entry, '--target', 'browser', '--format', 'iife', '--outfile', bundle
  ], { cwd: sourceRoot, stdio: 'pipe' })
  await execute(`${readFileSync(bundle, 'utf8')}\nreturn Boolean(window.__filePathCheckApi.Channel)`)
}

async function closeSession() {
  if (!sessionId) return
  await webdriver('DELETE', `/session/${sessionId}`)
  sessionId = undefined
}

async function initializeRepository() {
  const directory = join(temporaryRoot, 'Workspace ')
  mkdirSync(directory)
  const initialized = await invoke('lore_repository_initialize', {
    directoryPath: directory, repositoryName: 'file-path-check',
    description: 'Disposable file-path regression', repositoryIdentity: '',
    defaultIdentity: null, useSharedStore: false, sharedStorePath: null
  })
  assert.equal(initialized.result.status, 0)
  const repositoryPath = realpathSync(directory)
  assert.equal(initialized.repositoryPath, repositoryPath)
  await invoke('lore_repository_config_update', {
    repositoryPath, identity: 'File Path Check <file-path-check@example.invalid>', remoteUrl: ''
  })
  return repositoryPath
}

async function preview(repositoryPath, path, options = {}) {
  return execute(`
    return new Promise((resolve, reject) => {
      const started = performance.now()
      let commandCompleted = false
      let received = 0
      let chunks = 0
      let target = null
      let settled = false
      const timeout = setTimeout(() => fail(new Error('Preview stream did not complete')), 90000)
      const fail = error => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        channel.cleanupCallback()
        reject(error)
      }
      const finish = () => {
        if (settled || !commandCompleted || !target || received !== target.byteLength) return
        try {
          if (target.byteLength < 4) throw new Error('Preview envelope is too short')
          const metadataBytes = new DataView(target.buffer).getUint32(0, true)
          if (metadataBytes === 0 || 4 + metadataBytes > target.byteLength) {
            throw new Error('Preview metadata length is invalid')
          }
          const metadata = JSON.parse(new TextDecoder().decode(target.subarray(4, 4 + metadataBytes)))
          const data = target.subarray(4 + metadataBytes)
          settled = true
          clearTimeout(timeout)
          channel.cleanupCallback()
          resolve({ metadata, envelopeBytes: target.byteLength, metadataBytes,
            payloadBytes: data.byteLength, chunks, elapsedMs: performance.now() - started,
            payloadPrefix: Array.from(data.subarray(0, 64)),
            payloadSuffix: Array.from(data.subarray(Math.max(0, data.byteLength - 64))) })
        } catch (error) { fail(error) }
      }
      const channel = new window.__filePathCheckApi.Channel(message => {
        if (settled) return
        try {
          if (message instanceof ArrayBuffer) {
            if (!target) throw new Error('Preview payload preceded the header')
            if (received + message.byteLength > target.byteLength) throw new Error('Preview overflow')
            target.set(new Uint8Array(message), received)
            received += message.byteLength
            chunks += 1
          } else {
            if (target || !Number.isSafeInteger(message.byteLength) || message.byteLength <= 0) {
              throw new Error('Invalid preview stream header')
            }
            target = new Uint8Array(message.byteLength)
          }
          finish()
        } catch (error) { fail(error) }
      })
      window.__TAURI_INTERNALS__.invoke('lore_file_preview_stream', {
        ...arguments[0], onChunk: channel
      }).then(() => { commandCompleted = true; finish() }, fail)
    })
  `, [{
    repositoryPath, path, revision: null, metadataOnly: false, previewLimitMib: 20,
    ...options, operationContext: contextFor(repositoryPath)
  }])
}

async function checkPaths(repositoryPath) {
  const contents = new Map([
    ['asset', 'plain asset baseline\n'],
    ['asset ', 'trailing-space asset baseline\n'],
    [' asset', 'leading-space asset baseline\n'],
    [' ', 'space-only filename baseline\n'],
    [' dir /leaf ', 'nested directory and file spaces baseline\n']
  ])
  for (const [path, content] of contents) {
    mkdirSync(dirname(join(repositoryPath, path)), { recursive: true })
    writeFileSync(join(repositoryPath, path), content)
  }
  const plainPreview = await preview(repositoryPath, 'asset')
  assert.equal(plainPreview.metadata.path, 'asset')
  assert.equal(plainPreview.metadata.size, Buffer.byteLength(contents.get('asset')))
  const paths = [...contents.keys()]
  const stagedPaths = async () => {
    const status = await invoke('lore_repository_status', { repositoryPath })
    return status.events.filter(event => event.tagName === 'repositoryStatusFile' &&
      event.data.type === 'file' && event.data.flagStaged).map(event => event.data.path).sort()
  }
  await invoke('lore_stage', { repositoryPath, paths: ['asset '] })
  assert.deepEqual(await stagedPaths(), ['asset '], 'Stage must use the selected trailing-space file')
  await invoke('lore_stage', { repositoryPath, paths: ['asset'] })
  assert.deepEqual(await stagedPaths(), ['asset', 'asset '])
  await invoke('lore_unstage', { repositoryPath, paths: ['asset '] })
  assert.deepEqual(await stagedPaths(), ['asset'], 'Unstage must preserve the staged sibling')
  await invoke('lore_stage', { repositoryPath, paths: [' '] })
  assert.deepEqual(await stagedPaths(), [' ', 'asset'], 'A space-only path must not mean Stage All')
  await invoke('lore_unstage', { repositoryPath, paths: [' '] })
  assert.deepEqual(await stagedPaths(), ['asset'], 'A space-only path must not mean Unstage All')
  await invoke('lore_unstage', { repositoryPath, paths: ['asset'] })
  assert.deepEqual(await stagedPaths(), [])
  record('selective stage and unstage preserve trailing and space-only identities', {
    selectedPaths: ['asset ', ' '], siblings: paths
  })

  await invoke('lore_stage', { repositoryPath, paths })
  assert.deepEqual(await stagedPaths(), [...paths].sort())
  await invoke('lore_commit', { repositoryPath, message: 'Whitespace file baseline', defaultIdentity: null })
  const history = await invoke('lore_revision_history', {
    repositoryPath, limit: 10, revision: null, branch: null, date: null, onlyBranch: false
  })
  assert.equal(history.entries.length, 1)
  const revision = history.entries[0].revision
  assert.match(revision, /^[0-9a-f]+$/i)
  const files = await invoke('lore_revision_files', { repositoryPath, revision })
  assert.deepEqual(files.map(file => file.path).sort(), [...paths].sort())
  for (const [path, content] of contents) {
    assert.equal(await invoke('lore_read_workspace_text', { repositoryPath, relativePath: path }), content)
    assert.equal(await invoke('lore_read_revision_text', { repositoryPath, revision, relativePath: path }), content)
    for (const selectedRevision of [null, revision]) {
      const actual = await preview(repositoryPath, path, { revision: selectedRevision })
      assert.equal(actual.metadata.path, path)
      assert.equal(actual.metadata.size, Buffer.byteLength(content))
      assert.equal(actual.metadata.contentState, 'unsupported', 'Unknown extensions return honest metadata')
      assert.equal(actual.payloadBytes, 0)
    }
  }
  record('committed tree, text and preview preserve every exact filename', { revision, paths })

  const selected = 'asset '
  const sibling = 'asset'
  const selectedEdit = 'selected trailing-space edit\n'
  const siblingEdit = 'unselected plain edit\n'
  writeFileSync(join(repositoryPath, selected), selectedEdit)
  writeFileSync(join(repositoryPath, sibling), siblingEdit)
  const diff = await invoke('lore_workspace_diff', { repositoryPath, paths: [selected] })
  const changes = diff.events.filter(event => event.tagName === 'fileDiff')
  assert.deepEqual(changes.map(event => event.data.path), [selected])
  assert.ok(changes[0].data.patch.includes(selectedEdit.trimEnd()))
  assert.ok(!changes[0].data.patch.includes(siblingEdit.trimEnd()))
  await invoke('lore_file_reset', { repositoryPath, paths: [selected], revision })
  assert.equal(readFileSync(join(repositoryPath, selected), 'utf8'), contents.get(selected))
  assert.equal(readFileSync(join(repositoryPath, sibling), 'utf8'), siblingEdit)
  record('diff and reset select one exact file and preserve its sibling', { selected, untouched: sibling })

  const outside = join(temporaryRoot, 'outside.txt')
  writeFileSync(outside, 'outside sentinel\n')
  symlinkSync(outside, join(repositoryPath, 'outside-link'))
  const rejected = []
  for (const [command, args] of [
    ['lore_stage', { paths: [''] }],
    ['lore_unstage', { paths: [''] }],
    ['lore_workspace_diff', { paths: [''] }],
    ['lore_file_reset', { paths: [''], revision }],
    ['lore_file_reset', { paths: ['../outside.txt'], revision }],
    ['lore_read_workspace_text', { relativePath: '../outside.txt' }],
    ['lore_read_workspace_text', { relativePath: outside }],
    ['lore_read_workspace_text', { relativePath: 'outside-link' }]
  ]) {
    const response = await invokeDetailed(command, { repositoryPath, ...args })
    assert.equal(response.ok, false, `${command} must reject ${JSON.stringify(args)}`)
    rejected.push({ command, args, code: response.code })
  }
  assert.deepEqual(await stagedPaths(), [], 'Rejected explicit paths must never become Stage All')
  assert.equal(readFileSync(outside, 'utf8'), 'outside sentinel\n')
  assert.equal(readFileSync(join(repositoryPath, sibling), 'utf8'), siblingEdit)
  record('empty, escaping and external symlink paths are rejected without widening scope', rejected)
  writeFileSync(join(evidenceDir, 'path-results.json'), JSON.stringify({ revision, paths, rejected }, null, 2))
}

function processSample() {
  const processes = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const status = readFileSync(`/proc/${name}/status`, 'utf8')
      const numeric = (field) => Number(status.match(new RegExp(`^${field}:\\s+(\\d+)`, 'm'))?.[1] ?? 0)
      processes.push({ pid: Number(name), ppid: numeric('PPid'),
        rssKiB: numeric('VmRSS'), highWaterKiB: numeric('VmHWM') })
    } catch { /* Processes may exit while /proc is being sampled. */ }
  }
  const owned = new Set([appPid])
  let added
  do {
    added = false
    for (const entry of processes) {
      if (owned.has(entry.ppid) && !owned.has(entry.pid)) {
        owned.add(entry.pid)
        added = true
      }
    }
  } while (added)
  const members = processes.filter(entry => owned.has(entry.pid))
  const app = members.find(entry => entry.pid === appPid)
  assert.ok(app, 'The owned app must still be alive during memory sampling')
  return { at: Date.now(), appRssKiB: app.rssKiB, appHighWaterKiB: app.highWaterKiB,
    treeRssKiB: members.reduce((sum, entry) => sum + entry.rssKiB, 0),
    processes: members.map(({ pid, rssKiB }) => ({ pid, rssKiB })) }
}

async function measuredPreview(repositoryPath, path, options) {
  const samples = [processSample()]
  let sampleFailure
  const timer = setInterval(() => {
    try { samples.push(processSample()) } catch (error) { sampleFailure = error }
  }, 25)
  const start = performance.now()
  let value
  try {
    value = await preview(repositoryPath, path, options)
  } finally {
    clearInterval(timer)
  }
  const wallElapsedMs = performance.now() - start
  samples.push(processSample())
  if (sampleFailure) throw sampleFailure
  return {
    ...value, wallElapsedMs,
    memory: {
      samplingIntervalMs: 25, sampleCount: samples.length,
      baseline: samples[0], after: samples.at(-1),
      sampledPeakAppRssKiB: Math.max(...samples.map(sample => sample.appRssKiB)),
      sampledPeakTreeRssKiB: Math.max(...samples.map(sample => sample.treeRssKiB)),
      samples
    }
  }
}

function createPreviewFixtures(repositoryPath) {
  const output = execFileSync('python3', ['-c', `
import hashlib, json, pathlib, struct, sys, zipfile
root = pathlib.Path(sys.argv[1])
fixtures = []
for mib in (1, 10, 20):
    size = mib * 1024 * 1024
    wav = root / ('preview-%dmib.wav' % mib)
    header = b'RIFF' + struct.pack('<I', size - 8) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, 1, 22050, 44100, 2, 16)
    header += b'data' + struct.pack('<I', size - 44)
    with wav.open('wb') as handle:
        handle.write(header)
        remaining = size - len(header)
        block = bytes(range(256)) * 256
        while remaining:
            count = min(remaining, len(block))
            handle.write(block[:count])
            remaining -= count
    archive = root / ('preview-%dmib.zip' % mib)
    # A stored entry with fixed metadata produces an exactly sized ZIP. Directory
    # parsing must scan the actual bounded source but should transmit no body.
    info = zipfile.ZipInfo('payload.bin', date_time=(2024, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    overhead = 30 + len(info.filename) + 46 + len(info.filename) + 22
    with zipfile.ZipFile(archive, 'w') as handle:
        with handle.open(info, 'w') as entry:
            remaining = size - overhead
            while remaining:
                count = min(remaining, len(block))
                entry.write(block[:count])
                remaining -= count
    for path, kind in ((wav, 'audio'), (archive, 'archive')):
        actual = path.stat().st_size
        assert actual == size, (path, actual, size)
        fixtures.append({'path': path.name, 'kind': kind, 'sourceBytes': actual,
                         'sha256': hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()})
print(json.dumps(fixtures))
`, repositoryPath], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  return JSON.parse(output)
}

async function measurePreviewBaseline(repositoryPath) {
  const fixtures = createPreviewFixtures(repositoryPath)
  const measurements = []
  for (const fixture of fixtures) {
    const warmup = await measuredPreview(repositoryPath, fixture.path)
    const samples = []
    for (let index = 0; index < repetitions; index += 1) {
      const sample = await measuredPreview(repositoryPath, fixture.path)
      assert.equal(sample.metadata.path, fixture.path)
      assert.equal(sample.metadata.kind, fixture.kind)
      assert.equal(sample.metadata.size, fixture.sourceBytes)
      assert.equal(sample.metadata.contentState, 'available')
      assert.equal(sample.envelopeBytes, 4 + sample.metadataBytes + sample.payloadBytes)
      if (fixture.kind === 'archive') {
        assert.equal(sample.payloadBytes, 0)
        assert.equal(sample.metadata.structuredPreview?.type, 'archive')
        assert.equal(sample.metadata.structuredPreview.totalEntries, 1)
        assert.equal(sample.metadata.structuredPreview.entries[0].path, 'payload.bin')
      } else {
        assert.equal(sample.payloadBytes, fixture.sourceBytes)
        const source = readFileSync(join(repositoryPath, fixture.path))
        assert.deepEqual(sample.payloadPrefix, [...source.subarray(0, 64)])
        assert.deepEqual(sample.payloadSuffix, [...source.subarray(source.length - 64)])
      }
      samples.push(sample)
    }
    measurements.push({ ...fixture, warmup, samples })
    console.log(`[MEASURE] ${fixture.path}: ${JSON.stringify(samples.map(sample => ({
      elapsedMs: sample.elapsedMs, envelopeBytes: sample.envelopeBytes,
      sampledPeakTreeRssKiB: sample.memory.sampledPeakTreeRssKiB
    })))}`)
  }
  const metadataOnly = await measuredPreview(repositoryPath, fixtures[0].path, { metadataOnly: true })
  assert.equal(metadataOnly.metadata.contentState, 'metadataOnly')
  assert.equal(metadataOnly.payloadBytes, 0)
  const report = {
    startedAt, completedAt: new Date().toISOString(), appPath, appSha256,
    environment: { platform: process.platform, kernel: release(), cpu: cpus()[0]?.model,
      logicalCpuCount: cpus().length, buildMode: process.env.LORE_PREVIEW_BUILD_MODE ?? 'unspecified',
      desktopRuntime: process.env.LORE_PREVIEW_RUNTIME_NOTE ?? 'unspecified' },
    method: {
      source: 'workspace files', warmupsPerFixture: 1, repetitions,
      timing: 'WebView performance.now through real invoke, Channel delivery and envelope decoding',
      wallTiming: 'Node time including WebDriver round trip and scheduled RSS sampling',
      ipcBytes: 'actual binary envelope bytes, excluding transport framing and the small JSON channel header',
      memory: '25 ms RSS samples of the owned app and its descendants; shared pages may be counted repeatedly',
      limitations: [
        'Warm samples use filesystem and allocator caches; no cold-start or cold-Store claim.',
        'Sampling can miss short peaks; VmHWM belongs to the entire app lifetime, not one call.',
        'RSS is not PSS, an allocation count, a leak test or a cross-machine performance threshold.',
        'The script reads and decodes previews but does not render audio or archive UI.',
        'ZIP_STORED has one entry; compressed archives and many-entry directories are separate workloads.'
      ]
    },
    measurements, metadataOnly
  }
  writeFileSync(join(evidenceDir, 'preview-measurements.json'), JSON.stringify(report, null, 2))
  record('actual preview Channel bytes and sampled memory baseline collected', {
    fixtures: fixtures.length, repetitions, report: join(evidenceDir, 'preview-measurements.json')
  })
}

async function main() {
  assert.equal(process.platform, 'linux', 'The isolated XDG launcher and /proc sampling require Linux')
  assert.ok(appPath && isAbsolute(appPath), 'Set LORE_CLIENT_APP to the absolute built executable path')
  assert.ok(statSync(appPath).isFile())
  accessSync(appPath, constants.X_OK)
  assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 10)
  assert.ok(checkFilePaths || measurePreviews, 'Enable at least one check group')
  appSha256 = digest(readFileSync(appPath))
  if (process.env.LORE_EXPECTED_APP_SHA256) assert.equal(appSha256, process.env.LORE_EXPECTED_APP_SHA256)
  prepareLauncher()
  await openSession()
  const repositoryPath = await initializeRepository()
  if (checkFilePaths) await checkPaths(repositoryPath)
  if (measurePreviews) await measurePreviewBaseline(repositoryPath)
}

mkdirSync(evidenceDir, { recursive: true })
try {
  await main()
} catch (error) {
  results.push({ name: 'desktop file path check', status: 'fail', detail: error.stack ?? String(error) })
  console.error(error)
  if (sessionId) {
    const screenshot = await webdriver('GET', `/session/${sessionId}/screenshot`).catch(() => null)
    if (screenshot) writeFileSync(join(evidenceDir, 'failure.png'), Buffer.from(screenshot, 'base64'))
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
    evidenceDir, temporaryRoot, cleanupComplete, retainedWorkspace, checkFilePaths, measurePreviews, results
  }
  writeFileSync(join(evidenceDir, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  process.exitCode = results.some(result => result.status === 'fail') ? 1 : 0
}
