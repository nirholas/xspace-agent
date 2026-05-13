// Dual-account: drives BOTH X Chromes into the same Space.
const puppeteer = require('puppeteer-core')

const SPACE_URL = process.argv[2]
if (!SPACE_URL || !SPACE_URL.includes('x.com/i/spaces/')) {
  console.error('usage: node vm-automation-dual.js <https://x.com/i/spaces/...>')
  process.exit(1)
}

const COOKIES = {
  swarming: {
    auth_token: process.env.X_AUTH_TOKEN,
    ct0: process.env.X_CT0,
  },
  eplus: {
    auth_token: process.env.X_AUTH_TOKEN_EPLUS,
    ct0: process.env.X_CT0_EPLUS,
  },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function joinAsAccount(cdpUrl, label, creds) {
  if (!creds.auth_token || !creds.ct0) {
    console.error(`[${label}] missing cookies in env`); return
  }
  console.log(`[${label}] connecting to ${cdpUrl}`)
  const b = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null })
  const page = (await b.pages())[0] || (await b.newPage())
  const cdp = await page.target().createCDPSession()
  await cdp.send('Network.setCookies', {
    cookies: [
      { name: 'auth_token', value: creds.auth_token, domain: '.x.com', path: '/', secure: true, httpOnly: true, expires: -1 },
      { name: 'ct0', value: creds.ct0, domain: '.x.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax', expires: -1 },
    ],
  })
  console.log(`[${label}] navigating to Space`)
  await page.goto(SPACE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await sleep(4_000)
  console.log(`[${label}] url after nav: ${page.url()}`)

  const click = async (needle, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const r = await page.evaluate((n) => {
        const all = [...document.querySelectorAll('button, [role="button"]')]
        for (const b of all) {
          const t = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).toLowerCase()
          if (t.includes(n)) {
            const rect = b.getBoundingClientRect()
            if (rect.width > 4 && rect.height > 4) { b.scrollIntoView({ block: 'center' }); b.click(); return t.slice(0, 60) }
          }
        }
        return null
      }, needle)
      if (r) return r
      await sleep(700)
    }
    return null
  }

  const sl = await click('start listening')
  console.log(`[${label}] start listening: ${sl}`)
  await sleep(3_000)
  const rs = await click('request')
  console.log(`[${label}] request to speak: ${rs}`)

  b.disconnect()
}

;(async () => {
  await joinAsAccount('http://127.0.0.1:9223', 'swarming', COOKIES.swarming)
  await joinAsAccount('http://127.0.0.1:9225', 'eplus', COOKIES.eplus)
  console.log('[done] Both accounts requested speaker. Accept each on phone, then run unmute-dual.js.')
})().catch((e) => { console.error(e); process.exit(1) })
