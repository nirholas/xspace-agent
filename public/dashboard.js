/* Voice Agent Dashboard — generic, project-agnostic.
 * Subscribes to the /space Socket.IO namespace and renders whatever agents
 * the server reports. No agent names are hardcoded.
 */
(function () {
  "use strict"

  // ---------- auth ----------
  // Key precedence:
  //   1. window.AGENT_AUTH_KEY — server-injected if /dashboard?key=… was used
  //   2. sessionStorage("xspace.adminKey") — operator login persists for the tab
  //   3. null — login modal will collect it
  const SS_KEY     = "xspace.adminKey"
  const SS_FILTERS = "xspace.filters"
  let KEY = (window.AGENT_AUTH_KEY || sessionStorage.getItem(SS_KEY) || "").trim() || null
  let AUTH_REQUIRED = true   // assume strict until /auth/info says otherwise
  let operator = null        // { name, role } — set after /auth/check
  let socket = null          // lazy — created after auth resolves

  function setKey(k) {
    KEY = k && k.trim() ? k.trim() : null
    if (KEY) sessionStorage.setItem(SS_KEY, KEY)
    else sessionStorage.removeItem(SS_KEY)
  }

  function setOperator(op) {
    operator = op || null
    const wrap = document.getElementById("who-wrap")
    const whoEl = document.getElementById("who")
    if (!wrap || !whoEl) return
    if (op && op.name) {
      whoEl.textContent = op.name + (op.role && op.role !== "admin" ? " (" + op.role + ")" : "")
      wrap.hidden = false
    } else {
      wrap.hidden = true
    }
    applyRoleUI()
  }

  function applyRoleUI() {
    const isViewer = operator && operator.role === "viewer"
    // Hide write controls for viewers
    const writeSelectors = [
      "#inject-send", "#inject-text", "#inject-from",
      ".kick", ".kick-instructed", ".save-prompt", ".prompt-text"
    ]
    for (const sel of writeSelectors) {
      document.querySelectorAll(sel).forEach(el => { el.style.display = isViewer ? "none" : "" })
    }
  }

  async function authedFetch(url, opts) {
    opts = opts || {}
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

    document.getElementById("logout-btn")?.addEventListener("click", () => {
    setKey(null)
    setOperator(null)
    location.reload()
  })

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault()
    const candidate = loginInput.value.trim()
    if (!candidate) return
    try {
      const r = await fetch("/auth/check", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + candidate }
      })
      if (r.ok) {
        const data = await r.json().catch(() => ({}))
        setKey(candidate)
        setOperator(data.name ? { name: data.name, role: data.role } : null)
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
    const s = io("/space", {
      transports: ["websocket", "polling"],
      auth: KEY ? { key: KEY } : {},
      reconnection: true
    })
    wireSocket(s)
    return s
  }

  const els = {
    connDot:      document.getElementById("conn-dot"),
    connLabel:    document.getElementById("conn-label"),
    spaceLink:    document.getElementById("space-link"),
    turnQueue:    document.getElementById("turn-queue"),
    uptime:       document.getElementById("uptime"),
    agents:       document.getElementById("agents"),
    transcript:   document.getElementById("transcript"),
    autoscroll:   document.getElementById("autoscroll"),
    injectText:   document.getElementById("inject-text"),
    injectFrom:   document.getElementById("inject-from"),
    injectSend:   document.getElementById("inject-send"),
    pulseRoutes:  document.getElementById("pulse-routes"),
    pulseUnavail: document.getElementById("pulse-unavail"),
    silenceBar:   document.getElementById("silence-alarm-bar"),
    silenceText:  document.getElementById("silence-alarm-text"),
    xtabOut:      document.getElementById("xtab-out"),
    healthBtn:    document.getElementById("health-refresh"),
    tpl:          document.getElementById("agent-card-tpl"),
    filterSearch: document.getElementById("transcript-search"),
    filterChips:  document.querySelectorAll(".chip[data-filter]"),
    exportBtn:    document.getElementById("export-btn"),
    exportMenu:   document.getElementById("export-menu"),
    exportCopy:   document.getElementById("export-copy"),
    exportTxt:    document.getElementById("export-txt"),
    exportJson:   document.getElementById("export-json"),
    chromeHealth: document.getElementById("chrome-health"),
  }

  // ---------- state ----------
  const state = {
    agents: {},              // id -> { id, name, status, ... }
    voices: {},              // id -> voice
    prompts: {},             // id -> instructions
    personalities: {},       // name -> { displayName, voice, tags }
    personalitiesActive: {}, // agentId -> name
    personalitiesOverride: {}, // agentId -> true when ad-hoc override active
    ttsMode: "realtime",     // "realtime" | "elevenlabs" — from /config
    currentTurn: null,
    turnQueue: [],
    turnMetrics: {},         // agentId -> { p50DurMs, p95DurMs, p50TtftMs, p95TtftMs, recent[] }
    streaming: {},           // messageId -> { agentId, text, el }
    seenMessageIds: new Set(),
  }

  // ---------- listen mode ----------
  // agentId -> { mode:"webrtc"|"el", audioEl, mediaSource?, sourceBuffer?, queue?, ... }
  const listenState = {}

  function processListenQueue(agentId) {
    const st = listenState[agentId]
    if (!st || !st.sourceBuffer || st.sourceBuffer.updating || st.queue.length === 0) return
    const chunk = st.queue.shift()
    try {
      st.sourceBuffer.appendBuffer(chunk)
      st.bufferedCount = (st.bufferedCount || 0) + 1
      if (st.bufferedCount >= 3 && !st.playing) {
        st.playing = true
        st.audioEl.play().catch(() => {})
      }
    } catch (e) {
      if (e.name === "QuotaExceededError") st.queue.unshift(chunk)
      console.warn("[listen] appendBuffer:", e.name)
    }
  }

  function appendListenChunk(agentId, chunk) {
    const st = listenState[agentId]
    if (!st) return
    let buf
    if (chunk instanceof ArrayBuffer) buf = chunk
    else if (chunk && chunk.buffer instanceof ArrayBuffer) buf = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
    else return
    if (st.mode === "webrtc") {
      st.queue.push(buf)
      processListenQueue(agentId)
    }
  }

  function startListenWebRTC(agentId) {
    if (!window.MediaSource) return false
    const mime = MediaSource.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
      : MediaSource.isTypeSupported("audio/ogg;codecs=opus") ? "audio/ogg;codecs=opus"
      : null
    if (!mime) return false
    const ms = new MediaSource()
    const audio = document.createElement("audio")
    audio.preload = "none"
    audio.playsInline = true
    document.body.appendChild(audio)
    const st = {
      mode: "webrtc", mime, mediaSource: ms, sourceBuffer: null,
      audioEl: audio, queue: [], bufferedCount: 0, playing: false, msOpen: false,
    }
    listenState[agentId] = st
    ms.addEventListener("sourceopen", () => {
      st.msOpen = true
      try {
        const sb = ms.addSourceBuffer(mime)
        st.sourceBuffer = sb
        sb.addEventListener("updateend", () => {
          try {
            if (!sb.updating && sb.buffered.length > 0) {
              const end = sb.buffered.end(0)
              if (end > 15) { sb.remove(0, end - 10); return }
            }
          } catch (_) {}
          processListenQueue(agentId)
        })
      } catch (e) { console.warn("[listen] SourceBuffer:", e); return }
      processListenQueue(agentId)
    })
    audio.src = URL.createObjectURL(ms)
    if (socket) socket.emit("listenSubscribe", { agentId })
    return true
  }

  function startListenEL(agentId) {
    const audio = document.createElement("audio")
    const keyParam = KEY ? "?key=" + encodeURIComponent(KEY) : ""
    audio.src = "/listen/" + agentId + keyParam
    audio.preload = "none"
    audio.autoplay = true
    audio.playsInline = true
    document.body.appendChild(audio)
    audio.play().catch(() => {})
    listenState[agentId] = { mode: "el", audioEl: audio }
    return true
  }

  function startListen(agentId) {
    if (listenState[agentId]) stopListen(agentId)
    const isEL = /^(elevenlabs|eleven|11labs)$/.test(state.ttsMode || "")
    const ok = isEL ? startListenEL(agentId) : startListenWebRTC(agentId)
    if (!ok) return
    const card = findCard(agentId)
    if (card) {
      card.querySelector(".listen-btn").classList.add("active")
      const savedVol = sessionStorage.getItem("xspace.vol." + agentId)
      if (savedVol !== null) {
        card.querySelector(".vol-slider").value = savedVol
        listenState[agentId].audioEl.volume = parseFloat(savedVol)
      }
    }
    updateListenAllBtn()
  }

  function stopListen(agentId) {
    const st = listenState[agentId]
    if (!st) return
    if (socket) socket.emit("listenUnsubscribe", { agentId })
    if (st.audioEl) {
      try { st.audioEl.pause() } catch (_) {}
      const blobSrc = st.audioEl.src
      st.audioEl.src = ""
      try { st.audioEl.remove() } catch (_) {}
      if (blobSrc && blobSrc.startsWith("blob:")) URL.revokeObjectURL(blobSrc)
    }
    if (st.mediaSource && st.mediaSource.readyState === "open") {
      try { st.mediaSource.endOfStream() } catch (_) {}
    }
    delete listenState[agentId]
    const card = findCard(agentId)
    if (card) {
      card.querySelector(".listen-btn").classList.remove("active")
      card.querySelector(".listen-latency").textContent = ""
    }
    updateListenAllBtn()
  }

  function updateListenAllBtn() {
    const btn = document.getElementById("listen-all-btn")
    if (!btn) return
    const ids = Object.keys(state.agents)
    const allOn = ids.length > 0 && ids.every(id => !!listenState[Number(id)])
    btn.classList.toggle("active", allOn)
  }

  // ---------- filter state ----------
  const filterState = {
    search: "",
    kinds: { agent: true, human: true, audit: true, injected: true },
  }
  // texts of pending operator-injected messages (cleared on echo match)
  const pendingInjectTexts = new Set()

  ;(function loadFilterState() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SS_FILTERS) || "null")
      if (!saved) return
      if (typeof saved.search === "string") filterState.search = saved.search
      if (saved.kinds && typeof saved.kinds === "object") Object.assign(filterState.kinds, saved.kinds)
    } catch (_) {}
  })()

  function saveFilterState() {
    try { sessionStorage.setItem(SS_FILTERS, JSON.stringify(filterState)) } catch (_) {}
  }

  // ---------- helpers ----------
  function fmtTime(ts) {
    const d = ts ? new Date(ts) : new Date()
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
  }
  function escapeText(s) { return s == null ? "" : String(s) }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  }
  function isAtBottom(el) {
    return el.scrollHeight - el.clientHeight - el.scrollTop < 40
  }
  function maybeScroll() {
    if (els.autoscroll.checked) els.transcript.scrollTop = els.transcript.scrollHeight
  }

  // ---------- toast notifications ----------
  const toastContainer = document.getElementById("toast-container")
  function showToast(message, durationMs = 3500) {
    const el = document.createElement("div")
    el.className = "toast"
    el.textContent = message
    toastContainer.appendChild(el)
    setTimeout(() => { el.remove() }, durationMs)
  }

  // ---------- transcript entry helpers ----------
  function kindFromClasses(classes) {
    if (!classes) return "agent"
    if (/\baudit\b/.test(classes))    return "audit"
    if (/\bhuman\b/.test(classes))    return "human"
    return "agent"
  }

  function addEntry({ id, classes, name, text, streaming, kind }) {
    if (!kind) kind = kindFromClasses(classes)
    const wrap = document.createElement("div")
    wrap.className = "t-entry " + (classes || "")
    wrap.dataset.kind = kind
    if (id) wrap.dataset.msgId = id
    if (streaming) wrap.classList.add("streaming")
    wrap.innerHTML = `<div class="t-time">${fmtTime()}</div>
      <div class="t-body"><span class="t-name"></span><span class="t-text"></span></div>`
    wrap.querySelector(".t-name").textContent = name ? name + ":" : ""
    wrap.querySelector(".t-text").textContent = text || ""
    els.transcript.appendChild(wrap)
    applyEntryFilter(wrap)
    if (wrap.style.display !== "none") maybeScroll()
    return wrap
  }

  function appendTo(entry, delta) {
    const span = entry.querySelector(".t-text")
    span.textContent += delta
    if (entry.style.display !== "none") maybeScroll()
  }

  function finalize(entry, text) {
    entry.classList.remove("streaming")
    if (text != null) entry.querySelector(".t-text").textContent = text
    // re-evaluate search filter now that the full text is known
    applyEntryFilter(entry)
  }

  // ---------- filter application ----------
  function applyEntryFilter(entry) {
    // always show streaming entries — re-evaluated in finalize()
    if (entry.classList.contains("streaming")) {
      entry.style.display = ""
      return
    }
    const kind = entry.dataset.kind || "agent"
    const kindActive = filterState.kinds[kind] !== false
    const q = filterState.search.trim().toLowerCase().replace(/\s+/g, " ")
    const haystack = (entry.textContent || "").toLowerCase().replace(/\s+/g, " ")
    const matchSearch = !q || haystack.indexOf(q) !== -1
    entry.style.display = (kindActive && matchSearch) ? "" : "none"
  }

  function applyFilters() {
    const entries = els.transcript.querySelectorAll(".t-entry")
    if (entries.length > 200) {
      requestAnimationFrame(() => { for (const e of entries) applyEntryFilter(e) })
    } else {
      for (const e of entries) applyEntryFilter(e)
    }
  }

  // ---------- export helpers ----------
  function getVisibleEntries() {
    return Array.from(els.transcript.querySelectorAll(".t-entry"))
      .filter(e => e.style.display !== "none")
  }

  function entryToText(entry) {
    const time = (entry.querySelector(".t-time") || {}).textContent || ""
    const name = ((entry.querySelector(".t-name") || {}).textContent || "").replace(/:$/, "")
    const text = (entry.querySelector(".t-text") || {}).textContent || ""
    return `[${time}] ${name}: ${text}`
  }

  function entryToJSON(entry) {
    const time = (entry.querySelector(".t-time") || {}).textContent || ""
    const name = ((entry.querySelector(".t-name") || {}).textContent || "").replace(/:$/, "")
    const text = (entry.querySelector(".t-text") || {}).textContent || ""
    return {
      id:        entry.dataset.msgId || null,
      kind:      entry.dataset.kind || null,
      name,
      text,
      timestamp: time,
      isUser:    entry.classList.contains("human"),
      isAudit:   entry.classList.contains("audit"),
    }
  }

  function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url; a.download = filename; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }

  function auditEntry(text) {
    const id = "local-audit-" + Date.now()
    if (state.seenMessageIds.has(id)) return
    state.seenMessageIds.add(id)
    addEntry({ id, classes: "audit", kind: "audit", name: "audit", text })
  }

  // ---------- filter UI setup ----------
  function setupFilters() {
    els.filterSearch.value = filterState.search
    for (const chip of els.filterChips) {
      const kind = chip.dataset.filter
      const active = filterState.kinds[kind] !== false
      chip.setAttribute("aria-pressed", String(active))
      chip.classList.toggle("active", active)
    }

    els.filterSearch.addEventListener("input", () => {
      filterState.search = els.filterSearch.value
      saveFilterState()
      applyFilters()
    })

    for (const chip of els.filterChips) {
      chip.addEventListener("click", () => {
        const kind = chip.dataset.filter
        filterState.kinds[kind] = !filterState.kinds[kind]
        chip.setAttribute("aria-pressed", String(filterState.kinds[kind]))
        chip.classList.toggle("active", filterState.kinds[kind])
        saveFilterState()
        applyFilters()
      })
    }

    // export dropdown — click outside closes it
    els.exportBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      els.exportMenu.hidden = !els.exportMenu.hidden
    })
    document.addEventListener("click", () => { els.exportMenu.hidden = true })

    els.exportCopy.addEventListener("click", () => {
      const lines = getVisibleEntries().map(entryToText).join("\n")
      navigator.clipboard.writeText(lines).catch(() => {})
      els.exportMenu.hidden = true
    })

    els.exportTxt.addEventListener("click", () => {
      const lines = getVisibleEntries().map(entryToText).join("\n")
      downloadFile("transcript.txt", lines, "text/plain;charset=utf-8")
      els.exportMenu.hidden = true
    })

    els.exportJson.addEventListener("click", () => {
      const entries = getVisibleEntries()
      const data = entries.map(entryToJSON)
      downloadFile("transcript.json", JSON.stringify(data, null, 2), "application/json")
      auditEntry(`export transcript (${data.length} entries)`)
      els.exportMenu.hidden = true
    })
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
      applyRoleUI()
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
      badge.title = agent.lastReconnectAt
        ? "last reconnect: " + fmtTime(agent.lastReconnectAt)
        : ""
      // Show/hide retry button based on deadlocked status
      const retryBtn = card.querySelector(".retry-deadlock")
      if (retryBtn) retryBtn.hidden = status !== "deadlocked"
      const promptEl = card.querySelector(".prompt-text")
      if (document.activeElement !== promptEl) {
        const next = state.prompts[id] ?? state.prompts[Number(id)] ?? ""
        if (promptEl.value !== next) promptEl.value = next
      }
      populatePicker(card, Number(id))
    }

    function populatePicker(card, agentId) {
      const picker = card.querySelector(".personality-picker")
      if (!picker) return
      const current = state.personalitiesActive[agentId] ?? state.personalitiesActive[String(agentId)]
      picker.innerHTML = ""
      // Placeholder when no personalities loaded yet
      if (!Object.keys(state.personalities).length) {
        const opt = document.createElement("option")
        opt.value = ""; opt.textContent = "no personalities loaded"
        picker.appendChild(opt)
        return
      }
      for (const [name, p] of Object.entries(state.personalities)) {
        const opt = document.createElement("option")
        opt.value = name
        opt.textContent = p.displayName || name
        if (name === current) opt.selected = true
        picker.appendChild(opt)
      }
      // Reflect override state on the badge
      const badge = card.querySelector(".override-badge")
      if (badge) badge.hidden = !state.personalitiesOverride[agentId]
    }

    function wireCard(card, agentId) {
      card.querySelector(".kick").addEventListener("click", () => {
        socket.emit("kickRequest", { agentId })
      })
      card.querySelector(".retry-deadlock").addEventListener("click", () => {
        socket.emit("kickConnect", { agentId })
        const retryBtn = card.querySelector(".retry-deadlock")
        if (retryBtn) retryBtn.hidden = true
      })
      card.querySelector(".kick-instructed").addEventListener("click", () => {
        const instructions = window.prompt("Kick with custom instructions (sent as response.create)?", "")
        if (instructions == null) return
        socket.emit("kickRequest", { agentId, instructions: instructions.trim() || null })
      })
      card.querySelector(".save-prompt").addEventListener("click", () => {
        const instructions = card.querySelector(".prompt-text").value
        socket.emit("promptUpdate", { agentId, instructions })
        state.personalitiesOverride[agentId] = true
        const overrideBadge = card.querySelector(".override-badge")
        if (overrideBadge) overrideBadge.hidden = false
        const statusEl = card.querySelector(".save-status")
        statusEl.textContent = "pushed @ " + fmtTime()
        setTimeout(() => { statusEl.textContent = "" }, 4000)
      })
      card.querySelector(".save-as-btn").addEventListener("click", async () => {
        const instructions = card.querySelector(".prompt-text").value.trim()
        if (!instructions) return
        const rawName = window.prompt("Name for this personality (lowercase, hyphens ok):", "")
        if (!rawName) return
        const name = rawName.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/, "")
        if (!name) { alert("Invalid name"); return }
        const displayName = window.prompt("Display name:", rawName) || rawName
        try {
          const r = await authedFetch("/personalities", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, displayName, prompt: instructions })
          })
          const data = await r.json()
          if (!r.ok) { alert("Error: " + (data.error || r.status)); return }
          const statusEl = card.querySelector(".save-status")
          statusEl.textContent = `saved as "${name}"  @ ` + fmtTime()
          setTimeout(() => { statusEl.textContent = "" }, 5000)
        } catch (err) {
          alert("Error: " + err.message)
        }
      })
      card.querySelector(".personality-picker").addEventListener("change", (e) => {
        const name = e.target.value
        if (!name) return
        socket.emit("personalityActivate", { agentId, name })
      })
      card.querySelector(".listen-btn").addEventListener("click", () => {
        if (listenState[agentId]) stopListen(agentId)
        else startListen(agentId)
      })
      card.querySelector(".vol-slider").addEventListener("input", (e) => {
        const vol = parseFloat(e.target.value)
        sessionStorage.setItem("xspace.vol." + agentId, vol)
        const st = listenState[agentId]
        if (st && st.audioEl) st.audioEl.volume = vol
      })
      const savedVol = sessionStorage.getItem("xspace.vol." + agentId)
      if (savedVol !== null) card.querySelector(".vol-slider").value = savedVol
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
      // Clear silence alarm when audio recovers
      if (Number(level) >= 0.02 && !els.silenceBar.hidden) {
        const alarmFor = els.silenceText.dataset.agentId
        if (alarmFor == null || String(agentId) === alarmFor) els.silenceBar.hidden = true
      }
    })

    // ---------- silence alarm ----------
    socket.on("silenceAlarm", ({ agentId, agentName, durationMs }) => {
      const name = agentName || state.agents[agentId]?.name || `Agent ${agentId}`
      const secs = Math.round((durationMs || 0) / 1000)
      els.silenceText.textContent = `🔇 ${name} — silent ${secs}s while speaking`
      els.silenceText.dataset.agentId = String(agentId)
      els.silenceBar.hidden = false
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("🔇 Silence Alarm", {
          body: `${name} has been silent for ${secs}s while status is speaking`,
          tag: `silence-${agentId}`,
          renotify: true
        })
      }
    })

    // ---------- listen mode audio streaming ----------
    socket.on("listenAudioInit", ({ agentId, mime, chunk }) => {
      const st = listenState[agentId]
      if (!st || st.mode !== "webrtc") return
      appendListenChunk(agentId, chunk)
    })

    socket.on("listenAudio", ({ agentId, mime, chunk, t }) => {
      const st = listenState[agentId]
      if (!st || st.mode !== "webrtc") return
      if (t) {
        const lag = Math.max(0, Date.now() - t)
        const card = findCard(agentId)
        if (card) {
          const latEl = card.querySelector(".listen-latency")
          if (latEl) latEl.textContent = "~" + lag + "ms"
        }
      }
      appendListenChunk(agentId, chunk)
    })

    // ---------- header / turn ----------
    function renderTurnQueue() {
      if (!els.turnQueue) return
      const chips = []
      if (state.currentTurn !== null && state.currentTurn !== undefined) {
        const name = escapeText(state.agents[state.currentTurn]?.name || `Agent ${state.currentTurn}`)
        chips.push(`<span class="q-chip active">${name} · speaking</span>`)
      }
      for (const id of (state.turnQueue || [])) {
        const name = escapeText(state.agents[id]?.name || `Agent ${id}`)
        chips.push(`<span class="q-arrow">→</span><span class="q-chip queued">${name} · queued</span>`)
      }
      els.turnQueue.innerHTML = chips.length ? chips.join("") : '<span class="q-idle">idle</span>'
    }

    function latClass(ms, good, warn) {
      if (ms == null) return ""
      return ms <= good ? "lat-good" : ms <= warn ? "lat-warn" : "lat-bad"
    }
    function fmtMs(ms) {
      if (ms == null) return "—"
      return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s"
    }

    function renderLatency(card, agentId) {
      const m = state.turnMetrics[agentId] || state.turnMetrics[String(agentId)]
      const row = card && card.querySelector(".latency-row")
      if (!row) return
      if (!m || !m.count) { row.hidden = true; return }
      row.hidden = false
      const last = m.recent && m.recent[m.recent.length - 1]
      const lastMs = last ? last.durationMs : null
      const ttftMs = last ? last.ttftMs : null
      const p95Ms  = m.p95DurMs
      const setSpan = (sel, ms, good, warn) => {
        const el = row.querySelector(sel)
        if (el) { el.className = sel.slice(1) + " " + latClass(ms, good, warn); el.textContent = fmtMs(ms) }
      }
      setSpan(".lat-last", lastMs, 3000, 6000)
      setSpan(".lat-ttft", ttftMs, 500, 1500)
      setSpan(".lat-p95", p95Ms, 3000, 6000)
    }

    function renderSparkline(card, agentId) {
      const m = state.turnMetrics[agentId] || state.turnMetrics[String(agentId)]
      const el = card && card.querySelector(".sparkline")
      if (!el) return
      const recent = (m && m.recent ? m.recent : []).slice(-8)
      if (!recent.length) { el.innerHTML = ""; return }
      const maxMs = Math.max(...recent.map(r => r.durationMs || 0), 1)
      el.innerHTML = recent.map(r => {
        const pct = Math.max(4, Math.round(((r.durationMs || 0) / maxMs) * 100))
        const cls = (r.durationMs || 0) > 6000 ? " bad" : (r.durationMs || 0) > 3000 ? " warn" : ""
        return `<div class="spark-bar${cls}" style="height:${pct}%" title="${fmtMs(r.durationMs)}"></div>`
      }).join("")
    }

    socket.on("stateUpdate", ({ agents, currentTurn, turnQueue }) => {
      if (agents) state.agents = agents
      if (currentTurn !== undefined) state.currentTurn = currentTurn ?? null
      if (Array.isArray(turnQueue)) state.turnQueue = turnQueue
      renderAgents()
      renderTurnQueue()
    })

    socket.on("agentStatus", ({ agentId, status, name }) => {
      if (!state.agents[agentId]) state.agents[agentId] = { id: agentId, name, status }
      else { state.agents[agentId].status = status; if (name) state.agents[agentId].name = name }
      const card = findCard(agentId)
      if (card) updateCard(card, state.agents[agentId])
    })

    socket.on("agentDeadlock", ({ agentId }) => {
      if (state.agents[agentId]) state.agents[agentId].status = "deadlocked"
      const card = findCard(agentId)
      if (card) updateCard(card, state.agents[agentId] || { id: agentId, status: "deadlocked" })
    })

    socket.on("turnGranted", ({ agentId }) => {
      state.currentTurn = agentId
      renderTurnQueue()
    })

    socket.on("turnComplete", ({ agentId, durationMs, ttftMs, chars }) => {
      const m = state.turnMetrics[agentId] || (state.turnMetrics[agentId] = { count: 0, p50DurMs: null, p95DurMs: null, p50TtftMs: null, p95TtftMs: null, recent: [] })
      m.recent.push({ durationMs, ttftMs, chars })
      if (m.recent.length > 8) m.recent.shift()
      m.count = (m.count || 0) + 1
      const card = findCard(agentId)
      if (card) { renderLatency(card, agentId); renderSparkline(card, agentId) }
    })

    // ---------- transcript ----------
    socket.on("messageHistory", (history) => {
      if (!Array.isArray(history)) return
      els.transcript.innerHTML = ""
      state.seenMessageIds.clear()
      for (const m of history) {
        if (!m || !m.id) continue
        state.seenMessageIds.add(String(m.id))
        const klass = m.isUser ? "human" : `agent-${m.agentId}`
        const kind  = m.isUser ? "human" : "agent"
        addEntry({ id: m.id, classes: klass, kind, name: m.name || (m.isUser ? "User" : `Agent ${m.agentId}`), text: m.text })
      }
    })

    socket.on("textDelta", ({ agentId, delta, messageId, name }) => {
      if (!messageId) return
      let s = state.streaming[messageId]
      if (!s) {
        const entry = addEntry({
          id: messageId,
          classes: `agent-${agentId}`,
          kind: "agent",
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
        const kind  = msg.isUser ? "human" : "agent"
        addEntry({
          id: msg.id, classes: klass, kind,
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
      const isInjected = pendingInjectTexts.has(msg.text)
      if (isInjected) pendingInjectTexts.delete(msg.text)
      const kind    = isInjected ? "injected" : "human"
      const classes = isInjected ? "human injected" : "human"
      addEntry({ id: msg.id, classes, kind, name: msg.name || "User", text: msg.text })
    })

    socket.on("humanTranscript", ({ agentId, name, text }) => {
      addEntry({ classes: "human", kind: "human", name: name || "Human (Space)", text })
    })

    socket.on("pumpfunMessage", (msg) => {
      if (!msg) return
      addEntry({ classes: "human", kind: "human", name: msg.name || "external", text: msg.text })
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
      addEntry({ id: msg.id, classes: "audit", kind: "audit", name: msg.name || "audit", text: msg.text })
    })

    socket.on("personalitiesUpdated", (data) => {
      if (data && data.personalities) state.personalities = data.personalities
      if (data && data.active) state.personalitiesActive = data.active
      if (data && data.overrides) state.personalitiesOverride = data.overrides
      els.agents.querySelectorAll(".agent-card").forEach(card => {
        const id = Number(card.dataset.agentId)
        populatePicker(card, id)
      })
    })

    socket.on("personalityActivated", ({ agentId, name }) => {
      state.personalitiesActive[agentId] = name
      delete state.personalitiesOverride[agentId]
      const card = findCard(agentId)
      if (!card) return
      const picker = card.querySelector(".personality-picker")
      if (picker) picker.value = name
      const badge = card.querySelector(".override-badge")
      if (badge) badge.hidden = true
    })

    socket.on("promptOverrideActive", ({ agentId }) => {
      state.personalitiesOverride[agentId] = true
      const card = findCard(agentId)
      if (!card) return
      const badge = card.querySelector(".override-badge")
      if (badge) badge.hidden = false
    })

    socket.on("rateLimited", ({ event, retryAfterMs }) => {
      const retry = Math.ceil((retryAfterMs || 1000) / 1000)
      showToast(`Rate-limited: ${event} — retry in ${retry}s`)
      // Briefly disable the relevant action buttons so operators notice the limit.
      const selectors = []
      if (event === "kickRequest")   selectors.push(".kick", ".kick-instructed")
      if (event === "promptUpdate")  selectors.push(".save-prompt")
      if (event === "userMessage")   selectors.push("#inject-send")
      if (event.startsWith("xspace")) selectors.push("[data-xspace-btn]")
      const ms = retryAfterMs || 1000
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(btn => {
          btn.disabled = true
          setTimeout(() => { btn.disabled = false }, ms)
        })
      })
    })

    // ---------- X tab watchdog events ----------
    socket.on("xTabAlert", ({ portName, alive, url, reason }) => {
      const ts = new Date().toLocaleTimeString()
      const bannerId = `xtab-banner-${portName}`
      const existing = document.getElementById(bannerId)
      if (existing) existing.remove()
      const banner = document.createElement("div")
      banner.id = bannerId
      banner.className = "x-tab-alert"
      banner.innerHTML = `<span>X tab down: <strong>${portName}</strong> — ${reason || "unreachable"}${url ? ` (${url})` : ""} <span class="muted" style="font-weight:400;font-size:11px">${ts}</span></span><button class="banner-close" title="dismiss">×</button>`
      banner.querySelector(".banner-close").addEventListener("click", () => banner.remove())
      document.getElementById("xtab-banners").appendChild(banner)
      auditEntry(`⚠ X tab alert: ${portName} — ${reason || "unreachable"}${url ? " — " + url : ""}`)
    })

    socket.on("xTabRecovered", ({ portName, url }) => {
      const bannerId = `xtab-banner-${portName}`
      const existing = document.getElementById(bannerId)
      if (existing) existing.remove()
      auditEntry(`✓ X tab recovered: ${portName}${url ? " — " + url : ""}`)
    })

    socket.on("xTabLoginExpired", ({ portName }) => {
      const ts = new Date().toLocaleTimeString()
      const bannerId = `xtab-login-${portName}`
      const existing = document.getElementById(bannerId)
      if (existing) existing.remove()
      const banner = document.createElement("div")
      banner.id = bannerId
      banner.className = "x-tab-warn"
      banner.innerHTML = `<span>X cookies expired on <strong>${portName}</strong> — re-export <code>auth_token</code> + <code>ct0</code> <span class="muted" style="font-weight:400;font-size:11px">${ts}</span></span><button class="banner-close" title="dismiss">×</button>`
      banner.querySelector(".banner-close").addEventListener("click", () => banner.remove())
      document.getElementById("xtab-banners").appendChild(banner)
      auditEntry(`⚠ X cookies expired: ${portName}`)
    })

    socket.on("xTabHealthSnapshot", ({ ports, timestamp }) => {
      renderChromeHealth(ports, timestamp)
    })
  } // end wireSocket

  // ---------- inject ----------
  function sendInject() {
    if (!socket) return
    const text = els.injectText.value.trim()
    if (!text) return
    // track before echo so userMessage handler can tag it as injected
    pendingInjectTexts.add(text)
    socket.emit("userMessage", { text, from: els.injectFrom.value.trim() || "Operator" })
    els.injectText.value = ""
    els.injectText.focus()
  }
  els.injectSend.addEventListener("click", sendInject)
  els.injectText.addEventListener("keydown", (e) => { if (e.key === "Enter") sendInject() })

  // ---------- bootstrap from REST ----------
  async function bootstrap() {
    try {
      const [stateR, cfgR, infoR, configR, persR] = await Promise.all([
        authedFetch("/state").then(r => r.json()).catch(() => ({})),
        authedFetch("/agent-config").then(r => r.json()).catch(() => ({})),
        fetch("/space-info").then(r => r.json()).catch(() => ({})),
        fetch("/config").then(r => r.json()).catch(() => ({})),
        authedFetch("/personalities").then(r => r.json()).catch(() => ({})),
      ])
      if (stateR.agents) state.agents = stateR.agents
      if (cfgR.voices)  state.voices  = cfgR.voices
      if (cfgR.prompts) state.prompts = cfgR.prompts
      if (cfgR.active)  state.personalitiesActive = cfgR.active
      if (cfgR.overrides) state.personalitiesOverride = cfgR.overrides
      if (persR.personalities) state.personalities = persR.personalities
      if (configR.ttsMode) state.ttsMode = configR.ttsMode
      if (stateR.currentTurn !== undefined) state.currentTurn = stateR.currentTurn ?? null
      if (Array.isArray(stateR.turnQueue)) state.turnQueue = stateR.turnQueue
      renderAgents()
      renderTurnQueue()
      try {
        const tm = await authedFetch("/metrics/turns").then(r => r.json())
        for (const [id, data] of Object.entries(tm || {})) {
          state.turnMetrics[id] = data
          const card = findCard(Number(id))
          if (card) { renderLatency(card, Number(id)); renderSparkline(card, Number(id)) }
        }
      } catch (_) { /* non-fatal */ }
      try {
        const ch = await authedFetch("/chrome-health").then(r => r.json())
        renderChromeHealth(ch.ports, ch.timestamp)
      } catch (_) { /* non-fatal */ }
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
          const kind  = m.isUser ? "human" : "agent"
          addEntry({ id: m.id, classes: klass, kind, name: m.name, text: m.text })
        }
      }
    } catch (e) {
      console.warn("bootstrap failed", e)
    }
  }

  // ---------- pulse route table ----------
  function renderPulseRoutes(pulse) {
    if (!pulse || !pulse.available) {
      els.pulseRoutes.innerHTML = ""
      els.pulseUnavail.hidden = false
      return
    }
    els.pulseUnavail.hidden = true
    const inputs = pulse.sinkInputs || []
    if (inputs.length === 0) {
      els.pulseRoutes.innerHTML = '<span class="pulse-empty muted small">No sink-inputs detected</span>'
      return
    }

    const rows = inputs.map(si => {
      const sink      = (pulse.sinks || []).find(s => s.name === si.sink)
      const monName   = si.sink ? si.sink + ".monitor" : null
      const sourceOut = monName ? (pulse.sourceOuts || []).find(so => so.source === monName) : null

      const siLabel   = si.client || `sink-input #${si.index}`
      const sinkLabel = si.sink   || `sink #${si.sinkIndex ?? "?"}`
      const monLabel  = monName   || "monitor"
      const soLabel   = sourceOut?.client || (sourceOut ? `source-out #${sourceOut.index}` : null)

      const siOk   = !si.muted && (si.volume == null || si.volume > 0)
      const sinkOk = sink ? !sink.muted : false
      const monOk  = !!sourceOut
      const soOk   = !!sourceOut

      const muteAction = si.muted ? "unmute" : "mute"
      const muteTip    = si.muted ? "click to unmute" : "click to mute"
      const volStr   = si.volume != null ? `<span class="hop-vol">${si.volume}%</span>` : ""
      const mutedStr = si.muted ? '<span class="hop-muted">muted</span>' : ""
      const soHop    = soLabel ? `
          <span class="pulse-arrow">──▶</span>
          <div class="pulse-hop ${soOk ? "ok" : "err"}">
            <span class="hop-dot"></span>
            <span>${escapeHtml(soLabel)}</span>
          </div>` : ""

      return `<div class="pulse-route">
        <div class="pulse-hops">
          <button class="pulse-hop ${siOk ? "ok" : "err"}"
              data-pulse-action="${muteAction}" data-pulse-idx="${si.index}" title="${muteTip}">
            <span class="hop-dot"></span>
            <span>${escapeHtml(siLabel)}</span>
            ${volStr}${mutedStr}
          </button>
          <span class="pulse-arrow">──▶</span>
          <div class="pulse-hop ${sinkOk ? "ok" : "err"}">
            <span class="hop-dot"></span>
            <span>${escapeHtml(sinkLabel)}</span>
          </div>
          <span class="pulse-arrow">──▶</span>
          <div class="pulse-hop ${monOk ? "ok" : "err"}">
            <span class="hop-dot"></span>
            <span>${escapeHtml(monLabel)}</span>
          </div>
          ${soHop}
        </div>
      </div>`
    }).join("")

    els.pulseRoutes.innerHTML = rows

    els.pulseRoutes.querySelectorAll("[data-pulse-action]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.pulseAction
        const idx    = btn.dataset.pulseIdx
        try {
          await authedFetch(`/pulse/${action}/${idx}`, { method: "POST" })
          await refreshHealth()
        } catch (e) {
          console.error("[pulse toggle]", e)
        }
      })
    })
  }

  // ---------- health ----------
  async function refreshHealth() {
    els.xtabOut.textContent = "loading…"
    try {
      const h = await authedFetch("/health").then(r => r.json())
      if (h.uptime != null) els.uptime.textContent = formatUptime(h.uptime)
      renderPulseRoutes(h.pulse)
    } catch (e) {
      renderPulseRoutes(null)
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
  function fmtAgo(ts) {
    if (!ts) return "never"
    const s = Math.round((Date.now() - ts) / 1000)
    if (s < 60)  return s + "s ago"
    if (s < 3600) return Math.floor(s / 60) + "m ago"
    return Math.floor(s / 3600) + "h ago"
  }

  function renderChromeHealth(ports, _timestamp) {
    if (!els.chromeHealth) return
    if (!ports || !Object.keys(ports).length) {
      els.chromeHealth.textContent = "no data yet"
      return
    }
    const lines = Object.entries(ports).map(([name, info]) => {
      const dotCls = info.alive ? "alive" : "dead"
      const seen   = info.alive ? `last seen ${fmtAgo(info.lastAliveAt)}` : `down since ${fmtAgo(info.lastAliveAt)}`
      const urlStr = info.url ? ` — ${info.url.slice(0, 60)}` : ""
      const tag    = info.isLoginPage ? " [login page]" : (info.isSpace ? " [✓ space]" : (info.url ? " [?]" : ""))
      return `<span class="cdp-dot ${dotCls}"></span><strong>${name}</strong> ${seen}${urlStr}${tag}`
    })
    els.chromeHealth.innerHTML = lines.join("<br>")
  }

  els.healthBtn.addEventListener("click", refreshHealth)

  // ---------- listen-all button ----------
  document.getElementById("listen-all-btn")?.addEventListener("click", () => {
    const ids = Object.keys(state.agents).map(Number)
    const anyOff = ids.some(id => !listenState[id])
    if (anyOff) ids.forEach(id => { if (!listenState[id]) startListen(id) })
    else        ids.forEach(id => stopListen(id))
    updateListenAllBtn()
  })

  // ---------- connect lifecycle ----------
  async function connect() {
    socket = makeSocket()
    await bootstrap()
    refreshHealth()
    if (window.DashCostPanel) window.DashCostPanel.init(socket, authedFetch)
  }

  async function init() {
    // Request notification permission early so the operator gets paged on silence alarm
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {})
    }

    try {
      const info = await fetch("/auth/info").then(r => r.json())
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
      const r = await fetch("/auth/check", {
        method: "POST",
        headers: { "Authorization": "Bearer " + KEY }
      })
      if (r.ok) {
        const data = await r.json().catch(() => ({}))
        setOperator(data.name ? { name: data.name, role: data.role } : null)
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

  setupFilters()
  init()
  setInterval(() => { if (socket && socket.connected) refreshHealth() }, 30000)
})()
