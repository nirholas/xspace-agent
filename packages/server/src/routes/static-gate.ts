// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

// =============================================================================
// Static-file auth gate — injects window.AGENT_AUTH_KEY into operator HTML.
//
// Operator pages (agent1.html, agent2.html, admin.html, builder.html) must
// never be served raw from express.static because:
//   1. They reach the client without window.AGENT_AUTH_KEY, so their JS
//      cannot authenticate to Socket.IO or call privileged JSON endpoints.
//   2. An unauthenticated visitor could inspect operator-only UI before
//      the key check runs.
//
// Ported from legacy server.js GATED_HTML + sendWithAuthInjection.
// =============================================================================

import { readFileSync } from 'fs'
import path from 'path'
import { timingSafeEqual } from 'crypto'
import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express'

// HTML file names that require auth + key injection.
const GATED_HTML = new Set([
  // packages/server/public/ names
  'admin.html',
  'agent1.html',
  'agent2.html',
  'builder.html',
  // Legacy root public/ names (kept so the middleware guards both locations
  // if the public dir is ever pointed at the legacy root public/).
  'bob.html',
  'alice.html',
  'server-agent1.html',
  'server-agent2.html',
  'server-admin.html',
  'server-builder.html',
  'server-dashboard.html',
])

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Extract the API key from a request using the same precedence as legacy
 * server.js: Bearer → X-API-Key → ?key= → ?apiKey= → body.key.
 */
export function extractLegacyKey(req: Request): string | null {
  const auth = req.headers.authorization
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim()
  const x = req.headers['x-api-key'] as string
  if (x) return x.trim()
  if (typeof req.query.key === 'string') return req.query.key
  if (typeof req.query.apiKey === 'string') return req.query.apiKey
  if (req.body && typeof req.body.key === 'string') return req.body.key
  return null
}

function timingSafeCheck(provided: string, expected: string): boolean {
  try {
    const a = Buffer.from(provided)
    const b = Buffer.from(expected)
    if (a.length !== b.length) {
      timingSafeEqual(a, a) // burn same time
      return false
    }
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** Inline login page — same HTML as legacy server.js. */
function loginPageHtml(target: string): string {
  const safeTarget = String(target || '/dashboard').replace(/[<>"]/g, '')
  return `<!doctype html><meta charset=utf-8><title>Authorize</title>
<style>
  body{margin:0;background:#0b0d10;color:#e6edf3;font:14px/1.5 -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
  form{background:#14181d;border:1px solid #2a313a;border-radius:8px;padding:20px;width:min(360px,90vw)}
  h1{margin:0 0 12px;font-size:16px}
  input{width:100%;box-sizing:border-box;background:#1c2128;color:#e6edf3;border:1px solid #2a313a;border-radius:6px;padding:10px;font:inherit;margin:8px 0 12px}
  button{background:#58a6ff;color:#061018;border:0;border-radius:6px;padding:8px 14px;font-weight:600;cursor:pointer;width:100%}
  p{color:#9aa4ae;font-size:12px;margin:0 0 4px}
</style>
<form method=GET action="${safeTarget}">
  <h1>Admin key required</h1>
  <p>Enter ADMIN_API_KEY to continue.</p>
  <input name=key type=password autofocus autocomplete=off />
  <button type=submit>Authorize</button>
</form>`
}

/**
 * Read an HTML file, optionally inject the API key as window.AGENT_AUTH_KEY,
 * and send it. Falls back to 404 if the file is missing.
 */
function sendWithAuthInjection(res: Response, filePath: string, adminApiKey: string): void {
  let html: string
  try {
    html = readFileSync(filePath, 'utf8')
  } catch {
    res.status(404).type('text').send('not found')
    return
  }
  if (adminApiKey) {
    const inject = `<script>window.AGENT_AUTH_KEY=${JSON.stringify(adminApiKey)};</script>`
    html = html.includes('</head>')
      ? html.replace('</head>', inject + '</head>')
      : inject + html
  }
  res.type('html').send(html)
}

// ---------------------------------------------------------------------------
// Middleware — intercepts any gated HTML file access via express.static
// ---------------------------------------------------------------------------

/**
 * Mount BEFORE express.static.  Intercepts GET/HEAD for files in GATED_HTML
 * and enforces auth + key injection.  Non-gated files pass through to the
 * static handler unchanged.
 */
export function createStaticGateMiddleware(
  publicDir: string,
  adminApiKey: string,
): RequestHandler {
  const authRequired = adminApiKey.length > 0

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next()
      return
    }
    const match = req.path.match(/\/([^/]+\.html)$/i)
    if (!match || !GATED_HTML.has(match[1].toLowerCase())) {
      next()
      return
    }

    if (!authRequired) {
      sendWithAuthInjection(res, path.join(publicDir, match[1]), adminApiKey)
      return
    }

    const provided = extractLegacyKey(req)
    if (provided && timingSafeCheck(provided, adminApiKey)) {
      sendWithAuthInjection(res, path.join(publicDir, match[1]), adminApiKey)
      return
    }

    // Browser navigating without a key → show inline login form.
    if (req.accepts('html') && !(req.headers['x-requested-with'])) {
      res.status(401).type('html').send(loginPageHtml(req.originalUrl))
      return
    }

    res.status(401).json({
      error: 'unauthorized',
      hint: 'include Authorization: Bearer <ADMIN_API_KEY>, X-API-Key, or ?key=',
    })
  }
}

// ---------------------------------------------------------------------------
// Router — named operator page routes
// ---------------------------------------------------------------------------

/**
 * Registers auth-gated named routes for operator HTML pages.  Mount after the
 * static gate middleware and before express.static.
 */
export function createStaticGateRouter(publicDir: string, adminApiKey: string): Router {
  const router = Router()
  const authRequired = adminApiKey.length > 0

  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (!authRequired) {
      next()
      return
    }
    const provided = extractLegacyKey(req)
    if (provided && timingSafeCheck(provided, adminApiKey)) {
      next()
      return
    }
    if (req.accepts('html') && !(req.headers['x-requested-with'])) {
      res.status(401).type('html').send(loginPageHtml(req.originalUrl))
      return
    }
    res.status(401).json({
      error: 'unauthorized',
      hint: 'include Authorization: Bearer <ADMIN_API_KEY>, X-API-Key, or ?key=',
    })
  }

  const serve =
    (filename: string) =>
    (_req: Request, res: Response): void => {
      sendWithAuthInjection(res, path.join(publicDir, filename), adminApiKey)
    }

  // Operator pages
  router.get('/admin', requireAuth, serve('admin.html'))
  router.get('/builder', requireAuth, serve('builder.html'))
  router.get('/server-agent1', requireAuth, serve('agent1.html'))
  router.get('/server-agent2', requireAuth, serve('agent2.html'))

  // /dashboard is semi-public: rendered plain unless the request already
  // carries a valid key, in which case the key is injected.
  router.get('/dashboard', (req: Request, res: Response): void => {
    if (authRequired) {
      const provided = extractLegacyKey(req)
      if (provided && timingSafeCheck(provided, adminApiKey)) {
        sendWithAuthInjection(res, path.join(publicDir, 'index.html'), adminApiKey)
        return
      }
    }
    let html: string
    try {
      html = readFileSync(path.join(publicDir, 'index.html'), 'utf8')
    } catch {
      res.status(404).type('text').send('not found')
      return
    }
    res.type('html').send(html)
  })

  return router
}
