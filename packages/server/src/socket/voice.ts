// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

// =============================================================================
// setVoice — Socket.IO handler for runtime ElevenLabs voice swaps.
//
// Ported from legacy server.js socket.on("setVoice", ...).
// Socket must already be auth-gated by the namespace middleware before this
// handler is registered — validation here is for correctness, not security.
// =============================================================================

import type { Socket, Namespace } from 'socket.io'
import { VOICE_ID_RE, elevenVoiceIds } from '../lib/eleven-state'

export interface VoiceSocketLogger {
  info(meta: Record<string, unknown>, msg: string): void
}

/**
 * Register the `setVoice` event handler on an already-authenticated socket.
 *
 * Payload: `{ agentId: 0|1, voiceId: string }`
 *
 * On success:
 *   - Updates the in-memory voice ID for the given agent (affects all
 *     subsequent /tts/:id/stream requests).
 *   - Emits `voiceUpdated { agentId, voiceId }` to all namespace clients.
 *   - Emits `auditLog` with a human-readable change record.
 *
 * Silently ignores invalid payloads (same as legacy behaviour — operator
 * pages validate before sending; malformed events are not an error condition
 * worth surfacing to the client).
 */
export function registerVoiceSocketHandler(
  socket: Socket,
  spaceNS: Namespace,
  log?: VoiceSocketLogger,
): void {
  socket.on('setVoice', (data: unknown) => {
    if (!data || typeof data !== 'object') return
    const { agentId, voiceId } = data as Record<string, unknown>

    const id = parseInt(String(agentId ?? ''), 10)
    if (id !== 0 && id !== 1) return

    const v = String(voiceId ?? '').trim()
    if (!VOICE_ID_RE.test(v)) return

    // No-op if the voice hasn't actually changed.
    if (elevenVoiceIds[id] === v) return

    const prev = elevenVoiceIds[id]
    elevenVoiceIds[id] = v

    const ip =
      (socket.handshake.headers['x-forwarded-for'] as string) ||
      socket.handshake.address ||
      'unknown'

    log?.info({ agentId: id, prevVoiceId: prev, newVoiceId: v, ip }, 'voice changed via setVoice')

    // Emit the same audit log event as legacy so existing dashboards don't need changes.
    const auditMsg = {
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentId: -2,
      name: 'audit',
      text: `voice change agent ${id}: ${prev} → ${v}  (from ${ip})`,
      timestamp: Date.now(),
      isAudit: true,
    }
    spaceNS.emit('auditLog', auditMsg)
    spaceNS.emit('voiceUpdated', { agentId: id, voiceId: v })
  })
}
