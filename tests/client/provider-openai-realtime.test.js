// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent) [§72]

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initOpenAIRealtime } from '../../public/js/provider-openai-realtime.js'
import {
  createMockAgent,
  mockFetch,
  mockAudio,
  mockRTC,
} from './helpers/mocks.js'

// Flush the microtask queue n times to let chained promises resolve.
async function flush(n = 12) {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

// ── connection helper ──────────────────────────────────────────────────────────
// Builds mock RTC + navigator, inits the provider, clicks connect, and awaits
// the full async startup so dc.onopen/dc.onmessage are wired by the time we
// return.
async function buildConnection(opts = {}) {
  const { authKey = null, agentId = 0, mode = 'elevenlabs' } = opts

  if (mode === 'elevenlabs') {
    vi.stubGlobal('location', { search: '?tts=elevenlabs' })
  } else {
    vi.stubGlobal('location', { search: '' })
  }

  const agent = createMockAgent({ AUTH_KEY: authKey, AGENT_ID: agentId })
  const { dc, pc } = mockRTC()

  Object.defineProperty(global.navigator, 'mediaDevices', {
    value: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [], active: true }),
    },
    writable: true,
    configurable: true,
  })

  // Default fetch covering handshake + EL routes.
  mockFetch({
    [`GET ${agent.SESSION_ENDPOINT}`]: {
      json: { client_secret: { value: 'eph-key' }, model: 'gpt-realtime' },
    },
    '*': async (url) => {
      if (url.includes('api.openai.com')) return { ok: true, status: 200, text: async () => 'answer-sdp' }
      if (url === '/voices') return { ok: true, status: 200, json: async () => ({ voices: [], current: {} }) }
      if (url.includes('/tts/')) return { ok: true, status: 200, blob: async () => new Blob(['mp3'], { type: 'audio/mpeg' }) }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
    },
  })

  initOpenAIRealtime(agent)

  // Trigger the WebRTC connect flow via the click listener.
  const clickCall = agent.connectBtn.addEventListener.mock.calls.find(c => c[0] === 'click')
  if (clickCall) clickCall[1]()   // not async — handler calls startConnection without await
  await flush(16)

  return { agent, dc, pc }
}

