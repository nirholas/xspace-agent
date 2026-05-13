// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

// =============================================================================
// Tests — TTS streaming proxy + voice catalog routes (createTTSRouter)
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import type { Server as IOServer } from 'socket.io'

// ---------------------------------------------------------------------------
// vi.hoisted — variables that must be accessible inside vi.mock factory
// (vi.mock factories are hoisted above all imports, so module-level const
//  declarations aren't yet initialized when the factory runs).
// ---------------------------------------------------------------------------

const {
  mockElTake,
  mockSetVoicesCache,
  elevenVoiceIds,
  elDailyStats,
} = vi.hoisted(() => ({
  mockElTake: vi.fn<[], boolean>().mockReturnValue(true),
  mockSetVoicesCache: vi.fn(),
  elevenVoiceIds: { 0: 'AAAAAAAAAAAAAAAA', 1: 'BBBBBBBBBBBBBBBB' } as Record<number, string>,
  elDailyStats: {
    charsSentToday: 0,
    callsToday: 0,
    rateLimitedToday: 0,
    upstreamErrorsToday: 0,
    warnedAt80: false,
    warnedAt95: false,
  },
}))

// voicesCache is a nullable variable read lazily via getter — no hoisting needed.
let mockVoicesCache: { at: number; payload: { voices: any[] } } | null = null
let mockElevenKey: string | undefined = 'test-el-key'

vi.mock('../../src/lib/eleven-state', () => ({
  get ELEVEN_KEY() { return mockElevenKey },
  ELEVEN_MODEL: 'eleven_turbo_v2_5',
  ELEVEN_OPTIMIZE: '2',
  ELEVEN_FORMAT: 'mp3_22050_32',
  VOICE_ID_RE: /^[A-Za-z0-9]{16,40}$/,
  EL_MAX_TEXT: 100,
  EL_BURST: 8,
  ELEVENLABS_DAILY_CHAR_CAP: 1000,
  elevenVoiceIds,
  elDailyStats,
  elTake: mockElTake,
  get voicesCache() { return mockVoicesCache },
  setVoicesCache: mockSetVoicesCache,
  VOICES_TTL_MS: 300_000,
}))

// ---------------------------------------------------------------------------
// Mock globalThis.fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

import { createTTSRouter } from '../../src/routes/tts'

function buildApp() {
  const ioMock = {
    of: vi.fn().mockReturnValue({ emit: vi.fn() }),
  } as unknown as IOServer

  const app = express()
  app.use(express.json())
  app.set('trust proxy', false)
  app.use(createTTSRouter(ioMock))
  return app
}

function makeReadableStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++])
      else controller.close()
    },
  })
}

// ---------------------------------------------------------------------------
// Tests — POST /tts/:agentId/stream
// ---------------------------------------------------------------------------

