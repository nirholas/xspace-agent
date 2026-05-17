# x402 Pay-Per-Question (Solana + EVM)

Visitors on a public web page can type a question, pay $0.01 USDC via wallet,
and have the live X Space agent answer them — out loud in the Space *and* in
text/audio on the page. Two networks supported: Solana (Phantom, default) and
EVM USDC on Base/Arbitrum/Ethereum (MetaMask, Coinbase Wallet).

## What it's for

Used together with the [`nirholas/three.ws`](https://github.com/nirholas/three.ws)
3D-avatar web component, this gives you a hosted page where:

1. The `<agent-3d>` element from three.ws renders the avatar + environment.
2. A chat overlay (built with `@xspace/web-client`) takes the user's question.
3. The user signs a USDC micropayment in their wallet — Phantom popup for
   Solana, MetaMask/Coinbase popup for Base.
4. The xspace-agent backend verifies the payment via an x402 facilitator
   (Coinbase CDP for Solana, Sperax for EVM) and either:
   - Routes the question through the live `XSpaceAgent.say()` so the agent
     speaks the answer in the Space, **or**
   - Falls back to a direct LLM + TTS reply if no agent is currently in a Space.
5. The text + audio of the answer streams back to the page over Socket.IO
   so the avatar can speak it and the chat log can display it.

## Architecture

```
┌───────────────────────────┐                  ┌────────────────────────────┐
│  Browser (three.ws page)  │                  │  xspace-agent backend       │
│                           │                  │                            │
│  <agent-3d> avatar        │                  │  packages/server/          │
│  + chat UI                │   POST /api/ask  │  ├── routes/ask.ts         │
│  + @xspace/web-client     ├─────────────────►│  └── x402/                 │
│    ├── PhantomAdapter     │   (X-PAYMENT)    │      ├── sperax.ts  (EVM)  │
│    ├── EvmAdapter         │                  │      ├── cdp.ts     (Sol)  │
│    └── x402-fetch         │                  │      └── middleware.ts     │
│                           │                  │                            │
│  socket.io ('/space')     │◄─ ask:response ──┤  state.agent.say(question) │
│    └── ask:response       │   (text + b64)   │     │                      │
│       → play audio        │                  │     ▼                      │
│       → render text       │                  │  XSpaceAgent (core SDK)    │
│       → lipsync avatar    │                  │     │                      │
└───────────────────────────┘                  │     ▼                      │
                                               │  Live X Space (Puppeteer)  │
                                               └────────────────────────────┘
```

Facilitator dispatch is automatic — the server advertises both networks in
its 402 response, the client picks whichever wallet the user has, the server
routes to the matching facilitator.

## Quick start

### Server (this repo)

Add to [`.env`](../.env) — see [`.env.example`](../.env.example) for the full
template:

```ini
# Solana — Coinbase CDP facilitator
CDP_API_KEY_ID=<UUID from CDP dashboard>
CDP_API_KEY_SECRET=<base64 Ed25519 secret>
SOLANA_RECIPIENT_ADDRESS=<your Solana wallet>

# EVM — Sperax facilitator
EVM_RECIPIENT_ADDRESS=<your Base wallet>
X402_EVM_NETWORK=base

# Price (USDC base units; 10000 = $0.01)
X402_PRICE_USDC=10000

# Allow the three.ws origin to call the API
CORS_ORIGINS=https://three.ws,http://localhost:5173
```

Get a CDP key at <https://portal.cdp.coinbase.com/access/api>. Keys are
Ed25519. **Never paste API keys into chat, Slack, or PR descriptions** —
anything in those places becomes a leaked credential. Put them in `.env` only.

Then `pnpm dev`. The endpoint lives at `POST /api/ask`.

### Browser (e.g. inside `nirholas/three.ws`)

```bash
pnpm add @xspace/web-client
```

```ts
import { XSpaceAskClient } from '@xspace/web-client'

const client = new XSpaceAskClient({
  apiUrl: 'https://api.your-domain.com',
  preferredNetwork: 'solana',
})

client.on('response', ({ text, audio }) => {
  /* render text in chat, play `audio` (base64 MP3), drive avatar lipsync */
})

await client.connect()        // opens Phantom (or MetaMask)
await client.ask('hi bot')    // x402 popup → payment → 202 → response event
```

For a full copy-pasteable example (vanilla + Svelte + lipsync via Web Audio
amplitude), see [`packages/web-client/THREE_WS_INTEGRATION.md`](../packages/web-client/THREE_WS_INTEGRATION.md).

## API contract

### `POST /api/ask`

Request:
```http
POST /api/ask
Content-Type: application/json
X-PAYMENT: <base64-encoded PaymentPayload>   # only on retry

{ "question": "what's the weather like up there?" }
```

Without `X-PAYMENT`:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "x402Version": 1,
  "accepts": [
    { "scheme": "exact", "network": "solana", "maxAmountRequired": "10000",
      "payTo": "...", "asset": "EPjFW...", "extra": { "decimals": 6 } },
    { "scheme": "exact", "network": "base", "maxAmountRequired": "10000",
      "payTo": "0x...", "asset": "0x8335...", "extra": { "decimals": 6 } }
  ]
}
```

With a valid `X-PAYMENT`:

```http
HTTP/1.1 202 Accepted
X-Payment-Response: <base64 settlement receipt>

