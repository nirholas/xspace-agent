// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent) [§32]

// OpenAI Realtime WebRTC provider — extracted from original agent HTML
//
// Two output modes:
//   - "realtime" (default): model speaks via its own audio track over WebRTC.
//   - "elevenlabs": model emits text only, page streams MP3 from /tts/:id/stream.
// Toggle via URL query (?tts=elevenlabs) or AGENT_CONFIG.tts. Defaults to realtime.
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
  if (USE_ELEVEN) agent.log("TTS mode: ElevenLabs streaming", "success")

  // Sequential MP3 playback queue (so chunks don't overlap).
  let speakChain = Promise.resolve()
  let elevenAudioCtx = null
  let lastVoiceId = null

  agent.socket.on("voiceUpdated", ({ agentId, voiceId }) => {
    if (agentId === agent.AGENT_ID) {
      lastVoiceId = voiceId
      agent.log("Voice updated: " + voiceId)
      const picker = document.getElementById("voicePicker")
      if (picker && picker.value !== voiceId) picker.value = voiceId
    }
  })

  if (USE_ELEVEN) {
    const ttsRow = document.getElementById("ttsRow")
    const picker = document.getElementById("voicePicker")
    if (ttsRow) ttsRow.style.display = "flex"
    if (picker) {
      fetch("/voices")
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
  }

  function attachMeterToElement(audioEl) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      elevenAudioCtx = elevenAudioCtx || new Ctx()
      // captureStream() gives us a MediaStream we can feed into the existing meter.
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
      agent.log("EL playback error: " + err.message, "error")
    })
    return speakChain
  }

  async function playOne(text) {
    let blobUrl = null
    try {
      agent.setStatus("speaking")
      const res = await fetch(`/tts/${agent.AGENT_ID}/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voiceId: lastVoiceId || undefined })
      })
      if (!res.ok) {
        agent.log("EL TTS HTTP " + res.status, "error")
        agent.setStatus("idle")
        agent.socket.emit("releaseTurn", { agentId: agent.AGENT_ID })
        return
      }
      const blob = await res.blob()
      blobUrl = URL.createObjectURL(blob)
      const audio = new Audio(blobUrl)
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
      if (blobUrl) URL.revokeObjectURL(blobUrl)
      agent.setStatus("idle")
      agent.socket.emit("releaseTurn", { agentId: agent.AGENT_ID })
    }
  }

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
    if (!dc || dc.readyState !== "open" || !instructions) return
    dc.send(JSON.stringify({
      type: "session.update",
      session: { type: "realtime", instructions }
    }))
    agent.log("Prompt updated by dashboard")
  })

  // Handle text-to-agent for Agent 0 (receives chat via data channel)
  agent.socket.on("textToAgent", ({ text, from }) => {
    if (!dc || dc.readyState !== "open") return
    if (agent.AGENT_ID !== 0) return

    agent.log("Received text from " + from + ": " + text)

    const event = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `[CHAT - ${from}]: ${text}` }]
      }
    }
    dc.send(JSON.stringify(event))

    setTimeout(() => {
      dc.send(JSON.stringify({ type: "response.create" }))
    }, 100)
  })

  agent.connectBtn.addEventListener("click", startConnection)

  async function startConnection() {
    try {
      agent.connectBtn.disabled = true
      agent.log("Getting session token...")

      const res = await fetch(agent.SESSION_ENDPOINT)
      const data = await res.json()
      const ephemeralKey = data.client_secret.value
      agent.log("Token received", "success")

      pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
      })

      pc.ontrack = (e) => {
        agent.log("Audio track received", "success")
        if (USE_ELEVEN) {
          // Model is text-only in EL mode; ignore any inbound audio track to avoid
          // doubled voices if the API still produces silent/leftover audio.
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
            document.addEventListener("click", () => {
              audio.play()
            }, { once: true })
          })
        }
      }

      pc.oniceconnectionstatechange = () => {
        agent.log("ICE state: " + pc.iceConnectionState)
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
          agent.markConnected()
        } else if (["failed", "disconnected", "closed"].includes(pc.iceConnectionState)) {
          agent.markDisconnected()
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach(track => pc.addTrack(track, stream))
      agent.log("Microphone access granted", "success")

      dc = pc.createDataChannel("oai-events")
      dc.onopen = () => {
        agent.log("Data channel open", "success")
        if (USE_ELEVEN) {
          // Ask the model to emit text only — ElevenLabs handles voice on this side.
          // Send both shapes; Realtime API has used "modalities" historically and
          // "output_modalities" / nested forms in newer revisions.
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
      }
      dc.onmessage = (e) => handleDataChannelMessage(e, agent)

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      const sdpRes = await fetch("https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: "Bearer " + ephemeralKey,
          "Content-Type": "application/sdp"
        }
      })

      const answerSdp = await sdpRes.text()
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp })
      agent.log("Connection established!", "success")

    } catch (err) {
      agent.log("Error: " + err.message, "error")
      agent.connectBtn.disabled = false
    }
  }

  function handleDataChannelMessage(e, agent) {
    try {
      const msg = JSON.parse(e.data)

      if (msg.type === "input_audio_buffer.speech_started") {
        agent.setStatus("listening")
        agent.log("Listening to input...")
      }
      else if (msg.type === "input_audio_buffer.speech_stopped") {
        if (!agent.isSpeaking) agent.setStatus("idle")
      }
      else if (msg.type === "response.created") {
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
          if (USE_ELEVEN) speakViaElevenLabs(finalText)
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


