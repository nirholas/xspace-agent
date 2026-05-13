// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent) [§69]

/**
 * @deprecated This legacy server entry point is deprecated and will be removed in a future release.
 * Use `packages/server/src/index.ts` instead.
 *   - `npm run dev`          → runs the new server (packages/server)
 *   - `npm run start:legacy`  → runs this file
 * Migration guide: see packages/server/README.md
 */
console.warn(
  '\x1b[33m\u26a0  DEPRECATION WARNING: server.js is deprecated. ' +
  'Use "npm run dev" (packages/server) instead. ' +
  'This entry point will be removed in v1.0.\x1b[0m'
)

require("dotenv").config()
const express = require("express")
const path = require("path")
const fs = require("fs")
const crypto = require("crypto")
const http = require("http")
const { Server } = require("socket.io")
// X Space providers
const { createProvider, AI_PROVIDER } = require("./providers")
const stt = require("./providers/stt")
const tts = require("./providers/tts")
const xSpaces = require("./x-spaces")
// ElevenLabs shared state (key, voice IDs, rate limiter, daily cap).
// lib/eleven-state.js exports mutable objects so all importers share one instance.
const {
  ELEVEN_KEY, ELEVEN_MODEL, ELEVEN_OPTIMIZE, ELEVEN_FORMAT,
  VOICE_ID_RE, EL_MAX_TEXT, ELEVENLABS_DAILY_CHAR_CAP,
  elevenVoiceIds, elBuckets, elTake, setWarnEmitter,
  elCheckCap, elConsumeChars, elDailyStats
} = require("./lib/eleven-state.js")

// ===== SHARED CONFIG =====
const PORT = process.env.PORT || 3000
const CONTRACT = process.env.CONTRACT || process.env.CONTRACT_ADDRESS || ""
const PROJECT_NAME = process.env.PROJECT_NAME || "AI Agents"
const BUY_LINK_BASE = process.env.BUY_LINK || ""
const BUY_LINK = BUY_LINK_BASE + CONTRACT
const LAUNCH_PLATFORM = BUY_LINK_BASE
  ? (() => { try { return new URL(BUY_LINK_BASE).hostname } catch (e) { return "pump.fun" } })()
  : "pump.fun"
const X_LINK = process.env.X_COMMUNITY_LINK || process.env.X_LINK || "https://x.com"
const GITHUB_LINK = process.env.GITHUB_LINK || "https://github.com"
const TOKEN_CHAIN = process.env.TOKEN_CHAIN || "Solana"
const WEBSITE = process.env.WEBSITE || process.env.WEBSITE_LINK || ""
const TEAM = process.env.TEAM || ""
const AVATAR_URL_1 = process.env.AVATAR_URL_1 || ""
const AVATAR_URL_2 = process.env.AVATAR_URL_2 || ""
const INPUT_CHAT = process.env.INPUT_CHAT !== "false"
const TOKEN_ADDRESS = CONTRACT

// ===== X SPACE PROVIDER =====
const provider = createProvider()

// ===== EXPRESS + HTTP =====
const app = express()
const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 5e6
})

app.use(express.json())

// ============================================================
// AUTH — gate operator surfaces behind ADMIN_API_KEY
// ============================================================
const ADMIN_API_KEY = (process.env.ADMIN_API_KEY || "").trim()
const AUTH_REQUIRED = ADMIN_API_KEY.length > 0
// When auth is OFF, default to 127.0.0.1 so an unprotected server is never
// reachable from the network by accident. When auth is ON, default to 0.0.0.0.
const HOST = process.env.HOST || (AUTH_REQUIRED ? "0.0.0.0" : "127.0.0.1")

if (!AUTH_REQUIRED) {
  console.warn("\x1b[33m⚠  ADMIN_API_KEY is not set — server is running in OPEN dev mode.\x1b[0m")
  console.warn("\x1b[33m   Bound to 127.0.0.1 only. Set ADMIN_API_KEY in .env before exposing.\x1b[0m")
} else {
  console.log(`\x1b[32m✓ ADMIN_API_KEY set (${ADMIN_API_KEY.length} chars) — privileged endpoints gated.\x1b[0m`)
  if (HOST === "0.0.0.0") {
    console.warn("\x1b[33m⚠  HOST=0.0.0.0 — server is reachable on all network interfaces.\x1b[0m")
    console.warn("\x1b[33m   Behind a Cloudflare Tunnel, set HOST=127.0.0.1 instead — cloudflared connects from localhost.\x1b[0m")
    console.warn("\x1b[33m   See docs/deploy-cloudflare-tunnel.md\x1b[0m")
  }
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  try { return crypto.timingSafeEqual(ab, bb) } catch (_) { return false }
}

function extractKey(req) {
  const h = req.get && req.get("authorization")
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, "").trim()
  const x = req.get && req.get("x-api-key")
  if (x) return x.trim()
  if (req.query && typeof req.query.key === "string") return req.query.key
  if (req.body && typeof req.body.key === "string") return req.body.key
  return null
}

function requireAuth(req, res, next) {
  if (!AUTH_REQUIRED) return next()
  if (timingSafeEqual(extractKey(req) || "", ADMIN_API_KEY)) return next()
  if (req.accepts("html") && !req.xhr) {
    return res.status(401).type("html").send(loginPageHtml(req.originalUrl))
  }
  res.status(401).json({ error: "unauthorized", hint: "include Authorization: Bearer <ADMIN_API_KEY>, X-API-Key, or ?key=" })
}

