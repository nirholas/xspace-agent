#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

/**
 * Selector audit script — read-only DOM probe.
 *
 * Usage:
 *   AUDIT_SPACE_URL=https://x.com/i/spaces/<id> node x-spaces/scripts/audit-selectors.js
 *
 * Connects to a logged-in Chrome via CDP on port 9222 (set CDP_PORT to override),
 * opens the Space URL, probes each selector without clicking anything,
 * then prints a status table. Exits 1 if any selector is BROKEN.
 *
 * Never clicks destructive buttons (leave, mute). Audits by DOM presence only.
 */

'use strict';

const puppeteer = require('puppeteer-core');

// ---------------------------------------------------------------------------
// Selector inventory (mirrors packages/core/src/browser/selectors.ts)
// Actions marked destructive:true are audited for presence only — never clicked.
// ---------------------------------------------------------------------------

const SELECTORS = [
  // Login flow
  {
    action: 'username-input',
    primary: 'input[autocomplete="username"]',
    fallbacks: ['input[name="text"]', 'input[type="text"]'],
    phase: 'login',
  },
  {
    action: 'next-button',
    primary: '[data-testid="LoginForm_Forward_Button"]',
    fallbacks: ['button[aria-label="Next"]', '[role="button"][data-testid*="Forward"]', '[role="button"] span'],
    phase: 'login',
    textMatch: 'Next',
  },
  {
    action: 'password-input',
    primary: 'input[name="password"]',
    fallbacks: ['input[type="password"]'],
    phase: 'login',
  },
  {
    action: 'login-button',
    primary: '[data-testid="LoginForm_Login_Button"]',
    fallbacks: ['button[aria-label="Log in"]', '[role="button"][data-testid*="Login"]', 'button[type="submit"]'],
    phase: 'login',
    textMatch: 'Log in',
  },
  {
    action: 'verify-email-input',
    primary: 'input[data-testid="ocfEnterTextTextInput"]',
    fallbacks: ['input[placeholder*="email" i]', 'input[placeholder*="phone" i]', 'input[type="text"]:not([autocomplete="username"])'],
    phase: 'login',
  },
  {
    action: 'verify-next-button',
    primary: '[data-testid="ocfEnterTextNextButton"]',
    fallbacks: ['[role="button"][data-testid*="Next"]', 'button[aria-label="Next"]'],
    phase: 'login',
    textMatch: 'Next',
  },

  // Home feed
  {
    action: 'home-timeline',
    primary: '[data-testid="primaryColumn"]',
    fallbacks: ['main[role="main"]', 'nav[aria-label*="Home" i]'],
    phase: 'home',
  },

  // Space UI — probed after navigating to AUDIT_SPACE_URL
  {
    action: 'join-button',
    primary: 'button[aria-label="Start listening"]',
    fallbacks: [
      '[data-testid="SpaceJoinButton"]',
      'button[aria-label*="listen" i]',
      'button[aria-label*="join" i]',
      'button[aria-label*="tune in" i]',
    ],
    phase: 'space',
    textMatch: 'Start listening',
  },
  {
    action: 'request-speaker',
    primary: 'button[aria-label="Request to speak"]',
    fallbacks: [
      'button[aria-label*="Request"]',
      '[data-testid="SpaceRequestToSpeakButton"]',
      'button[aria-label*="request to speak"]',
      'button[aria-label*="Raise hand"]',
      'button[aria-label*="Ask to speak"]',
    ],
    phase: 'space',
    textMatch: 'Request to speak',
  },
  {
    action: 'unmute',
    primary: '[data-testid="SpaceMuteButton"]',
    fallbacks: [
      '[data-testid="SpaceUnmuteButton"]',
      'button[aria-label="Unmute"]',
      'button[aria-label*="Unmute"]',
      'button[aria-label*="unmute"]',
      'button[aria-label*="Turn on microphone"]',
    ],
    phase: 'space',
    textMatch: 'Unmute',
    destructive: false,
  },
  {
    action: 'mute',
    primary: '[data-testid="SpaceMuteButton"]',
    fallbacks: [
      'button[aria-label="Mute"]',
      'button[aria-label*="Mute"]',
      'button[aria-label*="Turn off microphone"]',
      'button[aria-label*="microphone is on"]',
    ],
    phase: 'space',
    textMatch: 'Mute',
    destructive: true, // audit presence only
  },
  {
    action: 'leave-button',
    primary: '[data-testid="SpaceLeaveButton"]',
    fallbacks: ['button[aria-label*="leave" i]', '[data-testid="SpaceDockExpanded"] button'],
    phase: 'space',
    textMatch: 'Leave',
    destructive: true, // audit presence only — never click
  },
  {
    action: 'space-dock',
    primary: '[data-testid="SpaceDockExpanded"]',
    fallbacks: ['[data-testid="SpaceDockCollapsed"]'],
    phase: 'space',
  },
  {
    action: 'mic-button',
    primary: '[data-testid="SpaceMuteButton"]',
    fallbacks: [
      '[data-testid="SpaceUnmuteButton"]',
      'button[aria-label*="microphone"]',
      'button[aria-label*="Microphone"]',
      'button[aria-label="Unmute"]',
      'button[aria-label="Mute"]',
    ],
    phase: 'space',
  },
  {
    action: 'speaker-list',
    primary: '[data-testid="SpaceSpeakerAvatar"]',
    fallbacks: [
      '[data-testid="SpaceSpeakerCard"]',
      '[aria-label*="speaker" i]',
      '[data-testid="SpaceDockExpanded"] img[src*="profile_images"]',
    ],
    phase: 'space',
  },
  {
    action: 'space-ended',
    primary: '[data-testid="spaceEnded"]',
    fallbacks: [
      '[data-testid="SpaceEndedBanner"]',
      '[aria-label*="ended" i]',
    ],
    phase: 'space',
    textMatch: 'has ended',
  },
  {
    action: 'space-live-indicator',
    primary: '[data-testid="SpaceLiveIndicator"]',
    fallbacks: [
      '[data-testid="SpaceLiveBadge"]',
      '[aria-label*="LIVE" i]',
    ],
    phase: 'space',
    textMatch: 'LIVE',
  },
];

