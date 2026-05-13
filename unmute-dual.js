// Click unmute in both X Chromes.
const puppeteer = require('puppeteer-core')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const NEEDLES = ['unmute', 'turn on microphone', 'start speaking', 'turn on mic']

async function unmute(cdpUrl, label) {
  const b = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null })
  const page = (await b.pages()).find((p) => p.url().includes('/spaces/')) || (await b.pages())[0]
  console.log(`[${label}] url: ${page.url()}`)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const r = await page.evaluate((needles) => {
      const all = [...document.querySelectorAll('button, [role="button"]')]
      for (const b of all) {
        const t = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).toLowerCase()
        for (const n of needles) {
          if (t.includes(n)) {
            const rect = b.getBoundingClientRect()
            if (rect.width > 4 && rect.height > 4) { b.scrollIntoView({ block: 'center' }); b.click(); return { ok: true, n, t: t.slice(0, 80) } }
          }
        }
      }
      return null
    }, NEEDLES)
    if (r) { console.log(`[${label}] clicked:`, r); b.disconnect(); return }
    await sleep(1500)
  }
  console.log(`[${label}] no unmute button found after 60s`)
  b.disconnect()
}

;(async () => {
  await unmute('http://127.0.0.1:9223', 'swarming')
  await unmute('http://127.0.0.1:9225', 'eplus')
})().catch((e) => { console.error(e); process.exit(1) })