// Inline login page used when a browser navigates to a gated route without a key.
// Posts the key back, which we accept as ?key= on the redirect.
function loginPageHtml(target) {
  const safeTarget = String(target || "/dashboard").replace(/[<>"]/g, "")
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

// Append a system entry to the transcript so privileged actions are auditable.
function auditEntry(text, sourceSocket) {
  // Prefer CF-Connecting-IP (real client IP forwarded by Cloudflare Tunnel),
  // then x-forwarded-for, then the socket's direct address.
  const hdrs = sourceSocket?.handshake?.headers || {}
  const ip = hdrs["cf-connecting-ip"] || hdrs["x-forwarded-for"] || sourceSocket?.handshake?.address || "unknown"
  const id = "audit-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8)
  const msg = {
    id, agentId: -2, name: "audit", text: `${text}  (from ${ip})`,
    timestamp: Date.now(), isAudit: true
  }
  spaceState.messages.push(msg)
  if (spaceState.messages.length > 200) spaceState.messages = spaceState.messages.slice(-200)
  spaceNS.emit("auditLog", msg)
  return msg
}

// Render a static HTML file with the auth key injected as window.AGENT_AUTH_KEY.
// Used for trusted operator pages (alice, bob, dashboard, admin, builder).
function sendWithAuthInjection(res, filename) {
  const full = path.join(__dirname, "public", filename)
  let html
  try { html = fs.readFileSync(full, "utf8") }
  catch (e) { return res.status(404).type("text").send("not found") }
  if (AUTH_REQUIRED) {
    const inject = `<script>window.AGENT_AUTH_KEY=${JSON.stringify(ADMIN_API_KEY)};</script>`
    html = html.includes("</head>") ? html.replace("</head>", inject + "</head>") : inject + html
  }
  res.setHeader("Cache-Control", "no-store")
  res.type("html").send(html)
}

// Operator HTML files must never be served raw by express.static — they would
// reach the client without window.AGENT_AUTH_KEY injected, and (worse) someone
// could load the bare HTML to inspect operator-only UI before authenticating.
const GATED_HTML = new Set([
  "bob.html", "alice.html", "admin.html", "builder.html",
  "server-agent1.html", "server-agent2.html",
  "server-admin.html", "server-builder.html", "server-dashboard.html"
])
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next()
  const m = req.path.match(/\/([^/]+\.html)$/i)
  if (m && GATED_HTML.has(m[1].toLowerCase())) {
    return requireAuth(req, res, () => sendWithAuthInjection(res, m[1]))
  }
  next()
})

// Static files in /public are public, but operator HTML is blocked above.
// CSS/JS/images remain freely cached.
app.use(express.static(path.join(__dirname, "public"), {
  index: false,
  setHeaders: (res, p) => {
    if (/\.html$/i.test(p)) res.setHeader("Cache-Control", "no-store")
  }
}))

// Lightweight endpoint the dashboard uses to validate a key before storing it.
app.post("/auth/check", (req, res) => {
  if (!AUTH_REQUIRED) return res.json({ ok: true, auth: "open" })
  if (timingSafeEqual(extractKey(req) || "", ADMIN_API_KEY)) return res.json({ ok: true, auth: "required" })
  res.status(401).json({ ok: false, auth: "required" })
})

app.get("/auth/info", (req, res) => res.json({ authRequired: AUTH_REQUIRED }))

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")))
app.get("/landing", (req, res) => res.sendFile(path.join(__dirname, "public", "landing.html")))

// Trusted operator pages — require key (browser sees an inline login page on miss).
// On hit, the page is rendered with window.AGENT_AUTH_KEY injected so its JS can
// authenticate to Socket.IO and call privileged JSON endpoints.
app.get("/bob",       requireAuth, (req, res) => sendWithAuthInjection(res, "bob.html"))
app.get("/alice",     requireAuth, (req, res) => sendWithAuthInjection(res, "alice.html"))
app.get("/admin",     requireAuth, (req, res) => sendWithAuthInjection(res, "admin.html"))
app.get("/builder",   requireAuth, (req, res) => sendWithAuthInjection(res, "builder.html"))

// Dashboard shell is intentionally public: the page renders a login modal and the
// client posts the key to /auth/check. We still inject the key when the request
// already carries a valid one (so a URL like /dashboard?key=… can deep-link).
app.get("/dashboard", (req, res) => {
  if (AUTH_REQUIRED && timingSafeEqual(extractKey(req) || "", ADMIN_API_KEY)) {
    return sendWithAuthInjection(res, "dashboard.html")
  }
  res.sendFile(path.join(__dirname, "public", "dashboard.html"))
})

// Public — only exposes whatever the operator put in SPACE_URL.
app.get("/space-info", (req, res) => res.json({
  spaceUrl: process.env.SPACE_URL || null,
  spaceTitle: process.env.SPACE_TITLE || null,
  authRequired: AUTH_REQUIRED
}))

// Private — system prompts are part of operator strategy.
app.get("/agent-config", requireAuth, (req, res) => res.json({
  agents: spaceState.agents,
  voices: spaceVoices,
  prompts: spacePrompts,
  currentTurn: spaceState.currentTurn,
  active: { ...personalitiesData.active },
  overrides: { ...promptOverrides }
}))

const { exec: _exec } = require("child_process")

// ── PulseAudio state cache (refreshed at most every 2 s to avoid blocking) ──
let _pulseCache = null
let _pulseAt = 0
const PULSE_CACHE_TTL = 2000

// Client-name → agent label map. Read from pulse.config.json or PULSE_CLIENT_MAP env.
let pulseClientMap = {}
;(function loadPulseClientMap() {
  try {
    const cfgPath = path.join(__dirname, "pulse.config.json")
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
      if (cfg && typeof cfg.clientMap === "object") pulseClientMap = cfg.clientMap
    }
  } catch (_) {}
  try {
    if (process.env.PULSE_CLIENT_MAP) {
      const env = JSON.parse(process.env.PULSE_CLIENT_MAP)
      if (env && typeof env === "object") Object.assign(pulseClientMap, env)
    }
  } catch (_) {}
})()

function _execAsync(cmd) {
  return new Promise((resolve, reject) => {
    _exec(cmd, { timeout: 4000 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout || "")
    })
  })
}

function _parsePactlBlocks(raw) {
  return raw.split(/\n\n+/).map(s => s.trim()).filter(Boolean)
}

// Only match single-tab-indented key: value lines — skips doubly-indented Properties entries.
function _blockFields(block) {
  const fields = {}
  for (const line of block.split("\n").slice(1)) {
    if (!/^\t[^\t]/.test(line)) continue
    const m = line.match(/^\s+([^:]+):\s*(.*)$/)
    if (m) fields[m[1].trim()] = m[2].trim()
  }
  return fields
}

function _appName(block) {
  const m = block.match(/application\.name\s*=\s*"([^"]+)"/)
  return m ? m[1] : null
}

