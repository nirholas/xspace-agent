/* Voice Agent Dashboard — generic, project-agnostic.
 * Subscribes to the /space Socket.IO namespace and renders whatever agents
 * the server reports. No agent names are hardcoded.
 *
 * Vercel variant: reads API_BASE from <meta name="api-base"> so all requests
 * go to the tunneled VM origin, not to Vercel.
 */
(function () {
  "use strict"

  // API_BASE points every fetch and Socket.IO connection at the VM.
  // Set by inject-api.js at build time via the <meta name="api-base"> tag.
  const API_BASE = (
    document.querySelector('meta[name="api-base"]')?.content || ""
  ).replace(/\/$/, "")

  // ---------- auth ----------
  // Key precedence:
  //   1. window.AGENT_AUTH_KEY — server-injected if /dashboard?key=… was used
  //   2. sessionStorage("xspace.adminKey") — operator login persists for the tab
  //   3. null — login modal will collect it
  const SS_KEY = "xspace.adminKey"
  let KEY = (window.AGENT_AUTH_KEY || sessionStorage.getItem(SS_KEY) || "").trim() || null
  let AUTH_REQUIRED = true   // assume strict until /auth/info says otherwise
  let socket = null          // lazy — created after auth resolves

  function setKey(k) {
    KEY = k && k.trim() ? k.trim() : null
    if (KEY) sessionStorage.setItem(SS_KEY, KEY)
    else sessionStorage.removeItem(SS_KEY)
  }

  async function authedFetch(path, opts) {
    opts = opts || {}
    const url = /^https?:\/\//.test(path) ? path : API_BASE + path
    const headers = Object.assign({}, opts.headers || {})
    if (KEY) headers["Authorization"] = "Bearer " + KEY
    const r = await fetch(url, Object.assign({}, opts, { headers }))
    if (r.status === 401) {
      setKey(null)
      showLogin("Key rejected by server. Try again.")
      throw new Error("unauthorized")
    }
    return r
  }

  // ---------- login modal ----------
  const loginOverlay = document.getElementById("login-overlay")
  const loginForm    = document.getElementById("login-form")
  const loginInput   = document.getElementById("login-key")
  const loginMsg     = document.getElementById("login-msg")
  const loginCard    = loginForm.querySelector(".login-card") || loginForm

  function showLogin(msg) {
    if (msg) { loginMsg.textContent = msg; loginCard.classList.add("error") }
    else     { loginCard.classList.remove("error") }
    loginOverlay.hidden = false
    setTimeout(() => loginInput.focus(), 0)
  }
  function hideLogin() {
    loginOverlay.hidden = true
    loginCard.classList.remove("error")
  }

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault()
    const candidate = loginInput.value.trim()
    if (!candidate) return
    try {
      const r = await fetch(API_BASE + "/auth/check", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + candidate }
      })
      if (r.ok) {
        setKey(candidate)
        hideLogin()
        loginInput.value = ""
        await connect()
      } else {
        showLogin("Invalid key.")
        loginInput.select()
      }
    } catch (err) {
      showLogin("Network error: " + err.message)
    }
  })

  // ---------- socket (created after auth resolves) ----------
  function makeSocket() {
    const s = io(API_BASE + "/space", {
      transports: ["websocket", "polling"],
      auth: KEY ? { key: KEY } : {},
      reconnection: true
    })
    wireSocket(s)
    return s
  }

  const els = {
    connDot:    document.getElementById("conn-dot"),
    connLabel:  document.getElementById("conn-label"),
    spaceLink:  document.getElementById("space-link"),
    currentTurn: document.getElementById("current-turn"),
    uptime:     document.getElementById("uptime"),
    agents:     document.getElementById("agents"),
    transcript: document.getElementById("transcript"),
    autoscroll: document.getElementById("autoscroll"),
    injectText: document.getElementById("inject-text"),
    injectFrom: document.getElementById("inject-from"),
    injectSend: document.getElementById("inject-send"),
    pulseOut:   document.getElementById("pulse-out"),
    xtabOut:    document.getElementById("xtab-out"),
    healthBtn:  document.getElementById("health-refresh"),
    tpl:        document.getElementById("agent-card-tpl"),
  }

  // ---------- state ----------
  const state = {
    agents: {},           // id -> { id, name, status, ... }
    voices: {},           // id -> voice
    prompts: {},          // id -> instructions
    currentTurn: null,
    streaming: {},        // messageId -> { agentId, text, el }
    seenMessageIds: new Set(),
  }

  // ---------- helpers ----------
  function fmtTime(ts) {
    const d = ts ? new Date(ts) : new Date()
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
  }
  function escapeText(s) { return s == null ? "" : String(s) }
  function isAtBottom(el) {
    return el.scrollHeight - el.clientHeight - el.scrollTop < 40
  }
  function maybeScroll() {
    if (els.autoscroll.checked) els.transcript.scrollTop = els.transcript.scrollHeight
  }

  // ---------- socket handlers (registered when wireSocket runs) ----------
  function wireSocket(s) {
    const socket = s
  socket.on("connect", () => {
    els.connDot.classList.remove("offline"); els.connDot.classList.add("connected")
    els.connLabel.textContent = "connected"
  })
  socket.on("disconnect", () => {
    els.connDot.classList.remove("connected"); els.connDot.classList.add("offline")
    els.connLabel.textContent = "disconnected"
  })
  socket.on("connect_error", (err) => {
    const msg = (err && err.message) ? err.message : String(err)
    els.connLabel.textContent = "error: " + msg
    if (/unauthor/i.test(msg)) {
      setKey(null)
      showLogin("Socket rejected: " + msg)
    }
  })

  // ---------- agent cards ----------
  function renderAgents() {
    const existing = new Map(
      Array.from(els.agents.querySelectorAll(".agent-card"))
        .map(el => [el.dataset.agentId, el])
    )
    const wantIds = Object.keys(state.agents).sort((a, b) => Number(a) - Number(b))

    for (const id of wantIds) {
      let card = existing.get(id)
      if (!card) {
        card = els.tpl.content.firstElementChild.cloneNode(true)
        card.dataset.agentId = id
        wireCard(card, Number(id))
        els.agents.appendChild(card)
      }
      existing.delete(id)
      updateCard(card, state.agents[id])
    }
    // remove agents no longer reported
    for (const orphan of existing.values()) orphan.remove()
  }

  function updateCard(card, agent) {
    if (!agent) return
    const id = String(agent.id)
    card.querySelector(".agent-name").textContent = agent.name || `Agent ${id}`
    const voice = state.voices[id] || state.voices[Number(id)]
    card.querySelector(".voice").textContent = voice ? `voice: ${voice}` : ""
    const badge = card.querySelector(".badge.status")
    const status = agent.status || "offline"
    badge.dataset.status = status
    badge.textContent = status
    const promptEl = card.querySelector(".prompt-text")
    if (document.activeElement !== promptEl) {
      const next = state.prompts[id] ?? state.prompts[Number(id)] ?? ""
      if (promptEl.value !== next) promptEl.value = next
    }
  }

  function wireCard(card, agentId) {
    card.querySelector(".kick").addEventListener("click", () => {
      socket.emit("kickRequest", { agentId })
    })
    card.querySelector(".kick-instructed").addEventListener("click", () => {
      const instructions = window.prompt("Kick with custom instructions (sent as response.create)?", "")
      if (instructions == null) return
      socket.emit("kickRequest", { agentId, instructions: instructions.trim() || null })
    })
    card.querySelector(".save-prompt").addEventListener("click", () => {
      const instructions = card.querySelector(".prompt-text").value
      socket.emit("promptUpdate", { agentId, instructions })
      const statusEl = card.querySelector(".save-status")
      statusEl.textContent = "pushed @ " + fmtTime()
      setTimeout(() => { statusEl.textContent = "" }, 4000)
    })
  }

  function setCurrent(msg, card) {
    const box = card.querySelector(".current-msg")
    box.textContent = msg || "—"
    box.classList.toggle("active", !!msg)
  }

  function findCard(agentId) {
    return els.agents.querySelector(`.agent-card[data-agent-id="${agentId}"]`)
  }

  // ---------- audio levels ----------
  socket.on("audioLevel", ({ agentId, level }) => {
    const card = findCard(agentId)
    if (!card) return
    const pct = Math.max(0, Math.min(1, Number(level) || 0)) * 100
    card.querySelector(".meter-fill").style.width = pct.toFixed(1) + "%"
  })

  // ---------- header / turn ----------
  function setCurrentTurn(turn) {
    state.currentTurn = turn
    if (turn === null || turn === undefined) {
      els.currentTurn.textContent = "—"
      els.currentTurn.classList.add("muted")
    } else {
      const name = state.agents[turn]?.name || `Agent ${turn}`
      els.currentTurn.textContent = name
      els.currentTurn.classList.remove("muted")
    }
  }

  socket.on("stateUpdate", ({ agents, currentTurn }) => {
    if (agents) state.agents = agents
    renderAgents()
    setCurrentTurn(currentTurn ?? null)
  })

  socket.on("agentStatus", ({ agentId, status, name }) => {
    if (!state.agents[agentId]) state.agents[agentId] = { id: agentId, name, status }
    else { state.agents[agentId].status = status; if (name) state.agents[agentId].name = name }
    const card = findCard(agentId)
    if (card) updateCard(card, state.agents[agentId])
  })

  socket.on("turnGranted", ({ agentId }) => setCurrentTurn(agentId))

  // ---------- transcript ----------
  function addEntry({ id, classes, name, text, streaming }) {
    const wrap = document.createElement("div")
    wrap.className = "t-entry " + (classes || "")
    if (id) wrap.dataset.msgId = id
    if (streaming) wrap.classList.add("streaming")
    wrap.innerHTML = `<div class="t-time">${fmtTime()}</div>
      <div class="t-body"><span class="t-name"></span><span class="t-text"></span></div>`
    wrap.querySelector(".t-name").textContent = name ? name + ":" : ""
    wrap.querySelector(".t-text").textContent = text || ""
    els.transcript.appendChild(wrap)
    maybeScroll()
    return wrap
  }

  function appendTo(entry, delta) {
    const span = entry.querySelector(".t-text")
    span.textContent += delta
    maybeScroll()
  }

  function finalize(entry, text) {
    entry.classList.remove("streaming")
    if (text != null) entry.querySelector(".t-text").textContent = text
  }

  socket.on("messageHistory", (history) => {
    if (!Array.isArray(history)) return
    els.transcript.innerHTML = ""
    state.seenMessageIds.clear()
    for (const m of history) {
      if (!m || !m.id) continue
      state.seenMessageIds.add(String(m.id))
      const klass = m.isUser ? "human" : `agent-${m.agentId}`
      addEntry({ id: m.id, classes: klass, name: m.name || (m.isUser ? "User" : `Agent ${m.agentId}`), text: m.text })
    }
  })

  socket.on("textDelta", ({ agentId, delta, messageId, name }) => {
    if (!messageId) return
    let s = state.streaming[messageId]
    if (!s) {
      const entry = addEntry({
        id: messageId,
        classes: `agent-${agentId}`,
        name: name || state.agents[agentId]?.name || `Agent ${agentId}`,
        text: "",
        streaming: true
      })
      s = state.streaming[messageId] = { agentId, text: "", el: entry }
    }
    s.text += delta || ""
    appendTo(s.el, delta || "")
    const card = findCard(agentId)
    if (card) setCurrent(s.text, card)
  })

  socket.on("textComplete", (msg) => {
    if (!msg) return
    const key = String(msg.id)
    const s = state.streaming[key]
    if (s) {
      finalize(s.el, msg.text || s.text)
      delete state.streaming[key]
    } else if (!state.seenMessageIds.has(key)) {
      const klass = msg.isUser ? "human" : `agent-${msg.agentId}`
      addEntry({
        id: msg.id, classes: klass,
        name: msg.name || (msg.isUser ? "User" : `Agent ${msg.agentId}`),
        text: msg.text
      })
    }
    state.seenMessageIds.add(key)
    if (!msg.isUser) {
      const card = findCard(msg.agentId)
      if (card) setCurrent(msg.text, card)
    }
  })

  socket.on("userMessage", (msg) => {
    if (!msg || !msg.id || state.seenMessageIds.has(String(msg.id))) return
    state.seenMessageIds.add(String(msg.id))
    addEntry({ id: msg.id, classes: "human", name: msg.name || "User", text: msg.text })
  })

  socket.on("humanTranscript", ({ agentId, name, text }) => {
    addEntry({ classes: "human", name: name || "Human (Space)", text })
  })

  socket.on("pumpfunMessage", (msg) => {
    if (!msg) return
    addEntry({ classes: "human", name: msg.name || "external", text: msg.text })
  })

  socket.on("promptUpdated", ({ agentId, instructions }) => {
    state.prompts[agentId] = instructions
    const card = findCard(agentId)
    if (card) {
      const el = card.querySelector(".prompt-text")
      if (document.activeElement !== el) el.value = instructions
    }
  })

  socket.on("auditLog", (msg) => {
    if (!msg || !msg.id || state.seenMessageIds.has(String(msg.id))) return
    state.seenMessageIds.add(String(msg.id))
    addEntry({ id: msg.id, classes: "audit", name: msg.name || "audit", text: msg.text })
  })
  } // end wireSocket

  // ---------- inject ----------
  function sendInject() {
    if (!socket) return
    const text = els.injectText.value.trim()
    if (!text) return
    socket.emit("userMessage", { text, from: els.injectFrom.value.trim() || "Operator" })
    els.injectText.value = ""
    els.injectText.focus()
  }
  els.injectSend.addEventListener("click", sendInject)
  els.injectText.addEventListener("keydown", (e) => { if (e.key === "Enter") sendInject() })

  // ---------- bootstrap from REST ----------
  async function bootstrap() {
    try {
      const [stateR, cfgR, infoR] = await Promise.all([
        authedFetch("/state").then(r => r.json()).catch(() => ({})),
        authedFetch("/agent-config").then(r => r.json()).catch(() => ({})),
        fetch(API_BASE + "/space-info").then(r => r.json()).catch(() => ({})),
      ])
      if (stateR.agents) state.agents = stateR.agents
      if (cfgR.voices)  state.voices  = cfgR.voices
      if (cfgR.prompts) state.prompts = cfgR.prompts
      if (stateR.currentTurn !== undefined) setCurrentTurn(stateR.currentTurn)
      renderAgents()
      if (infoR.spaceUrl) {
        els.spaceLink.textContent = infoR.spaceTitle || infoR.spaceUrl
        els.spaceLink.href = infoR.spaceUrl
      } else {
        els.spaceLink.textContent = "(set SPACE_URL env var)"
        els.spaceLink.removeAttribute("href")
      }
      if (Array.isArray(stateR.messages)) {
        els.transcript.innerHTML = ""
        state.seenMessageIds.clear()
        for (const m of stateR.messages) {
          state.seenMessageIds.add(String(m.id))
          const klass = m.isUser ? "human" : `agent-${m.agentId}`
          addEntry({ id: m.id, classes: klass, name: m.name, text: m.text })
        }
      }
    } catch (e) {
      console.warn("bootstrap failed", e)
    }
  }

  // ---------- health ----------
  async function refreshHealth() {
    els.pulseOut.textContent = "loading…"
    els.xtabOut.textContent  = "loading…"
    try {
      const h = await authedFetch("/health").then(r => r.json())
      els.pulseOut.textContent = h.pulse || "(no data)"
      els.uptime.textContent   = formatUptime(h.uptime)
    } catch (e) {
      els.pulseOut.textContent = "error: " + e.message
    }
    try {
      const x = await authedFetch("/x-tab-url").then(r => r.json())
      if (x.error) {
        els.xtabOut.textContent = x.error
      } else {
        els.xtabOut.textContent = (x.tabs || []).map(t => `${t.url}\n  ${t.title || ""}`).join("\n") || "(no tabs)"
      }
    } catch (e) {
      els.xtabOut.textContent = "error: " + e.message
    }
  }
  function formatUptime(s) {
    if (!s) return "—"
    s = Math.floor(s)
    const d = Math.floor(s / 86400); s %= 86400
    const h = Math.floor(s / 3600);  s %= 3600
    const m = Math.floor(s / 60);    s %= 60
    const parts = []
    if (d) parts.push(d + "d")
    if (h) parts.push(h + "h")
    if (m) parts.push(m + "m")
    parts.push(s + "s")
    return parts.join(" ")
  }
  els.healthBtn.addEventListener("click", refreshHealth)

  // ---------- connect lifecycle ----------
  async function connect() {
    socket = makeSocket()
    await bootstrap()
    refreshHealth()
    if (window.DashCostPanel) window.DashCostPanel.init(socket, authedFetch)
  }

  async function init() {
    try {
      const info = await fetch(API_BASE + "/auth/info").then(r => r.json())
      AUTH_REQUIRED = !!info.authRequired
    } catch (_) { /* assume strict */ }

    if (!AUTH_REQUIRED) {
      hideLogin()
      await connect()
      return
    }

    if (!KEY) {
      showLogin()
      return
    }

    // Have a candidate key — validate before connecting so we surface bad
    // keys via the login flow, not a half-broken dashboard.
    try {
      const r = await fetch(API_BASE + "/auth/check", {
        method: "POST",
        headers: { "Authorization": "Bearer " + KEY }
      })
      if (r.ok) {
        hideLogin()
        await connect()
      } else {
        setKey(null)
        showLogin("Saved key was rejected. Re-enter.")
      }
    } catch (e) {
      showLogin("Network error: " + e.message)
    }
  }

  init()
})()
