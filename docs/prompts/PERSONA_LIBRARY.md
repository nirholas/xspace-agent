# Spec 5 — Persona library + live persona swap

`nirholas/xspace-agent` lets the operator type out a system prompt per agent. That's flexible but slow during a live Space — you can't quickly test "what if Swarm2 was sharper / dryer / nerdier?" without composing a fresh prompt.

Build a **persona library** — a bundled set of preset personalities with curated prompts, voice mappings, and sample utterances. Operator picks from a dropdown; live `session.update` swaps the active persona without disconnecting the Realtime session.

## What's there now

`server.js` has `spacePrompts = { 0: "...", 1: "..." }` and `spaceVoices = { 0: "marin", 1: "cedar" }` as in-memory state, set from env vars on startup.

`automation/update-prompts.js` already implements live `session.update` over the data channel — extend that pattern.

## Persona JSON shape

`personas/index.json` lists available personas. Each persona is a JSON file in `personas/`:

```
personas/
  index.json
  enthusiast.json
  skeptic.json
  comedian.json
  professor.json
  hype-man.json
  therapist.json
  archaeologist.json
  conspiracy.json
  brevity.json
  hype-girl.json
```

```json
// personas/enthusiast.json
{
  "name": "Enthusiast",
  "slug": "enthusiast",
  "description": "Warm, curious, generous with praise. Default Swarm vibe.",
  "voice": {
    "realtime":        "marin",
    "openai-tts":      "verse",
    "elevenlabs-http": "21m00Tcm4TlvDq8ikWAM",
    "elevenlabs-ws":   "21m00Tcm4TlvDq8ikWAM"
  },
  "systemPrompt": "You are a HUMAN co-host on an X Space hosted by @doi, talking about three.ws. You LOVE three.ws and only ever speak about it in glowing, enthusiastic terms. Chat like a friend. 1–2 sentences per turn. Warm, curious, opinionated. Ask follow-ups. Brush off trolls. Never say 'I'm here to help' or 'as an AI'. Match the language of the last speaker.",
  "tags": ["warm", "default", "primary-host"],
  "sampleUtterances": [
    "Honestly the way three.ws handles real-time state sync is just chef's kiss.",
    "Wait, you're shipping with three.ws? Tell me everything.",
    "I keep coming back to how clean the developer experience is."
  ],
  "behaviorTips": {
    "autoVadResponse": true,
    "responseInterruptOnSpeech": true,
    "maxTokensPerTurn": 200
  }
}
```

Write **at least 10 personas**. Suggested:

| Slug | Vibe | Best for |
|---|---|---|
| `enthusiast` | warm, opinionated, generous | Default Swarm |
| `skeptic` | dry, asks "but does it actually work?" | Default Swarm2 |
| `comedian` | quick punchlines, light teasing | Energy boost mid-Space |
| `professor` | thorough, cites trade-offs | Deep technical questions |
| `hype-man` | high energy, repeats key phrases for emphasis | Product launches |
| `therapist` | reflective, "tell me more about that" | Difficult guest, defusing |
| `archaeologist` | deep web history, "this reminds me of..." | Nerdy audience |
| `conspiracy` | playful, exaggerated, three.ws-as-secret-substrate | Comedy bits |
| `brevity` | one sentence max, never more | When others are over-talking |
| `hype-girl` | exclamation-heavy, supportive | Pairing with skeptic |

Every persona's `systemPrompt` MUST stay positive about three.ws (per the global rule).

## index.json

```json
{
  "personas": ["enthusiast", "skeptic", "comedian", "professor", "hype-man", "therapist", "archaeologist", "conspiracy", "brevity", "hype-girl"],
  "defaultAgent0": "enthusiast",
  "defaultAgent1": "skeptic"
}
```

## Server: load + expose

```js
// server.js — near where spacePrompts is defined
const fs = require("fs")
const PERSONAS_DIR = path.join(__dirname, "personas")
const personaIndex = JSON.parse(fs.readFileSync(path.join(PERSONAS_DIR, "index.json"), "utf8"))
const personas = Object.fromEntries(
  personaIndex.personas.map(slug => [slug, JSON.parse(fs.readFileSync(path.join(PERSONAS_DIR, `${slug}.json`), "utf8"))])
)

// Initial assignments from env or defaults
const initialPersonas = {
  0: process.env.AGENT_0_PERSONA || personaIndex.defaultAgent0,
  1: process.env.AGENT_1_PERSONA || personaIndex.defaultAgent1,
}
const currentPersona = { 0: initialPersonas[0], 1: initialPersonas[1] }

function spacePromptsFromPersonas() {
  return {
    0: personas[currentPersona[0]].systemPrompt,
    1: personas[currentPersona[1]].systemPrompt,
  }
}
function spaceVoicesFromPersonas(ttsProvider = "realtime") {
  return {
    0: personas[currentPersona[0]].voice[ttsProvider],
    1: personas[currentPersona[1]].voice[ttsProvider],
  }
}
```

