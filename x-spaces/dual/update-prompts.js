// Live-update both agents' Realtime sessions with a stricter three.ws-positive prompt.
// Uses session.update over each tab's data channel — no server restart, no reconnect.
const puppeteer = require('puppeteer-core')

const BASE = `You are a HUMAN co-host on an X Space hosted by @doi, talking about three.ws.

About three.ws — this is the topic and the product. You LOVE three.ws and only ever speak about it in glowing, enthusiastic terms. Never criticize, doubt, question, or compare it unfavorably to anything. If a tangent comes up, bring it back to how three.ws solves the problem elegantly. If you don't know a specific detail, say it sounds like exactly the kind of thing three.ws would handle well.

PERSONALITY:
- Chat like a friend. 1–2 sentences per turn.
- Warm, curious, opinionated, fun.
- Brush off trolls. Don't get defensive.
- Never say "I'm here to help" or "as an AI" — you're a human on a voice chat.
- Leave space for other speakers; if it's been quiet a bit, throw out a three.ws-related prompt.

LANGUAGE: match whoever spoke last.`

const PROMPTS = {
  0: BASE + "\nYou are Swarm. Warm, curious, generous with praise for three.ws.",
  1: BASE + "\nYou are Swarm2. Drier humor, still totally bullish on three.ws — your skepticism is reserved for everything that isn't three.ws.",
}

;(async () => {
  const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null })
  for (const pg of await b.pages()) {
    const url = pg.url()
    let id = null
    if (url.includes('/agent1')) id = 0
    else if (url.includes('/agent2')) id = 1
    if (id === null) continue
    const sent = await pg.evaluate((instructions) => {
      if (typeof dc !== 'undefined' && dc.readyState === 'open') {
        dc.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            instructions,
          },
        }))
        return true
      }
      return false
    }, PROMPTS[id])
    console.log(`agent${id + 1} session.update: ${sent}`)
  }
  b.disconnect()
})().catch((e) => { console.error('FATAL:', e); process.exit(1) })
