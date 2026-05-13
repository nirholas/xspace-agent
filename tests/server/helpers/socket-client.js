'use strict'

const { io } = require('socket.io-client')

/**
 * Connect a Socket.IO client to the /space namespace as an operator.
 * Returns the connected socket.
 */
function connectAsOperator({ key, port }) {
  return io(`http://127.0.0.1:${port}/space`, {
    auth: { key },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  })
}

/**
 * Promise that resolves with the first matching event payload,
 * or rejects after timeoutMs milliseconds.
 */
function waitForEvent(socket, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for socket event "${event}"`)),
      timeoutMs
    )
    socket.once(event, (data) => {
      clearTimeout(timer)
      resolve(data)
    })
  })
}

module.exports = { connectAsOperator, waitForEvent }
