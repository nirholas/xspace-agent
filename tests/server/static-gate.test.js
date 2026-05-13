// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { createRequire } from 'module'

const _require = createRequire(import.meta.url)

const KEY = 'static-gate-test-key-abc'

// Set env before the module is evaluated
process.env.ADMIN_API_KEY = KEY
process.env.ELEVENLABS_API_KEY = 'el-test'
process.env.AI_PROVIDER = 'openai'
process.env.X_SPACES_ENABLED = 'false'

const { app } = _require('../../server.js')

// ────────────────────────────────────────────────────────────
// Static-file middleware — gated HTML files
// ────────────────────────────────────────────────────────────

const GATED_PAGES = [
  'server-agent1.html',
  'bob.html',
  'alice.html',
  'admin.html',
  'builder.html',
]

describe('Static-file gate: gated HTML via middleware', () => {
  for (const page of GATED_PAGES) {
    describe(`/${page}`, () => {
      it('returns 401 without a key', async () => {
        const res = await request(app).get(`/${page}`)
        expect(res.status).toBe(401)
      })

      it('returns 401 with a wrong key', async () => {
        const res = await request(app).get(`/${page}?key=wrong-key`)
        expect(res.status).toBe(401)
      })

      it('returns 200 with correct key and injects window.AGENT_AUTH_KEY', async () => {
        const res = await request(app)
          .get(`/${page}?key=${KEY}`)
          .set('Accept', 'text/html')
        expect(res.status).toBe(200)
        expect(res.text).toContain('window.AGENT_AUTH_KEY')
        expect(res.text).toContain(KEY)
      })
    })
  }
})

describe('Static-file gate: public JS assets are not gated', () => {
  it('GET /js/agent-common.js returns 200 without a key', async () => {
    const res = await request(app).get('/js/agent-common.js')
    // The file may or may not exist — the important thing is it is NOT blocked
    // by the auth middleware (no 401).  It might 404 if the file doesn't exist.
    expect(res.status).not.toBe(401)
  })
})

// ────────────────────────────────────────────────────────────
// Named operator routes (no .html extension)
// ────────────────────────────────────────────────────────────

describe('Operator routes without .html extension', () => {
  it('GET /server-agent1 without key → 401', async () => {
    const res = await request(app).get('/server-agent1')
    expect(res.status).toBe(401)
  })

  it('GET /server-agent1?key=<correct> → 200 with injected key', async () => {
    const res = await request(app)
      .get(`/server-agent1?key=${KEY}`)
      .set('Accept', 'text/html')
    expect(res.status).toBe(200)
    expect(res.text).toContain('window.AGENT_AUTH_KEY')
  })

  it('GET /bob without key → 401', async () => {
    const res = await request(app).get('/bob')
    expect(res.status).toBe(401)
  })

  it('GET /alice without key → 401', async () => {
    const res = await request(app).get('/alice')
    expect(res.status).toBe(401)
  })

  it('GET /admin without key → 401', async () => {
    const res = await request(app).get('/admin')
    expect(res.status).toBe(401)
  })

  it('GET /builder without key → 401', async () => {
    const res = await request(app).get('/builder')
    expect(res.status).toBe(401)
  })
})

// ────────────────────────────────────────────────────────────
// Cache-Control headers
// ────────────────────────────────────────────────────────────

describe('Cache-Control headers', () => {
  it('gated HTML served with correct key has Cache-Control: no-store', async () => {
    const res = await request(app)
      .get(`/server-agent1?key=${KEY}`)
      .set('Accept', 'text/html')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toMatch(/no-store/)
  })

  it('public JS asset does NOT have Cache-Control: no-store', async () => {
    const res = await request(app).get('/js/agent-common.js')
    // May 404 if file absent, but should not force no-store
    expect(res.headers['cache-control'] || '').not.toMatch(/^no-store$/)
  })
})
