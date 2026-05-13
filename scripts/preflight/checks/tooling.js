// @ts-check
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { check, ROOT } from '../runner.js';

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function parseVersion(str) {
  const m = str && str.match(/(\d+)\.(\d+)\.?(\d+)?/);
  return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3] || '0')] : null;
}

function versionGte(str, maj, min = 0) {
  const v = parseVersion(str);
  if (!v) return false;
  if (v[0] !== maj) return v[0] > maj;
  return v[1] >= min;
}

export async function run_checks() {
  const results = [];

  // node version
  const nodeVer = process.version;
  results.push(check({
    id: 'node',
    label: `node ${nodeVer} (>= 18)`,
    status: versionGte(nodeVer, 18) ? 'ok' : 'fail',
    detail: `Found ${nodeVer}`,
    fixHint: 'Install Node.js >= 18 from https://nodejs.org',
  }));

  // pnpm
  const pnpmOut = run('pnpm --version');
  if (pnpmOut) {
    const ok = versionGte(pnpmOut, 8);
    results.push(check({
      id: 'pnpm',
      label: `pnpm ${pnpmOut} (>= 8)`,
      status: ok ? 'ok' : 'warn',
      detail: `Found ${pnpmOut}`,
      fixHint: 'Run: npm install -g pnpm@latest',
    }));
  } else {
    results.push(check({
      id: 'pnpm',
      label: 'pnpm not found',
      status: 'fail',
      fixHint: 'Run: npm install -g pnpm',
    }));
  }

  // ffmpeg
  const ffmpegOut = run('ffmpeg -version 2>&1');
  if (ffmpegOut && ffmpegOut.includes('ffmpeg')) {
    const ver = ffmpegOut.match(/ffmpeg version (\S+)/)?.[1] || 'unknown';
    results.push(check({ id: 'ffmpeg', label: `ffmpeg ${ver} on PATH`, status: 'ok' }));
  } else {
    results.push(check({
      id: 'ffmpeg',
      label: 'ffmpeg not found',
      status: 'warn',
      fixHint: 'Install: sudo apt-get install ffmpeg  OR  brew install ffmpeg',
    }));
  }

  // pactl (PulseAudio) — optional on non-Linux
  const isLinux = process.platform === 'linux';
  const pactlOut = run('pactl --version 2>/dev/null');
  if (pactlOut) {
    const ver = pactlOut.split('\n')[0].replace('pactl ', '');
    results.push(check({ id: 'pactl', label: `pactl ${ver} on PATH`, status: 'ok' }));
  } else {
    results.push(check({
      id: 'pactl',
      label: 'pactl not found',
      status: isLinux ? 'warn' : 'skip',
      detail: isLinux ? 'PulseAudio not installed' : 'Non-Linux host — PulseAudio not required',
      fixHint: isLinux ? 'sudo apt-get install pulseaudio-utils' : undefined,
    }));
  }

  // puppeteer-core in node_modules
  const puppeteerPath = path.join(ROOT, 'node_modules', 'puppeteer-core', 'package.json');
  if (existsSync(puppeteerPath)) {
    try {
      const { version } = JSON.parse(
        (await import('fs')).readFileSync(puppeteerPath, 'utf8')
      );
      results.push(check({ id: 'puppeteer-core', label: `puppeteer-core ${version} in node_modules`, status: 'ok' }));
    } catch {
      results.push(check({ id: 'puppeteer-core', label: 'puppeteer-core found (version unknown)', status: 'ok' }));
    }
  } else {
    // check in packages/core too
    const corePath = path.join(ROOT, 'packages', 'core', 'node_modules', 'puppeteer-core', 'package.json');
    if (existsSync(corePath)) {
      try {
        const { version } = JSON.parse(
          (await import('fs')).readFileSync(corePath, 'utf8')
        );
        results.push(check({ id: 'puppeteer-core', label: `puppeteer-core ${version} in packages/core/node_modules`, status: 'ok' }));
      } catch {
        results.push(check({ id: 'puppeteer-core', label: 'puppeteer-core found in packages/core', status: 'ok' }));
      }
    } else {
      results.push(check({
        id: 'puppeteer-core',
        label: 'puppeteer-core missing from node_modules',
        status: 'fail',
        fixHint: 'Run: pnpm install',
        autoFix: 'install',
      }));
    }
  }

  return results;
}
