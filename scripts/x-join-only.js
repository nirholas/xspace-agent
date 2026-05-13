#!/usr/bin/env node
// X tab only: set auth cookies, navigate to Space, click Start listening,
// click Request to speak. Does NOT touch the agent Chrome.
// Use when the agent is already running and you just need the X side.
//
// Usage: node scripts/x-join-only.js <https://x.com/i/spaces/...>
//
// Env (required): X_AUTH_TOKEN, X_CT0
// Env (optional): X_CDP (default http://127.0.0.1:9223)

const puppeteer = require('puppeteer-core')

const SPACE_URL = process.argv[2]
if (!SPACE_URL || !SPACE_URL.includes('x.com/i/spaces/') || process.argv.includes('--help')) {
  console.log('Usage: node scripts/x-join-only.js <https://x.com/i/spaces/...>')
  console.log('')
  console.log('Required env: X_AUTH_TOKEN, X_CT0')
  console.log('Optional env: X_CDP (default http://127.0.0.1:9223)')
  process.exit(SPACE_URL ? 1 : 0)
}

const X_AUTH_TOKEN = process.env.X_AUTH_TOKEN
const X_CT0        = process.env.X_CT0
const X_CDP        = process.env.X_CDP || 'http://127.0.0.1:9223'
const sleep        = (ms) => new Promise((r) => setTimeout(r, ms))

async function click(page, needle, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  const n = needle.toLowerCase()
  while (Date.now() < deadline) {
    const r = await page.evaluate((n) => {
      const all = Array.from(document.querySelectorAll('button, [role="button"]'))
      for (const b of all) {
        const t = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).toLowerCase()
        if (t.includes(n)) {
          const r = b.getBoundingClientRect()
          if (r.width > 4 && r.height > 4) {
            b.scrollIntoView({ block: 'center' })
            b.click()
            return { ok: true, label: t.slice(0, 60) }
          }
        }
      }
      return { ok: false }
    }, n)
    if (r.ok) return r
    await sleep(800)
  }
  return { ok: false }
}

;(async () => {
  const xb = await puppeteer.connect({ browserURL: X_CDP, defaultViewport: null })
  const pages = await xb.pages()
  const xPage = pages[0] || (await xb.newPage())

  if (X_AUTH_TOKEN && X_CT0) {
    const cdp = await xPage.target().createCDPSession()
    await cdp.send('Network.setCookies', {
      cookies: [
        { name: 'auth_token', value: X_AUTH_TOKEN, domain: '.x.com', path: '/', secure: true, httpOnly: true, expires: -1 },
        { name: 'ct0',        value: X_CT0,        domain: '.x.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax', expires: -1 },
      ],
    })
  }

  console.log('[x] navigating to', SPACE_URL)
  await xPage.goto(SPACE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await sleep(4_000)
  console.log('[x] url after nav:', xPage.url())

  console.log('[x] clicking Start listening')
  console.log('[x] start listening:', await click(xPage, 'start listening', 20_000))
  await sleep(3_000)

  console.log('[x] clicking Request to speak')
  console.log('[x] request:', await click(xPage, 'request', 15_000))

  console.log('[x] done. Accept on your phone as @doi, then run: node scripts/unmute-and-greet.js', SPACE_URL)
  xb.disconnect()
})().catch((e) => { console.error('[x] FATAL:', e); process.exit(1) })
