// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent) [§32]

// =============================================================================
// Pipeline – Speech-to-Text Provider
// =============================================================================

import axios from 'axios'
import FormData from 'form-data'
import type { STTProvider, ProviderMetrics } from './types'
import { getMetrics } from '../observability/metrics'
import { getAppLogger } from '../observability/logger'

export interface STTConfig {
  provider: 'groq' | 'openai' | 'google'
  apiKey: string
  /** Google Cloud project ID — required for Chirp 2 (v2 API). Omit to use v1p1beta1 with Chirp. */
  projectId?: string
  /** BCP-47 language code (default: 'en-US'). Google STT only. */
  languageCode?: string
  /** Google STT model override (default: 'chirp_2' with projectId, 'chirp' without). */
  model?: string
}

// Pricing per minute of audio
const STT_PRICING: Record<string, number> = {
  'openai-whisper': 0.006,
  'groq-whisper': 0.00, // Free tier
  'google-stt': 0.048,  // Chirp / Chirp 2 — $0.048/min
}

function createSTTMetrics(): ProviderMetrics {
  return {
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    avgLatencyMs: 0,
    avgTimeToFirstTokenMs: 0,
  }
}

export function createSTT(config: STTConfig): STTProvider {
  const { provider, apiKey } = config

  // ---------------------------------------------------------------------------
  // Google Cloud STT (Chirp / Chirp 2)
  // ---------------------------------------------------------------------------
  if (provider === 'google') {
    const languageCode = config.languageCode || 'en-US'
    const projectId = config.projectId
    const useV2 = !!projectId
    const model = config.model || (useV2 ? 'chirp_2' : 'chirp')
    const metrics = createSTTMetrics()
    const log = getAppLogger('stt')
    const labels = { provider: 'google-stt' }

    return {
      name: 'google-stt',

      async transcribe(audioBuffer: Buffer, _mimeType: string = 'audio/wav'): Promise<{ text: string }> {
        const start = Date.now()
        const audioContent = audioBuffer.toString('base64')
        const m = getMetrics()

        try {
          let responseData: any

          if (useV2) {
            const url = `https://speech.googleapis.com/v2/projects/${projectId}/locations/global/recognizers/_:recognize`
            const res = await axios.post(
              url,
              {
                config: {
                  model,
                  languageCodes: [languageCode],
                  features: { enableAutomaticPunctuation: true },
                },
                content: audioContent,
              },
              {
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                timeout: 30_000,
              },
            )
            responseData = res.data
          } else {
            const url = `https://speech.googleapis.com/v1p1beta1/speech:recognize?key=${encodeURIComponent(apiKey)}`
            const res = await axios.post(
              url,
              {
                config: {
                  languageCode,
                  model,
                  enableAutomaticPunctuation: true,
                  // No encoding field — WAV/FLAC are self-describing
                },
                audio: { content: audioContent },
              },
              {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30_000,
              },
            )
            responseData = res.data
          }

          const latencyMs = Date.now() - start
          metrics.requestCount++
          metrics.successCount++
          metrics.avgLatencyMs =
            (metrics.avgLatencyMs * (metrics.requestCount - 1) + latencyMs) / metrics.requestCount

          m.counter('xspace_stt_requests_total', 'Total STT requests', labels)
          m.histogram('xspace_stt_latency_ms', latencyMs, 'STT request latency', labels)
          m.histogram('xspace_stt_audio_bytes', audioBuffer.length, 'Audio bytes processed', labels)
          log.debug({ provider: 'google-stt', model, latencyMs, audioBytes: audioBuffer.length }, 'STT transcription completed')

          const results: any[] = responseData?.results || []
          const text = results
            .map((r) => r.alternatives?.[0]?.transcript ?? '')
            .join(' ')
            .trim()

          return { text }
        } catch (err) {
          metrics.requestCount++
          metrics.errorCount++
          m.counter('xspace_stt_requests_total', 'Total STT requests', labels)
          m.counter('xspace_stt_errors_total', 'STT request errors', labels)
          log.error({ err, provider: 'google-stt' }, 'STT transcription failed')
          throw err
        }
      },

      getMetrics(): ProviderMetrics {
        return { ...metrics }
      },

      estimateCost(durationSeconds: number): number {
        return (durationSeconds / 60) * (STT_PRICING['google-stt'] ?? 0)
      },

      async checkHealth(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
        const start = Date.now()
        try {
          // List recognizers (v2) confirms API key + project access; fall back to root ping
          const url = useV2
            ? `https://speech.googleapis.com/v2/projects/${projectId}/locations/global/recognizers`
            : `https://speech.googleapis.com/$discovery/rest?version=v1p1beta1`
          const res = await axios.get(url, {
            headers: useV2 ? { Authorization: `Bearer ${apiKey}` } : {},
            timeout: 5_000,
          })
          return { ok: res.status >= 200 && res.status < 500, latencyMs: Date.now() - start }
        } catch (err: any) {
          return { ok: false, latencyMs: Date.now() - start, error: err?.message ?? String(err) }
        }
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Whisper (OpenAI / Groq)
  // ---------------------------------------------------------------------------
  const model = provider === 'openai' ? 'whisper-1' : 'whisper-large-v3'
  const baseUrl =
    provider === 'openai'
      ? 'https://api.openai.com/v1/audio/transcriptions'
      : 'https://api.groq.com/openai/v1/audio/transcriptions'

  const providerName = provider === 'openai' ? 'openai-whisper' : 'groq-whisper'
  const metrics = createSTTMetrics()
  const log = getAppLogger('stt')

  return {
    name: providerName,

    async transcribe(
      audioBuffer: Buffer,
      mimeType: string = 'audio/webm',
    ): Promise<{ text: string }> {
      const ext = mimeType.includes('wav') ? 'wav' : 'webm'
      const start = Date.now()

      const form = new FormData()
      form.append('file', audioBuffer, {
        filename: `audio.${ext}`,
        contentType: mimeType,
      })
      form.append('model', model)

      const m = getMetrics()
      const labels = { provider: providerName }

      try {
        const response = await axios.post(baseUrl, form, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            ...form.getHeaders(),
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        })

        const latencyMs = Date.now() - start
        metrics.requestCount++
        metrics.successCount++
        metrics.avgLatencyMs =
          (metrics.avgLatencyMs * (metrics.requestCount - 1) + latencyMs) / metrics.requestCount

        m.counter('xspace_stt_requests_total', 'Total STT requests', labels)
        m.histogram('xspace_stt_latency_ms', latencyMs, 'STT request latency', labels)
        m.histogram('xspace_stt_audio_bytes', audioBuffer.length, 'Audio bytes processed', labels)
        log.debug({ provider: providerName, latencyMs, audioBytes: audioBuffer.length }, 'STT transcription completed')

        return { text: response.data.text || '' }
      } catch (err) {
        metrics.requestCount++
        metrics.errorCount++
        m.counter('xspace_stt_requests_total', 'Total STT requests', labels)
        m.counter('xspace_stt_errors_total', 'STT request errors', labels)
        log.error({ err, provider: providerName }, 'STT transcription failed')
        throw err
      }
    },

    getMetrics(): ProviderMetrics {
      return { ...metrics }
    },

    estimateCost(durationSeconds: number): number {
      const perMinute = STT_PRICING[providerName] ?? 0
      return (durationSeconds / 60) * perMinute
    },

    async checkHealth(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
      const start = Date.now()
      const healthUrl =
        provider === 'openai'
          ? 'https://api.openai.com/v1/models'
          : 'https://api.groq.com/openai/v1/models'
      try {
        const res = await axios.get(healthUrl, {
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 5000,
        })
        return { ok: res.status >= 200 && res.status < 300, latencyMs: Date.now() - start }
      } catch (err: any) {
        return { ok: false, latencyMs: Date.now() - start, error: err?.message ?? String(err) }
      }
    },
  }
}