// Fire response.created + response.output_text.done so speakViaElevenLabs
// is called once with the given text.
function respondWith(dc, text) {
  dc._fireMessage({ type: 'response.created' })
  dc._fireMessage({ type: 'response.output_text.done', text })
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('initOpenAIRealtime', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { search: '' })
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:test-url'),
      revokeObjectURL: vi.fn(),
    })
    delete window.AGENT_CONFIG
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  // ── 1. Mode resolution ───────────────────────────────────────────────────────
  describe('mode resolution', () => {
    it('no tts param → realtime mode (no EL log)', () => {
      const agent = createMockAgent()
      initOpenAIRealtime(agent)
      expect(agent.log).not.toHaveBeenCalledWith(
        expect.stringContaining('ElevenLabs'), 'success',
      )
    })

    it('?tts=elevenlabs → EL mode', () => {
      vi.stubGlobal('location', { search: '?tts=elevenlabs' })
      const agent = createMockAgent()
      initOpenAIRealtime(agent)
      expect(agent.log).toHaveBeenCalledWith(
        expect.stringContaining('ElevenLabs'), 'success',
      )
    })

    it('?tts=eleven → EL mode', () => {
      vi.stubGlobal('location', { search: '?tts=eleven' })
      const agent = createMockAgent()
      initOpenAIRealtime(agent)
      expect(agent.log).toHaveBeenCalledWith(
        expect.stringContaining('ElevenLabs'), 'success',
      )
    })

    it('?tts=11labs → EL mode', () => {
      vi.stubGlobal('location', { search: '?tts=11labs' })
      const agent = createMockAgent()
      initOpenAIRealtime(agent)
      expect(agent.log).toHaveBeenCalledWith(
        expect.stringContaining('ElevenLabs'), 'success',
      )
    })

    it('AGENT_CONFIG.tts === "elevenlabs" → EL mode', () => {
      window.AGENT_CONFIG = { tts: 'elevenlabs' }
      const agent = createMockAgent()
      initOpenAIRealtime(agent)
      expect(agent.log).toHaveBeenCalledWith(
        expect.stringContaining('ElevenLabs'), 'success',
      )
    })

    it('?tts=ElevenLabs (uppercase) → EL mode (case-insensitive)', () => {
      vi.stubGlobal('location', { search: '?tts=ElevenLabs' })
      const agent = createMockAgent()
      initOpenAIRealtime(agent)
      expect(agent.log).toHaveBeenCalledWith(
        expect.stringContaining('ElevenLabs'), 'success',
      )
    })
  })

  // ── 2. Auth headers ──────────────────────────────────────────────────────────
  describe('auth headers', () => {
    beforeEach(() => {
      vi.stubGlobal('location', { search: '?tts=elevenlabs' })
      const picker = document.createElement('select')
      picker.id = 'voicePicker'
      document.body.appendChild(picker)
    })

    it('sends Authorization: Bearer to /voices when AUTH_KEY is set', async () => {
      const calls = []
      vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
        calls.push({ url, opts })
        return { ok: true, status: 200, json: async () => ({ voices: [], current: {} }) }
      }))

      const agent = createMockAgent({ AUTH_KEY: 'test-key' })
      initOpenAIRealtime(agent)
      await flush()

      const voicesCall = calls.find(c => c.url === '/voices')
      expect(voicesCall).toBeTruthy()
      expect(voicesCall.opts?.headers?.['Authorization']).toBe('Bearer test-key')
    })

    it('no Authorization header when AUTH_KEY is absent', async () => {
      const calls = []
      vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
        calls.push({ url, opts })
        return { ok: true, status: 200, json: async () => ({ voices: [], current: {} }) }
      }))

      const agent = createMockAgent({ AUTH_KEY: null })
      initOpenAIRealtime(agent)
      await flush()

      const voicesCall = calls.find(c => c.url === '/voices')
      expect(voicesCall).toBeTruthy()
      expect(voicesCall.opts?.headers?.['Authorization']).toBeUndefined()
    })

    it('sends Authorization header to /tts/:id/stream', async () => {
      const { agent, dc } = await buildConnection({ authKey: 'tts-key' })
      mockAudio()

      const ttsCallOpts = []
      const base = global.fetch
      vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
        if (url.includes('/tts/')) {
          ttsCallOpts.push(opts)
          return { ok: true, status: 200, blob: async () => new Blob(['mp3']) }
        }
        return base(url, opts)
      }))

      dc._fireOpen()
      respondWith(dc, 'Testing auth headers.')
      await flush(16)

      expect(ttsCallOpts.length).toBeGreaterThan(0)
      expect(ttsCallOpts[0]?.headers?.['Authorization']).toBe('Bearer tts-key')
    })
  })

  // ── 3. Sequential playback queue ─────────────────────────────────────────────
  describe('sequential playback queue', () => {
    it('second fetch does not start until first Audio.onended fires', async () => {
      const { dc } = await buildConnection()
      const { instances } = mockAudio()

      const ttsFetchCount = { n: 0 }
      const base = global.fetch
      vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
        if (url.includes('/tts/')) {
          ttsFetchCount.n++
          return { ok: true, status: 200, blob: async () => new Blob(['mp3']) }
        }
        return base(url, opts)
      }))

      // Three utterances chained into speakChain via successive *.done events.
      dc._fireOpen()
      dc._fireMessage({ type: 'response.output_text.done', text: 'First utterance here.' })
      dc._fireMessage({ type: 'response.output_text.done', text: 'Second one follows now.' })
      dc._fireMessage({ type: 'response.output_text.done', text: 'Third comes after that.' })
      await flush(16)

      expect(ttsFetchCount.n).toBe(1)   // only the first started

      instances[0].endNow()
      await flush(16)

      expect(ttsFetchCount.n).toBe(2)   // second started after first ended
    })

    it('releaseTurn is emitted exactly once per utterance', async () => {
      const { agent, dc } = await buildConnection()
      const { instances } = mockAudio()

      vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (url.includes('/tts/')) return { ok: true, status: 200, blob: async () => new Blob(['mp3']) }
        return { ok: false, status: 404, text: async () => '' }
      }))

      dc._fireOpen()
      dc._fireMessage({ type: 'response.output_text.done', text: 'Single utterance test.' })
      await flush(16)

      // Not yet — audio hasn't ended.
      expect(agent.socket.emit).not.toHaveBeenCalledWith('releaseTurn', expect.anything())

      instances[0].endNow()
      await flush(8)

      const releaseCalls = agent.socket.emit.mock.calls.filter(c => c[0] === 'releaseTurn')
      expect(releaseCalls).toHaveLength(1)
      expect(releaseCalls[0][1]).toEqual({ agentId: 0 })
    })
  })

  // ── 4. Status transitions in EL mode ─────────────────────────────────────────
  describe('status transitions in EL mode', () => {
    it('setStatus("speaking") before playback, "idle" after audio ends', async () => {
      const { agent, dc } = await buildConnection()
      const { instances } = mockAudio()

      vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (url.includes('/tts/')) return { ok: true, status: 200, blob: async () => new Blob(['mp3']) }
        return { ok: false, status: 404, text: async () => '' }
      }))

      dc._fireOpen()
      respondWith(dc, 'Hello world response text.')
      await flush(16)

      expect(agent.setStatus).toHaveBeenCalledWith('speaking')
      expect(agent.setStatus).not.toHaveBeenCalledWith('idle')

      instances[0].endNow()
      await flush(8)

      expect(agent.setStatus).toHaveBeenCalledWith('idle')
    })

    it('releaseTurn is emitted with the correct agentId', async () => {
      const { agent, dc } = await buildConnection({ agentId: 1 })
      const { instances } = mockAudio()

      vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (url.includes('/tts/')) return { ok: true, status: 200, blob: async () => new Blob(['mp3']) }
        return { ok: false, status: 404, text: async () => '' }
      }))

      dc._fireOpen()
      respondWith(dc, 'Testing agent ID routing.')
      await flush(16)
      instances[0].endNow()
      await flush(8)

      expect(agent.socket.emit).toHaveBeenCalledWith('releaseTurn', { agentId: 1 })
    })
  })

  // ── 5. Model audio track handling ────────────────────────────────────────────
  describe('model audio track handling', () => {
    it('EL mode: setupAudioAnalysis not called on ontrack', async () => {
      const { agent, pc } = await buildConnection()
      const mockStream = { getTracks: () => [], id: 'stream-1' }
      pc._fireTrack([mockStream])
      expect(agent.setupAudioAnalysis).not.toHaveBeenCalledWith(mockStream)
    })

    it('EL mode: no <audio> element appended to body on ontrack', async () => {
      const { pc } = await buildConnection()
      const mockStream = { getTracks: () => [], id: 'stream-2' }
      pc._fireTrack([mockStream])
      expect(document.querySelector('audio')).toBeNull()
    })

    it('realtime mode: setupAudioAnalysis called and audio element appended', async () => {
      const { agent, pc } = await buildConnection({ mode: 'realtime' })

      // Stub audio.play() on created elements to avoid unhandled rejection.
      vi.spyOn(document, 'createElement').mockImplementation((tag) => {
        const el = document.createElementNS('http://www.w3.org/1999/xhtml', tag)
        if (tag === 'audio') Object.assign(el, { play: vi.fn().mockResolvedValue(undefined) })
        return el
      })

      const mockStream = { getTracks: () => [], id: 'stream-3' }
      pc._fireTrack([mockStream])

      expect(agent.setupAudioAnalysis).toHaveBeenCalledWith(mockStream)
      expect(document.querySelector('audio')).toBeTruthy()
    })
  })

  // ── 6. session.update text-only payload ──────────────────────────────────────
  describe('session.update text-only payload in EL mode', () => {
    it('sends exactly three session.update payloads on dc.onopen (no currentPrompt)', async () => {
      const { dc } = await buildConnection()
      dc._fireOpen()

      const updates = dc.send.mock.calls
        .map(c => JSON.parse(c[0]))
        .filter(p => p.type === 'session.update')

      expect(updates).toHaveLength(3)
      expect(updates[0].session).toEqual({ modalities: ['text'] })
      expect(updates[1].session).toEqual({ output_modalities: ['text'] })
      expect(updates[2].session).toEqual({ audio: { output: { modalities: ['text'] } } })
    })
  })

  // ── 7. Voice picker ───────────────────────────────────────────────────────────
  describe('voice picker', () => {
    beforeEach(() => {
      vi.stubGlobal('location', { search: '?tts=elevenlabs' })
      const picker = document.createElement('select')
      picker.id = 'voicePicker'
      document.body.appendChild(picker)
    })

    it('fetches /voices once and populates the dropdown', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({
          voices: [
            { id: 'v1', name: 'Alice', labels: { accent: 'British' } },
            { id: 'v2', name: 'Bob', labels: {} },
          ],
          current: { 0: 'v1' },
        }),
      })))

      const agent = createMockAgent()
      initOpenAIRealtime(agent)
      await flush()

      expect(global.fetch).toHaveBeenCalledWith('/voices', expect.any(Object))
      const picker = document.getElementById('voicePicker')
      expect(picker.children).toHaveLength(2)
      expect(picker.children[0].value).toBe('v1')
      expect(picker.children[1].value).toBe('v2')
    })

    it('pre-selects the voice matching current[AGENT_ID]', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({
          voices: [{ id: 'v1', name: 'A', labels: {} }, { id: 'v2', name: 'B', labels: {} }],
          current: { 0: 'v2' },
        }),
      })))

      const agent = createMockAgent()
      initOpenAIRealtime(agent)
      await flush()

      expect(document.getElementById('voicePicker').value).toBe('v2')
    })

    it('emits setVoice on picker change', () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true, json: async () => ({ voices: [], current: {} }),
      })))

      const agent = createMockAgent()
      initOpenAIRealtime(agent)

      const picker = document.getElementById('voicePicker')
      const opt = document.createElement('option')
      opt.value = 'v-new'
      picker.appendChild(opt)
      picker.value = 'v-new'
      picker.dispatchEvent(new Event('change'))

      expect(agent.socket.emit).toHaveBeenCalledWith('setVoice', { agentId: 0, voiceId: 'v-new' })
    })
  })

  // ── 8. Voice updates ─────────────────────────────────────────────────────────
  describe('voice updates via socket', () => {
    it('updates picker.value on voiceUpdated for own agentId', () => {
      vi.stubGlobal('location', { search: '?tts=elevenlabs' })
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true, json: async () => ({ voices: [], current: {} }),
      })))

      const picker = document.createElement('select')
      picker.id = 'voicePicker'
      const opt = document.createElement('option')
      opt.value = 'new-voice-id'
      picker.appendChild(opt)
      document.body.appendChild(picker)

      const agent = createMockAgent({ AGENT_ID: 0 })
      initOpenAIRealtime(agent)

      agent.socket._emit('voiceUpdated', { agentId: 0, voiceId: 'new-voice-id' })

      expect(picker.value).toBe('new-voice-id')
      expect(agent.log).toHaveBeenCalledWith('Voice updated: new-voice-id')
    })

    it('ignores voiceUpdated for a different agentId', () => {
      const agent = createMockAgent({ AGENT_ID: 0 })
      initOpenAIRealtime(agent)

      const logsBefore = agent.log.mock.calls.length
      agent.socket._emit('voiceUpdated', { agentId: 99, voiceId: 'other-voice' })

      expect(agent.log.mock.calls.length).toBe(logsBefore)
    })
  })

  // ── 9. Delta events ───────────────────────────────────────────────────────────
  describe('delta events', () => {
    it('response.audio_transcript.delta → emits textDelta', async () => {
      const { agent, dc } = await buildConnection()
      dc._fireOpen()
      dc._fireMessage({ type: 'response.created' })
      dc._fireMessage({ type: 'response.audio_transcript.delta', delta: 'Hello' })

      expect(agent.socket.emit).toHaveBeenCalledWith('textDelta', {
        agentId: 0,
        delta: 'Hello',
        messageId: expect.any(String),
      })
    })

    it('response.output_text.delta → emits textDelta', async () => {
      const { agent, dc } = await buildConnection()
      dc._fireOpen()
      dc._fireMessage({ type: 'response.created' })
      dc._fireMessage({ type: 'response.output_text.delta', delta: 'World' })

      expect(agent.socket.emit).toHaveBeenCalledWith('textDelta', {
        agentId: 0,
        delta: 'World',
        messageId: expect.any(String),
      })
    })
  })

  // ── 10. Error paths ───────────────────────────────────────────────────────────
  describe('error paths', () => {
    it('401 on /tts/:id/stream: logs the HTTP status and still emits releaseTurn', async () => {
      const { agent, dc } = await buildConnection()
      mockAudio()

      vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (url.includes('/tts/')) {
          return { ok: false, status: 401, text: async () => 'Unauthorized', blob: async () => new Blob() }
        }
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
      }))

      dc._fireOpen()
      respondWith(dc, 'Secret text response here.')
      await flush(16)

      expect(agent.log).toHaveBeenCalledWith(expect.stringContaining('401'), 'error')
      expect(agent.socket.emit).toHaveBeenCalledWith('releaseTurn', { agentId: 0 })
    })

    it('429 on /tts/:id/stream: surfaces the status in the log', async () => {
      const { agent, dc } = await buildConnection()
      mockAudio()

      vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (url.includes('/tts/')) {
          return { ok: false, status: 429, text: async () => 'Rate limited', blob: async () => new Blob() }
        }
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
      }))

      dc._fireOpen()
      respondWith(dc, 'Fast response to rate limit.')
      await flush(16)

      expect(agent.log).toHaveBeenCalledWith(expect.stringContaining('429'), 'error')
    })

    it('audio.onerror releases the turn and sets status idle', async () => {
      const { agent, dc } = await buildConnection()
      const { instances } = mockAudio()

      vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (url.includes('/tts/')) return { ok: true, status: 200, blob: async () => new Blob(['mp3']) }
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
      }))

      dc._fireOpen()
      respondWith(dc, 'Error-prone audio playback.')
      await flush(16)

      instances[0].errorNow()
      await flush(8)

      expect(agent.socket.emit).toHaveBeenCalledWith('releaseTurn', { agentId: 0 })
      expect(agent.setStatus).toHaveBeenCalledWith('idle')
    })
  })
})
