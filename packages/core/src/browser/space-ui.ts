// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

// =============================================================================
// DOM interactions for X Spaces
// Event-driven via DOMObserver + self-healing via SelectorEngine
// =============================================================================

import type { Page, ElementHandle, JSHandle } from 'puppeteer';
import { EventEmitter } from 'events';
import type { SelectorEngine } from './selector-engine';
import type { DOMObserver } from './observer';
import { SELECTORS } from './selectors';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { getLogger } from '../logger';
import { SpaceNotFoundError, SpaceEndedError, SpeakerAccessDeniedError } from '../errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpaceState {
  isLive: boolean;
  hasEnded: boolean;
  isSpeaker: boolean;
  speakerCount: number;
}

export interface SpaceUIOptions {
  selectorEngine?: SelectorEngine;
  observer?: DOMObserver;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Find a button whose visible text or aria-label matches one of the
 * provided `textOptions` (case-insensitive).
 */
async function findButton(
  page: Page,
  textOptions: string[],
): Promise<ElementHandle | null> {
  for (const text of textOptions) {
    const btn: JSHandle = await page.evaluateHandle((t: string) => {
      const buttons = [
        ...document.querySelectorAll(
          'button, [role="button"], div[role="button"]',
        ),
      ];
      return buttons.find((b) => {
        const content = b.textContent?.trim() || '';
        const label = b.getAttribute('aria-label') || '';
        return (
          content.toLowerCase().includes(t.toLowerCase()) ||
          label.toLowerCase().includes(t.toLowerCase())
        );
      });
    }, text);

    const el = btn.asElement();
    if (el) return el as ElementHandle;
  }
  return null;
}

/**
 * Find an element using the SelectorEngine if available, falling back to
 * legacy CSS selector + text matching.
 */
async function findElement(
  page: Page,
  selectorName: string,
  cssSelector: string,
  textOptions: string[] = [],
  engine?: SelectorEngine,
): Promise<ElementHandle | null> {
  // Prefer SelectorEngine (self-healing with fallback chain)
  if (engine) {
    try {
      const el = await engine.find(page, selectorName);
      if (el) return el;
    } catch {
      // Unknown selector name — fall through to legacy
    }
  }

  // Legacy: CSS selector
  try {
    const el: ElementHandle | null = await page.$(cssSelector);
    if (el) return el;
  } catch {
    // selector may be invalid in vanilla Puppeteer (e.g. :has-text)
  }

  // Fall back to text / aria-label search
  if (textOptions.length > 0) {
    return findButton(page, textOptions);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Navigate to a Space URL and click the Join / Listen button.
 */
export async function joinSpace(
  page: Page,
  spaceUrl: string,
  emitter: EventEmitter,
  opts: SpaceUIOptions = {},
): Promise<boolean> {
  const { selectorEngine, observer } = opts;
  getLogger().info('[X-Spaces] Navigating to Space:', spaceUrl);
  emitter.emit('status', 'joining-space');

  await page.goto(spaceUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Wait for the Space UI to render rather than using a fixed delay
  try {
    await page.waitForSelector(
      `${SELECTORS.SPACE_JOIN_BUTTON}, ${SELECTORS.SPACE_LIVE_INDICATOR}, ${SELECTORS.SPACE_MIC_BUTTON}`,
      { timeout: 15000 },
    );
  } catch {
    // Fall back to a short delay if no known selector appeared
    await delay(2000);
  }

  // Check if Space has ended
  const ended: boolean = await page.evaluate(() => {
    return (
      document.body.innerText.includes('This Space has ended') ||
      document.body.innerText.includes('Space ended')
    );
  });
  if (ended) {
    throw new SpaceNotFoundError(spaceUrl);
  }

  // Click Join/Listen button using SelectorEngine first, then legacy
  const joinBtn = await findElement(
    page,
    'join-button',
    SELECTORS.SPACE_JOIN_BUTTON,
    ['Start listening', 'Listen', 'Join', 'Join this Space', 'Tune in'],
    selectorEngine,
  );

  if (joinBtn) {
    // Remove disabled attribute and force-click -- X sets disabled on the
    // button even when the Space is live, so we bypass it via JS dispatch
    await page.evaluate((el: any) => {
      el.removeAttribute('disabled');
      el.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    }, joinBtn);
    getLogger().info('[X-Spaces] Clicked join button (forced)');
    await delay(3000);
  } else {
    // Last resort: find any disabled join-like button and force-click it
    const forced: JSHandle = await page.evaluateHandle(() => {
      const candidates = [
        ...document.querySelectorAll('button, [role="button"]'),
      ];
      return candidates.find((b) => {
        const label = (
          b.getAttribute('aria-label') ||
          b.textContent ||
          ''
        ).toLowerCase();
        return (
          label.includes('listen') ||
          label.includes('join') ||
          label.includes('tune in') ||
          label.includes('start listening')
        );
      });
    });

    const forcedEl = forced.asElement();
    if (forcedEl) {
      await page.evaluate((el: any) => {
        el.removeAttribute('disabled');
        el.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
      }, forcedEl);
      getLogger().info('[X-Spaces] Force-clicked fallback join button');
      await delay(3000);
    } else {
      getLogger().info('[X-Spaces] No join button found, may already be in Space');
    }
  }

  // Start watching for space-ended indicator if observer is available
  if (observer) {
    observer.watch('space-ended');
    observer.watch('space-live-indicator');
  }

  emitter.emit('status', 'in-space-as-listener');
  return true;
}

/**
 * Request speaker access in a Space.
 *
 * @returns `"granted"` if already a speaker, `"requested"` if the request was
 *          sent, or `false` if the button could not be found.
 */
export async function requestSpeaker(
  page: Page,
  emitter: EventEmitter,
  opts: SpaceUIOptions = {},
): Promise<'granted' | 'requested' | false> {
  const { selectorEngine } = opts;
  getLogger().info('[X-Spaces] Requesting to speak...');
  emitter.emit('status', 'requesting-speaker');

  // Check if already a speaker (mic button present)
  const micBtn = await findElement(
    page,
    'mic-button',
    SELECTORS.SPACE_MIC_BUTTON,
    [],
    selectorEngine,
  );
  if (micBtn) {
    getLogger().info('[X-Spaces] Already a speaker (mic button found)');
    emitter.emit('status', 'speaker');
    return 'granted';
  }

  const speakBtn = await findElement(
    page,
    'request-speaker',
    SELECTORS.SPACE_REQUEST_SPEAK,
    ['Request to speak', 'Request', 'request to speak'],
    selectorEngine,
  );
  if (speakBtn) {
    await speakBtn.click();
    getLogger().info('[X-Spaces] Speaker request sent');
    emitter.emit('status', 'speaker-requested');
    return 'requested';
  }

  getLogger().warn('[X-Spaces] Could not find request-to-speak button');
  return false;
}

/**
 * Unmute the microphone. Uses observer to wait for the unmute button
 * event-driven, with a fallback polling loop.
 */
export async function unmute(
  page: Page,
  emitter: EventEmitter,
  opts: SpaceUIOptions = {},
): Promise<boolean> {
  const { selectorEngine, observer } = opts;
  getLogger().info('[X-Spaces] Unmuting...');

  let unmuteBtn: ElementHandle | null = null;

  // Event-driven: watch for the unmute button via observer
  if (observer) {
    unmuteBtn = await new Promise<ElementHandle | null>((resolve) => {
      const timeout = setTimeout(() => {
        observer.unwatch('unmute');
        resolve(null);
      }, 30000);

      // Check if already present
      selectorEngine?.find(page, 'unmute').then((el) => {
        if (el) {
          clearTimeout(timeout);
          observer.unwatch('unmute');
          resolve(el);
        } else {
          // Watch for it to appear
          observer.watch('unmute');
          observer.once('element:appeared', (name) => {
            if (name === 'unmute') {
              clearTimeout(timeout);
              observer.unwatch('unmute');
              selectorEngine?.find(page, 'unmute').then(resolve).catch(() => resolve(null));
            }
          });
        }
      }).catch(() => {
        // SelectorEngine find failed; watch and wait
        observer.watch('unmute');
        observer.once('element:appeared', (name) => {
          if (name === 'unmute') {
            clearTimeout(timeout);
            observer.unwatch('unmute');
            selectorEngine?.find(page, 'unmute').then(resolve).catch(() => resolve(null));
          }
        });
      });
    });
  } else {
    // Fallback: polling loop (legacy behavior)
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const handle: JSHandle = await page.evaluateHandle(() => {
        const btns = [
          ...document.querySelectorAll('button[role="button"], [role="button"]'),
        ];
        return btns.find((b) => {
          const label = (b.getAttribute('aria-label') || '').toLowerCase();
          const text = (b.textContent || '').trim().toLowerCase();
          return (
            label === 'unmute' ||
            label.includes('turn on mic') ||
            text === 'unmute' ||
            label.includes('start speaking')
          );
        });
      });

      const el = handle.asElement();
      if (el) {
        unmuteBtn = el as ElementHandle;
        break;
      }
      await delay(1000);
    }
  }

  if (unmuteBtn) {
    await page.evaluate((el: any) => {
      el.removeAttribute('disabled');
      el.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    }, unmuteBtn);
    await delay(500);
    getLogger().info('[X-Spaces] Unmuted');
    emitter.emit('status', 'speaking');
    return true;
  }

  // Dump all button labels and screenshot for debugging
  const btns = await page.evaluate(() =>
    [...document.querySelectorAll('button, [role="button"]')]
      .map((b) => ({
        label: b.getAttribute('aria-label'),
        text: b.textContent?.trim().slice(0, 40),
        testid: b.getAttribute('data-testid'),
      }))
      .filter((b) => b.label || b.text),
  );
  getLogger().warn(
    '[X-Spaces] Could not find unmute button. Buttons on page:',
    JSON.stringify(btns.slice(0, 20)),
  );
  if (process.env.DEBUG) {
    const screenshotPath = path.join(os.tmpdir(), `x-unmute-debug-${crypto.randomUUID()}.png`);
    await page.screenshot({ path: screenshotPath });
    getLogger().debug('[X-Spaces] Debug screenshot saved to', screenshotPath);
  }
  return false;
}

/**
 * Leave the current Space.
 */
export async function leaveSpace(
  page: Page,
  emitter: EventEmitter,
  opts: SpaceUIOptions = {},
): Promise<void> {
  const { selectorEngine, observer } = opts;
  getLogger().info('[X-Spaces] Leaving Space...');

  // Clean up watched selectors
  if (observer) {
    observer.unwatch('space-ended');
    observer.unwatch('space-live-indicator');
    observer.unwatch('unmute');
  }

  const leaveBtn = await findElement(
    page,
    'leave-button',
    SELECTORS.SPACE_LEAVE_BUTTON,
    ['Leave', 'Leave quietly', 'leave'],
    selectorEngine,
  );
  if (leaveBtn) {
    await leaveBtn.click();
    await delay(1000);

    // Confirm leave if prompted
    const confirmBtn = await findButton(page, ['Leave', 'Yes']);
    if (confirmBtn) await confirmBtn.click();
    await delay(1000);
  }

  emitter.emit('status', 'left-space');
  getLogger().info('[X-Spaces] Left Space');
}

/**
 * Read the current state of the Space from the DOM.
 * If observer is provided, augments result with watched element state.
 */
export async function getSpaceState(
  page: Page,
  opts: SpaceUIOptions = {},
): Promise<SpaceState> {
  const { observer } = opts;

  // If the observer is tracking these, use its cached state for a fast path
  if (observer) {
    const hasEnded = observer.isFound('space-ended');
    if (hasEnded) {
      return { isLive: false, hasEnded: true, isSpeaker: false, speakerCount: 0 };
    }
  }

  return await page.evaluate(() => {
    const text = document.body.innerText;
    const state: {
      isLive: boolean;
      hasEnded: boolean;
      isSpeaker: boolean;
      speakerCount: number;
    } = {
      isLive:
        text.includes('LIVE') ||
        !!document.querySelector('[data-testid="SpaceLiveIndicator"]'),
      hasEnded:
        text.includes('This Space has ended') ||
        text.includes('Space ended'),
      isSpeaker: !!document.querySelector(
        'button[aria-label*="Mute"], button[aria-label*="unmute"], button[aria-label*="Unmute"]',
      ),
      speakerCount: document.querySelectorAll(
        '[data-testid="SpaceSpeakerAvatar"]',
      ).length,
    };
    return state;
  });
}

/**
 * Wait for the host to accept the speaker request. Event-driven via observer
 * when available, with fallback to page.waitForSelector.
 *
 * Once the Unmute button appears the function clicks it and returns `true`.
 */
export async function waitForSpeakerAccess(
  page: Page,
  emitter: EventEmitter,
  timeoutMs: number = 300000,
  opts: SpaceUIOptions = {},
): Promise<boolean> {
  const { selectorEngine, observer } = opts;
  getLogger().info('[X-Spaces] Waiting for host to accept speaker request...');

  // Event-driven: use observer to wait for unmute button appearance
  if (observer && selectorEngine) {
    const appeared = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        observer.unwatch('unmute');
        resolve(false);
      }, timeoutMs);

      // Check if already present
      selectorEngine.find(page, 'unmute').then((el) => {
        if (el) {
          clearTimeout(timeout);
          observer.unwatch('unmute');
          resolve(true);
        } else {
          observer.watch('unmute');
          observer.once('element:appeared', (name) => {
            if (name === 'unmute') {
              clearTimeout(timeout);
              observer.unwatch('unmute');
              resolve(true);
            }
          });

          // Also watch for space-ended while waiting
          observer.once('element:appeared', (name) => {
            if (name === 'space-ended') {
              clearTimeout(timeout);
              observer.unwatch('unmute');
              resolve(false);
            }
          });
        }
      }).catch(() => {
        observer.watch('unmute');
        observer.once('element:appeared', (name) => {
          if (name === 'unmute') {
            clearTimeout(timeout);
            observer.unwatch('unmute');
            resolve(true);
          }
        });
      });
    });

