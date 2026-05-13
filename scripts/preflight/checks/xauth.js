// @ts-check
import { check } from '../runner.js';

const TIMEOUT_MS = 4000;

async function verifyXCookie(token, ct0) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const cookieStr = `auth_token=${token}; ct0=${ct0 || ''}`;
    const res = await fetch('https://api.x.com/1.1/account/verify_credentials.json', {
      method: 'GET',
      headers: {
        Cookie: cookieStr,
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        'X-Csrf-Token': ct0 || '',
      },
      signal: controller.signal,
    });
    clearTimeout(tid);
    return res.status;
  } catch (e) {
    clearTimeout(tid);
    return e.name === 'AbortError' ? 'timeout' : 'error';
  }
}

export async function run_checks() {
  const results = [];

  const authToken = process.env.X_AUTH_TOKEN;
  const ct0 = process.env.X_CT0;
  const username = process.env.X_USERNAME;
  const password = process.env.X_PASSWORD;

  if (authToken) {
    // Try a live check to confirm the cookie is valid
    const status = await verifyXCookie(authToken, ct0);

    if (status === 200) {
      const ct0Note = ct0 ? ' + ct0 set' : ' (no ct0 — some requests may fail)';
      results.push(check({
        id: 'x_auth_token',
        label: `X_AUTH_TOKEN: valid cookie${ct0Note}`,
        status: ct0 ? 'ok' : 'warn',
        detail: ct0 ? undefined : 'Set X_CT0 for full authenticated access',
        fixHint: ct0 ? undefined : 'Add X_CT0 from DevTools → Cookies → ct0',
      }));
    } else if (status === 401 || status === 403) {
      results.push(check({
        id: 'x_auth_token',
        label: 'X_AUTH_TOKEN: cookie expired or invalid',
        status: 'fail',
        detail: `API returned ${status}`,
        fixHint: 're-export from x.com → DevTools → Application → Cookies → auth_token',
      }));
    } else if (status === 'timeout') {
      results.push(check({
        id: 'x_auth_token',
        label: 'X_AUTH_TOKEN: set (live check timed out)',
        status: 'warn',
        detail: 'Could not reach X API within 4s — expiry unknown',
      }));
    } else {
      results.push(check({
        id: 'x_auth_token',
        label: `X_AUTH_TOKEN: set (live check returned ${status})`,
        status: 'warn',
        detail: 'Unexpected response — cookie may still work',
      }));
    }
  } else if (username && password) {
    results.push(check({
      id: 'x_auth_credentials',
      label: `X_USERNAME=${username} + X_PASSWORD set (credential auth mode)`,
      status: 'ok',
      detail: 'Cookie-based auth (X_AUTH_TOKEN) is more reliable',
    }));
  } else {
    results.push(check({
      id: 'x_auth',
      label: 'No X auth configured (X_AUTH_TOKEN or X_USERNAME+X_PASSWORD)',
      status: 'fail',
      fixHint: 'Open x.com → DevTools → Application → Cookies → copy auth_token and ct0 to .env',
    }));
  }

  return results;
}
