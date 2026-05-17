# Integrating `@xspace/web-client` into `three.ws`

This guide shows how to wire the xspace-agent pay-per-question API into the
`nirholas/three.ws` repo so visitors can:

1. See the 3D avatar (already provided by the `<agent-3d>` web component).
2. Type a question into a chat box.
3. Pay $0.01 USDC — Phantom (Solana) by default, MetaMask/Coinbase (Base) as fallback.
4. Watch the avatar speak the answer aloud while the same text appears in the chat log.

## Install

In the `three.ws` repo:

```bash
pnpm add @xspace/web-client
# peer deps the SDK relies on (already transitive but listed for clarity):
# @solana/web3.js  @solana/spl-token  socket.io-client
```

If you're publishing to npm later, set the package's `apiUrl` config to your
deployed xspace-agent backend (Cloud Run, Railway, etc.). For local dev,
point it at `http://localhost:3000`.

## Server-side prerequisites (in xspace-agent's `.env`)

```ini
# Payment recipient wallets
SOLANA_RECIPIENT_ADDRESS=<your Solana wallet>
EVM_RECIPIENT_ADDRESS=<your Base wallet>

# Coinbase CDP API key (paste from CDP dashboard — never in chat)
CDP_API_KEY_ID=<UUID>
CDP_API_KEY_SECRET=<base64 Ed25519 secret>

# Price per question (USDC base units; 10000 = $0.01)
X402_PRICE_USDC=10000

# Allow the three.ws origin to call the API
CORS_ORIGINS=https://three.ws,https://your-staging.three.ws,http://localhost:5173
```

## Minimal vanilla integration

Drop this into `three.ws`'s main entry HTML. The `<agent-3d>` element renders
the avatar; `XSpaceAskClient` handles payment + responses.

```html
<agent-3d id="avatar" body="https://cdn.three.ws/models/sample-avatar.glb"></agent-3d>

<div id="chat">
  <input id="q" placeholder="Ask the agent..." />
  <button id="send">Ask ($0.01)</button>
  <div id="transcript"></div>
</div>

<script type="module">
  import { XSpaceAskClient } from '@xspace/web-client'

  const client = new XSpaceAskClient({
    apiUrl: 'https://api.your-domain.com', // your xspace-agent backend
    preferredNetwork: 'solana',
  })

  const transcript = document.getElementById('transcript')
  const avatar = document.getElementById('avatar')

  client.on('response', ({ text, audio, source }) => {
    transcript.insertAdjacentHTML(
      'beforeend',
      `<p><b>Agent</b> <em>(${source})</em>: ${text}</p>`,
    )
    if (audio) {
      // Decode base64 MP3 and play it; also pipe amplitude to the avatar if
      // <agent-3d> exposes an audio sink (check three.ws docs for the API).
      const audioEl = new Audio('data:audio/mp3;base64,' + audio)
      audioEl.play()
      avatar?.dispatchEvent?.(new CustomEvent('speak', { detail: { audio: audioEl } }))
    }
  })

  client.on('error', ({ error }) => {
    transcript.insertAdjacentHTML('beforeend', `<p style="color:red">${error}</p>`)
  })

  document.getElementById('send').onclick = async () => {
    const question = document.getElementById('q').value.trim()
    if (!question) return

    // First click also triggers wallet connect if not connected yet.
    if (!client.getActive()) await client.connect()

    try {
      const { questionId, paidWith } = await client.ask(question)
      transcript.insertAdjacentHTML(
        'beforeend',
        `<p><b>You</b> <small>(paid ${paidWith.txHash.slice(0, 8)}…)</small>: ${question}</p>`,
      )
      document.getElementById('q').value = ''
    } catch (err) {
      transcript.insertAdjacentHTML(
        'beforeend',
        `<p style="color:red">${err.message}</p>`,
      )
    }
  }
</script>
```

## Svelte version (matches `three.ws`'s `chat/` stack)

```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { XSpaceAskClient } from '@xspace/web-client'

  const client = new XSpaceAskClient({
    apiUrl: import.meta.env.VITE_XSPACE_API_URL,
    preferredNetwork: 'solana',
  })

  let messages: Array<{ role: 'you' | 'agent'; text: string; audio?: string }> = []
  let question = ''
  let connecting = false
  let walletAddress: string | null = null

  onMount(() => {
    client.on('response', (ev) => {
      messages = [...messages, { role: 'agent', text: ev.text, audio: ev.audio ?? undefined }]
      if (ev.audio) new Audio('data:audio/mp3;base64,' + ev.audio).play()
    })
    client.on('error', (ev) => {
      messages = [...messages, { role: 'agent', text: `error: ${ev.error}` }]
    })
  })
  onDestroy(() => client.destroy())

  async function connect() {
    connecting = true
    try {
      const { address } = await client.connect()
      walletAddress = address
    } finally {
      connecting = false
    }
  }

  async function send() {
    if (!question.trim()) return
    if (!walletAddress) await connect()
    const text = question
    question = ''
    messages = [...messages, { role: 'you', text }]
    try { await client.ask(text) } catch (e) {
      messages = [...messages, { role: 'agent', text: `error: ${(e as Error).message}` }]
    }
  }
</script>

<div class="chat">
  {#each messages as m}
    <p class:you={m.role === 'you'} class:agent={m.role === 'agent'}>
      <b>{m.role}</b>: {m.text}
    </p>
  {/each}
  <input bind:value={question} on:keydown={(e) => e.key === 'Enter' && send()} />
  <button on:click={send} disabled={connecting}>
    {walletAddress ? 'Ask ($0.01)' : 'Connect wallet'}
  </button>
</div>
```

## Lipsync to the `<agent-3d>` avatar

`@xspace/web-client` returns the audio as base64 MP3 — it doesn't know how to
animate the avatar's mouth. The simplest approach is amplitude-driven mouth
movement using a `MediaElementAudioSourceNode + AnalyserNode`:

```js
const audioEl = new Audio('data:audio/mp3;base64,' + audio)
const ctx = new AudioContext()
const src = ctx.createMediaElementSource(audioEl)
const analyser = ctx.createAnalyser()
analyser.fftSize = 256
src.connect(analyser).connect(ctx.destination)
audioEl.play()

const data = new Uint8Array(analyser.frequencyBinCount)
function tick() {
  analyser.getByteFrequencyData(data)
  const amp = data.reduce((a, b) => a + b, 0) / data.length / 255 // 0..1
  // Forward to your avatar's morph-target / blendshape API:
  avatar.setMouthOpenness?.(amp)
  if (!audioEl.ended) requestAnimationFrame(tick)
}
tick()
```

If `<agent-3d>` exposes a `setMouthOpenness()` or `speak({ audio })` method,
prefer that. The amplitude approach is a cheap fallback that "looks alive"
without needing viseme generation.

## Testing locally

1. In `xspace-agent`: `pnpm dev` (port 3000).
2. In `three.ws`: set `VITE_XSPACE_API_URL=http://localhost:3000`, run `pnpm dev`.
3. Open the three.ws page. Make sure Phantom (or MetaMask) is installed.
4. Click **Ask** — Phantom popup appears with a $0.01 USDC SPL transfer.
5. Approve. After ~3–5s a response appears in the chat and audio plays.

If you see `402 Payment Required` errors in the network tab even after
approving, the facilitator (CDP or Sperax) rejected the payment — check the
server logs for the `invalidReason` from `verify()`.
