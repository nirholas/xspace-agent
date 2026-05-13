// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

// =============================================================================
// ElevenLabs TTS streaming proxy and voice catalog endpoint.
//
// Ported from legacy server.js /tts/:agentId/stream and /voices.
// Independent of providers/tts.js (that path handles Puppeteer X-Spaces audio
// injection; this one serves browser-page WebRTC agents directly).
//
// Migration note: Replaces server.js /tts and /voices. Both paths run in
// parallel during transition — see packages/server/README.md.
// =============================================================================

import { Router, type Request, type Response } from 'express'
import type { Server as IOServer } from 'socket.io'
import { z } from 'zod'
import {
  ELEVEN_KEY,
  ELEVEN_MODEL,
  ELEVEN_OPTIMIZE,
  ELEVEN_FORMAT,
  VOICE_ID_RE,
  EL_MAX_TEXT,
  ELEVENLABS_DAILY_CHAR_CAP,
  elevenVoiceIds,
  elTake,
  elDailyStats,
  voicesCache,
  setVoicesCache,
  VOICES_TTL_MS,
} from '../lib/eleven-state'

// ---------------------------------------------------------------------------
// Request schemas — Zod for structural validation; error messages match legacy
// ---------------------------------------------------------------------------

const TtsParamsSchema = z.object({
  agentId: z.string().refine(
    (v) => {
      const n = parseInt(v, 10)
      return n === 0 || n === 1
    },
    { message: 'invalid agent id' },
  ),
})

const TtsBodySchema = z.object({
  text: z.string().optional(),
  voiceId: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Route factory — accepts the Socket.IO server to emit cost-warning events
// ---------------------------------------------------------------------------

export function createTTSRouter(io: IOServer): Router {
  const router = Router()

  // ── POST /tts/:agentId/stream ─────────────────────────────────────────────
  //
  // Streams ElevenLabs audio directly to the browser page.  The API key is
  // never exposed to the client; the server proxies the stream.

  router.post('/tts/:agentId/stream', async (req: Request, res: Response) => {
    if (!ELEVEN_KEY) {
      res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' })
      return
    }

    // Param validation (returns legacy-compatible error shape)
    const paramsResult = TtsParamsSchema.safeParse(req.params)
    if (!paramsResult.success) {
      res.status(400).json({ error: 'invalid agent id' })
      return
    }
    const agentId = parseInt(paramsResult.data.agentId, 10)

    // Body validation
    const bodyResult = TtsBodySchema.safeParse(req.body)
    if (!bodyResult.success) {
      res.status(400).json({ error: 'missing text' })
      return
    }

    const text = (bodyResult.data.text ?? '').toString().trim()
    if (!text) {
      res.status(400).json({ error: 'missing text' })
      return
    }
    if (text.length > EL_MAX_TEXT) {
      res.status(413).json({
        error: `text too long (max ${EL_MAX_TEXT} chars)`,
        length: text.length,
      })
      return
    }

    const requestedVoice = (
      bodyResult.data.voiceId ??
      elevenVoiceIds[agentId] ??
      elevenVoiceIds[0]
    ).toString()

    if (!VOICE_ID_RE.test(requestedVoice)) {
      res.status(400).json({ error: 'invalid voice id' })
      return
    }

    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown'
    if (!elTake(ip)) {
      elDailyStats.rateLimitedToday++
      res.status(429).json({ error: 'rate limit exceeded (TTS)' })
      return
    }

    if (elDailyStats.charsSentToday + text.length > ELEVENLABS_DAILY_CHAR_CAP) {
      res.status(503).json({
        error: 'daily TTS cap reached',
        capacity: ELEVENLABS_DAILY_CHAR_CAP,
        used: elDailyStats.charsSentToday,
      })
      return
    }

    const url =
      `https://api.elevenlabs.io/v1/text-to-speech/${requestedVoice}/stream` +
      `?optimize_streaming_latency=${encodeURIComponent(ELEVEN_OPTIMIZE)}` +
      `&output_format=${encodeURIComponent(ELEVEN_FORMAT)}`

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

    try {
      const r = await globalThis.fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVEN_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: ELEVEN_MODEL,
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.7,
            style: 0.2,
            use_speaker_boost: true,
          },
        }),
      })

      if (!r.ok || !r.body) {
        const errBody = await r.text().catch(() => '')
        elDailyStats.upstreamErrorsToday++
        res.status(r.status || 502).send(errBody || 'elevenlabs error')
        return
      }

      res.setHeader('Content-Type', 'audio/mpeg')
      res.setHeader('Cache-Control', 'no-store')

      reader = r.body.getReader()
      // Cancel upstream reader if the client disconnects mid-stream.
      res.on('close', () => {
        try {
          reader?.cancel()
        } catch {
          // no-op
        }
      })

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && !res.writableEnded) res.write(Buffer.from(value))
      }

      // Accounting — only after a successful stream.
      elDailyStats.charsSentToday += text.length
      elDailyStats.callsToday++

      const pct = elDailyStats.charsSentToday / ELEVENLABS_DAILY_CHAR_CAP
      const spaceNS = io.of('/space')
      if (!elDailyStats.warnedAt80 && pct >= 0.8) {
        elDailyStats.warnedAt80 = true
        spaceNS.emit('costWarning', {
          kind: 'elevenlabs-daily-80pct',
          used: elDailyStats.charsSentToday,
          cap: ELEVENLABS_DAILY_CHAR_CAP,
          percent: Math.round(pct * 100),
        })
      }
      if (!elDailyStats.warnedAt95 && pct >= 0.95) {
        elDailyStats.warnedAt95 = true
        spaceNS.emit('costWarning', {
          kind: 'elevenlabs-daily-95pct',
          used: elDailyStats.charsSentToday,
          cap: ELEVENLABS_DAILY_CHAR_CAP,
          percent: Math.round(pct * 100),
        })
      }

      res.end()
    } catch (e: any) {
      if (!res.headersSent) res.status(500).json({ error: e.message })
      else {
        try {
          res.end()
        } catch {
          // no-op
        }
      }
      if (reader) {
        try {
          reader.cancel()
        } catch {
          // no-op
        }
      }
    }
  })

  // ── GET /voices ───────────────────────────────────────────────────────────
  //
  // Returns the ElevenLabs voice catalog, cached for 5 minutes.
  // current[] always reflects the live runtime voice IDs even on a cache hit.

  router.get('/voices', async (_req: Request, res: Response) => {
    if (!ELEVEN_KEY) {
      res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' })
      return
    }

    if (voicesCache && Date.now() - voicesCache.at < VOICES_TTL_MS) {
      res.json({ ...voicesCache.payload, current: { ...elevenVoiceIds } })
      return
    }

    try {
      const r = await globalThis.fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': ELEVEN_KEY },
      })
      if (!r.ok) {
        res.status(r.status).send(await r.text())
        return
      }

      const data = (await r.json()) as { voices?: any[] }
      const payload = {
        voices: (data.voices ?? []).map((v: any) => ({
          id: v.voice_id,
          name: v.name,
          category: v.category ?? null,
          description: v.labels?.description ?? null,
          labels: v.labels ?? null,
          preview: v.preview_url ?? null,
        })),
      }

      setVoicesCache({ at: Date.now(), payload })
      res.json({ ...payload, current: { ...elevenVoiceIds } })
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  return router
}
