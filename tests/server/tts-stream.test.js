// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import { createRequire } from 'module'

const _require = createRequire(import.meta.url)
const { installMockFetch, restoreFetch, streamFromChunks } = _require('./helpers/mock-fetch.js')

const KEY = 'tts-test-key-xyz789'
const VALID_VOICE = 'AbCdEfGhIjKlMnOp1234'   // 20 alphanum chars — passes VOICE_ID_RE

// Must be set before server.js is evaluated (EL_BURST is captured at load time)
process.env.ADMIN_API_KEY = KEY
process.env.ELEVENLABS_API_KEY = 'el-test-key'
process.env.ELEVENLABS_BURST = '3'
process.env.AI_PROVIDER = 'openai'
process.env.X_SPACES_ENABLED = 'false'

const { app, elBuckets } = _require('../../server.js')

const EL_URL_RE = /api\.elevenlabs\.io\/v1\/text-to-speech/

// ────────────────────────────────────────────────────────────
// State reset between tests
// ────────────────────────────────────────────────────────────

beforeEach(() => {
  elBuckets.clear()
  restoreFetch()
})

afterEach(() => {
  restoreFetch()
})

// ────────────────────────────────────────────────────────────
// Auth guard
// ────────────────────────────────────────────────────────────

describe('/tts/:id/stream — auth', () => {
  it('POST /tts/0/stream without auth → 401', async () => {
    const res = await request(app)
      .post('/tts/0/stream')
      .send({ text: 'hello' })
    expect(res.status).toBe(401)
  })

  it('POST /tts/0/stream with wrong key → 401', async () => {
    const res = await request(app)
      .post('/tts/0/stream')
      .set('Authorization', 'Bearer wrong-key')
      .send({ text: 'hello' })
    expect(res.status).toBe(401)
  })
})

// ────────────────────────────────────────────────────────────
// Input validation
// ────────────────────────────────────────────────────────────

describe('/tts/:id/stream — validation', () => {
  it('missing body text → 400 "missing text"', async () => {
    const res = await request(app)
      .post('/tts/0/stream')
      .set('Authorization', `Bearer ${KEY}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/missing text/i)
  })

  it('invalid agentId /tts/2/stream → 400', async () => {
    const res = await request(app)
      .post('/tts/2/stream')
      .set('Authorization', `Bearer ${KEY}`)
      .send({ text: 'hello' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid agent/i)
  })

  it('text exceeding max chars → 413 with length in body', async () => {
    const overlong = 'a'.repeat(2000)
    const res = await request(app)
      .post('/tts/0/stream')
      .set('Authorization', `Bearer ${KEY}`)
      .send({ text: overlong })
    expect(res.status).toBe(413)
    expect(res.body).toMatchObject({ length: 2000 })
  })

  it('voiceId that fails VOICE_ID_RE ("../etc/passwd") → 400', async () => {
    const res = await request(app)
      .post('/tts/0/stream')
      .set('Authorization', `Bearer ${KEY}`)
      .send({ text: 'hello', voiceId: '../etc/passwd' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid voice/i)
  })

  it('voiceId that is too short ("short") → 400', async () => {
    const res = await request(app)
      .post('/tts/0/stream')
      .set('Authorization', `Bearer ${KEY}`)
      .send({ text: 'hello', voiceId: 'short' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid voice/i)
  })
})

// ────────────────────────────────────────────────────────────
// Rate limiting (ELEVENLABS_BURST=3 set above)
// ────────────────────────────────────────────────────────────

describe('/tts/:id/stream — rate limit', () => {
  function mockOkStream() {
    installMockFetch([
      ['POST', EL_URL_RE, {
        ok: true,
        status: 200,
        body: streamFromChunks([Buffer.from('audio')]),
      }],
    ])
  }

  it('first 3 requests succeed, 4th gets 429', async () => {
    mockOkStream()
    const makeReq = () =>
      request(app)
        .post('/tts/0/stream')
        .set('Authorization', `Bearer ${KEY}`)
        .send({ text: 'hi', voiceId: VALID_VOICE })

    const [r1, r2, r3] = await Promise.all([makeReq(), makeReq(), makeReq()])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(r3.status).toBe(200)

    // 4th should be rate-limited
    const r4 = await makeReq()
    expect(r4.status).toBe(429)
    expect(r4.body.error).toMatch(/rate limit/i)
  })

  it('after bucket refills, next request succeeds', async () => {
    mockOkStream()
    const makeReq = () =>
      request(app)
        .post('/tts/0/stream')
        .set('Authorization', `Bearer ${KEY}`)
        .send({ text: 'hi', voiceId: VALID_VOICE })

    // Drain all 3 tokens
    await makeReq(); await makeReq(); await makeReq()

    // Simulate time passing by backdating the bucket entry
    const bucket = [...elBuckets.values()][0]
    bucket.ts = Date.now() - 2000   // pretend 2 seconds elapsed → 2 tokens refilled

    const r = await makeReq()
    expect(r.status).toBe(200)
  })
})

// ────────────────────────────────────────────────────────────
// Streaming proxy
// ────────────────────────────────────────────────────────────

describe('/tts/:id/stream — streaming', () => {
  it('proxies chunks, sets correct headers', async () => {
    const chunks = [Buffer.from('abc'), Buffer.from('def'), Buffer.from('ghi')]
    installMockFetch([
      ['POST', EL_URL_RE, {
        ok: true,
        status: 200,
        body: streamFromChunks(chunks),
      }],
    ])

    const res = await request(app)
      .post('/tts/0/stream')
      .set('Authorization', `Bearer ${KEY}`)
      .send({ text: 'hello world', voiceId: VALID_VOICE })
      .buffer(true)
      .parse((res, cb) => {
        const chunks = []
        res.on('data', d => chunks.push(d))
        res.on('end', () => cb(null, Buffer.concat(chunks)))
      })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/audio\/mpeg/)
    expect(res.headers['cache-control']).toBe('no-store')
    // All 3 chunks concatenated
    const body = res.body
    expect(body.toString()).toBe('abcdefghi')
  })

  it('upstream non-OK (502) → response is 502 with upstream body forwarded', async () => {
    installMockFetch([
      ['POST', EL_URL_RE, {
        ok: false,
        status: 502,
        text: 'bad gateway from elevenlabs',
      }],
    ])

    const res = await request(app)
      .post('/tts/0/stream')
      .set('Authorization', `Bearer ${KEY}`)
      .send({ text: 'hello', voiceId: VALID_VOICE })

    expect(res.status).toBe(502)
    expect(res.text).toContain('bad gateway from elevenlabs')
  })
})