// ---------------------------------------------------------------------------
// Probe helpers — all read-only DOM queries, never click
// ---------------------------------------------------------------------------

/**
 * Try a single CSS selector — returns true if any element is found.
 */
async function tryCSS(page, selector) {
  try {
    const el = await page.$(selector);
    if (el) { await el.dispose(); return true; }
    return false;
  } catch {
    return false;
  }
}

/**
 * Try text-content search across the DOM.
 */
async function tryText(page, text) {
  try {
    return await page.evaluate((t) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if ((walker.currentNode.textContent || '').toLowerCase().includes(t.toLowerCase())) {
          return true;
        }
      }
      return false;
    }, text);
  } catch {
    return false;
  }
}

/**
 * Probe a selector entry. Returns { found, strategy, strategySelector }.
 */
async function probe(page, entry) {
  // Primary CSS
  if (await tryCSS(page, entry.primary)) {
    return { found: true, strategy: 'css:primary', strategySelector: entry.primary };
  }

  // Fallback CSS strategies
  for (const sel of (entry.fallbacks || [])) {
    if (await tryCSS(page, sel)) {
      return { found: true, strategy: 'css:fallback', strategySelector: sel };
    }
  }

  // Text match
  if (entry.textMatch && await tryText(page, entry.textMatch)) {
    return { found: true, strategy: 'text', strategySelector: entry.textMatch };
  }

  return { found: false, strategy: null, strategySelector: null };
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

const COL = {
  action: 24,
  primary: 10,
  fallback: 28,
  status: 36,
};

function pad(str, len) {
  return String(str).slice(0, len).padEnd(len);
}

function header() {
  return [
    pad('action', COL.action),
    pad('primary', COL.primary),
    pad('winning strategy', COL.fallback),
    'status',
  ].join('  ');
}

function separator() {
  return '-'.repeat(COL.action + COL.primary + COL.fallback + 36 + 6);
}

function row(entry, result) {
  const primaryIcon = result.strategy === 'css:primary' ? '✓' : '✗';
  let statusLabel;
  if (!result.found) {
    statusLabel = '🔴 BROKEN → manual fix needed';
  } else if (result.strategy === 'css:primary') {
    statusLabel = '✅ OK';
  } else {
    statusLabel = `⚠️  DEGRADED → primary broken (${result.strategy}: ${result.strategySelector})`;
  }

  return [
    pad(entry.action, COL.action),
    pad(primaryIcon, COL.primary),
    pad(result.strategySelector || '—', COL.fallback),
    statusLabel,
  ].join('  ');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const spaceUrl = process.env.AUDIT_SPACE_URL;
  if (!spaceUrl) {
    console.error('Error: AUDIT_SPACE_URL env var is required.');
    console.error('  Example: AUDIT_SPACE_URL=https://x.com/i/spaces/<id> pnpm selectors:audit');
    process.exit(1);
  }

  const cdpPort = parseInt(process.env.CDP_PORT || '9222', 10);
  const wsEndpoint = `http://127.0.0.1:${cdpPort}/json/version`;

  console.log(`\nConnecting to Chrome CDP at port ${cdpPort}…`);

  let endpointUrl;
  try {
    const res = await fetch(wsEndpoint);
    const data = await res.json();
    endpointUrl = data.webSocketDebuggerUrl;
  } catch (err) {
    console.error(`\nFailed to connect to Chrome on port ${cdpPort}: ${err.message}`);
    console.error('Make sure Chrome is running with --remote-debugging-port=' + cdpPort);
    process.exit(2);
  }

  const browser = await puppeteer.connect({ browserWSEndpoint: endpointUrl });
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());

  console.log(`Navigating to Space: ${spaceUrl}`);
  await page.goto(spaceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Give the SPA a moment to hydrate
  await new Promise((r) => setTimeout(r, 4000));

  console.log('\n' + separator());
  console.log(header());
  console.log(separator());

  const results = [];

  // Separate Space-phase selectors from login-phase ones.
  // On a Space page we skip login selectors (they won't be present) and vice-versa.
  const currentUrl = page.url();
  const onSpacePage = currentUrl.includes('/spaces/') || currentUrl.includes('/i/spaces/');

  for (const entry of SELECTORS) {
    if (entry.phase === 'login' && onSpacePage) {
      // Skip login-phase selectors when auditing a live Space
      continue;
    }
    if (entry.phase === 'home' && onSpacePage) {
      continue;
    }

    const result = await probe(page, entry);
    results.push({ entry, result });
    console.log(row(entry, result));
  }

  console.log(separator());

  const broken = results.filter((r) => !r.result.found);
  const degraded = results.filter((r) => r.result.found && r.result.strategy !== 'css:primary');
  const healthy = results.filter((r) => r.result.found && r.result.strategy === 'css:primary');

  console.log(`\nSummary: ${healthy.length} OK  |  ${degraded.length} DEGRADED  |  ${broken.length} BROKEN`);
  console.log(`Audited: ${new Date().toISOString()}`);

  await browser.disconnect();

  if (broken.length > 0) {
    console.error('\nBROKEN selectors (manual fix required):');
    for (const { entry } of broken) {
      console.error(`  • ${entry.action}`);
    }
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(2);
});
