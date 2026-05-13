// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import { createRequire } from 'module'

const _require = createRequire(import.meta.url)
const { installMockFetch, restoreFetch } = _require('./helpers/mock-fetch.js')

const KEY = 'voices-test-key-qrs123'
const VALID_VOICE_A = 'VoiceAAAAAAAAAAAAAAAAAA'   // 22 chars, alphanum
const VALID_VOICE_B = 'VoiceBBBBBBBBBBBBBBBBBB'   // 22 chars, alphanum

process.env.ADMIN_API_KEY = KEY
process.env.ELEVENLABS_API_KEY = 'el-test-key'
process.env.AI_PROVIDER = 'openai'
process.env.X_SPACES_ENABLED = 'false'
// Seed deterministic default voices so tests can assert on them
process.env.ELEVENLABS_VOICE_0 = VALID_VOICE_A
process.env.ELEVENLABS_VOICE_1 = VALID_VOICE_B

const { app, elBuckets, elevenVoiceIds, clearVoicesCache } = _require('../../server.js')

const VOICES_API = 'https://api.elevenlabs.io/v1/voices'

const FAKE_VOICES_PAYLOAD = {
  voices: [
    { voice_id: VALID_VOICE_A, name: 'Voice A', category: 'premade', labels: { description: 'test' }, preview_url: null },
    { voice_id: VALID_VOICE_B, name: 'Voice B', category: 'premade', labels: {}, preview_url: null },
  ],
}

beforeEach(() => {
  elBuckets.clear()
  clearVoicesCache()
  // Reset voices to the env-seeded defaults
  elevenVoiceIds[0] = VALID_VOICE_A
  elevenVoiceIds[1] = VALID_VOICE_B
  restoreFetch()
})

afterEach(() => {
  restoreFetch()
})

// ────────────────────────────────────────────────────────────
// Auth gate
// ────────────────────────────────────────────────────────────

describe('/voices — auth', () => {
  it('requires a key', async () => {
    const res = await request(app).get('/voices')
    expect(res.status).toBe(401)
  })
})

// ────────────────────────────────────────────────────────────
// Cache behaviour
// ────────────────────────────────────────────────────────────

describe('/voices — cache', () => {
  it('first call hits upstream fetch exactly once', async () => {
    let fetchCount = 0
    installMockFetch([
      ['GET', VOICES_API, {
        ok: true,
        status: 200,
        json: FAKE_VOICES_PAYLOAD,
        get fetchCount() { fetchCount++; return undefined }  // side-effect on access
      }],
    ])
    // Replace with a counting wrapper
    const prev = global.fetch
    global.fetch = async (url, opts) => {
      if (url === VOICES_API) fetchCount++
      return prev(url, opts)
    }

    const res = await request(app)
      .get('/voices')
      .set('Authorization', `Bearer ${KEY}`)

    expect(res.status).toBe(200)
    expect(fetchCount).toBe(1)
  })

  it('second call within TTL does NOT call upstream again', async () => {
    let fetchCount = 0
    const prev = global.fetch
    global.fetch = async (url, opts) => {
      if (url === VOICES_API) {
        fetchCount++
        return {
          ok: true,
          status: 200,
          json: async () => FAKE_VOICES_PAYLOAD,
          text: async () => JSON.stringify(FAKE_VOICES_PAYLOAD),
          body: null,
          headers: { get: () => null },
        }
      }
      return prev(url, opts)
    }

    await request(app).get('/voices').set('Authorization', `Bearer ${KEY}`)
    await request(app).get('/voices').set('Authorization', `Bearer ${KEY}`)

    expect(fetchCount).toBe(1)
  })

  it('current[] in response reflects live elevenVoiceIds even on cache hit', async () => {
    global.fetch = async (url) => {
      if (url === VOICES_API) {
        return {
          ok: true,
          status: 200,
          json: async () => FAKE_VOICES_PAYLOAD,
          text: async () => '',
          body: null,
          headers: { get: () => null },
        }
      }
      throw new Error('unexpected fetch: ' + url)
    }

    // Seed the cache with a first call
    await request(app).get('/voices').set('Authorization', `Bearer ${KEY}`)

    // Now mutate the in-memory voice IDs (mimicking a setVoice call)
    const NEW_VOICE = 'NewVoice111111111111'
    elevenVoiceIds[0] = NEW_VOICE

    // Second call hits cache but must return updated current[]
    const res = await request(app)
      .get('/voices')
      .set('Authorization', `Bearer ${KEY}`)

    expect(res.status).toBe(200)
    expect(res.body.current[0]).toBe(NEW_VOICE)
  })
})

// ────────────────────────────────────────────────────────────
// Response shape
// ────────────────────────────────────────────────────────────

describe('/voices — response shape', () => {
  beforeEach(() => {
    global.fetch = async (url) => {
      if (url === VOICES_API) {
        return {
          ok: true,
          status: 200,
          json: async () => FAKE_VOICES_PAYLOAD,
          text: async () => '',
          body: null,
          headers: { get: () => null },
        }
      }
      throw new Error('unexpected fetch: ' + url)
    }
  })

  it('returns voices array and current map', async () => {
    const res = await request(app)
      .get('/voices')
      .set('Authorization', `Bearer ${KEY}`)

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.voices)).toBe(true)
    expect(res.body.voices).toHaveLength(2)
    expect(res.body.current[0]).toBe(VALID_VOICE_A)
    expect(res.body.current[1]).toBe(VALID_VOICE_B)
  })
})