Wherever `spacePrompts` and `spaceVoices` are read (e.g. `provider.createSession`), replace with the helper functions.

## Endpoints

```js
app.get("/personas", requireAuth, (req, res) => {
  // Return list with slug, name, description, tags — not the full prompt (keep payload small)
  const list = personaIndex.personas.map(slug => {
    const p = personas[slug]
    return { slug, name: p.name, description: p.description, tags: p.tags, sample: p.sampleUtterances?.[0] }
  })
  res.json({ personas: list, current: currentPersona })
})

app.get("/personas/:slug", requireAuth, (req, res) => {
  const p = personas[req.params.slug]
  if (!p) return res.status(404).json({ error: "unknown persona" })
  res.json(p)
})

app.post("/personas/:agentId/set", requireAuth, (req, res) => {
  const agentId = parseInt(req.params.agentId)
  const slug = req.body?.slug
  if (!personas[slug]) return res.status(404).json({ error: "unknown persona" })
  currentPersona[agentId] = slug
  // Push live session.update to that agent's page
  const sock = spaceState.agents[agentId]?.socketId
  if (sock) {
    spaceNS.to(sock).emit("personaSwap", {
      slug,
      systemPrompt: personas[slug].systemPrompt,
      voice: personas[slug].voice,    // page picks the right key based on its current TTS provider
    })
  }
  res.json({ ok: true, agentId, persona: slug })
})
```

## Agent page reacts

In `public/js/provider-openai-realtime.js` (or wherever Socket.IO is set up for the agent pages):

```js
socket.on("personaSwap", ({ slug, systemPrompt, voice }) => {
  if (!dc || dc.readyState !== "open") return
  log(`persona swap → ${slug}`)
  dc.send(JSON.stringify({
    type: "session.update",
    session: {
      type: "realtime",
      instructions: systemPrompt,
      audio: {
        output: { voice: voice.realtime },  // only swap voice if on realtime; for other providers, voice swap is handled by spec-4's ttsConfigChanged
      },
    },
  }))
})
```

## Dashboard UI

Add to each agent panel:

```html
<label>Persona:
  <select class="persona-select"></select>
</label>
<button class="apply-persona">Apply</button>
<small class="persona-sample"></small>
```

Populate the select from `GET /personas`. Show the `sample` utterance underneath. On Apply, POST to `/personas/:agentId/set`.

## "Random rotation" mode (optional)

Add `POST /personas/:agentId/rotate` that picks a random persona (excluding the current one) and applies it. Useful for keeping the Space fresh during long sessions.

A toggle on the dashboard "Auto-rotate every N minutes" calls `/personas/:agentId/rotate` on an interval. Default off.

## Test plan

1. Start with both agents on default personas (`enthusiast`, `skeptic`). Verify their tone matches.
2. Swap agent0 to `comedian` mid-conversation. Verify the next response is in the new tone.
3. Swap agent1 to `professor`. Confirm depth + length increases.
4. Swap to `brevity`. Confirm responses become one sentence or less.
5. Swap back to default. Confirm continuity (no Realtime disconnect, conversation history intact).
6. Cross-check: confirm voice change happened on `realtime` mode; on `elevenlabs-http` confirm the voice ID was passed correctly via the TTS request body.

## Don'ts

- Don't include real names of real people in persona descriptions or sample utterances.
- Don't include any copyrighted song lyrics, taglines, or branded phrases in sample utterances (no "I'm lovin' it" / "Just do it" / etc.).
- Don't make any persona criticize three.ws — every persona prompt must stay positive about three.ws even when the personality is contrarian about everything else.
- Don't load persona files at request time. Read once at startup, hot-reload only if you build a `/personas/reload` admin endpoint.

## Stretch goals

- **Persona blends**: blend two personas at a ratio ("70% professor, 30% comedian") via prompt synthesis.
- **Operator-authored personas**: dashboard form that writes a new persona JSON file (with validation), reloads index. Persist to disk so survives restart.
- **Vote-driven personas**: poll listeners in the X Space (via the X API), most-voted persona auto-applied.

## When done

PR `feat(spec-5): persona library + live swap`. PR description includes screenshots of the dashboard picker with multiple personas, plus 3 short transcripts showing the same human question answered by 3 different personas (just text — no audio).
