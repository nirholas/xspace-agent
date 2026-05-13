#!/usr/bin/env node
// automation/unmute-dual.js — Poll for the Unmute button on both X Chrome instances.
// Run after the host accepts speaker requests.
//
// Usage: node automation/unmute-dual.js
require("dotenv").config({ path: require("path").join(__dirname, "../.env") })
const puppeteer = require("puppeteer-core")

const ACCOUNTS = [
  { name: "swarminged", port: 9223 },
  { name: "eplus",      port: 9225 },
]

const UNMUTE_SELECTORS = [
  '[data-testid="audioSpaceUnmute"]',
  'button[aria-label*="Unmute"]',
  '[role="button"][aria-label*="Unmute"]',
  'button:has-text("Unmute")',
]

async function tryUnmute(name, port) {
  try {
    const browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${port}`,
      defaultViewport: null,
    })
    const pages = await browser.pages()
    const page = pages[0]
    if (!page) { console.log(`[${name}] No page open`); return false }

    for (const sel of UNMUTE_SELECTORS) {
      try {
        const el = await page.$(sel)
        if (el) {
          const box = await el.boundingBox()
          if (box) {
            await el.click()
            console.log(`[${name}] Unmuted via ${sel}`)
            return true
          }
        }
      } catch (_) {}
    }
    return false
  } catch (err) {
    console.log(`[${name}] CDP error: ${err.message}`)
    return false
  }
}

async function main() {
  const unmuted = { swarminged: false, eplus: false }
  const MAX_TRIES = 60  // ~2 minutes

  for (let i = 0; i < MAX_TRIES; i++) {
    for (const { name, port } of ACCOUNTS) {
      if (unmuted[name]) continue
      const ok = await tryUnmute(name, port)
      if (ok) unmuted[name] = true
    }

    if (unmuted.swarminged && unmuted.eplus) {
      console.log("[dual] Both accounts unmuted!")
      break
    }

    const pending = ACCOUNTS.filter(a => !unmuted[a.name]).map(a => a.name).join(", ")
    console.log(`[dual] Waiting for unmute: ${pending} (attempt ${i+1}/${MAX_TRIES})`)
    await new Promise(r => setTimeout(r, 2000))
  }

  if (!unmuted.swarminged || !unmuted.eplus) {
    console.log("[dual] WARN: Not all accounts unmuted within timeout.")
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
