// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

// =============================================================================
// POST /api/ask — pay-per-question endpoint gated by x402 micropayments.
//
// Flow:
//   1. Client posts { question } without payment.
//   2. x402Gate responds 402 with payment requirements (USDC on Solana via CDP,
//      and/or USDC on EVM via Sperax).
//   3. Client signs payment with Phantom/MetaMask, retries with X-PAYMENT header.
//   4. Gate verifies + settles, attaches req.x402, calls next().
//   5. We respond 202 { questionId } and route the question asynchronously:
//        - If an agent is live in a Space → agent.say(question)
//        - Otherwise → instantiate LLM + TTS from env, synthesize a reply
//   6. When the answer is ready, we emit Socket.IO `ask:response`
//      keyed by questionId so the web client can render it.
// =============================================================================

import { randomUUID } from 'crypto'
import { Router } from 'express'
import { z } from 'zod'
import type { Server as IOServer } from 'socket.io'
import {
  createLLM,
  createTTS,
  getAppLogger,
  type LLMProvider,
  type TTSProvider,
  type XSpaceAgent,
} from 'xspace-agent'

import { loadX402ConfigFromEnv, x402Gate } from '../x402'

const AskBody = z.object({
  question: z.string().trim().min(1).max(500),
})

interface AskRouterDeps {
  /** Reference to the server-wide state object holding the live agent (if any). */
  state: { agent: XSpaceAgent | null }
  io: IOServer
}

interface AskResponseEvent {
  questionId: string
  text: string
  /** Base64-encoded MP3, or null if no audio was generated. */
  audio: string | null
  /** Which path produced the answer. */
  source: 'agent' | 'direct'
  /** Tx hash from the x402 settlement, for receipts. */
  txHash?: string
  network?: string
  payer?: string
}

interface AskErrorEvent {
  questionId: string
  error: string
}

