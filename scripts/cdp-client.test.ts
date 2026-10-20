import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test'

import { createCdpClient } from './cdp-client.mjs'

class TestSocket extends EventTarget {
  readyState = 0
  messages: Array<{ id: number; method: string }> = []
  sendError: Error | null = null

  open() {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  send(data: Parameters<WebSocket['send']>[0]) {
    if (this.sendError) throw this.sendError
    this.messages.push(JSON.parse(String(data)))
  }

  close() {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }

  reply(message: object) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
  }
}

function createClient() {
  const socket = new TestSocket()
  const client = createCdpClient('ws://test.invalid', { createSocket: () => socket })
  return { socket, client }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('bounded CDP requests', () => {
  test('matches out-of-order replies and clears completed deadlines', async () => {
    const { socket, client } = createClient()
    socket.open()
    const first = client.send('Page.enable')
    const second = client.send('Runtime.enable')
    await Promise.resolve()

    socket.reply({ id: socket.messages[1].id, result: { second: true } })
    socket.reply({ id: socket.messages[0].id, result: { first: true } })

    expect(await first).toEqual({ first: true })
    expect(await second).toEqual({ second: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  test('reports protocol errors with the originating method', async () => {
    const { socket, client } = createClient()
    socket.open()
    const outcome = client.send('Page.navigate').catch((error) => error)
    await Promise.resolve()
    socket.reply({ id: socket.messages[0].id, error: { message: 'Invalid URL' } })
    expect(await outcome).toEqual(new Error('CDP command Page.navigate failed: Invalid URL'))
    expect(vi.getTimerCount()).toBe(0)
  })

  test('rejects an unanswered command at its deadline and ignores a late reply', async () => {
    const { socket, client } = createClient()
    socket.open()
    const outcome = client.send('Runtime.evaluate').catch((error) => error)
    await Promise.resolve()
    vi.advanceTimersByTime(15_000)
    expect(await outcome).toEqual(new Error('CDP command Runtime.evaluate did not return within 15000ms'))
    socket.reply({ id: socket.messages[0].id, result: { late: true } })
    expect(vi.getTimerCount()).toBe(0)
  })

  test('closes a connection which never opens and rejects its waiting command', async () => {
    const { socket, client } = createClient()
    const outcome = client.send('Page.enable').catch((error) => error)
    vi.advanceTimersByTime(5_000)
    expect(await outcome).toEqual(new Error('The CDP WebSocket did not connect before the timeout'))
    expect(socket.readyState).toBe(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each(['close', 'error'])('rejects a command when %s occurs before connection', async (eventName) => {
    const { socket, client } = createClient()
    const outcome = Promise.allSettled([client.send('Page.enable')])
    socket.dispatchEvent(new Event(eventName))
    expect((await outcome)[0].status).toBe('rejected')
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each(['close', 'error'])('rejects all pending and future commands after %s', async (eventName) => {
    const { socket, client } = createClient()
    socket.open()
    const outcomes = Promise.allSettled([client.send('Page.enable'), client.send('Runtime.enable')])
    await Promise.resolve()
    socket.dispatchEvent(new Event(eventName))
    expect((await outcomes).map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
    await expect(client.send('Page.navigate')).rejects.toThrow()
    expect(vi.getTimerCount()).toBe(0)
    expect(socket.messages).toHaveLength(2)
  })

  test('clears a deadline when sending throws synchronously', async () => {
    const { socket, client } = createClient()
    socket.open()
    socket.sendError = new Error('Socket send failed')
    await expect(client.send('Page.enable')).rejects.toThrow('Socket send failed')
    expect(vi.getTimerCount()).toBe(0)
  })

  test('preserves runtime diagnostics and protocol event subscriptions', () => {
    const { socket, client } = createClient()
    socket.open()
    const listener = vi.fn()
    client.on('Fetch.requestPaused', listener)
    socket.reply({ method: 'Fetch.requestPaused', params: { requestId: 'request-1' } })
    socket.reply({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: 'Page exception' } } })
    expect(listener).toHaveBeenCalledWith({ requestId: 'request-1' })
    expect(client.runtimeErrors).toEqual(['Page exception'])
    expect(vi.getTimerCount()).toBe(0)
  })
})