describe('POST /tts/:agentId/stream', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockElTake.mockReturnValue(true)
    mockElevenKey = 'test-el-key'
    elDailyStats.charsSentToday = 0
    elDailyStats.callsToday = 0
    elDailyStats.rateLimitedToday = 0
    elDailyStats.upstreamErrorsToday = 0
    elDailyStats.warnedAt80 = false
    elDailyStats.warnedAt95 = false
    elevenVoiceIds[0] = 'AAAAAAAAAAAAAAAA'
    elevenVoiceIds[1] = 'BBBBBBBBBBBBBBBB'
  })

  it('streams audio/mpeg from ElevenLabs on valid request', async () => {
    const audioChunk = new Uint8Array([0xff, 0xfb, 0x90, 0x00])
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: makeReadableStream([audioChunk]),
    })

    const app = buildApp()
    const res = await request(app)
      .post('/tts/0/stream')
      .send({ text: 'hello' })
      .buffer(true)

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/audio\/mpeg/)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, opts] = mockFetch.mock.calls[0] as [string, any]
    expect(url).toContain('AAAAAAAAAAAAAAAA')
    expect(JSON.parse(opts.body).text).toBe('hello')
  })

  it('uses agent 1 voice id for agentId=1', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, body: makeReadableStream([]) })
    await request(buildApp()).post('/tts/1/stream').send({ text: 'hi' })
    const [url] = mockFetch.mock.calls[0] as [string, any]
    expect(url).toContain('BBBBBBBBBBBBBBBB')
  })

  it('uses voiceId from body when provided', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, body: makeReadableStream([]) })
    await request(buildApp()).post('/tts/0/stream').send({ text: 'hi', voiceId: 'CCCCCCCCCCCCCCCC' })
    const [url] = mockFetch.mock.calls[0] as [string, any]
    expect(url).toContain('CCCCCCCCCCCCCCCC')
  })

  it('returns 400 for invalid agentId', async () => {
    const res = await request(buildApp()).post('/tts/9/stream').send({ text: 'hi' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid agent id')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 400 for missing text', async () => {
    const res = await request(buildApp()).post('/tts/0/stream').send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('missing text')
  })

  it('returns 400 for empty text', async () => {
    const res = await request(buildApp()).post('/tts/0/stream').send({ text: '   ' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('missing text')
  })

  it('returns 413 when text exceeds EL_MAX_TEXT', async () => {
    const longText = 'x'.repeat(101) // EL_MAX_TEXT mocked to 100
    const res = await request(buildApp()).post('/tts/0/stream').send({ text: longText })
    expect(res.status).toBe(413)
    expect(res.body.error).toMatch(/text too long/)
    expect(res.body.length).toBe(101)
  })

  it('returns 400 for invalid voiceId format', async () => {
    const res = await request(buildApp())
      .post('/tts/0/stream')
      .send({ text: 'hi', voiceId: '../inject' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid voice id')
  })

  it('returns 429 when token bucket is exhausted', async () => {
    mockElTake.mockReturnValue(false)
    const res = await request(buildApp()).post('/tts/0/stream').send({ text: 'hi' })
    expect(res.status).toBe(429)
    expect(res.body.error).toBe('rate limit exceeded (TTS)')
    expect(elDailyStats.rateLimitedToday).toBe(1)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 503 when daily cap is reached', async () => {
    elDailyStats.charsSentToday = 995
    // 'hello world' is 11 chars; 995 + 11 > 1000
    const res = await request(buildApp()).post('/tts/0/stream').send({ text: 'hello world' })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('daily TTS cap reached')
    expect(res.body.capacity).toBe(1000)
  })

  it('returns 500 when ELEVENLABS_API_KEY is not set', async () => {
    mockElevenKey = undefined
    const res = await request(buildApp()).post('/tts/0/stream').send({ text: 'hi' })
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('ELEVENLABS_API_KEY not configured')
  })

  it('forwards ElevenLabs error status when upstream rejects', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      body: null,
      text: vi.fn().mockResolvedValue('invalid_api_key'),
    })
    const res = await request(buildApp()).post('/tts/0/stream').send({ text: 'hi' })
    expect(res.status).toBe(401)
    expect(elDailyStats.upstreamErrorsToday).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Tests — GET /voices
// ---------------------------------------------------------------------------

describe('GET /voices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockElevenKey = 'test-el-key'
    mockVoicesCache = null
    elevenVoiceIds[0] = 'AAAAAAAAAAAAAAAA'
    elevenVoiceIds[1] = 'BBBBBBBBBBBBBBBB'
  })

  it('fetches and returns voice catalog with current voice IDs', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        voices: [
          {
            voice_id: 'AAAAAAAAAAAAAAAA',
            name: 'Rachel',
            category: 'premade',
            labels: { description: 'calm' },
            preview_url: 'https://el.io/preview.mp3',
          },
        ],
      }),
    })

    const res = await request(buildApp()).get('/voices')

    expect(res.status).toBe(200)
    expect(res.body.voices).toHaveLength(1)
    expect(res.body.voices[0].id).toBe('AAAAAAAAAAAAAAAA')
    expect(res.body.voices[0].name).toBe('Rachel')
    expect(res.body.voices[0].description).toBe('calm')
    expect(res.body.current[0]).toBe('AAAAAAAAAAAAAAAA')
    expect(res.body.current[1]).toBe('BBBBBBBBBBBBBBBB')
    expect(mockSetVoicesCache).toHaveBeenCalledOnce()
  })

  it('serves from cache when TTL has not expired', async () => {
    mockVoicesCache = {
      at: Date.now() - 60_000, // 1 min ago, within 5 min TTL
      payload: {
        voices: [
          {
            id: 'CACHED',
            name: 'Cached Voice',
            category: null,
            description: null,
            labels: null,
            preview: null,
          },
        ],
      },
    }

    const res = await request(buildApp()).get('/voices')

    expect(res.status).toBe(200)
    expect(res.body.voices[0].id).toBe('CACHED')
    expect(res.body.current[0]).toBe('AAAAAAAAAAAAAAAA')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('refetches when cache has expired', async () => {
    mockVoicesCache = {
      at: Date.now() - 6 * 60_000, // 6 min ago, expired
      payload: { voices: [] },
    }
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ voices: [] }),
    })

    await request(buildApp()).get('/voices')

    expect(mockFetch).toHaveBeenCalledOnce()
    expect(mockSetVoicesCache).toHaveBeenCalledOnce()
  })

  it('returns ElevenLabs error status on upstream failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: vi.fn().mockResolvedValue('rate_limited'),
    })
    const res = await request(buildApp()).get('/voices')
    expect(res.status).toBe(429)
  })

  it('returns 500 when ELEVENLABS_API_KEY is not set', async () => {
    mockElevenKey = undefined
    const res = await request(buildApp()).get('/voices')
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('ELEVENLABS_API_KEY not configured')
  })
})
