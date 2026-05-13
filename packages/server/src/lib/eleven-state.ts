// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

// =============================================================================
// ElevenLabs shared state — token-bucket rate limiter, daily counter,
// runtime voice IDs, and voice catalog cache.
//
// All mutable state lives in this single module so it can be shared between
// the TTS route handler and the setVoice socket handler, and reset cleanly
// in unit tests without touching global scope.
// =============================================================================

// ---------------------------------------------------------------------------
// Configuration — all from env vars (same names as legacy server.js)
// ---------------------------------------------------------------------------

export const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY
export const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL ?? 'eleven_turbo_v2_5'
export const ELEVEN_OPTIMIZE = process.env.ELEVENLABS_OPTIMIZE_LATENCY ?? '2'
export const ELEVEN_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT ?? 'mp3_22050_32'

/** Voice ID format: alphanumeric, 16–40 chars. Blocks path-injection abuse. */
export const VOICE_ID_RE = /^[A-Za-z0-9]{16,40}$/

/** Max chars per TTS request — each char ≈ 1 EL credit. */
export const EL_MAX_TEXT = Math.max(
  50,
  parseInt(process.env.ELEVENLABS_MAX_TEXT_CHARS ?? '1500', 10) || 1500,
)

/** Token-bucket burst capacity (max tokens). Refills 1 token/second. */
export const EL_BURST = Math.max(
  2,
  parseInt(process.env.ELEVENLABS_BURST ?? '8', 10) || 8,
)

/** Daily character cap — server emits costWarning at 80 % and 95 %. */
export const ELEVENLABS_DAILY_CHAR_CAP = Math.max(
  1,
  parseInt(process.env.ELEVENLABS_DAILY_CHAR_CAP ?? '200000', 10) || 200000,
)

// ---------------------------------------------------------------------------
// Runtime voice IDs — mutable by operator via setVoice socket event
// ---------------------------------------------------------------------------

export const elevenVoiceIds: Record<number, string> = {
  0:
    process.env.ELEVENLABS_VOICE_0 ??
    process.env.ELEVEN_VOICE_0 ??
    'S9NKLs1GeSTKzXd9D0Lf',
  1:
    process.env.ELEVENLABS_VOICE_1 ??
    process.env.ELEVEN_VOICE_1 ??
    'AZnzlk1XvdvUeBnXmlld',
}

// ---------------------------------------------------------------------------
// Token bucket — per client IP, 1 token/second refill up to EL_BURST
// ---------------------------------------------------------------------------

interface Bucket {
  tokens: number
  ts: number
}

const elBuckets = new Map<string, Bucket>()

/**
 * Attempt to consume one token from the per-IP token bucket.
 * Returns true if the request is allowed, false if it should be rate-limited.
 */
export function elTake(ip: string): boolean {
  const now = Date.now()
  let b = elBuckets.get(ip)
  if (!b) {
    b = { tokens: EL_BURST, ts: now }
    elBuckets.set(ip, b)
  }
  const refill = (now - b.ts) / 1000
  if (refill > 0) {
    b.tokens = Math.min(EL_BURST, b.tokens + refill)
    b.ts = now
  }
  if (b.tokens < 1) return false
  b.tokens -= 1
  return true
}

// Purge buckets that have been idle for >5 min to prevent unbounded map growth.
const _bucketCleanup = setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000
  for (const [ip, b] of elBuckets) {
    if (b.ts < cutoff) elBuckets.delete(ip)
  }
}, 60_000)
_bucketCleanup.unref()

/** Clear all per-IP token buckets. Intended for unit tests. */
export function resetBuckets(): void {
  elBuckets.clear()
}

// ---------------------------------------------------------------------------
// Daily character counter — resets at UTC midnight
// ---------------------------------------------------------------------------

export interface ElevenDailyStats {
  charsSentToday: number
  callsToday: number
  rateLimitedToday: number
  upstreamErrorsToday: number
  warnedAt80: boolean
  warnedAt95: boolean
}

export const elDailyStats: ElevenDailyStats = {
  charsSentToday: 0,
  callsToday: 0,
  rateLimitedToday: 0,
  upstreamErrorsToday: 0,
  warnedAt80: false,
  warnedAt95: false,
}

/** Reset all daily counters and warning flags. Intended for unit tests. */
export function resetDailyStats(): void {
  elDailyStats.charsSentToday = 0
  elDailyStats.callsToday = 0
  elDailyStats.rateLimitedToday = 0
  elDailyStats.upstreamErrorsToday = 0
  elDailyStats.warnedAt80 = false
  elDailyStats.warnedAt95 = false
}

function msUntilUtcMidnight(): number {
  const d = new Date()
  return (
    new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1),
    ).getTime() - Date.now()
  )
}

;(function scheduleUtcMidnightReset() {
  const t = setTimeout(() => {
    resetDailyStats()
    scheduleUtcMidnightReset()
  }, msUntilUtcMidnight())
  t.unref()
})()

// ---------------------------------------------------------------------------
// Voice catalog cache — 5 min TTL
// ---------------------------------------------------------------------------

export interface VoiceEntry {
  id: string
  name: string
  category: string | null
  description: string | null
  labels: Record<string, string> | null
  preview: string | null
}

export interface VoicesPayload {
  voices: VoiceEntry[]
}

export interface VoicesCache {
  at: number
  payload: VoicesPayload
}

export const VOICES_TTL_MS = 5 * 60_000

// voicesCache is a nullable module-level variable. In CJS (how TypeScript
// compiles this package) named imports are accessed as property reads on the
// module object, so consumers always see the current value. Use setVoicesCache
// to update it from route handlers (TypeScript disallows direct assignment to
// an imported binding).
export let voicesCache: VoicesCache | null = null

/** Update the voice catalog cache. */
export function setVoicesCache(c: VoicesCache | null): void {
  voicesCache = c
}
