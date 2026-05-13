#!/usr/bin/env node
// Reload the agent1 tab in the agent Chrome (CDP 9222) and click Connect.
// Use after fixing an API error or after the Realtime session drops.
//
// Usage: node scripts/reconnect-agent.js [--agent 0|1] [--cdp <url>]
//
// Env:  AGENT_CDP  — override CDP URL (default http://127.0.0.1:9222)

const puppeteer = require('puppeteer-core')

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/reconnect-agent.js [--agent 0|1] [--cdp <url>]')
  console.log('')
  console.log('Reloads the agent tab in the agent Chrome and clicks Connect.')
  console.log('Env: AGENT_CDP (default http://127.0.0.1:9222)')
  process.exit(0)
}

const agentIdx = (() => {
  const i = args.indexOf('--agent')
  return i !== -1 ? parseInt(args[i + 1], 10) : 0
})()
const cdpUrl = (() => {
  const i = args.indexOf('--cdp')
  return i !== -1 ? args[i + 1] : (process.env.AGENT_CDP || 'http://127.0.0.1:9222')
})()
const agentSlug = agentIdx === 0 ? 'agent1' : 'agent2'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function clickByText(page, label, timeoutMs = 15_000) {
  const start = Date.now()
  const needle = label.toLowerCase()
  while (Date.now() - start < timeoutMs) {
    const handle = await page.evaluateHandle((needle) => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      return buttons.find((b) => {
        const text = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).toLowerCase()
        const rect = b.getBoundingClientRect()
        return text.includes(needle) && rect.width > 4 && rect.height > 4
      })
    }, needle)
    const el = handle.asElement()
    if (el) {
      await el.click({ delay: 30 }).catch(async () => { await el.evaluate((e) => e.click()) })
      return true
    }
    await sleep(500)
  }
  return false
}

;(async () => {
  console.log(`[reconnect] connecting to ${cdpUrl}`)
  const browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null })
  const pages = await browser.pages()
  let agentPage = pages.find((p) => p.url().includes(`/${agentSlug}`)) || pages[0]
  console.log(`[reconnect] reloading ${agentPage.url()}`)
  await agentPage.goto(`http://localhost:3000/${agentSlug}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await sleep(2_000)
  const clicked = await clickByText(agentPage, 'connect', 15_000)
  console.log('[reconnect] connect clicked:', clicked)
  await sleep(2_000)
  const status = await agentPage.evaluate(() => document.body.innerText.slice(-1000))
  console.log('[reconnect] page tail:\n', status)
  browser.disconnect()
})().catch((e) => { console.error('[reconnect] FATAL:', e); process.exit(1) })
