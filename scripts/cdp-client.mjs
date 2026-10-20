/**
 * CDP transport shared by the smoke and visual checks. Every connection and
 * command has a deadline so a closed or unresponsive browser cannot hang a run.
 *
 * @param {string} webSocketUrl
 * @param {{
 *   createSocket?: (url: string) => Pick<WebSocket, 'addEventListener' | 'readyState' | 'send' | 'close'>,
 *   connectionTimeoutMilliseconds?: number,
 *   commandTimeoutMilliseconds?: number
 * }} options
 */
export function createCdpClient(
  webSocketUrl,
  {
    createSocket = (url) => new WebSocket(url),
    connectionTimeoutMilliseconds = 5_000,
    commandTimeoutMilliseconds = 15_000
  } = {}
) {
  const socket = createSocket(webSocketUrl)
  const pendingCommands = new Map()
  const eventListeners = new Map()
  const runtimeErrors = []
  let commandId = 0
  let connectionError = null
  let resolveOpened
  let rejectOpened
  const opened = new Promise((resolve, reject) => {
    resolveOpened = resolve
    rejectOpened = reject
  })
  // A browser can disconnect before the caller sends its first command. Keep
  // that rejection observable through send() without an unhandled rejection.
  void opened.catch(() => {})
  const connectionTimeout = setTimeout(() => {
    failConnection(new Error('The CDP WebSocket did not connect before the timeout'))
    socket.close()
  }, connectionTimeoutMilliseconds)

  function failConnection(error) {
    if (connectionError) return
    connectionError = error
    clearTimeout(connectionTimeout)
    rejectOpened(error)
    for (const { method, reject, timeout } of pendingCommands.values()) {
      clearTimeout(timeout)
      reject(new Error(`CDP command ${method} failed: ${error.message}`))
    }
    pendingCommands.clear()
  }

  socket.addEventListener(
    'open',
    () => {
      clearTimeout(connectionTimeout)
      resolveOpened()
    },
    { once: true }
  )
  socket.addEventListener('close', () => failConnection(new Error('The browser target was closed')))
  socket.addEventListener('error', () => failConnection(new Error('The CDP WebSocket connection failed')))
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pendingCommands.has(message.id)) {
      const { method, resolve, reject, timeout } = pendingCommands.get(message.id)
      pendingCommands.delete(message.id)
      clearTimeout(timeout)
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
    for (const listener of eventListeners.get(message.method) ?? []) {
      listener(message.params)
    }
  })

  function on(method, listener) {
    eventListeners.set(method, [...(eventListeners.get(method) ?? []), listener])
  }

  async function send(method, params = {}) {
    await opened
    if (connectionError) throw connectionError
    if (socket.readyState !== 1) throw new Error('The CDP WebSocket is not open')
    const currentCommandId = ++commandId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingCommands.delete(currentCommandId)
        reject(new Error(`CDP command ${method} did not return within ${commandTimeoutMilliseconds}ms`))
      }, commandTimeoutMilliseconds)
      pendingCommands.set(currentCommandId, { method, resolve, reject, timeout })
      try {
        socket.send(JSON.stringify({ id: currentCommandId, method, params }))
      } catch (error) {
        clearTimeout(timeout)
        pendingCommands.delete(currentCommandId)
        reject(error)
      }
    })
  }

  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }

  return { socket, send, evaluate, on, runtimeErrors }
}
