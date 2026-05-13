// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createRequire } from 'module'

const _require = createRequire(import.meta.url)
const { connectAsOperator, waitForEvent } = _require('./helpers/socket-client.js')

const KEY = 'socket-test-key-lmno567'
const VALID_VOICE_0 = 'DefaultVoice0AAAAAAAAA'   // 21 chars
const VALID_VOICE_1 = 'DefaultVoice1BBBBBBBBB'   // 21 chars
const NEW_VOICE     = 'NewVoiceXXXXXXXXXXXXX'   // 21 chars

process.env.ADMIN_API_KEY = KEY
process.env.ELEVENLABS_API_KEY = 'el-test-key'
process.env.AI_PROVIDER = 'openai'
process.env.X_SPACES_ENABLED = 'false'
process.env.ELEVENLABS_VOICE_0 = VALID_VOICE_0
process.env.ELEVENLABS_VOICE_1 = VALID_VOICE_1
// Wide CORS so the Socket.IO client isn't rejected
process.env.CORS_ORIGINS = 'http://127.0.0.1'

const { server, spaceState, elBuckets, elevenVoiceIds, clearVoicesCache } = _require('../../server.js')

let port

beforeAll(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

afterAll(async () => {
  await new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  )
})

beforeEach(() => {
  elBuckets.clear()
  clearVoicesCache()
  elevenVoiceIds[0] = VALID_VOICE_0
  elevenVoiceIds[1] = VALID_VOICE_1
  // Clear audit messages so each test starts clean
  spaceState.messages = []
})

// ────────────────────────────────────────────────────────────
// Connection auth
// ────────────────────────────────────────────────────────────

describe('Socket.IO /space — connection auth', () => {
  it('connecting without auth key is rejected with connect_error', async () => {
    const { io } = _require('socket.io-client')
    const socket = io(`http://127.0.0.1:${port}/space`, {
      auth: {},
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    })
    const err = await new Promise((resolve, reject) => {
      socket.on('connect_error', resolve)
      socket.on('connect', () => reject(new Error('should not have connected')))
      setTimeout(() => reject(new Error('timeout')), 3000)
    })
    expect(err.message).toMatch(/unauthorized/i)
    socket.disconnect()
  })

  it('connecting with correct key succeeds', async () => {
    const socket = connectAsOperator({ key: KEY, port })
    await waitForEvent(socket, 'connect')
    expect(socket.connected).toBe(true)
    socket.disconnect()
  })
})

// ────────────────────────────────────────────────────────────
// setVoice — valid change
// ────────────────────────────────────────────────────────────

describe('setVoice — valid change', () => {
  it('emits voiceUpdated to all sockets with new voice id', async () => {
    const emitter = connectAsOperator({ key: KEY, port })
    const listener = connectAsOperator({ key: KEY, port })

    await Promise.all([
      waitForEvent(emitter, 'connect'),
      waitForEvent(listener, 'connect'),
    ])

    const voiceUpdatedPromise = waitForEvent(listener, 'voiceUpdated')
    emitter.emit('setVoice', { agentId: 0, voiceId: NEW_VOICE })

    const payload = await voiceUpdatedPromise
    expect(payload.agentId).toBe(0)
    expect(payload.voiceId).toBe(NEW_VOICE)
    expect(elevenVoiceIds[0]).toBe(NEW_VOICE)

    emitter.disconnect()
    listener.disconnect()
  })

  it('logs an audit entry mentioning previous and new voice', async () => {
    const socket = connectAsOperator({ key: KEY, port })
    await waitForEvent(socket, 'connect')

    spaceState.messages = []
    socket.emit('setVoice', { agentId: 0, voiceId: NEW_VOICE })

    await waitForEvent(socket, 'voiceUpdated')

    const auditMsg = spaceState.messages.find((m) => m.isAudit)
    expect(auditMsg).toBeDefined()
    expect(auditMsg.text).toContain(VALID_VOICE_0)   // previous voice
    expect(auditMsg.text).toContain(NEW_VOICE)        // new voice

    socket.disconnect()
  })
})

// ────────────────────────────────────────────────────────────
// setVoice — invalid inputs (no voiceUpdated, no change)
// ────────────────────────────────────────────────────────────

describe('setVoice — invalid inputs', () => {
  it('invalid voiceId → no voiceUpdated event, voice unchanged', async () => {
    const socket = connectAsOperator({ key: KEY, port })
    await waitForEvent(socket, 'connect')

    let got = false
    socket.on('voiceUpdated', () => { got = true })
    socket.emit('setVoice', { agentId: 0, voiceId: '../bad' })

    // Wait a tick to let the event propagate if it were going to
    await new Promise((r) => setTimeout(r, 200))
    expect(got).toBe(false)
    expect(elevenVoiceIds[0]).toBe(VALID_VOICE_0)

    socket.disconnect()
  })

  it('invalid agentId (2) → no voiceUpdated event, voices unchanged', async () => {
    const socket = connectAsOperator({ key: KEY, port })
    await waitForEvent(socket, 'connect')

    let got = false
    socket.on('voiceUpdated', () => { got = true })
    socket.emit('setVoice', { agentId: 2, voiceId: NEW_VOICE })

    await new Promise((r) => setTimeout(r, 200))
    expect(got).toBe(false)
    expect(elevenVoiceIds[0]).toBe(VALID_VOICE_0)
    expect(elevenVoiceIds[1]).toBe(VALID_VOICE_1)

    socket.disconnect()
  })

  it('same voiceId as current → no voiceUpdated event emitted', async () => {
    const socket = connectAsOperator({ key: KEY, port })
    await waitForEvent(socket, 'connect')

    let got = false
    socket.on('voiceUpdated', () => { got = true })
    socket.emit('setVoice', { agentId: 0, voiceId: VALID_VOICE_0 })  // same as current

    await new Promise((r) => setTimeout(r, 200))
    expect(got).toBe(false)

    socket.disconnect()
  })
})