export function createAskRouter(deps: AskRouterDeps): Router {
  const router = Router()
  const log = getAppLogger('ask')

  const x402Config = loadX402ConfigFromEnv()
  if (!x402Config) {
    log.warn('x402 not configured — POST /api/ask will return 503')
    router.post('/', (_req, res) => {
      res.status(503).json({
        error: 'x402 not configured',
        hint: 'set SOLANA_RECIPIENT_ADDRESS + CDP_API_KEY_* and/or EVM_RECIPIENT_ADDRESS in .env',
      })
    })
    return router
  }

  const gate = x402Gate(x402Config)
  const spaceNS = deps.io.of('/space')

  // Lazy provider holders for the fallback path.
  let fallbackLlm: LLMProvider | null = null
  let fallbackTts: TTSProvider | null = null

  function getFallbackLlm(): LLMProvider | null {
    if (fallbackLlm) return fallbackLlm
    const provider = (process.env.AI_PROVIDER ?? 'openai') as
      | 'openai'
      | 'claude'
      | 'groq'
      | 'gemini'
    const apiKey =
      provider === 'claude'
        ? process.env.ANTHROPIC_API_KEY
        : provider === 'groq'
          ? process.env.GROQ_API_KEY
          : provider === 'gemini'
            ? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
            : process.env.OPENAI_API_KEY
    if (!apiKey) return null
    try {
      fallbackLlm = createLLM({ provider, apiKey } as any)
      return fallbackLlm
    } catch (err: any) {
      log.warn({ err: err.message }, 'failed to init fallback LLM')
      return null
    }
  }

  function getFallbackTts(): TTSProvider | null {
    if (fallbackTts) return fallbackTts
    const provider = (process.env.TTS_PROVIDER ?? 'openai') as
      | 'openai'
      | 'elevenlabs'
      | 'browser'
    const apiKey =
      provider === 'elevenlabs' ? process.env.ELEVENLABS_API_KEY : process.env.OPENAI_API_KEY
    if (!apiKey && provider !== 'browser') return null
    try {
      fallbackTts = createTTS({ provider, apiKey } as any)
      return fallbackTts
    } catch (err: any) {
      log.warn({ err: err.message }, 'failed to init fallback TTS')
      return null
    }
  }

  // ── POST /api/ask ────────────────────────────────────────────────────────
  router.post('/', gate, async (req, res) => {
    const parsed = AskBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', issues: parsed.error.flatten() })
      return
    }

    const { question } = parsed.data
    const questionId = randomUUID()
    const payment = req.x402!

    log.info(
      { questionId, network: payment.network, payer: payment.payer, txHash: payment.txHash },
      'paid question accepted',
    )

    // Respond immediately — the answer is delivered over Socket.IO.
    res.status(202).json({
      questionId,
      status: 'processing',
      paidWith: {
        network: payment.network,
        txHash: payment.txHash,
        amount: payment.amount,
        asset: payment.asset,
      },
    })

    // Process asynchronously.
    processQuestion({
      question,
      questionId,
      payment,
    }).catch((err: any) => {
      log.error({ err: err.message, questionId }, 'paid question processing failed')
      spaceNS.emit('ask:error', {
        questionId,
        error: err.message ?? 'processing failed',
      } satisfies AskErrorEvent)
    })
  })

  async function processQuestion(args: {
    question: string
    questionId: string
    payment: { network: string; txHash: string; payer: string }
  }): Promise<void> {
    const { question, questionId, payment } = args
    if (deps.state.agent) {
      await routeThroughAgent(deps.state.agent, question, questionId, payment)
      return
    }
    await routeDirect(question, questionId, payment)
  }

  /**
   * Active agent path — pipe the question through the live agent so it gets
   * spoken in the Space. We listen for the next `response` event and echo
   * its text + audio back to the web client.
   */
  async function routeThroughAgent(
    agent: XSpaceAgent,
    question: string,
    questionId: string,
    payment: { network: string; txHash: string; payer: string },
  ): Promise<void> {
    const TIMEOUT_MS = 45_000

    const result = await new Promise<{ text: string; audio: Buffer | null }>((resolve, reject) => {
      const onResponse = (ev: { text: string; audio: Buffer | null }): void => {
        cleanup()
        resolve(ev)
      }
      const onError = (err: Error): void => {
        cleanup()
        reject(err)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('agent response timeout'))
      }, TIMEOUT_MS)

      function cleanup(): void {
        clearTimeout(timer)
        ;(agent as any).off?.('response', onResponse)
        ;(agent as any).off?.('error', onError)
      }

      ;(agent as any).once('response', onResponse)
      ;(agent as any).once('error', onError)

      agent.say(question).catch((err: Error) => {
        cleanup()
        reject(err)
      })
    })

    spaceNS.emit('ask:response', {
      questionId,
      text: result.text,
      audio: result.audio ? result.audio.toString('base64') : null,
      source: 'agent',
      txHash: payment.txHash,
      network: payment.network,
      payer: payment.payer,
    } satisfies AskResponseEvent)
  }

  /**
   * Fallback path — no active agent. Generate a text response via LLM and
   * synthesize audio via TTS, then emit over Socket.IO. The audio is NOT
   * injected into any Space (there is none).
   */
  async function routeDirect(
    question: string,
    questionId: string,
    payment: { network: string; txHash: string; payer: string },
  ): Promise<void> {
    const llm = getFallbackLlm()
    if (!llm) {
      spaceNS.emit('ask:error', {
        questionId,
        error: 'no LLM provider configured for offline answers',
      } satisfies AskErrorEvent)
      return
    }

    const systemPrompt =
      'You are an AI agent that normally hosts live X Spaces. Right now you are not in a Space — answer briefly and conversationally, as if greeting a curious visitor on your website.'

    let text = ''
    for await (const chunk of llm.streamResponse(0, question, systemPrompt)) {
      text += chunk
    }
    text = text.trim()

    let audioB64: string | null = null
    const tts = getFallbackTts()
    if (tts) {
      try {
        const buf = await tts.synthesize(text)
        if (buf) audioB64 = buf.toString('base64')
      } catch (err: any) {
        log.warn({ err: err.message, questionId }, 'fallback TTS failed; sending text-only')
      }
    }

    spaceNS.emit('ask:response', {
      questionId,
      text,
      audio: audioB64,
      source: 'direct',
      txHash: payment.txHash,
      network: payment.network,
      payer: payment.payer,
    } satisfies AskResponseEvent)
  }

  return router
}