    if (!appeared) {
      // Check if space ended while we were waiting
      const ended: boolean = await page.evaluate(
        () =>
          document.body.innerText.includes('This Space has ended') ||
          document.body.innerText.includes('Space ended'),
      );
      if (ended) throw new SpaceEndedError();
      throw new SpeakerAccessDeniedError();
    }
  } else {
    // Fallback: waitForSelector (legacy)
    try {
      await page.waitForSelector('button[aria-label="Unmute"]', {
        timeout: timeoutMs,
      });
    } catch {
      const ended: boolean = await page.evaluate(
        () =>
          document.body.innerText.includes('This Space has ended') ||
          document.body.innerText.includes('Space ended'),
      );
      if (ended) throw new SpaceEndedError();
      throw new SpeakerAccessDeniedError();
    }
  }

  getLogger().info('[X-Spaces] Speaker access granted — unmuting...');
  emitter.emit('status', 'speaker');

  // Click the Unmute button
  const unmuteBtn = selectorEngine
    ? await selectorEngine.find(page, 'unmute')
    : await page.$('button[aria-label="Unmute"]');

  if (unmuteBtn) {
    await page.evaluate((el: any) => {
      el.removeAttribute('disabled');
      el.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    }, unmuteBtn);
    await delay(500);
    getLogger().info('[X-Spaces] Unmuted');
    emitter.emit('status', 'speaking');
  }

  return true;
}
