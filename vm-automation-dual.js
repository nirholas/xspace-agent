#!/usr/bin/env node
// vm-automation-dual.js — Join an X Space with both @swarminged and @eplus.
// Connects via CDP to two existing Chrome instances (ports 9223 + 9225),
// injects cookies, navigates to the Space, and clicks into speaker mode.
//
// Usage: node vm-automation-dual.js <space-url>
//
// Required env (from .env):
//   X_AUTH_TOKEN, X_CT0             — @swarminged cookies
//   X_AUTH_TOKEN_EPLUS, X_CT0_EPLUS — @eplus cookies

require("dotenv").config()
const puppeteer = require("puppeteer-core")

const SPACE_URL = process.argv[2]
if (!SPACE_URL) {
  console.error("usage: node vm-automation-dual.js <space-url>")
  process.exit(1)
}

const log = (account, msg) => console.log(`[${account}] ${msg}`)

const ACCOUNTS = [
  {
    name: "swarminged",
    cdpPort: 9223,
    authToken: process.env.X_AUTH_TOKEN,
    ct0: process.env.X_CT0,
  },
  {
    name: "eplus",
    cdpPort: 9225,
    authToken: process.env.X_AUTH_TOKEN_EPLUS,
    ct0: process.env.X_CT0_EPLUS,
  },
]

// Selectors for X Space UI — try multiple strategies
const SELECTORS = {
  listen: [
    '[data-testid="audioSpaceListen"]',
    'button[aria-label*="Listen"]',
    '[role="button"]:has-text("Start listening")',
    'button:has-text("Start listening")',
  ],
  requestSpeak: [
    '[data-testid="audioSpaceRequestSpeak"]',
    'button[aria-label*="Request"]',
    '[role="button"]:has-text("Request to speak")',
    'button:has-text("Request to speak")',
  ],
  unmute: [
    '[data-testid="audioSpaceUnmute"]',
    'button[aria-label*="Unmute"]',
    '[role="button"]:has-text("Unmute")',
    'button:has-text("Unmute")',
  ],
}

async function clickFirst(page, selectors, description, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel)
        if (el) {
          const box = await el.boundingBox()
          if (box) {
            await el.click()
            return true
          }
        }
      } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

async function joinSpace(account) {
  const { name, cdpPort, authToken, ct0 } = account

  if (!authToken || !ct0) {
    log(name, `SKIP — missing cookies (X_AUTH_TOKEN${name === "eplus" ? "_EPLUS" : ""})`)
    return
  }

  log(name, `Connecting to CDP :${cdpPort}...`)
  let browser
  try {
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${cdpPort}`,
      defaultViewport: null,
    })
  } catch (err) {
    log(name, `CDP connect failed: ${err.message}`)
    return
  }

  const pages = await browser.pages()
  const page = pages[0] || await browser.newPage()

  // Set cookies for x.com
  log(name, "Setting cookies...")
  await page.setCookie(
    { name: "auth_token", value: authToken, domain: ".x.com", path: "/", httpOnly: true, secure: true },
    { name: "ct0",        value: ct0,        domain: ".x.com", path: "/", httpOnly: false, secure: true }
  )

  // Navigate to the Space
  log(name, `Navigating to ${SPACE_URL}...`)
  try {
    await page.goto(SPACE_URL, { waitUntil: "domcontentloaded", timeout: 30000 })
  } catch (err) {
    log(name, `Navigation error (may be normal): ${err.message}`)
  }

  await new Promise(r => setTimeout(r, 3000))

  // Click "Start listening"
  log(name, 'Clicking "Start listening"...')
  const listened = await clickFirst(page, SELECTORS.listen, "Start listening", 20000)
  if (!listened) {
    log(name, 'WARN: "Start listening" not found — Space may already be joined or ended')
  } else {
    log(name, '"Start listening" clicked')
  }

  await new Promise(r => setTimeout(r, 3000))

  // Request to speak
  log(name, 'Clicking "Request to speak"...')
  const requested = await clickFirst(page, SELECTORS.requestSpeak, "Request to speak", 20000)
  if (!requested) {
    log(name, 'WARN: "Request to speak" not found — may need manual accept')
  } else {
    log(name, '"Request to speak" clicked — waiting for host to accept...')
  }

  log(name, "Done. Waiting for host to accept speaker request.")
  // Don't disconnect — keep the browser page alive
}

async function unmuteBoth() {
  // Called separately (or manually) after host accepts speaker requests
  for (const account of ACCOUNTS) {
    const { name, cdpPort, authToken, ct0 } = account
    if (!authToken || !ct0) continue

    try {
      const browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${cdpPort}`,
        defaultViewport: null,
      })
      const pages = await browser.pages()
      const page = pages[0]
      if (!page) continue

      log(name, 'Clicking "Unmute"...')
      const unmuted = await clickFirst(page, SELECTORS.unmute, "Unmute", 30000)
      log(name, unmuted ? "Unmuted!" : "Unmute button not found")
    } catch (err) {
      log(name, `Unmute error: ${err.message}`)
    }
  }
}

async function main() {
  log("dual", `Joining Space: ${SPACE_URL}`)

  // Join both accounts in parallel
  await Promise.all(ACCOUNTS.map(joinSpace))

  log("dual", "Both accounts submitted speaker requests.")
  log("dual", "When the host accepts both:")
  log("dual", "  node unmute-dual.js")
  log("dual", "  OR the unmute-loop will poll automatically.")
}

main().catch(err => {
  console.error("Fatal:", err.message)
  process.exit(1)
})
