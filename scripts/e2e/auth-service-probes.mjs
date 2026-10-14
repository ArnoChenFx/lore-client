#!/usr/bin/env node
// Checks the lore-auth-service findings listed in docs/en/E2E_LOCAL_STACK.md against a running stack
// (scripts/e2e/start-stack.sh). The findings are fixed in ArnoChenFx/lore-auth-service#1, so each check
// expects the fixed behavior, and the script exits 1 when any check fails. Against the pre-fix commit
// f257d43 (LORE_AUTH_SERVICE_REF=f257d43) the checks fail, which reproduces the findings.
// Prints status codes, counts and PASS or FAIL lines only. Each run creates probe-<label>-<run id> users
// and deletes them at the end, and never prints passwords, tokens or session codes. Every run still adds
// failed logins from 127.0.0.1 to the address counter, so read the re-run note in the guide before running
// it repeatedly.
//
// Usage: node scripts/e2e/auth-service-probes.mjs [login] [body] [deleted] [session]   (default: all)

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import https from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const home = process.env.LORE_E2E_HOME ?? join(homedir(), 'lore-e2e')
const authDir = process.env.LORE_AUTH_SERVICE_DIR ?? join(home, 'src', 'lore-auth-service')
const env = readEnvFile(join(home, 'auth', 'auth.env'))
const ca = readFileSync(join(home, 'tls', 'ca.pem'))
const host = env.HOST
const port = Number(env.PORT)
const probeSecret = (label) => `${label}-${randomBytes(12).toString('hex')}`
const runId = randomBytes(4).toString('hex')
const probeUser = (label) => `probe-${label}-${runId}`
const createdUsers = []
const results = []

function readEnvFile(path) {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.includes('=') && !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=')
        return [line.slice(0, index), line.slice(index + 1)]
      })
  )
}

function check(name, passed, detail = '') {
  results.push(passed)
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

function send({ method, path, headers = {}, chunks = null }) {
  return new Promise((resolve, reject) => {
    const request = https.request({ host, port, method, path, headers, ca }, (response) => {
      const parts = []
      response.on('data', (part) => parts.push(part))
      response.on('end', () =>
        resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(parts).toString('utf8') })
      )
    })
    request.on('error', reject)
    if (chunks) {
      for (const chunk of chunks) request.write(chunk)
    }
    request.end()
  })
}

function json(method, path, payload, token, { chunked = false } = {}) {
  const data = Buffer.from(JSON.stringify(payload))
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  if (chunked) {
    headers['transfer-encoding'] = 'chunked'
    const chunks = []
    for (let offset = 0; offset < data.length; offset += 8192) chunks.push(data.subarray(offset, offset + 8192))
    return send({ method, path, headers, chunks }).then(parseJsonResponse)
  }
  headers['content-length'] = String(data.length)
  return send({ method, path, headers, chunks: [data] }).then(parseJsonResponse)
}

function parseJsonResponse(response) {
  let body = null
  try {
    body = JSON.parse(response.text)
  } catch {
    body = null
  }
  return { status: response.status, headers: response.headers, body }
}

function connectGrpc() {
  const load = createRequire(join(authDir, 'package.json'))
  const grpc = load('@grpc/grpc-js')
  const protoLoader = load('@grpc/proto-loader')
  const definition = protoLoader.loadSync(join(authDir, 'proto', 'auth_api.proto'), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  })
  const UrcAuthApi = grpc.loadPackageDefinition(definition).epic_urc.UrcAuthApi
  const client = new UrcAuthApi(`${host}:${env.GRPC_PORT}`, grpc.credentials.createSsl(ca), {
    'grpc.ssl_target_name_override': 'localhost',
    'grpc.default_authority': 'localhost'
  })
  return { grpc, client }
}

function callGrpc(client, method, request) {
  return new Promise((resolve) => {
    client[method](request, (error, response) => resolve({ code: error ? error.code : 0, response }))
  })
}

async function adminToken() {
  const response = await json('POST', '/auth/login', { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD })
  if (response.status !== 200) throw new Error(`admin login failed with HTTP ${response.status}`)
  return response.body.token
}

async function createUser(token, username, password) {
  const response = await json('POST', '/admin/users', { username, password, is_admin: false }, token)
  if (response.status !== 201 && response.status !== 200) throw new Error(`creating ${username} failed with HTTP ${response.status}`)
  createdUsers.push(username)
}

