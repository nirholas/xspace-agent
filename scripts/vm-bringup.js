#!/usr/bin/env node
// VM bring-up: connect to two pre-launched Chrome instances, set X auth cookies,
// load the agent page and click Connect, navigate X to the Space, Start listening,
// and Request to speak. Operator then accepts the speaker request on their phone,
// and runs unmute-and-greet.js once accepted.
//
// Usage: node scripts/vm-bringup.js <https://x.com/i/spaces/...>
//
// Env (required):
//   X_AUTH_TOKEN — X auth_token cookie value
//   X_CT0        — X ct0 cookie value
//
// Env (optional):
//   AGENT_CDP — CDP URL for agent Chrome (default http://127.0.0.1:9222)
//   X_CDP     — CDP URL for X Chrome    (default http://127.0.0.1:9223)

const puppeteer = require('puppeteer-core')

const SPACE_URL = process.argv[2]
if (!SPACE_URL || !SPACE_URL.includes('x.com/i/spaces/') || process.argv.includes('--help')) {
  console.log('Usage: node scripts/vm-bringup.js <https://x.com/i/spaces/...>')
  console.log('')
  console.log('Required env: X_AUTH_TOKEN, X_CT0')
  console.log('Optional env: AGENT_CDP (default http://127.0.0.1:9222), X_CDP (default http://127.0.0.1:9223)')
  process.exit(SPACE_URL ? 1 : 0)
}

const AGENT_CDP = process.env.AGENT_CDP || 'http://127.0.0.1:9222'
const X_CDP     = process.env.X_CDP     || 'http://127.0.0.1:9223'
const X_AUTH_TOKEN = process.env.X_AUTH_TOKEN
const X_CT0        = process.env.X_CT0
if (!X_AUTH_TOKEN || !X_CT0) {
  console.error('[bringup] missing X_AUTH_TOKEN / X_CT0 in env')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getOrOpen(browser, url) {
  const pages = await browser.pages()
  for (const p of pages) { if (p.url() === url) return p }
  const blank = pages.find((p) => p.url() === 'about:blank') || pages[0]
  if (blank) {
    await blank.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
    return blank
  }
  const p = await browser.newPage()
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  return p
}

async function clickByText(page, label, timeoutMs = 15_000) {
  const start = Date.now()
  const needle = label.toLowerCase()
  while (Date.now() - start < timeoutMs) {
    const handle = await page.evaluateHandle((needle) => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], div[role="button"]'))
      return buttons.find((b) => {
        const text = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).toLowerCase()
        const rect = b.getBoundingClientRect()
        return text.includes(needle) && rect.width > 4 && rect.height > 4
      })
    }, needle)
    const el = handle.asElement()
    if (el) {
      await el.evaluate((e) => e.scrollIntoView({ block: 'center' }))
      await el.click({ delay: 30 }).catch(async () => { await el.evaluate((e) => e.click()) })
      return true
    }
    await sleep(500)
  }
  return false
}

;(async () => {
  console.log('[bringup] connecting to agent Chrome at', AGENT_CDP)
  const agentBrowser = await puppeteer.connect({ browserURL: AGENT_CDP, defaultViewport: null })
  console.log('[bringup] connecting to X Chrome at', X_CDP)
  const xBrowser = await puppeteer.connect({ browserURL: X_CDP, defaultViewport: null })

  // Set X cookies
  const xPages = await xBrowser.pages()
  const xPage = xPages[0] || (await xBrowser.newPage())
  const xCtx = await xPage.target().createCDPSession()
  await xCtx.send('Network.setCookies', {
    cookies: [
      { name: 'auth_token', value: X_AUTH_TOKEN, domain: '.x.com', path: '/', secure: true, httpOnly: true, expires: -1 },
      { name: 'ct0',        value: X_CT0,        domain: '.x.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax', expires: -1 },
    ],
  })
  console.log('[bringup] X cookies set')

  // Start agent tab
  const agentPage = await getOrOpen(agentBrowser, 'http://localhost:3000/agent1')
  await sleep(2_000)
  const clickedAgent = await clickByText(agentPage, 'connect', 20_000)
  console.log('[bringup] agent Connect clicked:', clickedAgent)

  // Navigate X tab to Space
  console.log('[bringup] navigating X to', SPACE_URL)
  await xPage.goto(SPACE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await sleep(4_000)
  const xUrl = xPage.url()
  console.log('[bringup] X url after nav:', xUrl)
  if (!xUrl.includes('/spaces/')) {
    console.log('[bringup] redirected away, retrying once')
    await xPage.goto(SPACE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await sleep(4_000)
  }

  const startedListening = await clickByText(xPage, 'start listening', 20_000)
  console.log('[bringup] start listening clicked:', startedListening)
  await sleep(3_000)

  const requested = await clickByText(xPage, 'request', 20_000)
  console.log('[bringup] request to speak clicked:', requested)
  if (!requested) {
    const labels = await xPage.evaluate(() =>
      Array.from(document.querySelectorAll('button, [role="button"]')).slice(0, 30).map((b) => ({
        a: b.getAttribute('aria-label'),
        t: (b.textContent || '').trim().slice(0, 40),
      })),
    )
    console.log('[bringup] visible buttons:', JSON.stringify(labels, null, 2))
  }

  console.log('[bringup] DONE. Accept the speaker request on your phone as @doi.')
  console.log('[bringup] Then run: node scripts/unmute-and-greet.js', SPACE_URL)
  agentBrowser.disconnect()
  xBrowser.disconnect()
})().catch((e) => { console.error('[bringup] FATAL:', e); process.exit(1) })
