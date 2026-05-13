// @ts-check
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { check, ROOT } from '../runner.js';

function tryParseJSON(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    JSON.parse(raw);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function run_checks() {
  const results = [];

  // personalities.json
  const personalitiesPath = path.join(ROOT, 'personalities.json');
  const personalitiesDirPath = path.join(ROOT, 'personalities');
  if (existsSync(personalitiesPath)) {
    const { ok, error } = tryParseJSON(personalitiesPath);
    results.push(check({
      id: 'personalities_json',
      label: ok ? 'personalities.json valid JSON' : `personalities.json invalid JSON: ${error}`,
      status: ok ? 'ok' : 'fail',
      fixHint: ok ? undefined : 'Fix JSON syntax in personalities.json',
    }));
  } else if (existsSync(personalitiesDirPath)) {
    results.push(check({
      id: 'personalities_json',
      label: 'personalities/ directory present (no personalities.json)',
      status: 'ok',
    }));
  } else {
    results.push(check({
      id: 'personalities_json',
      label: 'personalities.json not found',
      status: 'warn',
      detail: 'Required if using multi-agent personalities',
    }));
  }

  // operators.json (task 01)
  const operatorsPath = path.join(ROOT, 'operators.json');
  if (existsSync(operatorsPath)) {
    const { ok, error } = tryParseJSON(operatorsPath);
    results.push(check({
      id: 'operators_json',
      label: ok ? 'operators.json valid JSON' : `operators.json invalid JSON: ${error}`,
      status: ok ? 'ok' : 'fail',
      fixHint: ok ? undefined : 'Fix JSON syntax in operators.json',
    }));
  }

  // .cookies.json for x-spaces module
  const cookiesPath = path.join(ROOT, '.cookies.json');
  const cookiesPaths = [
    cookiesPath,
    path.join(ROOT, 'x-spaces', '.cookies.json'),
    path.join(ROOT, 'cookies.json'),
  ];
  const foundCookies = cookiesPaths.find(p => existsSync(p));

  if (foundCookies) {
    const { ok, error } = tryParseJSON(foundCookies);
    if (ok) {
      let detail = '';
      try {
        const cookies = JSON.parse(readFileSync(foundCookies, 'utf8'));
        const count = Array.isArray(cookies) ? cookies.length : Object.keys(cookies).length;
        detail = `${count} cookie entries`;
      } catch {
        detail = 'valid JSON';
      }
      results.push(check({
        id: 'cookies_json',
        label: `.cookies.json found and valid (${detail})`,
        status: 'ok',
        detail: foundCookies !== cookiesPath ? `at ${path.relative(ROOT, foundCookies)}` : undefined,
      }));
    } else {
      results.push(check({
        id: 'cookies_json',
        label: `.cookies.json invalid JSON: ${error}`,
        status: 'fail',
        fixHint: 'Re-export cookies from browser or delete and re-authenticate',
      }));
    }
  } else {
    results.push(check({
      id: 'cookies_json',
      label: '.cookies.json not found (cookie auth not cached)',
      status: 'warn',
      detail: 'Agent will use X_AUTH_TOKEN from env instead',
    }));
  }

  // swarm-server.service status (informational)
  try {
    const { execSync } = await import('child_process');
    // Only check on hosts where systemctl actually works
    const pidCheck = execSync('pgrep -x systemd 2>/dev/null || true', { encoding: 'utf8' }).trim();
    if (pidCheck) {
      const out = execSync('systemctl is-active swarm-server.service 2>/dev/null || echo inactive', {
        encoding: 'utf8',
      }).trim();
      const isActive = out === 'active';
      results.push(check({
        id: 'swarm_service',
        label: `swarm-server.service: ${out}${!isActive ? ' (ok — preflight is pre-start)' : ''}`,
        status: isActive ? 'warn' : 'ok',
        detail: isActive ? 'Service is running — preflight usually runs before start' : undefined,
        fixHint: isActive ? 'Run: sudo systemctl stop swarm-server.service' : undefined,
        autoFix: isActive ? 'stop_service' : undefined,
      }));
    }
  } catch {
    // systemctl not available (non-systemd host or Codespace)
  }

  return results;
}
