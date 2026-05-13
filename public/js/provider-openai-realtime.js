// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent) [§32]

// OpenAI Realtime WebRTC provider — extracted from original agent HTML
//
// Three output modes:
//   - "realtime" (default): model speaks via its own audio track over WebRTC.
//   - "elevenlabs": model emits text only, page streams MP3 via HTTP from /tts/:id/stream.
//   - "elevenlabs-ws": same as above but uses a persistent WebSocket to /tts-ws/:id for
//     ~100–200 ms lower first-byte latency. Opt-in until proven stable.
// Toggle via URL query (?tts=elevenlabs[-ws]) or AGENT_CONFIG.tts. Defaults to realtime.
function initOpenAIRealtime(agent) {
  let pc = null
  let dc = null

  const ttsModeRaw = (() => {
    try {
      const q = new URLSearchParams(window.location.search).get("tts")
      return (q || window.AGENT_CONFIG?.tts || "realtime").toString().toLowerCase()
    } catch (_) { return "realtime" }
  })()
  const USE_ELEVEN = ttsModeRaw === "elevenlabs" || ttsModeRaw === "eleven" || ttsModeRaw === "11labs"
  if (USE_ELEVEN) agent.log("TTS mode: ElevenLabs HTTP streaming", "success")
  const USE_ELEVEN_WS = ttsModeRaw === "elevenlabs-ws" || ttsModeRaw === "eleven-ws"
  if (USE_ELEVEN_WS) agent.log("TTS mode: ElevenLabs WebSocket streaming", "success")
  // Both EL modes need text-only output from the model.
  const NEEDS_TEXT_ONLY = USE_ELEVEN || USE_ELEVEN_WS

  // Sequential MP3 playback queue (so chunks don't overlap).
  let speakChain = Promise.resolve()
  let pendingUtterances = 0
  let elevenAudioCtx = null
  let lastVoiceId = null

  // Barge-in state (EL mode only).
  let currentAudioEl = null
  let speakChainAbort = new AbortController()
  let bargedIn = false

  // WS TTS state (elevenlabs-ws mode).
  let elWs = null           // persistent browser↔server WebSocket
  let elWsReady = false
  let elWsOpenCbs = []      // callbacks fired when WS opens or fails
  let elAudioElWs = null    // <audio> element for current WS turn
  let elMsWs = null         // MediaSource for current WS turn
  let elSbWs = null         // SourceBuffer for current WS turn
  let elBufQueueWs = []     // Uint8Array chunks queued until SourceBuffer is ready
  let elWsFallbackText = null  // text to replay via HTTP if WS drops mid-turn
  let elWsResponseStart = 0    // Date.now() when turn started (first-byte latency)
  let elWsFirstByteSeen = false

  // Reconnect state.
  let intentionalClose = false
  let reconnectAttempt = 0
  let reconnectPending = false  // prevents duplicate scheduleReconnect calls
  let deadlocked = false        // set after 5 consecutive failures; cleared on manual click

  // Mic stream — acquired once and reused across reconnects to avoid permission re-prompts.
  let micStream = null

  // Latest prompt pushed by the dashboard — re-applied to every new session so
  // reconnects pick up live prompt changes instead of falling back to defaults.
  let currentPrompt = null

  // Health-ping state.
  let healthPingTimer = null
  let healthPingTimeout = null

  // Backoff delays: 1 s, 2 s, 4 s, 8 s, 15 s, 30 s
  const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000]
  function backoff(attempt) {
    return BACKOFF_DELAYS[Math.min(attempt, BACKOFF_DELAYS.length - 1)]
  }

  // ------------------------------------------------------------------ health ping

  function startHealthPing() {
    stopHealthPing()
    healthPingTimer = setInterval(() => {
      if (!dc || dc.readyState !== "open") return
      try { dc.send(JSON.stringify({ type: "session.update", session: {} })) } catch (_) {}
      // If no session.updated ack arrives within 5 s the session is frozen.
      healthPingTimeout = setTimeout(() => {
        healthPingTimeout = null
        agent.log("Health ping timeout — reconnecting", "warn")
        if (!intentionalClose && !deadlocked) triggerReconnect("health ping timeout")
      }, 5000)
    }, 15000)
  }

  function stopHealthPing() {
    clearInterval(healthPingTimer)
    clearTimeout(healthPingTimeout)
    healthPingTimer = null
    healthPingTimeout = null
  }

  // ------------------------------------------------------------------ cleanup

  function cleanup() {
    stopHealthPing()
    intentionalClose = true
    try { dc?.close() } catch (_) {}
    try { pc?.close() } catch (_) {}
    pc = null; dc = null
    reconnectPending = false
    speakChain = Promise.resolve()
    pendingUtterances = 0
    if (currentAudioEl) {
      try { currentAudioEl.pause() } catch (_) {}
      currentAudioEl.src = ""
      currentAudioEl = null
    }
    if (elAudioElWs) {
      try { elAudioElWs.pause() } catch (_) {}
      if (elAudioElWs.src) URL.revokeObjectURL(elAudioElWs.src)
      elAudioElWs.src = ""; elAudioElWs.remove(); elAudioElWs = null
    }
    elMsWs = null; elSbWs = null; elBufQueueWs = []
    agent._elevenMeterAttached = false
    if (agent._listenRecorder) {
      try { agent._listenRecorder.stop() } catch (_) {}
      agent._listenRecorder = null
    }
    // micStream is intentionally preserved — reused across reconnects.
  }

  // ------------------------------------------------------------------ reconnect

  function triggerReconnect(reason) {
    if (!intentionalClose && !deadlocked) {
      agent.markDisconnected()
      scheduleReconnect()
    }
  }

  function scheduleReconnect() {
    if (deadlocked || reconnectPending) return
    if (reconnectAttempt >= 5) {
      deadlocked = true
      agent.log("Auto-reconnect failed after 5 attempts. Click Connect to retry.", "error")
      agent.connectBtn.textContent = "Deadlocked — click to retry"
      agent.connectBtn.disabled = false
      agent.socket.emit("agentDeadlock", { agentId: agent.AGENT_ID, reason: "5 consecutive failures" })
      return
    }
    reconnectPending = true
    const delay = backoff(reconnectAttempt)
    reconnectAttempt++
    agent.log(`ICE failed, reconnecting in ${delay / 1000}s (attempt ${reconnectAttempt}/5)`, "warn")
    agent.markReconnecting(reconnectAttempt)
    setTimeout(() => {
      reconnectPending = false
      if (!intentionalClose && !deadlocked) startConnection(true)
    }, delay)
  }

  // ------------------------------------------------------------------ EL helpers

  function authHeaders(extra) {
    const h = { ...(extra || {}) }
    if (agent.AUTH_KEY) h["Authorization"] = "Bearer " + agent.AUTH_KEY
    return h
  }

  agent.socket.on("voiceUpdated", ({ agentId, voiceId }) => {
    if (agentId === agent.AGENT_ID) {
      lastVoiceId = voiceId
      agent.log("Voice updated: " + voiceId)
      const picker = document.getElementById("voicePicker")
      if (picker && picker.value !== voiceId) picker.value = voiceId
    }
  })

  const PREVIEW_TEXT = "Hey, this is how I sound. Quick check before we go live."

  if (USE_ELEVEN) {
    const ttsRow = document.getElementById("ttsRow")
    const picker = document.getElementById("voicePicker")
    if (ttsRow) ttsRow.style.display = "flex"
    if (picker) {
      fetch("/voices", { headers: authHeaders() })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (!data || !Array.isArray(data.voices)) return
          const current = data.current?.[agent.AGENT_ID]
          picker.innerHTML = ""
          for (const v of data.voices) {
            const opt = document.createElement("option")
            opt.value = v.id
            opt.textContent = v.name + (v.labels?.accent ? ` — ${v.labels.accent}` : "")
            if (v.id === current) opt.selected = true
            picker.appendChild(opt)
          }
          if (current) lastVoiceId = current
        })
        .catch(err => agent.log("Voice list error: " + err.message, "error"))
      picker.addEventListener("change", () => {
        lastVoiceId = picker.value
        agent.socket.emit("setVoice", { agentId: agent.AGENT_ID, voiceId: picker.value })
      })
    }

    const previewBtn = document.getElementById("voicePreviewBtn")
    const previewError = document.getElementById("voicePreviewError")
    let previewAudio = null
    let previewBlobUrl = null

    function showPreviewError(msg) {
      if (!previewError) return
      previewError.textContent = msg
      setTimeout(() => { previewError.textContent = "" }, 3000)
    }

    function stopPreview() {
      if (previewAudio) {
        previewAudio.pause()
        previewAudio.src = ""
        previewAudio = null
      }
      if (previewBlobUrl) {
        URL.revokeObjectURL(previewBlobUrl)
        previewBlobUrl = null
      }
      if (previewBtn) {
        previewBtn.textContent = "▶ Preview"
        previewBtn.disabled = false
      }
    }

    async function previewVoice() {
      if (previewAudio) { stopPreview(); return }
      const voiceId = picker ? picker.value : (lastVoiceId || undefined)
      if (!voiceId) { showPreviewError("No voice selected"); return }
      if (previewBtn) { previewBtn.textContent = "Stop"; previewBtn.disabled = false }
      try {
        const res = await fetch(`/tts/${agent.AGENT_ID}/stream`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ text: PREVIEW_TEXT, voiceId })
        })
        if (!res.ok) {
          const detail = await res.text().catch(() => "")
          showPreviewError(`Error ${res.status}: ${detail.slice(0, 80)}`)
          if (previewBtn) { previewBtn.textContent = "▶ Preview"; previewBtn.disabled = false }
          return
        }
        const blob = await res.blob()
        previewBlobUrl = URL.createObjectURL(blob)
        previewAudio = new Audio(previewBlobUrl)
        previewAudio.onended = stopPreview
        previewAudio.onerror = () => { showPreviewError("Playback error"); stopPreview() }
        await previewAudio.play().catch(err => { showPreviewError(err.message); stopPreview() })
      } catch (err) {
        showPreviewError(err.message)
        if (previewBtn) { previewBtn.textContent = "▶ Preview"; previewBtn.disabled = false }
      }
    }

    if (previewBtn) previewBtn.addEventListener("click", previewVoice)
  }

  function attachMeterToElement(audioEl) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      elevenAudioCtx = elevenAudioCtx || new Ctx()
      if (typeof audioEl.captureStream === "function") {
        const stream = audioEl.captureStream()
        if (stream && !agent._elevenMeterAttached) {
          agent._elevenMeterAttached = true
          agent.setupAudioAnalysis(stream)
        }
      } else if (audioEl.mozCaptureStream) {
        const stream = audioEl.mozCaptureStream()
        if (stream && !agent._elevenMeterAttached) {
          agent._elevenMeterAttached = true
          agent.setupAudioAnalysis(stream)
        }
      }
    } catch (e) {
      agent.log("Meter attach failed: " + e.message, "error")
    }
  }

  async function speakViaElevenLabs(text) {
    const clean = (text || "").trim()
    if (!clean) return
    speakChain = speakChain.then(() => playOne(clean)).catch(err => {
      if (err.name !== "AbortError") {
        agent.log("EL playback error: " + err.message, "error")
      }
    })
    return speakChain
  }

  async function playOne(text) {
    let blobUrl = null
    try {
      agent.setStatus("speaking")
      const httpReqStart = Date.now()
      const res = await fetch(`/tts/${agent.AGENT_ID}/stream`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ text, voiceId: lastVoiceId || undefined }),
        signal: speakChainAbort.signal
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => "")
        agent.log(`EL TTS HTTP ${res.status} ${detail.slice(0, 120)}`, "error")
        agent.setStatus("idle")
        agent.socket.emit("releaseTurn", { agentId: agent.AGENT_ID })
        return
      }
      const blob = await res.blob()
      agent.log(`[EL-HTTP] first byte: ${Date.now() - httpReqStart} ms`)
      blobUrl = URL.createObjectURL(blob)
      const audio = new Audio(blobUrl)
      currentAudioEl = audio
      audio.crossOrigin = "anonymous"
      audio.autoplay = true
      audio.playsInline = true
      attachMeterToElement(audio)
      await new Promise((resolve) => {
        const done = () => { resolve() }
        audio.onended = done
        audio.onerror = () => { agent.log("EL audio element error", "error"); done() }
        audio.play().catch(err => { agent.log("EL play() rejected: " + err.message, "error"); done() })
      })
    } finally {
      currentAudioEl = null
      if (blobUrl) URL.revokeObjectURL(blobUrl)
      agent.setStatus("idle")
      agent.socket.emit("releaseTurn", { agentId: agent.AGENT_ID })
    }
  }

  // ------------------------------------------------------------------ WS TTS helpers (elevenlabs-ws mode)

  function openElWs() {
    if (elWs && elWs.readyState !== WebSocket.CLOSED && elWs.readyState !== WebSocket.CLOSING) return
    const key = encodeURIComponent(agent.AUTH_KEY || "")
    const proto = location.protocol === "https:" ? "wss:" : "ws:"
    elWs = new WebSocket(`${proto}//${location.host}/tts-ws/${agent.AGENT_ID}?key=${key}`)
    elWs.binaryType = "arraybuffer"
    elWsReady = false

    elWs.onopen = () => {
      elWsReady = true
      agent.log("[EL-WS] connected")
      const cbs = elWsOpenCbs.splice(0)
      for (const cb of cbs) cb(true)
    }

    elWs.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        if (!elWsFirstByteSeen && elWsResponseStart > 0) {
          elWsFirstByteSeen = true
          agent.log(`[EL-WS] first byte: ${Date.now() - elWsResponseStart} ms`)
        }
        pushElBuffer(new Uint8Array(ev.data))
      } else {
        let msg
        try { msg = JSON.parse(ev.data) } catch (_) { return }
        if (msg.type === "done") {
          endElMediaSource()
        } else if (msg.type === "error") {
          agent.log("[EL-WS] server error: " + (msg.reason || "?"), "error")
          if (elWsFallbackText) {
            const t = elWsFallbackText; elWsFallbackText = null; speakViaElevenLabs(t)
          }
        }
      }
    }

    elWs.onclose = (ev) => {
      elWsReady = false; elWs = null
      agent.log(`[EL-WS] closed (${ev.code})${ev.reason ? ": " + ev.reason : ""}`)
      const cbs = elWsOpenCbs.splice(0)
      for (const cb of cbs) cb(false)
      if (elWsFallbackText) {
        const t = elWsFallbackText; elWsFallbackText = null; speakViaElevenLabs(t)
      }
    }

    elWs.onerror = () => { agent.log("[EL-WS] WS error", "error") }
  }

  function initElMediaSource() {
    if (elAudioElWs) {
      try { elAudioElWs.pause() } catch (_) {}
      if (elAudioElWs.src) URL.revokeObjectURL(elAudioElWs.src)
      elAudioElWs.src = ""; elAudioElWs.remove(); elAudioElWs = null
    }
    elSbWs = null; elBufQueueWs = []

    if (!window.MediaSource || !MediaSource.isTypeSupported("audio/mpeg")) {
      agent.log("[EL-WS] MediaSource+MP3 not supported — falling back to HTTP", "warn")
      return false
    }

    elMsWs = new MediaSource()
    elAudioElWs = document.createElement("audio")
    elAudioElWs.src = URL.createObjectURL(elMsWs)
    elAudioElWs.autoplay = true
    elAudioElWs.playsInline = true
    document.body.appendChild(elAudioElWs)
    attachMeterToElement(elAudioElWs)

    elMsWs.addEventListener("sourceopen", () => {
      try {
        elSbWs = elMsWs.addSourceBuffer("audio/mpeg")
        elSbWs.addEventListener("updateend", flushElBufQueue)
        flushElBufQueue()
      } catch (e) {
        agent.log("[EL-WS] SourceBuffer error: " + e.message, "error")
      }
    }, { once: true })

    return true
  }

  function pushElBuffer(chunk) {
    if (!elSbWs || !elMsWs || elMsWs.readyState !== "open") {
      elBufQueueWs.push(chunk); return
    }
    if (elSbWs.updating) { elBufQueueWs.push(chunk); return }
    try { elSbWs.appendBuffer(chunk) }
    catch (e) { agent.log("[EL-WS] appendBuffer: " + e.message, "error") }
  }

  function flushElBufQueue() {
    if (!elSbWs || elSbWs.updating || elBufQueueWs.length === 0) return
    try { elSbWs.appendBuffer(elBufQueueWs.shift()) }
    catch (e) { agent.log("[EL-WS] flush: " + e.message, "error") }
  }

  function endElMediaSource() {
    function tryEnd() {
      if (!elMsWs || elMsWs.readyState !== "open") return
      if (elSbWs && elSbWs.updating) {
        elSbWs.addEventListener("updateend", tryEnd, { once: true }); return
      }
      if (elBufQueueWs.length > 0) {
        flushElBufQueue()
        if (elSbWs) { elSbWs.addEventListener("updateend", tryEnd, { once: true }) }
        return
      }
      try { elMsWs.endOfStream() } catch (_) {}
    }
    tryEnd()
  }

  function bargeInElWs() {
    elWsFallbackText = null
    if (elAudioElWs) { try { elAudioElWs.pause() } catch (_) {} }
    if (elSbWs) { try { elSbWs.abort() } catch (_) {} }
    if (elMsWs && elMsWs.readyState === "open") { try { elMsWs.endOfStream() } catch (_) {} }
    elBufQueueWs = []
    // Flush the upstream EL WS so the server finalises and discards queued audio.
    if (elWs && elWs.readyState === WebSocket.OPEN) {
      try { elWs.send(JSON.stringify({ type: "flush" })) } catch (_) {}
    }
  }

  async function speakViaElevenLabsWs(text) {
    const clean = (text || "").trim()
    if (!clean) return
    agent.setStatus("speaking")
    elWsFallbackText = clean
    elWsResponseStart = Date.now()
    elWsFirstByteSeen = false

    // Open WS if not already connected.
    if (!elWs || elWs.readyState === WebSocket.CLOSED || elWs.readyState === WebSocket.CLOSING) {
      openElWs()
    }

    // Wait for open (or failure) with a 5 s timeout.
    if (!elWsReady) {
      const ok = await new Promise(resolve => {
        const timer = setTimeout(() => { cleanupCb(); resolve(false) }, 5000)
        function cleanupCb() {
          clearTimeout(timer)
          const i = elWsOpenCbs.indexOf(cb)
          if (i >= 0) elWsOpenCbs.splice(i, 1)
        }
        function cb(result) { cleanupCb(); resolve(result) }
        elWsOpenCbs.push(cb)
      })
      if (!ok || !elWs || elWs.readyState !== WebSocket.OPEN) {
        agent.log("[EL-WS] connect failed — falling back to HTTP", "warn")
        elWsFallbackText = null
        return speakViaElevenLabs(clean)
      }
    }

    if (!initElMediaSource()) {
      elWsFallbackText = null
      return speakViaElevenLabs(clean)
    }

    elWs.send(JSON.stringify({ type: "text", text: clean }))
    elWs.send(JSON.stringify({ type: "flush" }))
    elWsFallbackText = null

    // Wait for playback to end (endOfStream() triggers audio "ended" event).
    const audio = elAudioElWs
    if (audio) {
      await new Promise(resolve => {
        audio.addEventListener("ended", resolve, { once: true })
        audio.addEventListener("error", resolve, { once: true })
        setTimeout(resolve, 90000) // 90 s safety valve
      })
    }

    agent.setStatus("idle")
    agent.socket.emit("releaseTurn", { agentId: agent.AGENT_ID })
  }

  // ------------------------------------------------------------------ socket bridges

  // Claim-token: server tells this agent to abort its in-flight response because
  // another agent just started speaking.
  agent.socket.on("cancelResponse", () => {
    if (!dc || dc.readyState !== "open") return
    try { dc.send(JSON.stringify({ type: "response.cancel" })) } catch (_) {}
    agent.log("cancelResponse: yielding floor to other agent")
  })

  // Dashboard: kick the agent into responding now
  agent.socket.on("kickAgent", ({ instructions }) => {
    if (!dc || dc.readyState !== "open") return
    const payload = { type: "response.create" }
    if (instructions) payload.response = { instructions }
    dc.send(JSON.stringify(payload))
    agent.log("Kicked by dashboard")
  })

  // Dashboard: live-update the agent's system prompt
  agent.socket.on("updatePrompt", ({ instructions }) => {
    if (!instructions) return
    currentPrompt = instructions   // persist for re-apply on reconnect
    if (!dc || dc.readyState !== "open") return
    dc.send(JSON.stringify({
      type: "session.update",
      session: { type: "realtime", instructions }
    }))
    agent.log("Prompt updated by dashboard")
  })

  // Dashboard: kick-to-retry after deadlock
  agent.socket.on("kickConnect", ({ agentId }) => {
    if (agentId !== agent.AGENT_ID) return
    agent.log("Kick-to-retry from dashboard", "success")
    deadlocked = false
    reconnectAttempt = 0
    startConnection(false)
  })

  // Both agents respond to textToAgent (banter forwarding from server)
  agent.socket.on("textToAgent", ({ text, from }) => {
    if (!dc || dc.readyState !== "open") return

    agent.log("Received from " + from + ": " + text)

    dc.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `[${from}]: ${text}` }]
      }
    }))

    setTimeout(() => dc.send(JSON.stringify({ type: "response.create" })), 100)
  })

  // Claim-token: server tells this agent another agent took the floor — cancel now
  agent.socket.on("cancelResponse", ({ reason }) => {
    agent.log("Cancelled: " + (reason || "floor taken"))
    if (dc && dc.readyState === "open") {
      try { dc.send(JSON.stringify({ type: "response.cancel" })) } catch (_) {}
    }
    // Reset EL state if mid-utterance
    if (USE_ELEVEN) {
      elGen++
      elBuffer = ""
      elDone = false
      pendingUtterances = 0
      speakChainAbort.abort()
      speakChainAbort = new AbortController()
      speakChain = Promise.resolve()
      if (currentAudioEl) {
        try { currentAudioEl.pause() } catch (_) {}
        currentAudioEl.src = ""
        currentAudioEl = null
      }
    }
    agent.setStatus("idle")
    agent.socket.emit("releaseTurn", { agentId: agent.AGENT_ID })
  })

  // ------------------------------------------------------------------ connect

  agent.connectBtn.addEventListener("click", () => {
    deadlocked = false
    startConnection(false)
  })

  async function getMicStream() {
    if (micStream && micStream.active) return micStream
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    agent.log("Microphone access granted", "success")
    return micStream
  }

  async function startConnection(isAutoReconnect = false) {
    intentionalClose = true
    cleanup()
    intentionalClose = false
    if (!isAutoReconnect) reconnectAttempt = 0

    try {
      agent.connectBtn.disabled = true
      agent.log("Getting session token...")

      const tokenRes = await fetch(agent.SESSION_ENDPOINT)
      if (!tokenRes.ok) {
        agent.log(`Session token error: HTTP ${tokenRes.status}`, "error")
        handleConnectError(isAutoReconnect)
        return
      }
      const data = await tokenRes.json()
      const ephemeralKey = data.client_secret.value
      const realtimeModel = data.model || "gpt-realtime"
      agent.log("Token received", "success")

      pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
      })

      pc.ontrack = (e) => {
        agent.log("Audio track received", "success")
        if (USE_ELEVEN || USE_ELEVEN_WS) {
          // Model is text-only in both EL modes; ignore any inbound audio track.
          return
        }
        if (e.streams[0]) {
          agent.setupAudioAnalysis(e.streams[0])
          const audio = document.createElement("audio")
          audio.srcObject = e.streams[0]
          audio.autoplay = true
          audio.playsInline = true
          document.body.appendChild(audio)
          audio.play().then(() => {
            agent.log("Audio playback started", "success")
          }).catch(err => {
            agent.log("Audio play error: " + err.message, "error")
            document.addEventListener("click", () => { audio.play() }, { once: true })
          })

          // Dashboard listen mode: stream inbound track chunks to server
          try {
            const listenMime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
              ? "audio/webm;codecs=opus"
              : MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
              ? "audio/ogg;codecs=opus"
              : null
            if (listenMime && agent.socket) {
              const recorder = new MediaRecorder(e.streams[0], { mimeType: listenMime })
              recorder.ondataavailable = (evt) => {
                if (evt.data && evt.data.size > 0 && agent.socket && agent.socket.connected) {
                  evt.data.arrayBuffer().then(buf => {
                    agent.socket.emit("agentAudioChunk", { agentId: agent.AGENT_ID, mime: listenMime, chunk: buf })
                  }).catch(() => {})
                }
              }
              recorder.start(250)
              agent._listenRecorder = recorder
              agent.log("Listen recorder started (" + listenMime + ")", "success")
            }
          } catch (recErr) {
            agent.log("Listen recorder init: " + recErr.message, "error")
          }
        }
      }

      pc.oniceconnectionstatechange = () => {
        const state = pc?.iceConnectionState
        if (!state) return
        agent.log("ICE state: " + state)
        if (state === "connected" || state === "completed") {
          reconnectAttempt = 0
          deadlocked = false
          agent.markConnected()
        } else if (state === "failed" || state === "disconnected") {
          if (!intentionalClose) triggerReconnect("ICE " + state)
        } else if (state === "closed") {
          if (!intentionalClose) agent.markDisconnected()
        }
      }

      // Reuse mic stream — getUserMedia only if the previous stream is gone.
      const stream = await getMicStream()
      stream.getTracks().forEach(track => pc.addTrack(track, stream))

      dc = pc.createDataChannel("oai-events")

      dc.onopen = () => {
        agent.log("Data channel open", "success")
        // Re-apply current personality prompt so reconnects use the live prompt,
        // not the session default. Server also pushes via updatePrompt on agentConnect.
        if (currentPrompt) {
          try {
            dc.send(JSON.stringify({
              type: "session.update",
              session: { type: "realtime", instructions: currentPrompt }
            }))
            agent.log("Re-applied live prompt", "success")
          } catch (_) {}
        }
        if (NEEDS_TEXT_ONLY) {
          const updates = [
            { type: "session.update", session: { modalities: ["text"] } },
            { type: "session.update", session: { output_modalities: ["text"] } },
            { type: "session.update", session: { audio: { output: { modalities: ["text"] } } } }
          ]
          for (const u of updates) {
            try { dc.send(JSON.stringify(u)) } catch (_) {}
          }
          agent.log("Requested text-only output for ElevenLabs path")
        }
        startHealthPing()

        // Agent 0 kicks off the greeting; if 0 isn't connected, agent 1 can too
        if (agent.AGENT_ID === 0) {
          setTimeout(() => {
            if (dc && dc.readyState === "open") {
              dc.send(JSON.stringify({
                type: "response.create",
                response: { instructions: "Greet the Space in 1-2 natural sentences. Mention three.ws. Be human and warm." }
              }))
            }
          }, 1500)
        }
      }

      dc.onclose = () => {
        agent.log("Data channel closed unexpectedly", "warn")
        if (!intentionalClose) triggerReconnect("data channel closed")
      }

      dc.onerror = (e) => {
        const msg = e?.error?.message || "unknown"
        agent.log("Data channel error: " + msg, "error")
        if (!intentionalClose) triggerReconnect("data channel error")
      }

      dc.onmessage = (e) => handleDataChannelMessage(e, agent)

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      const sdpRes = await fetch(
        `https://api.openai.com/v1/realtime?model=${encodeURIComponent(realtimeModel)}`,
        {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: "Bearer " + ephemeralKey,
            "Content-Type": "application/sdp"
          }
        }
      )

      if (!sdpRes.ok) {
        // Surface the HTTP status so the operator can distinguish rate-limiting from network errors.
        const errText = await sdpRes.text().catch(() => "")
        agent.log(`SDP error: HTTP ${sdpRes.status} — ${errText.slice(0, 120)}`, "error")
        handleConnectError(isAutoReconnect)
        return
      }

      const answerSdp = await sdpRes.text()
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp })
      agent.log("SDP exchange complete", "success")

    } catch (err) {
      agent.log("Connection error: " + err.message, "error")
      handleConnectError(isAutoReconnect)
    }
  }

  function handleConnectError(isAutoReconnect) {
    // Close any partially-set-up peer connection so stale ICE callbacks don't re-fire.
    const p = pc; const d = dc
    pc = null; dc = null
    stopHealthPing()
    reconnectPending = false
    try { d?.close() } catch (_) {}
    // Wait a tick before closing the PC to avoid Chrome console warnings.
    setTimeout(() => { try { p?.close() } catch (_) {} }, 0)
    if (isAutoReconnect) {
      scheduleReconnect()
    } else {
      agent.connectBtn.disabled = false
    }
  }

  // ------------------------------------------------------------------ message handler

  function handleDataChannelMessage(e, agent) {
    try {
      const msg = JSON.parse(e.data)

      // Clear health-ping ack timeout on any session ack.
      if (msg.type === "session.updated") {
        if (healthPingTimeout) { clearTimeout(healthPingTimeout); healthPingTimeout = null }
      }

      if (msg.type === "input_audio_buffer.speech_started") {
        agent.setStatus("listening")
        agent.log("Listening to input...")
        if (USE_ELEVEN) {
          bargedIn = true
          if (currentAudioEl) {
            try { currentAudioEl.pause() } catch (_) {}
            currentAudioEl.src = ""
            currentAudioEl = null
          }
          speakChainAbort.abort()
          speakChainAbort = new AbortController()
          speakChain = Promise.resolve()
          pendingUtterances = 0
          if (dc && dc.readyState === "open") {
            try { dc.send(JSON.stringify({ type: "response.cancel" })) } catch (_) {}
          }
          agent.socket.emit("releaseTurn", { agentId: agent.AGENT_ID })
          agent.log("Barge-in: cancelled current response")
        }
        if (USE_ELEVEN_WS) {
          bargedIn = true
          bargeInElWs()
          if (dc && dc.readyState === "open") {
            try { dc.send(JSON.stringify({ type: "response.cancel" })) } catch (_) {}
          }
          agent.socket.emit("releaseTurn", { agentId: agent.AGENT_ID })
          agent.log("Barge-in (WS): cancelled current response")
        }
      }
      else if (msg.type === "input_audio_buffer.speech_stopped") {
        bargedIn = false
        if (!agent.isSpeaking) agent.setStatus("idle")
      }
      else if (msg.type === "response.created") {
        bargedIn = false
        speakChainAbort = new AbortController()
        agent.socket.emit("requestTurn", { agentId: agent.AGENT_ID })
        agent.currentMessageId = Date.now().toString()
        agent.log("Response started")
      }
      else if (msg.type === "response.audio_transcript.delta" || msg.type === "response.output_text.delta") {
        if (msg.delta) {
          agent.socket.emit("textDelta", {
            agentId: agent.AGENT_ID,
            delta: msg.delta,
            messageId: agent.currentMessageId
          })
        }
      }
      else if (msg.type === "response.audio_transcript.done" || msg.type === "response.output_text.done") {
        const finalText = msg.transcript || msg.text || ""
        if (finalText) {
          agent.socket.emit("textComplete", {
            agentId: agent.AGENT_ID,
            text: finalText,
            messageId: agent.currentMessageId
          })
          agent.addChat(agent.AGENT_NAME, finalText, "self")
          agent.log("Response complete")
          if (USE_ELEVEN_WS) speakViaElevenLabsWs(finalText)
          else if (USE_ELEVEN) speakViaElevenLabs(finalText)
        }
      }
      else if (msg.type === "response.done") {
        agent.log("Response done event")
      }
      else if (msg.type === "conversation.item.created" && msg.item?.role === "user") {
        const content = msg.item.content || []
        let text = ""
        content.forEach(c => {
          if (c.transcript) text += c.transcript
          if (c.text) text += c.text
        })
        if (text.trim()) {
          agent.log("User said: " + text)
          agent.socket.emit("userTranscript", {
            agentId: agent.AGENT_ID,
            text,
            timestamp: Date.now()
          })
        }
      }
    } catch (err) {
      agent.log("Parse error", "error")
    }
  }
}

window.initOpenAIRealtime = initOpenAIRealtime
export { initOpenAIRealtime }
