// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent) [§72]

import { vi } from 'vitest'

export function createMockSocket() {
  const _handlers = {}
  const socket = {
    _handlers,
    on(event, fn) {
      if (!_handlers[event]) _handlers[event] = []
      _handlers[event].push(fn)
    },
    off(event, fn) {
      if (_handlers[event]) _handlers[event] = _handlers[event].filter(h => h !== fn)
    },
    emit: vi.fn(),
    _emit(event, data) {
      const handlers = _handlers[event] || []
      handlers.forEach(h => h(data))
    },
  }
  return socket
}

export function createMockAgent(overrides = {}) {
  const socket = createMockSocket()
  return {
    AGENT_ID: 0,
    AGENT_NAME: 'TestAgent',
    AUTH_KEY: null,
    SESSION_ENDPOINT: '/session/0',
    socket,
    log: vi.fn(),
    setStatus: vi.fn(),
    setupAudioAnalysis: vi.fn(),
    markConnected: vi.fn(),
    markDisconnected: vi.fn(),
    markReconnecting: vi.fn(),
    addChat: vi.fn(),
    connectBtn: { addEventListener: vi.fn(), disabled: false, textContent: 'Connect' },
    isSpeaking: false,
    currentMessageId: null,
    ...overrides,
    // Merge socket separately so overrides.socket replaces, not merges
    ...(overrides.socket ? {} : { socket }),
  }
}

/**
 * Install a global fetch stub that dispatches to route handlers keyed by
 * "METHOD url", "url", or "*". Handler may be a plain object (response shape)
 * or a function(url, opts) returning the same shape.
 */
export function mockFetch(routes = {}) {
  const stub = vi.fn(async (url, opts = {}) => {
    const method = (opts?.method || 'GET').toUpperCase()
    const handler =
      routes[`${method} ${url}`] ??
      routes[url] ??
      routes['*'] ??
      null
    if (!handler) {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => '',
        blob: async () => new Blob(),
      }
    }
    if (typeof handler === 'function') return handler(url, opts)
    return {
      ok: handler.ok ?? true,
      status: handler.status ?? 200,
      json: async () => handler.json ?? {},
      text: async () => handler.text ?? '',
      blob: async () => handler.blob ?? new Blob([handler.text ?? ''], { type: 'audio/mpeg' }),
    }
  })
  vi.stubGlobal('fetch', stub)
  return stub
}

/**
 * Replace window.Audio with a stub. Each constructed instance has:
 *   .play()      → resolves immediately
 *   .endNow()    → fires onended synchronously
 *   .errorNow()  → fires onerror synchronously
 * Returns { instances, MockAudio } for introspection.
 */
export function mockAudio() {
  const instances = []
  const MockAudio = vi.fn(function (src) {
    const inst = {
      src: src || '',
      crossOrigin: null,
      autoplay: false,
      playsInline: false,
      onended: null,
      onerror: null,
      play: vi.fn().mockResolvedValue(undefined),
      endNow() { if (this.onended) this.onended() },
      errorNow(err) { if (this.onerror) this.onerror(err || new Error('audio error')) },
    }
    instances.push(inst)
    return inst
  })
  vi.stubGlobal('Audio', MockAudio)
  return { instances, MockAudio }
}

/**
 * Install minimal RTCPeerConnection + data-channel stubs. The returned dc
 * exposes _fireOpen() / _fireMessage(data) helpers. The returned pc exposes
 * _fireTrack(streams) to simulate ontrack events.
 */
export function mockRTC() {
  const dc = {
    readyState: 'open',
    send: vi.fn(),
    onopen: null,
    onmessage: null,
    _fireOpen() { if (this.onopen) this.onopen() },
    _fireMessage(data) {
      if (this.onmessage) {
        this.onmessage({ data: typeof data === 'string' ? data : JSON.stringify(data) })
      }
    },
  }

  const pc = {
    ontrack: null,
    oniceconnectionstatechange: null,
    iceConnectionState: 'new',
    addTrack: vi.fn(),
    createDataChannel: vi.fn(() => dc),
    createOffer: vi.fn().mockResolvedValue({ sdp: 'offer-sdp' }),
    setLocalDescription: vi.fn().mockResolvedValue(undefined),
    setRemoteDescription: vi.fn().mockResolvedValue(undefined),
    _fireTrack(streams) {
      if (this.ontrack) this.ontrack({ streams })
    },
  }

  vi.stubGlobal('RTCPeerConnection', vi.fn(function () { return pc }))
  return { dc, pc }
}
