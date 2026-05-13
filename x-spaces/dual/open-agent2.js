// Open agent2 in a new tab of the agent Chrome and click Connect.
const puppeteer = require('puppeteer-core')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function clickByText(page, label, timeoutMs = 15_000) {
  const start = Date.now()
  const needle = label.toLowerCase()
  while (Date.now() - start < timeoutMs) {
    const handle = await page.evaluateHandle((needle) => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      return buttons.find((b) => {
        const text = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).toLowerCase()
        const r = b.getBoundingClientRect()
        return text.includes(needle) && r.width > 4 && r.height > 4
      })
    }, needle)
    const el = handle.asElement()
    if (el) {
      await el.click({ delay: 30 }).catch(async () => {
        await el.evaluate((e) => e.click())
      })
      return true
    }
    await sleep(500)
  }
  return false
}

;(async () => {
  const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null })

  // Reload agent1 so it picks up server patch (forwarding logic) — keeps session active
  let agent1 = (await b.pages()).find((p) => p.url().includes('/agent1'))
  if (agent1) {
    console.log('[open-agent2] reloading agent1 to pick up server patch')
    await agent1.goto('http://localhost:3000/agent1', { waitUntil: 'domcontentloaded', timeout: 20_000 })
    await sleep(2_000)
    const c1 = await clickByText(agent1, 'connect', 15_000)
    console.log('[open-agent2] agent1 reconnect:', c1)
  }

  // Open agent2 in a new tab
  let agent2 = (await b.pages()).find((p) => p.url().includes('/agent2'))
  if (!agent2) {
    agent2 = await b.newPage()
  }
  console.log('[open-agent2] navigating to /agent2')
  await agent2.goto('http://localhost:3000/agent2', { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await sleep(2_000)
  const c2 = await clickByText(agent2, 'connect', 15_000)
  console.log('[open-agent2] agent2 connect clicked:', c2)
  await sleep(3_000)

  // Dump tail of both pages
  for (const p of [agent1, agent2]) {
    if (!p) continue
    console.log('---', p.url(), '---')
    console.log(await p.evaluate(() => document.body.innerText.slice(-600)))
  }
  b.disconnect()
})().catch((e) => { console.error('[open-agent2] FATAL:', e); process.exit(1) })
