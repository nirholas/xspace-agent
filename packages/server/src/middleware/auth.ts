// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent) [§86]

// =============================================================================
// Admin authentication middleware — API key via header, query, or socket auth
// =============================================================================

import { timingSafeEqual } from 'crypto'
import type { Request, Response, NextFunction } from 'express'
import type { Socket } from 'socket.io'

/**
 * Timing-safe comparison to prevent timing attacks on API key checks.
 * Returns false for mismatched lengths without leaking which bytes differ.
 */
function timingSafeApiKeyCompare(provided: string, expected: string): boolean {
  try {
    const a = Buffer.from(provided, 'utf-8')
    const b = Buffer.from(expected, 'utf-8')
    if (a.length !== b.length) {
      // Compare against itself to burn the same time, then return false
      timingSafeEqual(a, a)
      return false
    }
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Express middleware that requires a valid API key on all routes except /health.
 * Accepts the key via:
 *   - `X-API-Key` header
 *   - `Authorization: Bearer <key>` header
 *   - `?apiKey=<key>` query parameter (convenience for browser access)
 */
export function createAuthMiddleware(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip auth for health check
    if (req.path === '/health') return next()

    // Extract key from multiple locations
    const provided =
      (req.headers['x-api-key'] as string) ??
      req.headers['authorization']?.replace('Bearer ', '') ??
      (req.query.apiKey as string)

    if (!provided || !timingSafeApiKeyCompare(provided, apiKey)) {
      res.status(401).json({
        error: 'Unauthorized',
        hint: 'Provide API key via X-API-Key header',
      })
      return
    }

    next()
  }
}

// ---------------------------------------------------------------------------
// Legacy-compatible auth middleware (matches server.js requireAuth semantics)
// ---------------------------------------------------------------------------

/**
 * Extract the API key from a request using the same precedence as legacy
 * server.js: Bearer → X-API-Key → ?key= → ?apiKey= → body.key.
 * Exported so static-gate.ts can reuse it without a second import chain.
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

/**
 * API-endpoint auth middleware with legacy `?key=` support.
 * Same semantics as server.js `requireAuth` minus the HTML login page
 * (which is handled separately by static-gate.ts for operator pages).
 *
 * When apiKey is empty (auth disabled) all requests pass through.
 */
export function createLegacyAuthMiddleware(apiKey: string) {
  const required = apiKey.length > 0
  return (req: Request, res: Response, next: NextFunction) => {
    if (!required) return next()
    const provided = extractLegacyKey(req)
    if (provided && timingSafeApiKeyCompare(provided, apiKey)) return next()
    res.status(401).json({
      error: 'unauthorized',
      hint: 'include Authorization: Bearer <ADMIN_API_KEY>, X-API-Key, or ?key=',
    })
  }
}

/**
 * Socket.IO authentication middleware.
 * Clients must pass their API key in `socket.handshake.auth.apiKey`
 * or the `x-api-key` handshake header.
 */
export function socketAuthMiddleware(apiKey: string) {
  return (socket: Socket, next: (err?: Error) => void) => {
    const token =
      socket.handshake.auth?.apiKey ??
      socket.handshake.auth?.token ??
      socket.handshake.auth?.bearer ??
      socket.handshake.auth?.authorization?.replace('Bearer ', '') ??
      (socket.handshake.headers?.authorization as string | undefined)?.replace('Bearer ', '') ??
      (socket.handshake.headers?.['x-api-key'] as string)

    if (!token || !timingSafeApiKeyCompare(token, apiKey)) {
      next(new Error('unauthorized'))
      return
    }

    next()
  }
}


