// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)
'use strict'

// Shared ElevenLabs state — consumed by both the HTTP streaming route and the
// WS proxy so they share one rate-limit bucket map, one daily char counter,
// and one set of voice-ID overrides.

const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5"
const ELEVEN_OPTIMIZE = process.env.ELEVENLABS_OPTIMIZE_LATENCY ?? "2"
const ELEVEN_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || "mp3_22050_32"

// Voice ID format: alphanumeric, 16–40 chars. Rejecting anything else stops
// path-injection-style abuse (e.g. "../something") via the request body.
const VOICE_ID_RE = /^[A-Za-z0-9]{16,40}$/

const EL_MAX_TEXT = Math.max(50, parseInt(process.env.ELEVENLABS_MAX_TEXT_CHARS || "1500", 10) || 1500)
const EL_BURST = Math.max(2, parseInt(process.env.ELEVENLABS_BURST || "8", 10) || 8)
const ELEVENLABS_DAILY_CHAR_CAP = Math.max(1, parseInt(process.env.ELEVENLABS_DAILY_CHAR_CAP || "200000", 10) || 200000)

// Mutable object so all importers share the same reference (mutations are visible everywhere).
const elevenVoiceIds = {
  0: process.env.ELEVENLABS_VOICE_0 || process.env.ELEVEN_VOICE_0 || "S9NKLs1GeSTKzXd9D0Lf",
  1: process.env.ELEVENLABS_VOICE_1 || process.env.ELEVEN_VOICE_1 || "AZnzlk1XvdvUeBnXmlld"
}

// ── Token bucket rate limiter (shared across HTTP + WS) ─────────────────────
const elBuckets = new Map()
function elTake(ip) {
  const now = Date.now()
  let b = elBuckets.get(ip)
  if (!b) { b = { tokens: EL_BURST, ts: now }; elBuckets.set(ip, b) }
  const refill = (now - b.ts) / 1000
  if (refill > 0) { b.tokens = Math.min(EL_BURST, b.tokens + refill); b.ts = now }
  if (b.tokens < 1) return false
  b.tokens -= 1
  return true
}
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000
  for (const [ip, b] of elBuckets) if (b.ts < cutoff) elBuckets.delete(ip)
}, 60 * 1000).unref?.()

// ── Daily char cap (shared across HTTP + WS) ────────────────────────────────
// Use a single mutable object so in-place resets are reflected everywhere.
const elDailyStats = {
  charsSentToday: 0, callsToday: 0, rateLimitedToday: 0,
  upstreamErrorsToday: 0, warnedAt80: false, warnedAt95: false
}

function msUntilUtcMidnight() {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).getTime() - Date.now()
}

;(function scheduleReset() {
  setTimeout(() => {
    Object.assign(elDailyStats, {
      charsSentToday: 0, callsToday: 0, rateLimitedToday: 0,
      upstreamErrorsToday: 0, warnedAt80: false, warnedAt95: false
    })
    scheduleReset()
  }, msUntilUtcMidnight()).unref?.()
})()

// Server calls setWarnEmitter(spaceNS) once spaceNS is ready so cost warnings
// can be broadcast without this module importing from server.js.
let _warnEmitter = null
function setWarnEmitter(emitter) { _warnEmitter = emitter }

// Check whether n chars fit within today's cap (does NOT consume).
function elCheckCap(n) {
  return elDailyStats.charsSentToday + n <= ELEVENLABS_DAILY_CHAR_CAP
}

// Consume n chars and emit 80%/95% cost warnings if thresholds crossed.
// Must only be called after a successful synthesis (so failed calls don't count).
function elConsumeChars(n) {
  elDailyStats.charsSentToday += n
  elDailyStats.callsToday++
  if (!_warnEmitter) return
  const pct = elDailyStats.charsSentToday / ELEVENLABS_DAILY_CHAR_CAP
  if (!elDailyStats.warnedAt80 && pct >= 0.80) {
    elDailyStats.warnedAt80 = true
    _warnEmitter.emit("costWarning", {
      kind: "elevenlabs-daily-80pct",
      used: elDailyStats.charsSentToday, cap: ELEVENLABS_DAILY_CHAR_CAP,
      percent: Math.round(pct * 100)
    })
  }
  if (!elDailyStats.warnedAt95 && pct >= 0.95) {
    elDailyStats.warnedAt95 = true
    _warnEmitter.emit("costWarning", {
      kind: "elevenlabs-daily-95pct",
      used: elDailyStats.charsSentToday, cap: ELEVENLABS_DAILY_CHAR_CAP,
      percent: Math.round(pct * 100)
    })
  }
}

module.exports = {
  ELEVEN_KEY, ELEVEN_MODEL, ELEVEN_OPTIMIZE, ELEVEN_FORMAT,
  VOICE_ID_RE, EL_MAX_TEXT, EL_BURST,
  ELEVENLABS_DAILY_CHAR_CAP, elDailyStats,
  elevenVoiceIds, elBuckets, elTake,
  setWarnEmitter, elCheckCap, elConsumeChars, msUntilUtcMidnight
}
