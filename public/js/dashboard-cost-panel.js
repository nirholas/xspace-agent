/* Cost & voices panel for /dashboard. Init via window.DashCostPanel.init(socket, authedFetch). */
(function () {
  "use strict"

  let _socket = null
  let _authedFetch = null
  let _rafPending = false
  let _pendingData = null
  const _seenAuditIds = new Set()

  function q(id) { return document.getElementById(id) }
  function val(v) { return v == null ? "—" : String(v) }
  function fmt(n) {
    if (n == null) return "—"
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k"
    return String(n)
  }

  function applyData(data) {
    if (!data) return
    if (data._unavailable) {
      q("cost-metrics-note").hidden = false
      return
    }
    q("cost-metrics-note").hidden = true

    const el = data.elevenlabs || {}
    const configured = el.configured !== false
    q("cost-el-unconfigured").hidden = configured
    q("cost-el-configured").hidden = !configured
    if (configured) {
      const chars = el.charsToday ?? null
      const cap = el.dailyCap ?? null
      const pct = cap ? Math.min(100, ((chars || 0) / cap) * 100) : 0
      const fill = q("el-bar-fill")
      fill.style.width = pct.toFixed(1) + "%"
      fill.dataset.level = pct >= 95 ? "danger" : pct >= 80 ? "warn" : ""
      q("el-bar-label").textContent = cap
        ? "ElevenLabs today: " + fmt(chars) + " / " + fmt(cap) + " chars"
        : "ElevenLabs today: " + fmt(chars) + " chars"
    }

    q("oai-sessions-count").textContent = val(data.openai?.sessionsToday)
    q("counter-rate-limited").textContent = val(data.rateLimited)
    q("counter-upstream-errors").textContent = val(data.upstreamErrors)
    q("counter-80pct").textContent = data.costWarning80 ? "yes" : "no"
  }

  function scheduleApply(data) {
    _pendingData = data
    if (_rafPending) return
    _rafPending = true
    requestAnimationFrame(() => {
      _rafPending = false
      applyData(_pendingData)
      _pendingData = null
    })
  }

  async function poll() {
    if (!_authedFetch) return
    try {
      const r = await _authedFetch("/metrics")
      if (r.status === 404) { scheduleApply({ _unavailable: true }); return }
      if (!r.ok) return
      const data = await r.json()
      scheduleApply(data)
    } catch (e) {
      console.warn("[cost-panel] poll error:", e.message)
    }
  }

  function prependAudit(text) {
    const list = q("voice-audit-list")
    if (!list) return
    const li = document.createElement("li")
    li.textContent = text
    list.insertBefore(li, list.firstChild)
    while (list.children.length > 5) list.removeChild(list.lastChild)
    q("audit-empty").hidden = true
  }

  function onAuditLog({ id, text } = {}) {
    if (!id || _seenAuditIds.has(String(id))) return
    _seenAuditIds.add(String(id))
    if (/voice change/i.test(text || "")) prependAudit(text)
  }

  function onCostWarning({ pct } = {}) {
    const title = q("cost-panel-title")
    if (!title) return
    title.dataset.warn = pct >= 95 ? "danger" : pct >= 80 ? "warn" : ""
  }

  function onVoiceUpdated({ agentId, voiceId } = {}) {
    const sel = q("voice-select-" + agentId)
    if (sel && sel.value !== String(voiceId)) sel.value = String(voiceId)
  }

  async function loadVoices() {
    const rows = q("voice-rows")
    if (!rows || !_authedFetch) return
    try {
      const r = await _authedFetch("/voices")
      if (!r.ok) {
        rows.innerHTML = '<p class="muted small">Voice list unavailable.</p>'
        return
      }
      const { voices, current } = await r.json()
      rows.innerHTML = ""
      const ids = Object.keys(current || {}).map(Number).sort()
      const agentCount = ids.length || 2
      for (let id = 0; id < agentCount; id++) {
        const wrap = document.createElement("div")
        wrap.className = "voice-row"
        const label = document.createElement("span")
        label.className = "muted small voice-row-label"
        label.textContent = "Agent " + id + ":"
        const sel = document.createElement("select")
        sel.id = "voice-select-" + id
        sel.className = "voice-select"
        ;(voices || []).forEach(v => {
          const opt = document.createElement("option")
          opt.value = v.id
          opt.textContent = v.name || v.id
          if ((current || {})[id] === v.id) opt.selected = true
          sel.appendChild(opt)
        })
        sel.addEventListener("change", () => {
          _socket && _socket.emit("setVoice", { agentId: id, voiceId: sel.value })
        })
        const previewBtn = document.createElement("button")
        previewBtn.className = "ghost preview-btn"
        previewBtn.textContent = "preview"
        previewBtn.disabled = true
        previewBtn.title = "Preview pending — see Voice Task 13"
        wrap.append(label, sel, previewBtn)
        rows.appendChild(wrap)
      }
    } catch (e) {
      rows.innerHTML = '<p class="muted small">Could not load voices.</p>'
    }
  }

  function init(socket, authedFetch) {
    if (_socket) {
      _socket.off("auditLog", onAuditLog)
      _socket.off("costWarning", onCostWarning)
      _socket.off("voiceUpdated", onVoiceUpdated)
    }
    _socket = socket
    _authedFetch = authedFetch
    socket.on("auditLog", onAuditLog)
    socket.on("costWarning", onCostWarning)
    socket.on("voiceUpdated", onVoiceUpdated)
    loadVoices()
    poll()
    setInterval(poll, 10_000)
  }

  window.DashCostPanel = { init }
})()
