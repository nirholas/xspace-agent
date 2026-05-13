// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

// =============================================================================
// Tests — Static-file auth gate (createStaticGateMiddleware + createStaticGateRouter)
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import path from 'path'

// ---------------------------------------------------------------------------
// Mock fs.readFileSync to avoid needing real HTML files on disk
// ---------------------------------------------------------------------------

// vi.hoisted ensures mockReadFileSync is available inside the vi.mock factory,
// which is hoisted above all const declarations in the file.
const { mockReadFileSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn<[string, string], string>((p: string, _enc: string): string => {
    if (p.endsWith('admin.html')) return '<html><head></head><body>admin</body></html>'
    if (p.endsWith('agent1.html')) return '<html><head></head><body>agent1</body></html>'
    if (p.endsWith('agent2.html')) return '<html><head></head><body>agent2</body></html>'
    if (p.endsWith('builder.html')) return '<html><head></head><body>builder</body></html>'
    if (p.endsWith('index.html')) return '<html><head></head><body>index</body></html>'
    throw Object.assign(new Error('not found'), { code: 'ENOENT' })
  }),
}))

vi.mock('fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('fs')>()
  return { ...orig, readFileSync: mockReadFileSync }
})

import { createStaticGateMiddleware, createStaticGateRouter } from '../../src/routes/static-gate'

const PUBLIC_DIR = '/fake/public'
const API_KEY = 'test-secret-key-32chars-long-abcd'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMiddlewareApp(key = API_KEY) {
  const app = express()
  app.use(express.json())
  app.use(createStaticGateMiddleware(PUBLIC_DIR, key))
  return app
}

function buildRouterApp(key = API_KEY) {
  const app = express()
  app.use(express.json())
  app.use(createStaticGateRouter(PUBLIC_DIR, key))
  return app
}

// ---------------------------------------------------------------------------
// Static gate MIDDLEWARE tests
// ---------------------------------------------------------------------------

describe('createStaticGateMiddleware', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes non-HTML requests through', async () => {
    const app = buildMiddlewareApp()
    app.get('/something.json', (_req, res) => res.json({ ok: true }))
    const res = await request(app).get('/something.json')
    expect(res.status).toBe(200)
  })

  it('passes non-gated HTML through', async () => {
    const app = buildMiddlewareApp()
    app.get('/public.html', (_req, res) => res.send('<html>public</html>'))
    const res = await request(app).get('/public.html')
    expect(res.status).toBe(200)
    expect(res.text).toContain('public')
  })

  it('returns 401 login page for gated HTML without key (browser request)', async () => {
    const app = buildMiddlewareApp()
    const res = await request(app)
      .get('/admin.html')
      .set('Accept', 'text/html')
    expect(res.status).toBe(401)
    expect(res.headers['content-type']).toMatch(/html/)
    expect(res.text).toContain('Admin key required')
  })

  it('returns 401 JSON for gated HTML without key (XHR/API request)', async () => {
    const app = buildMiddlewareApp()
    const res = await request(app)
      .get('/admin.html')
      .set('Accept', 'application/json')
      .set('X-Requested-With', 'XMLHttpRequest')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('unauthorized')
  })

  it('serves gated HTML with key injected when Bearer token is correct', async () => {
    const app = buildMiddlewareApp()
    const res = await request(app)
      .get('/admin.html')
      .set('Authorization', `Bearer ${API_KEY}`)
    expect(res.status).toBe(200)
    expect(res.text).toContain('window.AGENT_AUTH_KEY')
    expect(res.text).toContain(JSON.stringify(API_KEY))
  })

  it('serves gated HTML with ?key= query param', async () => {
    const app = buildMiddlewareApp()
    const res = await request(app).get(`/admin.html?key=${API_KEY}`)
    expect(res.status).toBe(200)
    expect(res.text).toContain('window.AGENT_AUTH_KEY')
  })

  it('serves gated HTML with X-API-Key header', async () => {
    const app = buildMiddlewareApp()
    const res = await request(app)
      .get('/admin.html')
      .set('X-API-Key', API_KEY)
    expect(res.status).toBe(200)
    expect(res.text).toContain('window.AGENT_AUTH_KEY')
  })

  it('injects key before </head> tag', async () => {
    const app = buildMiddlewareApp()
    const res = await request(app)
      .get('/admin.html')
      .set('X-API-Key', API_KEY)
    expect(res.text.indexOf('<script>window.AGENT_AUTH_KEY')).toBeLessThan(res.text.indexOf('</head>'))
  })

  it('serves all files when auth is disabled (empty key)', async () => {
    const app = buildMiddlewareApp('')
    const res = await request(app).get('/admin.html')
    expect(res.status).toBe(200)
    expect(res.text).not.toContain('window.AGENT_AUTH_KEY') // no key to inject
  })

  it('returns 404 for missing file', async () => {
    mockReadFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    const app = buildMiddlewareApp()
    const res = await request(app)
      .get('/admin.html')
      .set('X-API-Key', API_KEY)
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Static gate ROUTER tests
// ---------------------------------------------------------------------------

describe('createStaticGateRouter', () => {
  beforeEach(() => vi.clearAllMocks())

  it('GET /admin requires auth and injects key', async () => {
    const app = buildRouterApp()
    const res = await request(app)
      .get('/admin')
      .set('X-API-Key', API_KEY)
    expect(res.status).toBe(200)
    expect(res.text).toContain('window.AGENT_AUTH_KEY')
    expect(res.text).toContain('admin')
  })

  it('GET /admin returns 401 without key', async () => {
    const app = buildRouterApp()
    const res = await request(app)
      .get('/admin')
      .set('Accept', 'application/json')
      .set('X-Requested-With', 'XMLHttpRequest')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('unauthorized')
  })

  it('GET /builder requires auth', async () => {
    const app = buildRouterApp()
    const res = await request(app).get('/builder').set('X-API-Key', API_KEY)
    expect(res.status).toBe(200)
    expect(res.text).toContain('builder')
  })

  it('GET /server-agent1 requires auth and serves agent1.html', async () => {
    const app = buildRouterApp()
    const res = await request(app).get('/server-agent1').set('X-API-Key', API_KEY)
    expect(res.status).toBe(200)
    expect(res.text).toContain('agent1')
  })

  it('GET /server-agent2 requires auth and serves agent2.html', async () => {
    const app = buildRouterApp()
    const res = await request(app).get('/server-agent2').set('X-API-Key', API_KEY)
    expect(res.status).toBe(200)
    expect(res.text).toContain('agent2')
  })

  it('GET /dashboard is public (serves without key)', async () => {
    const app = buildRouterApp()
    const res = await request(app).get('/dashboard')
    expect(res.status).toBe(200)
    expect(res.text).not.toContain('window.AGENT_AUTH_KEY')
  })

  it('GET /dashboard injects key when authenticated', async () => {
    const app = buildRouterApp()
    const res = await request(app).get('/dashboard').set('X-API-Key', API_KEY)
    expect(res.status).toBe(200)
    expect(res.text).toContain('window.AGENT_AUTH_KEY')
  })

  it('accepts ?key= query param on named routes', async () => {
    const app = buildRouterApp()
    const res = await request(app).get(`/server-agent1?key=${API_KEY}`)
    expect(res.status).toBe(200)
  })

  it('passes through when auth is disabled (empty key)', async () => {
    const app = buildRouterApp('')
    const res = await request(app).get('/admin')
    expect(res.status).toBe(200)
  })
})
