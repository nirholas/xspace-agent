// After X unmute, trigger fresh banter from Swarm. Each agent's response will
// auto-forward via the server's textComplete → textToAgent rule, keeping the
// loop alive.
const puppeteer = require('puppeteer-core')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null })
  const agent1 = (await b.pages()).find((p) => p.url().includes('/agent1'))
  if (!agent1) { console.error('no agent1'); process.exit(1) }
  const sent = await agent1.evaluate(() => {
    if (typeof dc !== 'undefined' && dc.readyState === 'open') {
      dc.send(JSON.stringify({
        type: 'response.create',
        response: {
          instructions:
            "You and your friend Swarm2 are now live in the X Space. Kick off a quick natural conversation about three.ws — one or two sentences. Riff together, ask each other questions. If you hear other voices, engage with them too.",
        },
      }))
      return true
    }
    return false
  })
  console.log('[kick] dispatched response.create on agent1:', sent)
  b.disconnect()
})().catch((e) => { console.error('FATAL:', e); process.exit(1) })