async function removeProbeUsers(token) {
  for (const username of createdUsers.splice(0)) {
    const response = await send({ method: 'DELETE', path: `/admin/users/${username}`, headers: { authorization: `Bearer ${token}` } })
    if (response.status !== 200 && response.status !== 404) console.log(`cleanup: DELETE /admin/users/${username} -> HTTP ${response.status}`)
  }
}

async function probeLoginLimit(token) {
  const username = probeUser('lockout')
  const password = probeSecret('lockout')
  await createUser(token, username, password)
  const statuses = []
  let retryAfter = null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await json('POST', '/auth/login', { username, password: probeSecret('wrong') })
    statuses.push(response.status)
    if (response.status === 429 && retryAfter === null) retryAfter = response.headers['retry-after'] ?? null
  }
  const correct = await json('POST', '/auth/login', { username, password })
  console.log('login: 30 consecutive wrong passwords ->', summarize(statuses))
  console.log(`login: correct password after 30 failures -> HTTP ${correct.status}`)
  check(
    'login: wrong passwords are throttled',
    statuses.includes(429) && !statuses.includes(200),
    summarize(statuses)
  )
  check('login: correct password is refused while throttled', correct.status === 429, `HTTP ${correct.status}`)
  check('login: throttled response carries Retry-After', Number(retryAfter) > 0, `Retry-After ${retryAfter ?? 'missing'}`)
}

async function probeBodyLimit(token) {
  const username = probeUser('body')
  const password = probeSecret('body')
  await createUser(token, username, password)
  const padding = 'a'.repeat(200 * 1024)
  const wrong = { username, password: probeSecret('wrong'), pad: padding }
  const right = { username, password, pad: padding }
  const observed = [
    ['Content-Length, wrong password', (await json('POST', '/auth/login', wrong)).status],
    ['Content-Length, right password', (await json('POST', '/auth/login', right)).status],
    ['chunked, wrong password', (await json('POST', '/auth/login', wrong, undefined, { chunked: true })).status],
    ['chunked, right password', (await json('POST', '/auth/login', right, undefined, { chunked: true })).status]
  ]
  for (const [label, status] of observed) console.log(`body: 200 KiB JSON, ${label} -> ${status}`)
  check(
    'body: oversized JSON is refused with 413 for every transfer encoding',
    observed.every(([, status]) => status === 413),
    observed.map(([, status]) => status).join(' ')
  )
}

async function probeDeletedUser(token) {
  const username = probeUser('deleted')
  const password = probeSecret('deleted')
  await createUser(token, username, password)
  const login = await json('POST', '/auth/login', { username, password })
  const access = login.body?.token
  const refresh = login.body?.refresh_token
  const { grpc, client } = connectGrpc()
  try {
    const me = () =>
      send({ method: 'GET', path: '/auth/me', headers: { authorization: `Bearer ${access}` } }).then((r) => r.status)
    const exchange = () => callGrpc(client, 'ExchangeExternalTokenForUserToken', { external_token: access })
    const meBefore = await me()
    const exchangeBefore = await exchange()
    console.log(
      `deleted: login -> HTTP ${login.status}; /auth/me before delete -> HTTP ${meBefore}; gRPC exchange before delete -> code ${exchangeBefore.code}`
    )
    check(
      'deleted: sign-in works before deletion',
      login.status === 200 && meBefore === 200 && exchangeBefore.code === grpc.status.OK,
      `login ${login.status}, /auth/me ${meBefore}, gRPC code ${exchangeBefore.code}`
    )
    const deleted = await send({ method: 'DELETE', path: `/admin/users/${username}`, headers: { authorization: `Bearer ${token}` } })
    console.log(`deleted: DELETE /admin/users/${username} -> HTTP ${deleted.status}`)
    const meAfter = await me()
    console.log(`deleted: /auth/me with the access token after delete -> HTTP ${meAfter}`)
    check('deleted: access token is refused after deletion', meAfter === 401, `HTTP ${meAfter}`)
    const exchangeAfter = await exchange()
    console.log(`deleted: gRPC exchange of the access token after delete -> code ${exchangeAfter.code}`)
    check(
      'deleted: access token is refused by gRPC after deletion',
      exchangeAfter.code === grpc.status.UNAUTHENTICATED,
      `gRPC code ${exchangeAfter.code}`
    )
    const refreshAfter = (await json('POST', '/auth/refresh', { refresh_token: refresh })).status
    console.log(`deleted: /auth/refresh with the refresh token after delete -> HTTP ${refreshAfter}`)
    check('deleted: refresh token is refused after deletion', refreshAfter === 401, `HTTP ${refreshAfter}`)
  } finally {
    client.close()
  }
}

