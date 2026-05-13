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
  const ip = sourceSocket?.handshake?.address || sourceSocket?.handshake?.headers?.["x-forwarded-for"] || "unknown"
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
  res.type("html").send(html)
}

// Static files in /public are public, but we explicitly exclude the operator
// HTML pages (handled by gated routes below) so they only ship the key when
// auth has been validated. CSS/JS/images remain freely cached.
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
  currentTurn: spaceState.currentTurn
}))

const { exec: _exec } = require("child_process")
app.get("/health", requireAuth, (req, res) => {
  _exec("pactl list short sink-inputs 2>&1; echo '---SOURCES---'; pactl list short sources 2>&1", { timeout: 3000 }, (err, stdout) => {
    res.json({
      pulse: err ? `pactl unavailable: ${err.message}` : stdout,
      uptime: process.uptime(),
      memory: process.memoryUsage().rss,
      pid: process.pid
    })
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

// ===== ELEVENLABS STREAMING TTS (browser-page mode) =====
// Streaming proxy so browser pages can use ElevenLabs voices without seeing the key.
// Independent of providers/tts.js (used by the Puppeteer X-Spaces injection path).
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5"
const ELEVEN_OPTIMIZE = process.env.ELEVENLABS_OPTIMIZE_LATENCY ?? "2"
const ELEVEN_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || "mp3_22050_32"
const elevenVoiceIds = {
  0: process.env.ELEVENLABS_VOICE_0 || process.env.ELEVEN_VOICE_0 || "S9NKLs1GeSTKzXd9D0Lf",
  1: process.env.ELEVENLABS_VOICE_1 || process.env.ELEVEN_VOICE_1 || "AZnzlk1XvdvUeBnXmlld"
}

app.post("/tts/:agentId/stream", requireAuth, async (req, res) => {
  const agentId = parseInt(req.params.agentId, 10)
  const text = (req.body?.text || "").toString().trim()
  const voiceId = (req.body?.voiceId || elevenVoiceIds[agentId] || elevenVoiceIds[0]).toString()
  if (!ELEVEN_KEY) return res.status(500).json({ error: "ELEVENLABS_API_KEY not configured" })
  if (!text) return res.status(400).json({ error: "missing text" })
  if (!voiceId) return res.status(400).json({ error: "missing voice" })

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=${encodeURIComponent(ELEVEN_OPTIMIZE)}&output_format=${encodeURIComponent(ELEVEN_FORMAT)}`
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
      return res.status(r.status || 502).send(errBody || "elevenlabs error")
    }
    res.setHeader("Content-Type", "audio/mpeg")
    res.setHeader("Cache-Control", "no-store")
    // r.body is a web ReadableStream in modern Node — pipe via for-await to avoid buffering
    const reader = r.body.getReader()
    res.on("close", () => { try { reader.cancel() } catch (_) {} })
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) res.write(Buffer.from(value))
    }
    res.end()
  } catch (e) {
    console.error("[EL TTS] exception:", e.message)
    if (!res.headersSent) res.status(500).json({ error: e.message })
    else res.end()
  }
})

app.get("/voices", requireAuth, async (req, res) => {
  if (!ELEVEN_KEY) return res.status(500).json({ error: "ELEVENLABS_API_KEY not configured" })
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": ELEVEN_KEY }
    })
    if (!r.ok) return res.status(r.status).send(await r.text())
    const data = await r.json()
    res.json({
      current: elevenVoiceIds,
      voices: (data.voices || []).map(v => ({
        id: v.voice_id,
        name: v.name,
        category: v.category,
        description: v.labels?.description || null,
        labels: v.labels || null,
        preview: v.preview_url || null
      }))
    })
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
// X SPACE — namespace /space
// ============================================================
const spaceNS = io.of("/space")

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
    0: { id: 0, name: "Agent Zero", status: "offline", connected: false },
    1: { id: 1, name: "Agent One", status: "offline", connected: false }
  },
  currentTurn: null,
  turnQueue: [],
  messages: [],
  isProcessing: false
}

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

const spacePrompts = {
  0: `${baseInfo}\nYou're Agent Zero. You're the louder one. You talk shit and roast people but in a funny way. You don't take crap from anyone. If someone comes at you, you fire back harder. You and your partner are best friends.`,
  1: `${baseInfo}\nYou're Agent One. You're more chill but you've got a sharp tongue. Your humor is dry and sarcastic. You love making fun of your partner when they get too hyped. You can be savage when needed.`
}

const spaceVoices = { 0: "verse", 1: "sage" }

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

  spaceNS.emit("agentStatus", { agentId, status: "speaking", name: agentName })
  if (spaceState.agents[agentId]) spaceState.agents[agentId].status = "speaking"
  broadcastSpaceState()

  let fullText = ""
  try {
    for await (const delta of provider.streamResponse(agentId, userText, spacePrompts[agentId])) {
      fullText += delta
      spaceNS.emit("textDelta", { agentId, delta, messageId, name: agentName })
    }

    const msg = { id: messageId, agentId, name: agentName, text: fullText, timestamp: Date.now() }
    spaceState.messages.push(msg)
    if (spaceState.messages.length > 100) spaceState.messages = spaceState.messages.slice(-100)
    spaceNS.emit("textComplete", msg)

    try {
      const audioBuffer = await tts.synthesize(fullText, agentId)
      if (audioBuffer) {
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
  } catch (err) {
    console.error(`[Space] LLM error (${AI_PROVIDER}):`, err.message)
  } finally {
    if (spaceState.agents[agentId]) spaceState.agents[agentId].status = "idle"
    spaceNS.emit("agentStatus", { agentId, status: "idle", name: agentName })
    releaseTurn(agentId)
  }
}

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
      broadcastSpaceState()
    }
  })

  socket.on("agentDisconnect", ({ agentId }) => {
    if (spaceState.agents[agentId]) {
      spaceState.agents[agentId].connected = false
      spaceState.agents[agentId].status = "offline"
      if (spaceState.currentTurn === agentId) releaseTurn(agentId)
      spaceState.turnQueue = spaceState.turnQueue.filter(id => id !== agentId)
      console.log(`[Space] Agent ${agentId} disconnected`)
      broadcastSpaceState()
    }
  })

  socket.on("statusChange", ({ agentId, status }) => {
    if (spaceState.agents[agentId]) {
      spaceState.agents[agentId].status = status
      spaceNS.emit("agentStatus", { agentId, status, name: spaceState.agents[agentId].name })
      broadcastSpaceState()
    }
  })

  socket.on("requestTurn", ({ agentId }) => {
    const granted = requestTurn(agentId)
    socket.emit("turnResponse", { granted, currentTurn: spaceState.currentTurn })
  })

  socket.on("releaseTurn", ({ agentId }) => releaseTurn(agentId))

  socket.on("textDelta", ({ agentId, delta, messageId }) => {
    spaceNS.emit("textDelta", { agentId, delta, messageId, name: spaceState.agents[agentId]?.name })
  })

  socket.on("textComplete", ({ agentId, text, messageId }) => {
    const msg = {
      id: messageId,
      agentId,
      name: spaceState.agents[agentId]?.name,
      text,
      timestamp: Date.now()
    }
    spaceState.messages.push(msg)
    if (spaceState.messages.length > 100) spaceState.messages = spaceState.messages.slice(-100)
    spaceNS.emit("textComplete", msg)
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

  socket.on("audioLevel", ({ agentId, level }) => spaceNS.emit("audioLevel", { agentId, level }))

  // ElevenLabs streaming TTS — let operator change voice without redeploy.
  socket.on("setVoice", ({ agentId, voiceId }) => {
    const id = parseInt(agentId, 10)
    if ((id !== 0 && id !== 1) || !voiceId) return
    elevenVoiceIds[id] = String(voiceId)
    spaceNS.emit("voiceUpdated", { agentId: id, voiceId: elevenVoiceIds[id] })
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
    if (spacePrompts[agentId] !== undefined) spacePrompts[agentId] = instructions
    const target = spaceState.agents[agentId]
    if (target && target.socketId) {
      spaceNS.to(target.socketId).emit("updatePrompt", { instructions })
    }
    spaceNS.emit("promptUpdated", { agentId, instructions })
    auditEntry(`promptUpdate agent ${agentId} (${instructions.length} chars)`, socket)
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

    spaceNS.emit("agentStatus", { agentId, status: "speaking", name: agentName })
    if (spaceState.agents[agentId]) spaceState.agents[agentId].status = "speaking"
    broadcastSpaceState()

    let fullText = ""
    try {
      for await (const delta of provider.streamResponse(agentId, text, spacePrompts[agentId])) {
        fullText += delta
        spaceNS.emit("textDelta", { agentId, delta, messageId, name: agentName })
      }

      const msg = { id: messageId, agentId, name: agentName, text: fullText, timestamp: Date.now() }
      spaceState.messages.push(msg)
      if (spaceState.messages.length > 100) spaceState.messages = spaceState.messages.slice(-100)
      spaceNS.emit("textComplete", msg)

      // TTS and inject into X Space
      const audioBuffer = await tts.synthesize(fullText, agentId)
      if (audioBuffer) {
        await xSpaces.speakInSpace(audioBuffer)
        spaceNS.emit("ttsAudio", { agentId, audio: audioBuffer.toString("base64"), format: "mp3" })
      }
    } catch (err) {
      console.error("[X-Spaces] Response error:", err.message)
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