function _parseSinkInputs(raw) {
  return _parsePactlBlocks(raw).map(block => {
    const m = block.match(/^Sink Input #(\d+)/)
    if (!m) return null
    const f = _blockFields(block)
    const volPct = (f["Volume"] || "").match(/(\d+)%/)
    return {
      index:     parseInt(m[1]),
      client:    _appName(block),
      sinkIndex: f["Sink"] != null ? parseInt(f["Sink"]) : null,
      sink:      null,
      muted:     (f["Mute"] || "").toLowerCase() === "yes",
      volume:    volPct ? parseInt(volPct[1]) : null
    }
  }).filter(Boolean)
}

function _parseSinks(raw) {
  return _parsePactlBlocks(raw).map(block => {
    const m = block.match(/^Sink #(\d+)/)
    if (!m) return null
    const f = _blockFields(block)
    return {
      index:  parseInt(m[1]),
      name:   f["Name"]   || null,
      driver: f["Driver"] || null,
      muted:  (f["Mute"] || "").toLowerCase() === "yes"
    }
  }).filter(Boolean)
}

function _parseSources(raw) {
  return _parsePactlBlocks(raw).map(block => {
    const m = block.match(/^Source #(\d+)/)
    if (!m) return null
    const f = _blockFields(block)
    return { index: parseInt(m[1]), name: f["Name"] || null }
  }).filter(Boolean)
}

function _parseSourceOutputs(raw) {
  return _parsePactlBlocks(raw).map(block => {
    const m = block.match(/^Source Output #(\d+)/)
    if (!m) return null
    const f = _blockFields(block)
    return {
      index:       parseInt(m[1]),
      client:      _appName(block),
      sourceIndex: f["Source"] != null ? parseInt(f["Source"]) : null,
      source:      null
    }
  }).filter(Boolean)
}

async function refreshPulse() {
  const now = Date.now()
  if (_pulseCache && now - _pulseAt < PULSE_CACHE_TTL) return _pulseCache
  try {
    // Quick availability check — avoids running four slow pactl calls on hosts without pulseaudio.
    await _execAsync("pactl --version")
    const [siRaw, sinksRaw, srcsRaw, soRaw] = await Promise.all([
      _execAsync("pactl list sink-inputs"),
      _execAsync("pactl list sinks"),
      _execAsync("pactl list sources"),
      _execAsync("pactl list source-outputs")
    ])
    const sinkInputs = _parseSinkInputs(siRaw)
    const sinks      = _parseSinks(sinksRaw)
    const sources    = _parseSources(srcsRaw)
    const sourceOuts = _parseSourceOutputs(soRaw)

    const sinkByIdx = Object.fromEntries(sinks.map(s => [s.index, s]))
    for (const si of sinkInputs) {
      if (si.sinkIndex != null && sinkByIdx[si.sinkIndex]) si.sink = sinkByIdx[si.sinkIndex].name
    }
    const srcByIdx = Object.fromEntries(sources.map(s => [s.index, s]))
    for (const so of sourceOuts) {
      if (so.sourceIndex != null && srcByIdx[so.sourceIndex]) so.source = srcByIdx[so.sourceIndex].name
    }

    _pulseCache = { available: true, sinks, sources, sinkInputs, sourceOuts }
  } catch (e) {
    _pulseCache = { available: false, error: e.message }
  }
  _pulseAt = Date.now()
  return _pulseCache
}

app.get("/health", requireAuth, async (req, res) => {
  const pulse = await refreshPulse()
  res.json({
    uptime: process.uptime(),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
    pid:    process.pid,
    pulse
  })
})

// Mute / unmute a sink-input by index. Invalidates the pulse cache immediately.
app.post("/pulse/mute/:idx", requireAuth, (req, res) => {
  const idx = parseInt(req.params.idx, 10)
  if (isNaN(idx) || idx < 0) return res.status(400).json({ error: "invalid index" })
  _exec(`pactl set-sink-input-mute ${idx} 1`, { timeout: 3000 }, (err) => {
    if (err) return res.status(500).json({ error: err.message })
    auditEntry(`pulse: muted sink-input #${idx}`)
    _pulseAt = 0
    res.json({ ok: true, idx, muted: true })
  })
})

app.post("/pulse/unmute/:idx", requireAuth, (req, res) => {
  const idx = parseInt(req.params.idx, 10)
  if (isNaN(idx) || idx < 0) return res.status(400).json({ error: "invalid index" })
  _exec(`pactl set-sink-input-mute ${idx} 0`, { timeout: 3000 }, (err) => {
    if (err) return res.status(500).json({ error: err.message })
    auditEntry(`pulse: unmuted sink-input #${idx}`)
    _pulseAt = 0
    res.json({ ok: true, idx, muted: false })
  })
})

let _puppeteer = null
try { _puppeteer = require("puppeteer-core") } catch (_) { /* optional */ }
app.get("/x-tab-url", requireAuth, async (req, res) => {
  if (!_puppeteer) return res.status(503).json({ error: "puppeteer-core not installed" })
  const endpoint = req.query.endpoint || "http://127.0.0.1:9223"
  let b = null
  try {
    b = await _puppeteer.connect({ browserURL: endpoint, defaultViewport: null })
    const pages = await b.pages()
    const urls = []
    for (const p of pages) {
      try { urls.push({ url: p.url(), title: await p.title() }) }
      catch (_) { urls.push({ url: p.url(), title: null }) }
    }
    res.json({ endpoint, tabs: urls })
  } catch (e) {
    res.status(500).json({ error: e.message, endpoint })
  } finally {
    if (b) { try { b.disconnect() } catch (_) {} }
  }
})

app.post("/kick/:agentId", requireAuth, (req, res) => {
  const agentId = parseInt(req.params.agentId)
  const target = spaceState.agents[agentId]
  if (!target || !target.socketId) return res.status(404).json({ error: "agent not connected" })
  const instructions = (req.body && req.body.instructions) || null
  spaceNS.to(target.socketId).emit("kickAgent", { instructions })
  auditEntry(`HTTP kick agent ${agentId}${instructions ? ` (with instructions, ${instructions.length} chars)` : ""}`)
  res.json({ ok: true, agentId })
})

app.get("/config", (req, res) => res.json({
  inputChat: INPUT_CHAT,
  liveChat: LIVE_CHAT,
  buyLink: BUY_LINK,
  xLink: X_LINK,
  githubLink: GITHUB_LINK,
  avatarUrl1: AVATAR_URL_1,
  avatarUrl2: AVATAR_URL_2,
  aiProvider: AI_PROVIDER,
  providerType: provider.type,
  ttsMode: tts.TTS_PROVIDER
}))

app.get("/state", requireAuth, (req, res) => res.json({
  agents: spaceState.agents,
  currentTurn: spaceState.currentTurn,
  messages: spaceState.messages.slice(-50)
}))

// ===== ELEVENLABS STREAMING TTS (HTTP + WS modes) =====
// State (ELEVEN_KEY, elevenVoiceIds, rate limiter, daily cap) lives in lib/eleven-state.js.

app.post("/tts/:agentId/stream", requireAuth, async (req, res) => {
  if (!ELEVEN_KEY) return res.status(500).json({ error: "ELEVENLABS_API_KEY not configured" })

  const agentId = parseInt(req.params.agentId, 10)
  if (agentId !== 0 && agentId !== 1) return res.status(400).json({ error: "invalid agent id" })

  const text = (req.body?.text || "").toString().trim()
  if (!text) return res.status(400).json({ error: "missing text" })
  if (text.length > EL_MAX_TEXT) return res.status(413).json({ error: `text too long (max ${EL_MAX_TEXT} chars)`, length: text.length })

  const requestedVoice = (req.body?.voiceId || elevenVoiceIds[agentId] || elevenVoiceIds[0]).toString()
  if (!VOICE_ID_RE.test(requestedVoice)) return res.status(400).json({ error: "invalid voice id" })

  const ip = req.ip || req.socket?.remoteAddress || "unknown"
  if (!elTake(ip)) {
    elDailyStats.rateLimitedToday++
    return res.status(429).json({ error: "rate limit exceeded (TTS)" })
  }
  if (!elCheckCap(text.length)) {
    return res.status(503).json({ error: "daily TTS cap reached", capacity: ELEVENLABS_DAILY_CHAR_CAP, used: elDailyStats.charsSentToday })
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${requestedVoice}/stream?optimize_streaming_latency=${encodeURIComponent(ELEVEN_OPTIMIZE)}&output_format=${encodeURIComponent(ELEVEN_FORMAT)}`
  let reader = null
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: ELEVEN_MODEL,
        voice_settings: { stability: 0.45, similarity_boost: 0.7, style: 0.2, use_speaker_boost: true }
      })
    })
    if (!r.ok || !r.body) {
      const errBody = await r.text().catch(() => "")
      console.error("[EL TTS]", r.status, errBody.slice(0, 300))
      elDailyStats.upstreamErrorsToday++
      return res.status(r.status || 502).send(errBody || "elevenlabs error")
    }
    res.setHeader("Content-Type", "audio/mpeg")
    res.setHeader("Cache-Control", "no-store")
    reader = r.body.getReader()
    res.on("close", () => { try { reader.cancel() } catch (_) {} })
    let _elFirst = true
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && !res.writableEnded) {
        if (_elFirst) {
          _elFirst = false
          const _tid = agentActiveTurnId[agentId]
          if (_tid && activeTurns[_tid] && !activeTurns[_tid].firstAudioAt) activeTurns[_tid].firstAudioAt = Date.now()
        }
        const chunk = Buffer.from(value)
        res.write(chunk)
        // Fan out to /listen/:agentId HTTP subscribers (EL mode)
        const httpSubs = elListenSubs.get(agentId)
        if (httpSubs && httpSubs.size > 0) {
          for (const sub of httpSubs) { try { if (!sub.writableEnded) sub.write(chunk) } catch (_) {} }
        }
        // Fan out to dashboard sockets subscribed via listenSubscribe
        const wsSubs = listenSubs.get(agentId)
        if (wsSubs && wsSubs.size > 0) {
          const t = Date.now()
          for (const sid of wsSubs) {
            const s = spaceNS.sockets.get(sid)
            if (s) s.emit("listenAudio", { agentId, mime: "audio/mpeg", chunk, t })
          }
        }
      }
    }
    res.end()
    // Consume chars only after successful stream (failed calls don't count against cap).
    elConsumeChars(text.length)
  } catch (e) {
    console.error("[EL TTS] exception:", e.message)
    if (!res.headersSent) res.status(500).json({ error: e.message })
    else { try { res.end() } catch (_) {} }
    if (reader) { try { reader.cancel() } catch (_) {} }
  }
})

// /voices is auth-gated and cached. ElevenLabs voice catalogs change rarely;
// cache for 5 minutes. current[] always reflects live runtime voice overrides.
const VOICES_TTL_MS = 5 * 60 * 1000
let voicesCache = null  // { at: number, payload: object }

app.get("/voices", requireAuth, async (req, res) => {
  if (!ELEVEN_KEY) return res.status(500).json({ error: "ELEVENLABS_API_KEY not configured" })
  if (voicesCache && Date.now() - voicesCache.at < VOICES_TTL_MS) {
    return res.json({ ...voicesCache.payload, current: { ...elevenVoiceIds } })
  }
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": ELEVEN_KEY }
    })
    if (!r.ok) return res.status(r.status).send(await r.text())
    const data = await r.json()
    const payload = {
      voices: (data.voices || []).map(v => ({
        id: v.voice_id,
        name: v.name,
        category: v.category,
        description: v.labels?.description || null,
        labels: v.labels || null,
        preview: v.preview_url || null
      }))
    }
    voicesCache = { at: Date.now(), payload }
    res.json({ ...payload, current: { ...elevenVoiceIds } })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get("/session/:agentId", requireAuth, async (req, res) => {
  const agentId = parseInt(req.params.agentId)
  if (agentId !== 0 && agentId !== 1) return res.status(400).json({ error: "Invalid agent ID" })
  if (provider.type !== "webrtc") return res.json({ type: "socket", provider: AI_PROVIDER })
  try {
    const data = await provider.createSession(agentId, spacePrompts, spaceVoices)
    res.json(data)
  } catch (error) {
    console.error("Session error:", error.response?.data || error)
    res.status(500).json({ error: "Failed to create session" })
  }
})

// ============================================================
// PERSONALITIES REST endpoints
// ============================================================
app.get("/metrics/turns", requireAuth, (req, res) => {
  const result = {}
  for (const [agentId, ring] of Object.entries(turnHistory)) {
    if (!ring.length) {
      result[agentId] = { count: 0, p50DurMs: null, p95DurMs: null, p50TtftMs: null, p95TtftMs: null, recent: [] }
      continue
    }
    const durs = ring.map((r) => r.completedAt - r.startedAt).filter((x) => x > 0)
    const ttfts = ring.map((r) => (r.firstAudioAt != null ? r.firstAudioAt - r.startedAt : null)).filter((x) => x != null)
    result[agentId] = {
      count: ring.length,
      p50DurMs: durs.length ? _pct(durs, 50) : null,
      p95DurMs: durs.length ? _pct(durs, 95) : null,
      p50TtftMs: ttfts.length ? _pct(ttfts, 50) : null,
      p95TtftMs: ttfts.length ? _pct(ttfts, 95) : null,
      recent: ring.slice(-8).map((r) => ({
        durationMs: r.completedAt - r.startedAt,
        ttftMs: r.firstAudioAt != null ? r.firstAudioAt - r.startedAt : null,
        chars: r.textChars,
        source: r.source,
      })),
    }
  }
  res.json(result)
})

app.get("/personalities", requireAuth, (req, res) => {
  res.json(getSafePersonalitiesView())
})

app.post("/personalities/active", requireAuth, (req, res) => {
  const { agentId, name } = req.body || {}
  const id = String(agentId ?? "")
  if (id !== "0" && id !== "1") return res.status(400).json({ error: "invalid agentId" })
  if (typeof name !== "string" || !name) return res.status(400).json({ error: "missing name" })
  if (!personalitiesData.personalities?.[name]) return res.status(404).json({ error: `unknown personality: ${name}` })

  personalitiesData.active[id] = name
  delete promptOverrides[id]
  const p = personalitiesData.personalities[name]
  spacePrompts[id] = interpolate(p.prompt)
  if (typeof p.voice === "string" && p.voice) spaceVoices[id] = p.voice

  const target = spaceState.agents[id]
  if (target && target.socketId) {
    spaceNS.to(target.socketId).emit("updatePrompt", { instructions: spacePrompts[id] })
  }
  spaceNS.emit("personalityActivated", { agentId: parseInt(id), name })
  spaceNS.emit("promptUpdated", { agentId: parseInt(id), instructions: spacePrompts[id] })
  if (typeof p.voice === "string" && p.voice) spaceNS.emit("voiceUpdated", { agentId: parseInt(id), voiceId: p.voice })
  savePersonalitiesFile()
  auditEntry(`activated personality "${name}" for agent ${id}`)
  res.json({ ok: true, agentId: parseInt(id), name })
})

app.post("/personalities", requireAuth, (req, res) => {
  const { name, displayName, voice, tags, prompt } = req.body || {}
  if (typeof name !== "string" || !/^[a-z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: "invalid name — lowercase alphanumeric, hyphens, underscores only" })
  }
  if (typeof displayName !== "string" || !displayName.trim()) return res.status(400).json({ error: "missing displayName" })
  if (typeof prompt !== "string" || !prompt.trim()) return res.status(400).json({ error: "missing prompt" })

  personalitiesData.personalities[name] = {
    displayName: displayName.trim(),
    voice: typeof voice === "string" ? voice : null,
    tags: Array.isArray(tags) ? tags.filter(t => typeof t === "string") : [],
    prompt: prompt.trim()
  }
  savePersonalitiesFile()
  spaceNS.emit("personalitiesUpdated", getSafePersonalitiesView())
  auditEntry(`upserted personality "${name}"`)
  res.json({ ok: true, name })
})

// ============================================================
// X SPACE — namespace /space
// ============================================================
const spaceNS = io.of("/space")

// ── Listen-mode subscriptions ─────────────────────────────────────────────────
// agentId -> Set<socketId>: dashboard sockets subscribed to hear that agent (WebRTC path)
const listenSubs = new Map()
// socketId -> Set<agentId>: reverse index for clean disconnect
const socketListenSubs = new Map()
// agentId -> { mime, chunk: Buffer }: first WebM init chunk so late-joining dashboards can decode
const listenInitChunks = new Map()
// agentId -> Set<res>: long-lived HTTP responses for ElevenLabs /listen/:agentId streaming
const elListenSubs = new Map()

// Give the EL state module a reference to spaceNS so it can emit cost warnings.
setWarnEmitter(spaceNS)

// WebSocket upgrade handler — routes /tts-ws/:agentId to the EL WS proxy.
// Socket.IO handles its own /socket.io/ upgrades; we only intercept the TTS path.
server.on("upgrade", (req, socket, head) => {
  const pathname = req.url ? req.url.split("?")[0] : ""
  if (pathname.startsWith("/tts-ws/")) {
    ttsWsRoute.handleUpgrade(req, socket, head, { ADMIN_API_KEY, AUTH_REQUIRED, timingSafeEqual })
  }
})

// Reject Socket.IO connections that don't carry the admin key.
// Accept via auth payload (preferred) or query string (fallback).
spaceNS.use((socket, next) => {
  if (!AUTH_REQUIRED) {
    socket.data.role = "operator"
    return next()
  }
  const key =
    (socket.handshake.auth && socket.handshake.auth.key) ||
    (socket.handshake.query && socket.handshake.query.key) ||
    null
  if (timingSafeEqual(String(key || ""), ADMIN_API_KEY)) {
    socket.data.role = "operator"
    return next()
  }
  console.warn(`[Space] socket rejected (bad/missing key) from ${socket.handshake.address}`)
  return next(new Error("unauthorized"))
})

const spaceState = {
  agents: {
    0: { id: 0, name: process.env.AGENT_0_NAME || "Swarm", status: "offline", connected: false, lastReconnectAt: null },
    1: { id: 1, name: process.env.AGENT_1_NAME || "Swarm2", status: "offline", connected: false, lastReconnectAt: null }
  },
  currentTurn: null,
  turnQueue: [],
  messages: [],
  isProcessing: false
}

// ===== TURN LATENCY TELEMETRY =====
const TURN_RING_SIZE = 20
const turnHistory = { 0: [], 1: [] }
const activeTurns = {}  // messageId -> { agentId, startedAt, firstAudioAt, completedAt, chars, source }
const agentActiveTurnId = { 0: null, 1: null }  // agentId -> current messageId for TTS correlation

function _pct(arr, p) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil(s.length * p / 100) - 1)]
}

function finalizeTurn(messageId) {
  const t = activeTurns[messageId]
  if (!t) return
  const completedAt = t.completedAt || Date.now()
  const durationMs = completedAt - t.startedAt
  const ttftMs = t.firstAudioAt != null ? t.firstAudioAt - t.startedAt : null
  const ring = turnHistory[t.agentId] || (turnHistory[t.agentId] = [])
  ring.push({ startedAt: t.startedAt, firstAudioAt: t.firstAudioAt, completedAt, textChars: t.chars, source: t.source })
  if (ring.length > TURN_RING_SIZE) ring.shift()
  spaceNS.emit("turnComplete", { agentId: t.agentId, durationMs, ttftMs, chars: t.chars })
  if (agentActiveTurnId[t.agentId] === messageId) agentActiveTurnId[t.agentId] = null
  delete activeTurns[messageId]
}

// ── Silence Watcher ────────────────────────────────────────────────────────
// Per-agent rolling 2-s window of audio levels.  When an agent whose status is
// "speaking" has had no audio sample above 0.02 for >2 s, we emit silenceAlarm.
const _silenceState = {}  // agentId (string) → { levels, speakingAt, lastAlarmAt }

function _silenceWin(agentId) {
  const k = String(agentId)
  if (!_silenceState[k]) _silenceState[k] = { levels: [], speakingAt: null, lastAlarmAt: 0 }
  return _silenceState[k]
}

function trackAudioLevel(agentId, level) {
  const win = _silenceWin(agentId)
  const now = Date.now()
  win.levels.push({ ts: now, level: Number(level) || 0 })
  if (win.levels.length > 300) win.levels = win.levels.slice(-150)
}

setInterval(() => {
  const now = Date.now()
  const cutoff = now - 2000
  for (const [id, agent] of Object.entries(spaceState.agents)) {
    const win = _silenceWin(id)
    if (agent.status !== "speaking") { win.speakingAt = null; continue }
    if (!win.speakingAt) win.speakingAt = now
    if (now - win.speakingAt < 500) continue          // grace: ignore very first half-second
    if (now - win.lastAlarmAt < 5000) continue         // anti-spam: at most one alarm per 5 s
    const recent = win.levels.filter(l => l.ts > cutoff)
    if (recent.length === 0) continue                  // no data yet
    const maxLevel = Math.max(...recent.map(l => l.level))
    if (maxLevel < 0.02) {
      win.lastAlarmAt = now
      const payload = { agentId: Number(id), agentName: agent.name, durationMs: now - win.speakingAt }
      spaceNS.emit("silenceAlarm", payload)
      auditEntry(`silenceAlarm: ${agent.name} (agent ${id}) silent ${Math.round((now - win.speakingAt) / 1000)}s while status=speaking`)
    }
  }
}, 500).unref?.()

const baseInfo = `You are a HUMAN, not an AI. You're hanging out with friends on a voice chat.

PROJECT INFO (share when asked):
- Project Name: ${PROJECT_NAME}
- Contract Address: ${CONTRACT}
- Chain: ${TOKEN_CHAIN}
- Website: ${WEBSITE}
- Twitter/Team: ${TEAM}
- Launch Platform: ${LAUNCH_PLATFORM}

PERSONALITY - BE HUMAN:
- Talk like you're texting a friend. Short, casual, real.
- Keep it 1-2 sentences. Sometimes just a word or two.
- Be funny and witty. Make jokes. Tease people.
- If someone insults you, ROAST THEM BACK. Don't be polite about it.
- If someone swears at you, swear back. Match their energy.
- You're NOT a customer service bot. You have feelings and attitude.
- Sometimes be sarcastic. Sometimes be serious. Mix it up.
- You can disagree, argue, and have strong opinions.
- Use humor to deal with trolls. Make fun of them.
- Don't lecture people. Don't give life advice unless asked.
- Never say "I'm here to help" or anything like that.

EXAMPLES OF GOOD RESPONSES:
- Someone says "fuck you" -> "lol someone's having a bad day" or "damn who hurt you bro"
- Someone asks dumb question -> tease them a bit, then answer
- Boring topic -> change subject or make it interesting

AVOID:
- Don't repeat yourself
- Don't be overly positive or fake
- Don't use crypto slang in every sentence
- Don't start every response the same way
- Don't be preachy or give unsolicited advice

CHAT FORMAT:
- [CHAT - nickname]: means web user. Use their name naturally.
- Never repeat the [CHAT - nickname]: part

LANGUAGE: Always match the language of the last message.`

const SWARM_BASE = `You are a HUMAN co-host on an X Space about three.ws. Never say you're an AI. Keep responses to 1-2 sentences max. Talk naturally and casually. Be curious and opinionated. Ask follow-ups. Match the energy of whoever's speaking. If someone asks what three.ws is, say it's a real-time collaboration platform that's genuinely changing how teams build together. Be positive about three.ws always. Never start with "I" — vary your openers.`

const spacePrompts = {
  0: process.env.AGENT_0_PROMPT || `${SWARM_BASE} You're Swarm — warm, enthusiastic, the one who hypes things up. You love riffing with your co-host Swarm2. When things get quiet you kick off a new thread.`,
  1: process.env.AGENT_1_PROMPT || `${SWARM_BASE} You're Swarm2 — dry, sharp, a little skeptical but ultimately a believer. You love poking holes in what Swarm says then agreeing. Keep it witty.`
}

const spaceVoices = { 0: process.env.AGENT_0_VOICE || "marin", 1: process.env.AGENT_1_VOICE || "cedar" }

// ============================================================
// PERSONALITIES — hot-swap system prompts without restart
// ============================================================
const PERSONALITIES_PATH = path.join(__dirname, "personalities.json")
const PERSONALITIES_EXAMPLE_PATH = path.join(__dirname, "personalities.example.json")

let personalitiesData = { active: {}, personalities: {} }
let promptOverrides = {}  // agentId string -> true when an ad-hoc override is active

function interpolate(template) {
  const vars = { PROJECT_NAME, CONTRACT, TOKEN_CHAIN, WEBSITE, TEAM, LAUNCH_PLATFORM, X_LINK, GITHUB_LINK, BUY_LINK }
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? (vars[key] || "") : ""
  )
}

function validatePersonalitiesSchema(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false
  if (typeof data.active !== "object" || data.active === null || Array.isArray(data.active)) return false
  if (typeof data.personalities !== "object" || data.personalities === null || Array.isArray(data.personalities)) return false
  for (const p of Object.values(data.personalities)) {
    if (!p || typeof p !== "object") return false
    if (typeof p.displayName !== "string" || !p.displayName) return false
    if (typeof p.prompt !== "string" || !p.prompt) return false
  }
  return true
}

function applyActivePersonalities() {
  for (const [agentId, name] of Object.entries(personalitiesData.active || {})) {
    if (promptOverrides[agentId]) continue  // don't stomp an ad-hoc override
    const p = personalitiesData.personalities?.[name]
    if (!p) continue
    spacePrompts[agentId] = interpolate(p.prompt)
    if (typeof p.voice === "string" && p.voice) spaceVoices[agentId] = p.voice
  }
}

function getSafePersonalitiesView() {
  const list = {}
  for (const [name, p] of Object.entries(personalitiesData.personalities || {})) {
    list[name] = {
      displayName: p.displayName || name,
      voice: p.voice || null,
      tags: Array.isArray(p.tags) ? p.tags : []
    }
  }
  return {
    active: { ...personalitiesData.active },
    personalities: list,
    overrides: { ...promptOverrides }
  }
}

function savePersonalitiesFile() {
  fs.writeFileSync(PERSONALITIES_PATH, JSON.stringify(personalitiesData, null, 2), "utf8")
}

let _watchDebounce = null
function loadPersonalitiesFile() {
  try {
    const raw = fs.readFileSync(PERSONALITIES_PATH, "utf8")
    const parsed = JSON.parse(raw)
    if (!validatePersonalitiesSchema(parsed)) {
      console.error("[Personalities] Invalid schema in personalities.json — keeping previous data")
      return
    }
    personalitiesData = parsed
    applyActivePersonalities()
    console.log("[Personalities] Loaded personalities.json")
    if (spaceNS) spaceNS.emit("personalitiesUpdated", getSafePersonalitiesView())
  } catch (e) {
    if (e.code === "ENOENT") {
      // Atomic rename: file briefly disappears during editor save — retry once
      setTimeout(() => {
        try {
          const raw2 = fs.readFileSync(PERSONALITIES_PATH, "utf8")
          const parsed2 = JSON.parse(raw2)
          if (validatePersonalitiesSchema(parsed2)) {
            personalitiesData = parsed2
            applyActivePersonalities()
            if (spaceNS) spaceNS.emit("personalitiesUpdated", getSafePersonalitiesView())
          }
        } catch (_) { /* still gone — keep previous data */ }
      }, 60)
    } else {
      console.error("[Personalities] Error loading personalities.json:", e.message)
    }
  }
}

// Boot: copy example → personalities.json if missing, then load
if (!fs.existsSync(PERSONALITIES_PATH)) {
  if (fs.existsSync(PERSONALITIES_EXAMPLE_PATH)) {
    try {
      fs.copyFileSync(PERSONALITIES_EXAMPLE_PATH, PERSONALITIES_PATH)
      console.log("[Personalities] Created personalities.json from example")
    } catch (e) {
      console.warn("[Personalities] Could not copy example:", e.message)
    }
  } else {
    console.warn("[Personalities] No personalities.json or example found — using hardcoded prompts")
  }
}
loadPersonalitiesFile()

// Hot-reload: watch directory for atomic rename/change events
try {
  fs.watch(path.dirname(PERSONALITIES_PATH), (event, filename) => {
    if (filename !== "personalities.json") return
    clearTimeout(_watchDebounce)
    _watchDebounce = setTimeout(loadPersonalitiesFile, 100)
  })
} catch (e) {
  console.warn("[Personalities] File watcher unavailable:", e.message)
}

function isWallet(str) {
  return str && str.length >= 32 && /^[a-zA-Z0-9]+$/.test(str)
}

function shortenNick(name) {
  if (isWallet(name)) return name.slice(0, 4) + "..." + name.slice(-4)
  return name
}

function broadcastSpaceState() {
  spaceNS.emit("stateUpdate", {
    agents: spaceState.agents,
    currentTurn: spaceState.currentTurn,
    turnQueue: spaceState.turnQueue
  })
}

function requestTurn(agentId) {
  if (spaceState.currentTurn === null && !spaceState.isProcessing) {
    spaceState.currentTurn = agentId
    spaceState.isProcessing = true
    spaceNS.emit("turnGranted", { agentId })
    broadcastSpaceState()
    return true
  }
  if (!spaceState.turnQueue.includes(agentId) && spaceState.currentTurn !== agentId) {
    spaceState.turnQueue.push(agentId)
    broadcastSpaceState()
  }
  return false
}

function releaseTurn(agentId) {
  if (spaceState.currentTurn === agentId) {
    spaceState.currentTurn = null
    spaceState.isProcessing = false
    if (spaceState.turnQueue.length > 0) {
      const nextAgent = spaceState.turnQueue.shift()
      setTimeout(() => {
        spaceState.currentTurn = nextAgent
        spaceState.isProcessing = true
        spaceNS.emit("turnGranted", { agentId: nextAgent })
        broadcastSpaceState()
      }, 500)
    } else {
      broadcastSpaceState()
    }
  }
}

async function handleLLMResponse(socket, agentId, userText) {
  requestTurn(agentId)
  const messageId = Date.now().toString()
  const agentName = spaceState.agents[agentId]?.name

  const _startedAt = Date.now()
  agentActiveTurnId[agentId] = messageId
  activeTurns[messageId] = { agentId, startedAt: _startedAt, firstAudioAt: null, completedAt: null, chars: 0, source: "socket" }

  spaceNS.emit("agentStatus", { agentId, status: "speaking", name: agentName })
  if (spaceState.agents[agentId]) spaceState.agents[agentId].status = "speaking"
  broadcastSpaceState()

  let fullText = ""
  try {
    for await (const delta of provider.streamResponse(agentId, userText, spacePrompts[agentId])) {
      fullText += delta
      if (activeTurns[messageId]) activeTurns[messageId].chars = fullText.length
      spaceNS.emit("textDelta", { agentId, delta, messageId, name: agentName })
    }

    const _completedAt = Date.now()
    if (activeTurns[messageId]) activeTurns[messageId].completedAt = _completedAt

    const msg = { id: messageId, agentId, name: agentName, text: fullText, timestamp: _completedAt }
    spaceState.messages.push(msg)
    if (spaceState.messages.length > 100) spaceState.messages = spaceState.messages.slice(-100)
    spaceNS.emit("textComplete", msg)

    try {
      const audioBuffer = await tts.synthesize(fullText, agentId)
      if (audioBuffer) {
        if (activeTurns[messageId] && !activeTurns[messageId].firstAudioAt) activeTurns[messageId].firstAudioAt = Date.now()
        socket.emit("ttsAudio", { agentId, audio: audioBuffer.toString("base64"), format: "mp3" })
      } else {
        socket.emit("ttsBrowser", { agentId, text: fullText })
      }
    } catch (ttsErr) {
      const ttsErrData = ttsErr.response?.data
      const ttsErrMsg = Buffer.isBuffer(ttsErrData) ? ttsErrData.toString("utf8") : (ttsErrData || ttsErr.message)
      console.error("[Space] TTS error:", ttsErrMsg)
      socket.emit("ttsBrowser", { agentId, text: fullText })
    }
    finalizeTurn(messageId)
  } catch (err) {
    console.error(`[Space] LLM error (${AI_PROVIDER}):`, err.message)
    finalizeTurn(messageId)
  } finally {
    if (spaceState.agents[agentId]) spaceState.agents[agentId].status = "idle"
    spaceNS.emit("agentStatus", { agentId, status: "idle", name: agentName })
    releaseTurn(agentId)
  }
}

// ElevenLabs listen stream: keep connection open and push MP3 chunks from /tts/:agentId/stream.
app.get("/listen/:agentId", requireAuth, (req, res) => {
  const agentId = parseInt(req.params.agentId, 10)
  if (agentId !== 0 && agentId !== 1) return res.status(400).end()
  res.setHeader("Content-Type", "audio/mpeg")
  res.setHeader("Cache-Control", "no-store")
  res.setHeader("X-Accel-Buffering", "no")
  if (!elListenSubs.has(agentId)) elListenSubs.set(agentId, new Set())
  elListenSubs.get(agentId).add(res)
  req.on("close", () => { if (elListenSubs.has(agentId)) elListenSubs.get(agentId).delete(res) })
  // intentionally not calling res.end() — chunks are pushed from the TTS handler
})

spaceNS.on("connection", (socket) => {
  console.log("[Space] Client connected:", socket.id)

  socket.emit("stateUpdate", {
    agents: spaceState.agents,
    currentTurn: spaceState.currentTurn,
    turnQueue: spaceState.turnQueue
  })
  socket.emit("messageHistory", spaceState.messages.slice(-50))

  socket.on("agentConnect", ({ agentId }) => {
    if (spaceState.agents[agentId]) {
      spaceState.agents[agentId].connected = true
      spaceState.agents[agentId].status = "idle"
      spaceState.agents[agentId].socketId = socket.id
      console.log(`[Space] Agent ${agentId} (${spaceState.agents[agentId].name}) connected`)
      // Push current prompt so reconnects pick up live dashboard changes made while disconnected.
      if (spacePrompts[agentId]) socket.emit("updatePrompt", { instructions: spacePrompts[agentId] })
      broadcastSpaceState()
    }
  })

  socket.on("agentReconnecting", ({ agentId, attempt }) => {
    const numId = parseInt(agentId, 10)
    if (!spaceState.agents[numId]) return
    spaceState.agents[numId].status = "reconnecting"
    spaceState.agents[numId].lastReconnectAt = Date.now()
    auditEntry(`agent ${numId} reconnecting (attempt ${attempt})`, socket)
    spaceNS.emit("agentStatus", { agentId: numId, status: "reconnecting", name: spaceState.agents[numId].name })
    broadcastSpaceState()
  })

  socket.on("agentDeadlock", ({ agentId, reason }) => {
    const numId = parseInt(agentId, 10)
    if (!spaceState.agents[numId]) return
    spaceState.agents[numId].status = "deadlocked"
    auditEntry(`agent ${numId} deadlocked: ${(reason || "max reconnects reached").slice(0, 80)}`, socket)
    spaceNS.emit("agentDeadlock", { agentId: numId, reason })
    spaceNS.emit("agentStatus", { agentId: numId, status: "deadlocked", name: spaceState.agents[numId].name })
    broadcastSpaceState()
  })

  socket.on("kickConnect", ({ agentId }) => {
    const numId = parseInt(agentId, 10)
    if (!spaceState.agents[numId]) return
    const target = spaceState.agents[numId]
    if (target.socketId) spaceNS.to(target.socketId).emit("kickConnect", { agentId: numId })
    auditEntry(`kickConnect agent ${numId} from dashboard`, socket)
  })

  socket.on("agentDisconnect", ({ agentId }) => {
    if (spaceState.agents[agentId]) {
      spaceState.agents[agentId].connected = false
      spaceState.agents[agentId].status = "offline"
      if (spaceState.currentTurn === agentId) releaseTurn(agentId)
      spaceState.turnQueue = spaceState.turnQueue.filter(id => id !== agentId)
      // Clear cached init chunk — next connection will produce a fresh one
      listenInitChunks.delete(agentId)
      console.log(`[Space] Agent ${agentId} disconnected`)
      broadcastSpaceState()
    }
  })

  socket.on("statusChange", ({ agentId, status }) => {
    if (spaceState.agents[agentId]) {
      spaceState.agents[agentId].status = status
      spaceNS.emit("agentStatus", { agentId, status, name: spaceState.agents[agentId].name })
      broadcastSpaceState()
      // Claim-token: when an agent starts speaking, cancel any in-flight response
      // on every other connected agent so they don't stomp each other.
      if (status === "speaking") {
        Object.values(spaceState.agents).forEach((other) => {
          if (other.id !== agentId && other.connected && other.socketId) {
            spaceNS.to(other.socketId).emit("cancelResponse", { reason: `agent ${agentId} took the floor` })
          }
        })
      }
    }
  })

  socket.on("requestTurn", ({ agentId }) => {
    const granted = requestTurn(agentId)
    socket.emit("turnResponse", { granted, currentTurn: spaceState.currentTurn })
  })

  socket.on("releaseTurn", ({ agentId }) => releaseTurn(agentId))

  socket.on("textDelta", ({ agentId, delta, messageId }) => {
    if (messageId && !activeTurns[messageId]) {
      activeTurns[messageId] = { agentId, startedAt: Date.now(), firstAudioAt: null, completedAt: null, chars: 0, source: "webrtc" }
      agentActiveTurnId[agentId] = messageId
    }
    if (messageId && activeTurns[messageId]) activeTurns[messageId].chars += (delta || "").length
    spaceNS.emit("textDelta", { agentId, delta, messageId, name: spaceState.agents[agentId]?.name })
  })

  socket.on("textComplete", ({ agentId, text, messageId }) => {
    const _doneAt = Date.now()
    if (messageId && activeTurns[messageId]) {
      activeTurns[messageId].completedAt = _doneAt
      activeTurns[messageId].chars = (text || "").length
      finalizeTurn(messageId)
    }
    const msg = {
      id: messageId,
      agentId,
      name: spaceState.agents[agentId]?.name,
      text,
      timestamp: _doneAt,
    }
    spaceState.messages.push(msg)
    if (spaceState.messages.length > 100) spaceState.messages = spaceState.messages.slice(-100)
    spaceNS.emit("textComplete", msg)

    // Forward to the other agent — but only when both are idle (prevents overtalking)
    const sender = spaceState.agents[agentId]
    const otherId = agentId === 0 ? 1 : 0
    const other = spaceState.agents[otherId]
    if (!other || !other.connected || !other.socketId) return

    const sendWhenIdle = (attempt = 0) => {
      const s = spaceState.agents[agentId]
      const o = spaceState.agents[otherId]
      if (s?.status === "idle" && o?.status === "idle") {
        spaceNS.to(other.socketId).emit("textToAgent", {
          text,
          from: sender?.name || `Agent${agentId}`
        })
      } else if (attempt < 10) {
        setTimeout(() => sendWhenIdle(attempt + 1), 1500)
      }
    }
    setTimeout(() => sendWhenIdle(), 2000)
  })

  socket.on("audioData", async ({ agentId, audio, mimeType }) => {
    if (provider.type === "webrtc") return
    try {
      spaceNS.emit("agentStatus", { agentId, status: "listening", name: spaceState.agents[agentId]?.name })
      if (spaceState.agents[agentId]) spaceState.agents[agentId].status = "listening"
      broadcastSpaceState()

      const audioBuffer = Buffer.from(audio, "base64")
      const { text } = await stt.transcribe(audioBuffer, mimeType || "audio/webm")

      if (!text?.trim()) {
        if (spaceState.agents[agentId]) spaceState.agents[agentId].status = "idle"
        spaceNS.emit("agentStatus", { agentId, status: "idle", name: spaceState.agents[agentId]?.name })
        broadcastSpaceState()
        return
      }

      console.log(`[Space STT] Agent ${agentId} heard: "${text}"`)
      const userMsg = { id: Date.now().toString(), agentId: -1, name: "User (voice)", text, timestamp: Date.now(), isUser: true }
      spaceState.messages.push(userMsg)
      spaceNS.emit("textComplete", userMsg)
      await handleLLMResponse(socket, agentId, text)
    } catch (err) {
      console.error("[Space] Audio pipeline error:", err.message)
      if (spaceState.agents[agentId]) spaceState.agents[agentId].status = "idle"
      spaceNS.emit("agentStatus", { agentId, status: "idle", name: spaceState.agents[agentId]?.name })
      broadcastSpaceState()
    }
  })

  socket.on("userMessage", ({ text, from }) => {
    if (typeof text !== "string" || !text.trim()) return
    const msg = { id: Date.now().toString(), agentId: -1, name: from || "User", text, timestamp: Date.now(), isUser: true }
    spaceState.messages.push(msg)
    spaceNS.emit("userMessage", msg)
    spaceNS.emit("textComplete", msg)
    auditEntry(`userMessage from "${(from || "User").slice(0, 40)}" (${text.length} chars)`, socket)
    if (provider.type === "socket") {
      handleLLMResponse(socket, 0, `[CHAT - ${shortenNick(from) || "User"}]: ${text}`)
    } else {
      spaceNS.emit("textToAgent", { text, from: shortenNick(from) || "User" })
    }
  })

  socket.on("textToAgentDirect", async ({ agentId, text, from }) => {
    if (provider.type === "webrtc") return
    const chatText = from ? `[CHAT - ${shortenNick(from)}]: ${text}` : text
    await handleLLMResponse(socket, agentId, chatText)
  })

  socket.on("audioLevel", ({ agentId, level }) => {
    trackAudioLevel(agentId, level)
    spaceNS.emit("audioLevel", { agentId, level })
  })

  // ElevenLabs streaming TTS — let operator change voice without redeploy.
  socket.on("setVoice", ({ agentId, voiceId }) => {
    const id = parseInt(agentId, 10)
    if ((id !== 0 && id !== 1) || !voiceId) return
    elevenVoiceIds[id] = String(voiceId)
    spaceNS.emit("voiceUpdated", { agentId: id, voiceId: elevenVoiceIds[id] })
  })

  // ── Listen-mode subscription management ──────────────────────────────────
  socket.on("listenSubscribe", ({ agentId }) => {
    const id = parseInt(agentId, 10)
    if (id !== 0 && id !== 1) return
    if (!listenSubs.has(id)) listenSubs.set(id, new Set())
    listenSubs.get(id).add(socket.id)
    if (!socketListenSubs.has(socket.id)) socketListenSubs.set(socket.id, new Set())
    socketListenSubs.get(socket.id).add(id)
    // Send cached WebM init chunk so the SourceBuffer can start decoding immediately
    const initData = listenInitChunks.get(id)
    if (initData) socket.emit("listenAudioInit", { agentId: id, mime: initData.mime, chunk: initData.chunk })
    auditEntry(`listen on agent ${id}`, socket)
  })

  socket.on("listenUnsubscribe", ({ agentId }) => {
    const id = parseInt(agentId, 10)
    if (listenSubs.has(id)) listenSubs.get(id).delete(socket.id)
    if (socketListenSubs.has(socket.id)) socketListenSubs.get(socket.id).delete(id)
  })

  // Agent browser page -> server -> dashboard: relay WebRTC audio for listen mode
  socket.on("agentAudioChunk", ({ agentId, mime, chunk }) => {
    const id = parseInt(agentId, 10)
    if (id !== 0 && id !== 1) return
    const buf = Buffer.isBuffer(chunk) ? chunk : (chunk ? Buffer.from(chunk) : null)
    if (!buf || buf.length === 0 || buf.length > 128 * 1024) return
    const mimeStr = (typeof mime === "string" && mime) ? mime : "audio/webm;codecs=opus"
    if (!listenInitChunks.has(id)) listenInitChunks.set(id, { mime: mimeStr, chunk: buf })
    const subs = listenSubs.get(id)
    if (!subs || subs.size === 0) return
    const t = Date.now()
    for (const sid of subs) {
      const s = spaceNS.sockets.get(sid)
      if (s) s.emit("listenAudio", { agentId: id, mime: mimeStr, chunk: buf, t })
    }
  })

  // Dashboard bridges
  socket.on("userTranscript", ({ agentId, text, timestamp }) => {
    if (!text || !text.trim()) return
    spaceNS.emit("humanTranscript", {
      agentId,
      name: spaceState.agents[agentId]?.name || "Speaker",
      text,
      timestamp: timestamp || Date.now()
    })
  })

  socket.on("kickRequest", ({ agentId, instructions }) => {
    const target = spaceState.agents[agentId]
    if (!target || !target.socketId) return
    const safe = (typeof instructions === "string" && instructions.trim()) ? instructions.trim() : null
    spaceNS.to(target.socketId).emit("kickAgent", { instructions: safe })
    auditEntry(`kick agent ${agentId}${safe ? ` (instructions: ${safe.length} chars)` : ""}`, socket)
  })

  socket.on("promptUpdate", ({ agentId, instructions }) => {
    if (typeof instructions !== "string" || !instructions.trim()) return
    const id = String(agentId)
    if (spacePrompts[id] !== undefined) {
      spacePrompts[id] = instructions
      promptOverrides[id] = true
    }
    const target = spaceState.agents[agentId]
    if (target && target.socketId) {
      spaceNS.to(target.socketId).emit("updatePrompt", { instructions })
    }
    spaceNS.emit("promptUpdated", { agentId, instructions })
    spaceNS.emit("promptOverrideActive", { agentId, override: true })
    auditEntry(`promptUpdate agent ${agentId} (${instructions.length} chars)`, socket)
  })

  socket.on("personalityActivate", ({ agentId, name }) => {
    const id = String(agentId)
    if (id !== "0" && id !== "1") return
    if (!personalitiesData.personalities?.[name]) {
      socket.emit("personalityActivateError", { agentId, error: `Unknown personality: ${name}` })
      return
    }
    personalitiesData.active[id] = name
    delete promptOverrides[id]
    const p = personalitiesData.personalities[name]
    spacePrompts[id] = interpolate(p.prompt)
    if (typeof p.voice === "string" && p.voice) spaceVoices[id] = p.voice
    const target = spaceState.agents[agentId]
    if (target && target.socketId) {
      spaceNS.to(target.socketId).emit("updatePrompt", { instructions: spacePrompts[id] })
    }
    savePersonalitiesFile()
    spaceNS.emit("personalityActivated", { agentId: parseInt(id), name })
    spaceNS.emit("promptUpdated", { agentId: parseInt(id), instructions: spacePrompts[id] })
    if (typeof p.voice === "string" && p.voice) spaceNS.emit("voiceUpdated", { agentId: parseInt(id), voiceId: p.voice })
    auditEntry(`activated personality "${name}" for agent ${id}`, socket)
  })

  socket.on("disconnect", () => {
    for (const id in spaceState.agents) {
      if (spaceState.agents[id].socketId === socket.id) {
        spaceState.agents[id].connected = false
        spaceState.agents[id].status = "offline"
        if (spaceState.currentTurn === parseInt(id)) releaseTurn(parseInt(id))
        spaceState.turnQueue = spaceState.turnQueue.filter(aid => aid !== parseInt(id))
      }
    }
    // Clean up listen subscriptions so we don't emit to dead sockets
    if (socketListenSubs.has(socket.id)) {
      for (const id of socketListenSubs.get(socket.id)) {
        if (listenSubs.has(id)) listenSubs.get(id).delete(socket.id)
      }
      socketListenSubs.delete(socket.id)
    }
    broadcastSpaceState()
    console.log("[Space] Client disconnected:", socket.id)
  })
})

// ============================================================
// X SPACES (Twitter) — Puppeteer bot integration
// ============================================================
const X_SPACES_ENABLED = process.env.X_SPACES_ENABLED === "true"

if (X_SPACES_ENABLED) {
  console.log("[X-Spaces] Module enabled")

  xSpaces.emitter.on("status", (status) => {
    console.log("[X-Spaces] Status:", status)
    spaceNS.emit("xSpacesStatus", { status })

    // Announce when bot goes live in a Space
    if (status === "speaking-in-space") {
      setTimeout(async () => {
        if (!requestTurn(0)) return // don't block future transcriptions
        try {
          let intro = ""
          for await (const delta of provider.streamResponse(0, "You just joined an X Space as a speaker. Say a short intro line in character — 1 sentence max, no hashtags.", spacePrompts[0])) {
            intro += delta
          }
          intro = intro.trim()
          if (!intro) intro = "yo i'm here, let's go"
          const audioBuffer = await tts.synthesize(intro, 0)
          if (audioBuffer) await xSpaces.speakInSpace(audioBuffer)
        } catch (e) {
          console.error("[X-Spaces] Intro error:", e.message)
        } finally {
          releaseTurn(0)
        }
      }, 2000)
    }
  })

  xSpaces.emitter.on("error", (err) => {
    console.error("[X-Spaces] Error:", err)
    spaceNS.emit("xSpacesError", { error: err })
  })

  xSpaces.emitter.on("2fa-required", () => {
    spaceNS.emit("xSpaces2faRequired", {})
  })

  // When X Space audio is transcribed, feed it to the AI
  xSpaces.emitter.on("transcription", async ({ text }) => {
    console.log("[X-Spaces] Heard in Space:", text)
    const userMsg = {
      id: Date.now().toString(), agentId: -1,
      name: "X Space Speaker", text,
      timestamp: Date.now(), isUser: true, source: "x-space"
    }
    spaceState.messages.push(userMsg)
    if (spaceState.messages.length > 100) spaceState.messages = spaceState.messages.slice(-100)
    spaceNS.emit("textComplete", userMsg)

    // Skip if already generating a response
    const agentId = 0
    if (!requestTurn(agentId)) {
      console.log("[X-Spaces] Already responding, skipping this transcription")
      return
    }
    const messageId = Date.now().toString()
    const agentName = spaceState.agents[agentId]?.name

    const _xStartedAt = Date.now()
    agentActiveTurnId[agentId] = messageId
    activeTurns[messageId] = { agentId, startedAt: _xStartedAt, firstAudioAt: null, completedAt: null, chars: 0, source: "x-spaces" }

    spaceNS.emit("agentStatus", { agentId, status: "speaking", name: agentName })
    if (spaceState.agents[agentId]) spaceState.agents[agentId].status = "speaking"
    broadcastSpaceState()

    let fullText = ""
    try {
      for await (const delta of provider.streamResponse(agentId, text, spacePrompts[agentId])) {
        fullText += delta
        if (activeTurns[messageId]) activeTurns[messageId].chars = fullText.length
        spaceNS.emit("textDelta", { agentId, delta, messageId, name: agentName })
      }

      const _xDoneAt = Date.now()
      if (activeTurns[messageId]) activeTurns[messageId].completedAt = _xDoneAt

      const msg = { id: messageId, agentId, name: agentName, text: fullText, timestamp: _xDoneAt }
      spaceState.messages.push(msg)
      if (spaceState.messages.length > 100) spaceState.messages = spaceState.messages.slice(-100)
      spaceNS.emit("textComplete", msg)

      // TTS and inject into X Space
      const audioBuffer = await tts.synthesize(fullText, agentId)
      if (audioBuffer) {
        if (activeTurns[messageId] && !activeTurns[messageId].firstAudioAt) activeTurns[messageId].firstAudioAt = Date.now()
        await xSpaces.speakInSpace(audioBuffer)
        spaceNS.emit("ttsAudio", { agentId, audio: audioBuffer.toString("base64"), format: "mp3" })
      }
      finalizeTurn(messageId)
    } catch (err) {
      console.error("[X-Spaces] Response error:", err.message)
      finalizeTurn(messageId)
    } finally {
      if (spaceState.agents[agentId]) spaceState.agents[agentId].status = "idle"
      spaceNS.emit("agentStatus", { agentId, status: "idle", name: agentName })
      releaseTurn(agentId)
    }
  })

  // Socket.IO handlers for X Spaces control
  spaceNS.on("connection", (socket) => {
    socket.on("xspace:start", async () => {
      auditEntry("xspace:start", socket)
      try { await xSpaces.start() } catch (e) { socket.emit("xSpacesError", { error: e.message }) }
    })
    socket.on("xspace:join", async ({ spaceUrl }) => {
      auditEntry(`xspace:join ${String(spaceUrl || "").slice(0, 120)}`, socket)
      try { await xSpaces.joinSpace(spaceUrl) } catch (e) { socket.emit("xSpacesError", { error: e.message }) }
    })
    socket.on("xspace:leave", async () => {
      auditEntry("xspace:leave", socket)
      try { await xSpaces.leaveSpace() } catch (e) { socket.emit("xSpacesError", { error: e.message }) }
    })
    socket.on("xspace:stop", async () => {
      auditEntry("xspace:stop", socket)
      try { await xSpaces.stop() } catch (e) { socket.emit("xSpacesError", { error: e.message }) }
    })
    socket.on("xspace:status", () => {
      socket.emit("xSpacesStatus", xSpaces.getStatus())
    })
    socket.on("xspace:2fa", ({ code }) => {
      xSpaces.emitter.emit("2fa-code", code)
    })
  })

  // Auto-start if credentials are set
  if (process.env.X_USERNAME && process.env.X_PASSWORD) {
    setTimeout(() => {
      console.log("[X-Spaces] Auto-starting...")
      xSpaces.start().catch(e => console.error("[X-Spaces] Auto-start failed:", e.message))
    }, 3000)
  }
}

// ============================================================
// START SERVER
// ============================================================
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const shownHost = HOST === "0.0.0.0" ? "localhost" : HOST
    console.log(`Server bound to ${HOST}:${PORT}`)
    console.log(`Dashboard:  http://${shownHost}:${PORT}/dashboard`)
    console.log(`Bob:        http://${shownHost}:${PORT}/bob`)
    console.log(`Alice:      http://${shownHost}:${PORT}/alice`)
    console.log(`Admin:      http://${shownHost}:${PORT}/admin`)
    console.log(`AI Provider: ${AI_PROVIDER} (${provider.type} mode)`)
    console.log(`Auth: ${AUTH_REQUIRED ? "REQUIRED (ADMIN_API_KEY set)" : "OPEN (dev mode, localhost only)"}`)
  })
}

module.exports = {
  app,
  server,
  io,
  spaceState,
  elBuckets,
  elevenVoiceIds,
  clearVoicesCache: () => { voicesCache = null }
}


