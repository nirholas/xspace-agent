// @ts-check
import { check } from '../runner.js';

const TIMEOUT_MS = 3000;

async function fetchJson(url) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(tid);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    clearTimeout(tid);
    return { error: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

export async function run_checks() {
  const results = [];

  const cdpHost = process.env.CDP_HOST || '127.0.0.1';
  const cdpPort = process.env.CDP_PORT || '9223';
  const cdpUrl = `http://${cdpHost}:${cdpPort}`;

  const data = await fetchJson(`${cdpUrl}/json`);

  if (data.error) {
    const isTimeout = data.error === 'timeout';
    results.push(check({
      id: 'cdp_available',
      label: `Chrome CDP not reachable at ${cdpUrl} (${data.error})`,
      status: process.env.BROWSER_MODE === 'connect' ? 'fail' : 'warn',
      detail: process.env.BROWSER_MODE === 'connect'
        ? 'BROWSER_MODE=connect requires Chrome running with --remote-debugging-port'
        : 'Chrome CDP not running — OK for managed mode',
      fixHint: process.env.BROWSER_MODE === 'connect'
        ? `Start Chrome with: google-chrome --remote-debugging-port=${cdpPort} --headless=new`
        : undefined,
    }));
    return results;
  }

  const tabs = Array.isArray(data) ? data : [];
  results.push(check({
    id: 'cdp_available',
    label: `Chrome CDP reachable at ${cdpUrl} (${tabs.length} tabs)`,
    status: 'ok',
  }));

  // Check for X tab
  const xTab = tabs.find(t =>
    t.url && (t.url.includes('x.com') || t.url.includes('twitter.com'))
  );

  if (xTab) {
    results.push(check({
      id: 'cdp_x_tab',
      label: `Chrome tab attached to X: ${xTab.url.substring(0, 60)}`,
      status: 'ok',
    }));
  } else {
    results.push(check({
      id: 'cdp_x_tab',
      label: 'no Chrome tab attached to X tab',
      status: 'warn',
      detail: `Tabs open: ${tabs.map(t => t.url?.substring(0, 40) || 'blank').join(', ') || 'none'}`,
      fixHint: 'Open x.com in the Chrome instance: ./scripts/open-x-tab.sh',
    }));
  }

  return results;
}
