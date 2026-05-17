# x402 Pay-Per-Question — Micropayment API

A small USDC payment ($0.01 by default) buys a single question to the agent.
The endpoint is gated by [x402](https://www.x402.org/) — the HTTP 402-based
micropayment protocol — and supports two facilitators in parallel:

| Network | Asset | Facilitator | Wallets |
|---|---|---|---|
| Solana (mainnet) | USDC (SPL) | [Coinbase CDP](https://portal.cdp.coinbase.com) | Phantom, Solflare, Backpack |
| EVM — Base / Arbitrum / Ethereum | USDC | [Sperax](https://x402.sperax.io) | MetaMask, Coinbase Wallet, any EIP-1193 wallet |

The server publishes both options in its 402 challenge; the client picks whichever
network its wallet supports.

## The driving use case: `three.ws`

This API exists primarily to serve **[three.ws](https://github.com/nirholas/three.ws)** —
a 3D-avatar web app that lets visitors talk to the agent on the open web,
outside any X Space.

Flow on `three.ws`:

1. Visitor types a question into a chat box next to the avatar.
2. The browser SDK ([`@xspace/web-client`](../packages/web-client)) POSTs to
   `/api/ask` and receives `402 Payment Required` with USDC payment options.
3. Phantom (default) or MetaMask pops up to sign a $0.01 USDC transfer to the
   recipient wallet configured in xspace-agent's `.env`.
4. The browser re-sends the request with an `X-PAYMENT` header. The server
   verifies + settles via the facilitator and accepts the question (`202 Accepted`).
5. The answer is delivered asynchronously over Socket.IO (`/space` namespace,
   `ask:response` event) — text plus a base64 MP3.
6. `three.ws` plays the MP3 through a `MediaElementAudioSourceNode → AnalyserNode`
   and feeds the amplitude to the avatar's mouth blendshape to lipsync.

Two delivery modes, picked automatically by the server:

- **Live agent mode** — if an `XSpaceAgent` is currently joined to an X Space,
  the question is routed via `agent.say(question)`. The agent **speaks the
  question aloud in the Space**, the same text streams back to the web client,
  and the avatar lipsyncs to the same audio. Visitors paying $0.01 essentially
  get a one-line cameo in the live show.
- **Direct mode** — if no agent is live, the server instantiates the LLM + TTS
  providers from env vars and synthesizes a reply on its own. Audio is sent
  to the web client but **not** broadcast anywhere else.

The integration guide with copy-paste code (vanilla, Svelte, Web Component) lives
next to the SDK: **[packages/web-client/THREE_WS_INTEGRATION.md](../packages/web-client/THREE_WS_INTEGRATION.md)**.

## API surface

### `POST /api/ask`

**Request (first attempt — no payment):**

```http
POST /api/ask
Content-Type: application/json

{ "question": "what's the best way to learn Solana?" }
```

**Response — 402 Payment Required:**

```json
{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "exact",
      "network": "solana",
      "maxAmountRequired": "10000",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "payTo": "<SOLANA_RECIPIENT_ADDRESS>",
      "resource": "https://your-host/api/ask",
      "description": "Pay-per-question USDC micropayment"
    },
    {
      "scheme": "exact",
      "network": "base",
      "maxAmountRequired": "10000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "<EVM_RECIPIENT_ADDRESS>",
      "resource": "https://your-host/api/ask",
      "description": "Pay-per-question USDC micropayment"
    }
  ]
}
```

**Request (retry — signed payment):**

```http
POST /api/ask
Content-Type: application/json
X-PAYMENT: <base64-encoded payment payload signed by the wallet>

{ "question": "what's the best way to learn Solana?" }
```

**Response — 202 Accepted:**

```json
{
  "questionId": "8e6a…",
  "status": "processing",
  "paidWith": {
    "network": "solana",
    "txHash": "5Jh…",
    "amount": "10000",
    "asset": "EPjFWdd…"
  }
}
```

### Socket.IO — `/space` namespace

**`ask:response`** (server → client)

```ts
{
  questionId: string
  text: string
  audio: string | null   // base64 MP3
  source: 'agent' | 'direct'
  txHash?: string
  network?: string
  payer?: string
}
```

**`ask:error`** (server → client)

```ts
{ questionId: string; error: string }
```

Clients subscribe to both events and key handlers off `questionId`.

## Server configuration

All values live in `.env` — see [`.env.example`](../.env.example) for the
canonical reference. The minimum to enable Solana payments:

```ini
# Price per question — USDC base units (6 decimals → 10000 = $0.01)
X402_PRICE_USDC=10000

# Solana via Coinbase CDP
CDP_API_KEY_ID=<UUID from CDP dashboard>
CDP_API_KEY_SECRET=<base64 Ed25519 secret>
SOLANA_RECIPIENT_ADDRESS=<your Solana wallet>
X402_FACILITATOR_SOLANA=https://api.cdp.coinbase.com/platform/v2/x402/facilitator

# CORS — comma-separated list of allowed frontend origins
WEB_ORIGINS=https://three.ws,http://localhost:5173
```

To add EVM support alongside Solana:

```ini
# EVM via Sperax (Base mainnet by default)
EVM_RECIPIENT_ADDRESS=<your EVM wallet>
X402_FACILITATOR_EVM=https://x402.sperax.io
X402_EVM_NETWORK=base   # base | base-sepolia | arbitrum | ethereum
```

If neither pair of credentials is configured at boot, the server returns
`503 { error: "x402 not configured", hint: ... }` from `/api/ask` and logs a
warning. The rest of the server stays up.

## Routing decision

The route chooses its delivery path **per request**:

```
                       POST /api/ask + valid payment
                                  │
                ┌─────────────────┴─────────────────┐
                │                                   │
       state.agent !== null               state.agent === null
                │                                   │
       agent.say(question)               createLLM() + createTTS()
       wait for next response               from env vars
                │                                   │
       emit ask:response                  emit ask:response
       source: 'agent'                    source: 'direct'
       audio = agent's reply MP3          audio = TTS MP3 (or null)
```

Live-agent path has a **45 s timeout**. If the agent doesn't emit a `response`
event in that window, an `ask:error` is emitted with `'agent response timeout'`.

## Operational notes

- **Single live agent assumption.** The router listens to `agent.once('response')`,
  which is fine for the current single-agent server. If/when the server hosts
  multiple agents concurrently, this needs a per-question correlation ID
  threaded through the agent event payload.
- **Settlement happens before processing.** The facilitator settles funds
  before the route handler runs; if the LLM call fails afterward, the payer
  has already been charged. For now the on-chain receipt (returned to the
  client via `paidWith.txHash`) is the user's only refund recourse.
- **CORS.** The server adds `X-Payment` / `X-PAYMENT` to `allowedHeaders` and
  exposes `X-Payment-Response` — required for the 402 dance to work
  cross-origin. Set `WEB_ORIGINS` to lock down origins in production.
- **Rotate facilitator keys** if you ever paste `CDP_API_KEY_*` into chat,
  logs, or a screenshot. They sign settlement requests on your behalf.
- **No database.** Question/answer pairs are not persisted; the server only
  remembers them long enough to emit the Socket.IO event. Add your own
  logging hook if you need a paid-question audit trail.

## Related

- [`packages/web-client/`](../packages/web-client) — browser SDK source.
- [`packages/web-client/THREE_WS_INTEGRATION.md`](../packages/web-client/THREE_WS_INTEGRATION.md) — copy-paste integration recipes (vanilla, Svelte, web component).
- [`packages/server/src/x402/`](../packages/server/src/x402) — facilitator adapters and Express middleware.
- [`packages/server/src/routes/ask.ts`](../packages/server/src/routes/ask.ts) — the route itself.