async function probeSessionLockout(token) {
  const { grpc, client } = connectGrpc()
  try {
    const startSession = async () => {
      const clientState = randomBytes(16).toString('hex')
      const started = await callGrpc(client, 'StartAuthSession', { client_state: clientState })
      if (started.code !== grpc.status.OK) throw new Error(`StartAuthSession failed with gRPC code ${started.code}`)
      return { ...started.response, clientState }
    }
    const approve = async (session, username, password) => {
      const data = Buffer.from(
        new URLSearchParams({ session_code: session.session_code, client_state: session.clientState, username, password }).toString()
      )
      const response = await send({
        method: 'POST',
        path: '/auth/session/approve',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(data.length) },
        chunks: [data]
      })
      if (/Too many attempts|尝试次数过多/.test(response.text)) return `${response.status}:locked`
      if (/incorrect|不正确/.test(response.text)) return `${response.status}:invalid`
      return `${response.status}:other`
    }

    const username = probeUser('session')
    const password = probeSecret('session')
    await createUser(token, username, password)
    const maxAttempts = Number(env.AUTH_SESSION_MAX_ATTEMPTS ?? 5)
    const first = await startSession()
    const firstStatuses = []
    for (let attempt = 0; attempt < maxAttempts + 1; attempt += 1) {
      firstStatuses.push(await approve(first, username, probeSecret('wrong')))
    }
    console.log(`session: one session, ${maxAttempts} wrong guesses then one more ->`, firstStatuses.join(' '))
    const sameSession = await approve(first, username, password)
    console.log('session: correct password in the same session after the lock ->', sameSession)

    const freshStatuses = []
    for (let attempt = 0; attempt < 10; attempt += 1) {
      freshStatuses.push(await approve(await startSession(), username, probeSecret('wrong')))
    }
    console.log('session: 10 new sessions via unauthenticated StartAuthSession, one wrong guess each ->', summarize(freshStatuses))
    const freshSession = await approve(await startSession(), username, password)
    console.log('session: new session with the correct password ->', freshSession)

    check(
      'session: wrong guesses lock the session',
      !firstStatuses.some((status) => status.startsWith('200')) && firstStatuses.at(-1).endsWith(':locked'),
      firstStatuses.join(' ')
    )
    check('session: correct password is refused after the session lock', sameSession.endsWith(':locked'), sameSession)
    check(
      'session: new sessions share the lock',
      freshStatuses.every((status) => status.endsWith(':locked')),
      summarize(freshStatuses)
    )
    check('session: correct password in a new session is refused while locked', freshSession.endsWith(':locked'), freshSession)
  } finally {
    client.close()
  }
}

function summarize(statuses) {
  const counts = new Map()
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1)
  return [...counts].map(([status, count]) => `${status} x${count}`).join(', ')
}

const probes = { login: probeLoginLimit, body: probeBodyLimit, deleted: probeDeletedUser, session: probeSessionLockout }
const requested = process.argv.slice(2)
const selected = requested.length ? requested : Object.keys(probes)
const unknown = selected.filter((name) => !Object.hasOwn(probes, name))
if (unknown.length) {
  console.error(`unknown probe: ${unknown.join(', ')}; choose from ${Object.keys(probes).join(', ')}`)
  process.exit(2)
}

let token
try {
  token = await adminToken()
} catch (error) {
  console.log(`FAIL admin sign-in: ${error.message}`)
  console.log('0 of 1 checks passed')
  process.exit(1)
}

try {
  for (const name of selected) {
    try {
      await probes[name](token)
    } catch (error) {
      check(`${name}: probe ran to completion`, false, error.message)
    }
  }
} finally {
  await removeProbeUsers(token)
}

const failed = results.filter((passed) => !passed).length
console.log(`${results.length - failed} of ${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
