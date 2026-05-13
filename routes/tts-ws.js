// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)
'use strict'

// WebSocket TTS proxy for ElevenLabs stream-input API.
// Mounted at GET /tts-ws/:agentId — server.js calls handleUpgrade() from its
// "upgrade" event handler.  One upstream EL WebSocket is created per turn
// (per "flush" message from the browser) and closed after isFinal is received.
// The browser-to-server WS stays open for the lifetime of the page.

const WebSocket = require("ws")
const {
  ELEVEN_KEY, ELEVEN_MODEL, ELEVEN_OPTIMIZE, ELEVEN_FORMAT,
  VOICE_ID_RE, EL_MAX_TEXT, elevenVoiceIds, elTake, elCheckCap, elConsumeChars, elDailyStats
} = require("../lib/eleven-state")

const wss = new WebSocket.Server({ noServer: true })

// EL WebSocket URL for stream-input API.
function elWsUrl(voiceId) {
  return (
    `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input` +
    `?model_id=${encodeURIComponent(ELEVEN_MODEL)}` +
    `&output_format=${encodeURIComponent(ELEVEN_FORMAT)}` +
    `&optimize_streaming_latency=${encodeURIComponent(ELEVEN_OPTIMIZE)}`
  )
}

const EL_VOICE_SETTINGS = { stability: 0.45, similarity_boost: 0.7, style: 0.2, use_speaker_boost: true }
const EL_GEN_CONFIG = { chunk_length_schedule: [120, 160, 250, 290] }

// Per-session state for a connected browser WS.
function makeTurnState() {
  return {
    upstream: null,       // active EL WebSocket (null when idle)
    textBuffer: [],       // text chunks waiting for upstream to open
    totalChars: 0,        // chars accumulated this turn (for daily cap)
    flushPending: false,  // flush received before upstream opened
    voiceId: null         // resolved at flush time (allows mid-session voice change)
  }
}

function openUpstream(voiceId, turn, browser) {
  if (!ELEVEN_KEY) {
    safeClose(browser, 1011, "ELEVENLABS_API_KEY not configured")
    return null
  }

  const up = new WebSocket(elWsUrl(voiceId), {
    headers: { "xi-api-key": ELEVEN_KEY }
  })
  turn.upstream = up

  up.on("open", () => {
    // BOS — must be the first message.
    up.send(JSON.stringify({ text: " ", voice_settings: EL_VOICE_SETTINGS, generation_config: EL_GEN_CONFIG }))
    // Drain buffered text.
    for (const chunk of turn.textBuffer) {
      up.send(JSON.stringify({ text: chunk }))
    }
    turn.textBuffer = []
    if (turn.flushPending) {
      turn.flushPending = false
      up.send(JSON.stringify({ text: "" })) // EOS
    }
  })

  up.on("message", (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch (_) { return }

    if (msg.audio) {
      const buf = Buffer.from(msg.audio, "base64")
      if (browser.readyState === WebSocket.OPEN) {
        browser.send(buf, { binary: true })
      }
    }
    if (msg.isFinal) {
      // Consume chars now that the turn succeeded.
      elConsumeChars(turn.totalChars)
      // Signal browser that this turn's audio stream is complete.
      if (browser.readyState === WebSocket.OPEN) {
        browser.send(JSON.stringify({ type: "done" }))
      }
      safeClose(up)
      turn.upstream = null
      turn.totalChars = 0
    }
  })

  up.on("error", (err) => {
    console.error("[EL-WS] upstream error:", err.message)
    elDailyStats.upstreamErrorsToday++
    if (browser.readyState === WebSocket.OPEN) {
      browser.send(JSON.stringify({ type: "error", reason: "upstream error" }))
    }
    safeClose(up)
    turn.upstream = null
    turn.totalChars = 0
  })

  up.on("close", () => {
    if (turn.upstream === up) turn.upstream = null
  })

  return up
}

function safeClose(ws, code, reason) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(code || 1000, reason || "")
  } catch (_) {}
}