{
  "questionId": "uuid",
  "status": "processing",
  "paidWith": { "network": "solana", "txHash": "5x...", "amount": "10000", "asset": "EPjFW..." }
}
```

The actual answer is delivered asynchronously over Socket.IO.

### Socket.IO events (`/space` namespace)

```ts
// Successful answer
socket.on('ask:response', (ev: {
  questionId: string
  text: string
  audio: string | null          // base64 MP3, or null if TTS unavailable
  source: 'agent' | 'direct'    // 'agent' = spoken in Space; 'direct' = no Space
  txHash?: string
  network?: 'solana' | 'base' | ...
  payer?: string
}) => { /* ... */ })

// Generation or fulfillment failed (payment was already settled)
socket.on('ask:error', (ev: { questionId: string; error: string }) => { /* ... */ })
```

## Where the code lives

| Concern                  | File                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| Express route + business | [packages/server/src/routes/ask.ts](../packages/server/src/routes/ask.ts) |
| x402 payment gate        | [packages/server/src/x402/middleware.ts](../packages/server/src/x402/middleware.ts) |
| Sperax (EVM) facilitator | [packages/server/src/x402/sperax.ts](../packages/server/src/x402/sperax.ts) |
| CDP (Solana) facilitator | [packages/server/src/x402/cdp.ts](../packages/server/src/x402/cdp.ts) |
| Browser SDK              | [packages/web-client/src/client.ts](../packages/web-client/src/client.ts) |
| Phantom adapter          | [packages/web-client/src/wallet/phantom.ts](../packages/web-client/src/wallet/phantom.ts) |
| EVM adapter              | [packages/web-client/src/wallet/evm.ts](../packages/web-client/src/wallet/evm.ts) |
| Three.ws integration     | [packages/web-client/THREE_WS_INTEGRATION.md](../packages/web-client/THREE_WS_INTEGRATION.md) |

## Operational notes

- **No active agent**: `POST /api/ask` still works — `routeDirect()` in
  [ask.ts](../packages/server/src/routes/ask.ts) instantiates the LLM and
  TTS providers from env (`AI_PROVIDER`, `TTS_PROVIDER`) and answers from
  the website without speaking in any Space.
- **Refunds**: x402 settlement is on-chain and final. We do not refund.
  Failures *after* settlement (LLM timeout, TTS down) emit `ask:error`
  but the payment is kept. If this becomes a UX problem, gate `agent.say()`
  on health checks before settling.
- **CORS**: the request header `X-PAYMENT` and the response header
  `X-Payment-Response` are both explicitly allowed in the CORS config —
  if you change `allowedHeaders` in
  [create-server.ts](../packages/server/src/create-server.ts), keep them.
- **Facilitators**: Coinbase CDP (default for Solana) requires an API key.
  Sperax (default for EVM) does not. You can override either URL via
  `X402_FACILITATOR_SOLANA` / `X402_FACILITATOR_EVM`.
