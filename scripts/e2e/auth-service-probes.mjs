#!/usr/bin/env node
// Reproduces the lore-auth-service findings listed in docs/en/E2E_LOCAL_STACK.md against a running
// stack (scripts/e2e/start-stack.sh). Prints observed status codes and counts only. The script creates
// probe-* users on the stack and never prints passwords, tokens or session codes.
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

const env = readEnvFile(join(home, 'auth', 'auth.env'))
const ca = readFileSync(join(home, 'tls', 'ca.pem'))
const host = env.HOST
const port = Number(env.PORT)
const probeSecret = (label) => `${label}-${randomBytes(12).toString('hex')}`

function send({ method, path, headers = {}, chunks = null }) {
  return new Promise((resolve, reject) => {
    const request = https.request({ host, port, method, path, headers, ca }, (response) => {
      const parts = []
      response.on('data', (part) => parts.push(part))
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(parts).toString('utf8') }))
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
  return { status: response.status, body }
}

async function adminToken() {
  const response = await json('POST', '/auth/login', { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD })
  if (response.status !== 200) throw new Error(`admin login failed with HTTP ${response.status}`)
  return response.body.token
}

async function createUser(token, username, password) {
  await send({ method: 'DELETE', path: `/admin/users/${username}`, headers: { authorization: `Bearer ${token}` } })
  const response = await json('POST', '/admin/users', { username, password, is_admin: false }, token)
  if (response.status !== 201 && response.status !== 200) throw new Error(`creating ${username} failed with HTTP ${response.status}`)
}

async function probeLoginLimit(token) {
  const username = 'probe-lockout'
  const password = probeSecret('lockout')
  await createUser(token, username, password)
  const statuses = []
  for (let attempt = 0; attempt < 30; attempt += 1) {
    statuses.push((await json('POST', '/auth/login', { username, password: probeSecret('wrong') })).status)
  }
  const correct = await json('POST', '/auth/login', { username, password })
  console.log('login: 30 consecutive wrong passwords ->', summarize(statuses))
  console.log(`login: correct password after 30 failures -> HTTP ${correct.status}`)
}

async function probeBodyLimit(token) {
  const username = 'probe-body'
  const password = probeSecret('body')
  await createUser(token, username, password)
  const padding = 'a'.repeat(200 * 1024)
  const wrong = { username, password: probeSecret('wrong'), pad: padding }
  const right = { username, password, pad: padding }
  console.log('body: 200 KiB JSON, Content-Length, wrong password ->', (await json('POST', '/auth/login', wrong)).status)
  console.log('body: 200 KiB JSON, Content-Length, right password ->', (await json('POST', '/auth/login', right)).status)
  console.log('body: 200 KiB JSON, chunked, wrong password ->', (await json('POST', '/auth/login', wrong, undefined, { chunked: true })).status)
  console.log('body: 200 KiB JSON, chunked, right password ->', (await json('POST', '/auth/login', right, undefined, { chunked: true })).status)
}

async function probeDeletedUser(token) {
  const username = 'probe-deleted'
  const password = probeSecret('deleted')
  await createUser(token, username, password)
  const login = await json('POST', '/auth/login', { username, password })
  const access = login.body.token
  const refresh = login.body.refresh_token
  const me = (value) => send({ method: 'GET', path: '/auth/me', headers: { authorization: `Bearer ${value}` } }).then((r) => r.status)
  console.log(`deleted: login -> HTTP ${login.status}; /auth/me before delete -> HTTP ${await me(access)}`)
  const deleted = await send({ method: 'DELETE', path: `/admin/users/${username}`, headers: { authorization: `Bearer ${token}` } })
  console.log(`deleted: DELETE /admin/users/${username} -> HTTP ${deleted.status}`)
  console.log(`deleted: /auth/me with the access token after delete -> HTTP ${await me(access)}`)
  console.log(`deleted: /auth/refresh with the refresh token after delete -> HTTP ${(await json('POST', '/auth/refresh', { refresh_token: refresh })).status}`)
}

async function probeSessionLockout(token) {
  const grpc = createRequire(join(authDir, 'package.json'))('@grpc/grpc-js')
  const protoLoader = createRequire(join(authDir, 'package.json'))('@grpc/proto-loader')
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
  const startSession = () =>
    new Promise((resolve, reject) => {
      const clientState = randomBytes(16).toString('hex')
      client.StartAuthSession({ client_state: clientState }, (error, response) =>
        error ? reject(error) : resolve({ ...response, clientState })
      )
    })
  const approve = async (session, username, password) => {
    const response = await send({
      method: 'POST',
      path: '/auth/session/approve',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      chunks: [Buffer.from(new URLSearchParams({ session_code: session.session_code, client_state: session.clientState, username, password }).toString())]
    })
    if (/Too many attempts|尝试次数过多/.test(response.text)) return `${response.status}:locked`
    if (/incorrect|不正确/.test(response.text)) return `${response.status}:invalid`
    return `${response.status}:other`
  }

  const username = 'probe-session'
  const password = probeSecret('session')
  await createUser(token, username, password)
  const maxAttempts = Number(env.AUTH_SESSION_MAX_ATTEMPTS ?? 5)
  const first = await startSession()
  const firstStatuses = []
  for (let attempt = 0; attempt < maxAttempts + 1; attempt += 1) {
    firstStatuses.push(await approve(first, username, probeSecret('wrong')))
  }
  console.log(`session: one session, ${maxAttempts} wrong guesses then one more ->`, firstStatuses.join(' '))
  console.log('session: correct password in the same session after the lock ->', await approve(first, username, password))

  const freshStatuses = []
  for (let attempt = 0; attempt < 10; attempt += 1) {
    freshStatuses.push(await approve(await startSession(), username, probeSecret('wrong')))
  }
  console.log('session: 10 new sessions via unauthenticated StartAuthSession, one wrong guess each ->', summarize(freshStatuses))
  console.log('session: new session with the correct password ->', await approve(await startSession(), username, password))
  client.close()
}

function summarize(statuses) {
  const counts = new Map()
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1)
  return [...counts].map(([status, count]) => `${status} x${count}`).join(', ')
}

const selected = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ['login', 'body', 'deleted', 'session'])
const token = await adminToken()
if (selected.has('login')) await probeLoginLimit(token)
if (selected.has('body')) await probeBodyLimit(token)
if (selected.has('deleted')) await probeDeletedUser(token)
if (selected.has('session')) await probeSessionLockout(token)