// Called by server.js from its "upgrade" event handler.
function handleUpgrade(req, socket, head, { ADMIN_API_KEY, AUTH_REQUIRED, timingSafeEqual }) {
  // Validate path: /tts-ws/:agentId
  const url = new URL(req.url, "http://localhost")
  const m = url.pathname.match(/^\/tts-ws\/(\d+)$/)
  if (!m) { socket.destroy(); return }

  const agentId = parseInt(m[1], 10)
  if (agentId !== 0 && agentId !== 1) { socket.destroy(); return }

  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket?.remoteAddress || "unknown"

  // Auth gate — browsers cannot send custom headers on WS upgrade, so key must
  // be in the query string.  We reject before completing the handshake where we
  // can, but we must complete it first and then close because the WS spec
  // doesn't expose a way to send an HTTP 401 mid-upgrade in all ws versions.
  wss.handleUpgrade(req, socket, head, (browser) => {
    if (AUTH_REQUIRED) {
      const key = url.searchParams.get("key") || ""
      if (!timingSafeEqual(key, ADMIN_API_KEY)) {
        browser.close(4001, "unauthorized")
        return
      }
    }

    if (!ELEVEN_KEY) {
      browser.close(1011, "ELEVENLABS_API_KEY not configured")
      return
    }

    // Per-IP rate limit (separate bucket sweep but same elBuckets map as HTTP).
    if (!elTake(ip)) {
      elDailyStats.rateLimitedToday++
      browser.close(4029, "rate limit exceeded")
      return
    }

    const turn = makeTurnState()
    console.log(`[EL-WS] agent ${agentId} connected from ${ip}`)

    browser.on("message", (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch (_) { return }

      if (msg.type === "text") {
        const text = (msg.text || "").toString()
        if (!text) return
        if (text.length > EL_MAX_TEXT) {
          browser.close(4413, `text chunk too long (max ${EL_MAX_TEXT} chars)`)
          return
        }
        // Pre-flight daily cap check (don't consume yet — turn may fail).
        if (!elCheckCap(turn.totalChars + text.length)) {
          browser.close(4503, "daily TTS cap reached")
          return
        }
        turn.totalChars += text.length
        if (!turn.upstream || turn.upstream.readyState === WebSocket.CLOSING || turn.upstream.readyState === WebSocket.CLOSED) {
          // Upstream will be opened on flush; buffer the text.
          turn.textBuffer.push(text)
        } else if (turn.upstream.readyState === WebSocket.CONNECTING) {
          turn.textBuffer.push(text)
        } else {
          turn.upstream.send(JSON.stringify({ text }))
        }
      } else if (msg.type === "flush") {
        // End of this turn's text — open (or signal) upstream to finalize.
        const voiceId = (elevenVoiceIds[agentId] || elevenVoiceIds[0]).toString()
        if (!VOICE_ID_RE.test(voiceId)) {
          browser.close(4400, "invalid voice id")
          return
        }
        if (!turn.upstream || turn.upstream.readyState === WebSocket.CLOSING || turn.upstream.readyState === WebSocket.CLOSED) {
          // Open a fresh upstream for this turn.
          openUpstream(voiceId, turn, browser)
          // If upstream opens after we set flushPending it will send EOS itself.
          if (!turn.upstream || turn.upstream.readyState === WebSocket.CONNECTING) {
            turn.flushPending = true
          } else {
            // Opened synchronously (won't happen with real WS but guard anyway).
            turn.upstream.send(JSON.stringify({ text: "" }))
          }
        } else if (turn.upstream.readyState === WebSocket.OPEN) {
          turn.upstream.send(JSON.stringify({ text: "" })) // EOS
        } else {
          turn.flushPending = true
        }
      } else if (msg.type === "end") {
        safeClose(turn.upstream)
        turn.upstream = null
        turn.textBuffer = []
        turn.totalChars = 0
      }
    })

    browser.on("close", () => {
      console.log(`[EL-WS] agent ${agentId} disconnected`)
      safeClose(turn.upstream)
      turn.upstream = null
    })

    browser.on("error", (err) => {
      console.error("[EL-WS] browser error:", err.message)
      safeClose(turn.upstream)
      turn.upstream = null
    })
  })
}

module.exports = { handleUpgrade }
