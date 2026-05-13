// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

// =============================================================================
// Tests — setVoice Socket.IO handler (registerVoiceSocketHandler)
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Socket, Namespace } from 'socket.io'

// ---------------------------------------------------------------------------
// vi.hoisted — elevenVoiceIds must be accessible inside vi.mock factory
// ---------------------------------------------------------------------------

const { elevenVoiceIds } = vi.hoisted(() => ({
  elevenVoiceIds: { 0: 'AAAAAAAAAAAAAAAA', 1: 'BBBBBBBBBBBBBBBB' } as Record<number, string>,
}))

vi.mock('../../src/lib/eleven-state', () => ({
  VOICE_ID_RE: /^[A-Za-z0-9]{16,40}$/,
  elevenVoiceIds,
}))

import { registerVoiceSocketHandler } from '../../src/socket/voice'

// ---------------------------------------------------------------------------
// Helpers — minimal Socket.IO mocks
// ---------------------------------------------------------------------------

function createMockSocket(ip = '127.0.0.1'): Socket & { _handlers: Record<string, (data: any) => void> } {
  const _handlers: Record<string, (data: any) => void> = {}
  return {
    on: vi.fn((event: string, handler: (data: any) => void) => {
      _handlers[event] = handler
    }),
    handshake: {
      address: ip,
      headers: {},
      auth: {},
    },
    _handlers,
  } as any
}

function createMockNamespace(): Namespace {
  return { emit: vi.fn() } as unknown as Namespace
}

function triggerSetVoice(socket: ReturnType<typeof createMockSocket>, data: unknown) {
  const h = socket._handlers['setVoice']
  if (!h) throw new Error('setVoice handler not registered')
  h(data)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerVoiceSocketHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    elevenVoiceIds[0] = 'AAAAAAAAAAAAAAAA'
    elevenVoiceIds[1] = 'BBBBBBBBBBBBBBBB'
  })

  it('registers a setVoice event listener on the socket', () => {
    const socket = createMockSocket()
    const ns = createMockNamespace()
    registerVoiceSocketHandler(socket, ns)
    expect(socket.on).toHaveBeenCalledWith('setVoice', expect.any(Function))
  })

  it('updates elevenVoiceIds and emits voiceUpdated on valid payload', () => {
    const socket = createMockSocket()
    const ns = createMockNamespace()
    registerVoiceSocketHandler(socket, ns)

    triggerSetVoice(socket, { agentId: 0, voiceId: 'CCCCCCCCCCCCCCCC' })

    expect(elevenVoiceIds[0]).toBe('CCCCCCCCCCCCCCCC')
    expect(ns.emit).toHaveBeenCalledWith('voiceUpdated', { agentId: 0, voiceId: 'CCCCCCCCCCCCCCCC' })
  })

  it('emits auditLog with previous and new voice IDs', () => {
    const socket = createMockSocket()
    const ns = createMockNamespace()
    registerVoiceSocketHandler(socket, ns)

    triggerSetVoice(socket, { agentId: 1, voiceId: 'DDDDDDDDDDDDDDDD' })

    const auditCall = (ns.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event]) => event === 'auditLog',
    )
    expect(auditCall).toBeDefined()
    const [, msg] = auditCall!
    expect(msg.text).toContain('BBBBBBBBBBBBBBBB')
    expect(msg.text).toContain('DDDDDDDDDDDDDDDD')
    expect(msg.isAudit).toBe(true)
    expect(msg.agentId).toBe(-2)
  })

  it('ignores payload when agentId is invalid (out of range)', () => {
    const socket = createMockSocket()
    const ns = createMockNamespace()
    registerVoiceSocketHandler(socket, ns)

    triggerSetVoice(socket, { agentId: 2, voiceId: 'CCCCCCCCCCCCCCCC' })

    expect(ns.emit).not.toHaveBeenCalled()
    expect(elevenVoiceIds[0]).toBe('AAAAAAAAAAAAAAAA')
  })

  it('ignores payload when agentId is not a number', () => {
    const socket = createMockSocket()
    const ns = createMockNamespace()
    registerVoiceSocketHandler(socket, ns)

    triggerSetVoice(socket, { agentId: 'bad', voiceId: 'CCCCCCCCCCCCCCCC' })

    expect(ns.emit).not.toHaveBeenCalled()
  })

  it('ignores payload when voiceId is too short', () => {
    const socket = createMockSocket()
    const ns = createMockNamespace()
    registerVoiceSocketHandler(socket, ns)

    triggerSetVoice(socket, { agentId: 0, voiceId: 'tooshort' })

    expect(ns.emit).not.toHaveBeenCalled()
    expect(elevenVoiceIds[0]).toBe('AAAAAAAAAAAAAAAA')
  })

  it('ignores payload when voiceId contains invalid characters', () => {
    const socket = createMockSocket()
    const ns = createMockNamespace()
    registerVoiceSocketHandler(socket, ns)

    triggerSetVoice(socket, { agentId: 0, voiceId: '../../../etc/passwd' })

    expect(ns.emit).not.toHaveBeenCalled()
  })

  it('is a no-op when voice has not changed', () => {
    const socket = createMockSocket()
    const ns = createMockNamespace()
    registerVoiceSocketHandler(socket, ns)

    triggerSetVoice(socket, { agentId: 0, voiceId: 'AAAAAAAAAAAAAAAA' })

    expect(ns.emit).not.toHaveBeenCalled()
  })

  it('ignores non-object payloads', () => {
    const socket = createMockSocket()
    const ns = createMockNamespace()
    registerVoiceSocketHandler(socket, ns)

    triggerSetVoice(socket, null)
    triggerSetVoice(socket, 'string payload')
    triggerSetVoice(socket, 42)

    expect(ns.emit).not.toHaveBeenCalled()
  })

  it('includes IP in audit log text', () => {
    const socket = createMockSocket('10.0.0.1')
    const ns = createMockNamespace()
    registerVoiceSocketHandler(socket, ns)

    triggerSetVoice(socket, { agentId: 0, voiceId: 'CCCCCCCCCCCCCCCC' })

    const auditCall = (ns.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event]) => event === 'auditLog',
    )
    expect(auditCall![1].text).toContain('10.0.0.1')
  })

  it('calls logger when provided', () => {
    const socket = createMockSocket()
    const ns = createMockNamespace()
    const log = { info: vi.fn() }
    registerVoiceSocketHandler(socket, ns, log)

    triggerSetVoice(socket, { agentId: 0, voiceId: 'CCCCCCCCCCCCCCCC' })

    expect(log.info).toHaveBeenCalledOnce()
    const [meta] = log.info.mock.calls[0] as any[]
    expect(meta.agentId).toBe(0)
    expect(meta.prevVoiceId).toBe('AAAAAAAAAAAAAAAA')
    expect(meta.newVoiceId).toBe('CCCCCCCCCCCCCCCC')
  })
})
