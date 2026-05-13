#!/usr/bin/env node
// @ts-check

/**
 * xspace-agent preflight diagnostic tool.
 * Usage: pnpm preflight [--json] [--strict] [--fix] [--skip pulse,cdp] [--no-color]
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { execSync, spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Load .env before anything else ──────────────────────────────────────────
const envPath = path.join(ROOT, '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

// ── Parse flags ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const FLAG_JSON   = args.includes('--json');
const FLAG_STRICT = args.includes('--strict');
const FLAG_FIX    = args.includes('--fix');
const FLAG_NO_COLOR = args.includes('--no-color') || !!process.env.NO_COLOR;

const skipIdx = args.findIndex(a => a === '--skip');
const SKIP = skipIdx !== -1 && args[skipIdx + 1]
  ? args[skipIdx + 1].split(',').map(s => s.trim().toLowerCase())
  : [];

// Also accept --skip=pulse,cdp form
for (const a of args) {
  if (a.startsWith('--skip=')) {
    SKIP.push(...a.slice(7).split(',').map(s => s.trim().toLowerCase()));
  }
}

// ── Color helpers ────────────────────────────────────────────────────────────
const c = FLAG_NO_COLOR
  ? { green: s => s, red: s => s, yellow: s => s, gray: s => s, bold: s => s, dim: s => s }
  : {
      green:  s => `\x1b[32m${s}\x1b[0m`,
      red:    s => `\x1b[31m${s}\x1b[0m`,
      yellow: s => `\x1b[33m${s}\x1b[0m`,
      gray:   s => `\x1b[90m${s}\x1b[0m`,
      bold:   s => `\x1b[1m${s}\x1b[0m`,
      dim:    s => `\x1b[2m${s}\x1b[0m`,
    };

const ICON = {
  ok:   c.green('✓'),
  fail: c.red('✗'),
  warn: c.yellow('⚠'),
  skip: c.gray('·'),
};

// ── Prompt helper ─────────────────────────────────────────────────────────────
function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ── Auto-fix actions ──────────────────────────────────────────────────────────
async function applyFix(result) {
  if (!result.autoFix) return false;

  if (result.autoFix === 'install') {
    console.log(c.yellow(`  → Running pnpm install...`));
    const r = spawnSync('pnpm', ['install'], { cwd: ROOT, stdio: 'inherit' });
    return r.status === 0;
  }

  if (result.autoFix.startsWith('kill_port_')) {
    const port = result.autoFix.replace('kill_port_', '');
    const ans = await prompt(c.yellow(`  → Kill process on port ${port}? [y/N] `));
    if (ans !== 'y') { console.log(c.gray('  Skipped.')); return false; }
    try {
      execSync(`lsof -ti:${port} | xargs kill 2>/dev/null || true`, { shell: true });
      console.log(c.green(`  → Killed process on :${port}`));
      return true;
    } catch {
      console.log(c.red(`  → Failed to kill process on :${port}`));
      return false;
    }
  }

  if (result.autoFix === 'stop_service') {
    const ans = await prompt(c.yellow(`  → Run: sudo systemctl stop swarm-server.service? [y/N] `));
    if (ans !== 'y') { console.log(c.gray('  Skipped.')); return false; }
    const r = spawnSync('sudo', ['systemctl', 'stop', 'swarm-server.service'], { stdio: 'inherit' });
    return r.status === 0;
  }

  if (result.autoFix === 'pulse_setup') {
    const setupScript = path.join(ROOT, 'scripts', 'setup-pulse.sh');
    if (!existsSync(setupScript)) {
      console.log(c.yellow(`  → scripts/setup-pulse.sh not found — skipping`));
      return false;
    }
    const ans = await prompt(c.yellow(`  → Run scripts/setup-pulse.sh? [y/N] `));
    if (ans !== 'y') { console.log(c.gray('  Skipped.')); return false; }
    const r = spawnSync('bash', [setupScript], { stdio: 'inherit', cwd: ROOT });
    return r.status === 0;
  }

  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!FLAG_JSON) {
    console.log(c.bold('\nxspace-agent preflight\n'));
  }

  const { runAllChecks } = await import('./preflight/runner.js');
  const results = await runAllChecks({ skip: SKIP });

  if (FLAG_JSON) {
    console.log(JSON.stringify(results, null, 2));
    const fails = results.filter(r => r.status === 'fail');
    if (FLAG_STRICT && fails.length > 0) process.exit(1);
    const criticalOk = isCriticalOk(results);
    process.exit(FLAG_STRICT ? (fails.length > 0 ? 1 : 0) : (criticalOk ? 0 : 1));
  }

  // Render table
  for (const r of results) {
    if (r.status === 'skip') {
      console.log(`${ICON.skip} ${c.dim(r.label)}`);
      continue;
    }
    const icon = ICON[r.status] || ICON.warn;
    const label = r.status === 'fail' ? c.red(r.label)
                : r.status === 'warn' ? c.yellow(r.label)
                : r.label;
    console.log(`${icon} ${label}`);
    if (r.detail) {
      console.log(`  ${c.dim(r.detail)}`);
    }
    if (r.fixHint && (r.status === 'fail' || r.status === 'warn')) {
      console.log(`  ${c.gray('fix:')} ${r.fixHint}`);
    }
  }

  // Summary line
  const counts = { ok: 0, fail: 0, warn: 0, skip: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;

  const summary = [
    c.green(`${counts.ok} ok`),
    counts.fail > 0 ? c.red(`${counts.fail} fail`) : c.dim('0 fail'),
    counts.warn > 0 ? c.yellow(`${counts.warn} warn`) : c.dim('0 warn'),
    counts.skip > 0 ? c.gray(`${counts.skip} skip`) : null,
  ].filter(Boolean).join(c.dim(' · '));

  console.log(`\n${summary}\n`);

  // --fix mode
  if (FLAG_FIX) {
    const fixable = results.filter(r => r.autoFix && (r.status === 'fail' || r.status === 'warn'));
    if (fixable.length === 0) {
      console.log(c.gray('No auto-fixable issues found.'));
    } else {
      console.log(c.bold(`Auto-fix: ${fixable.length} issue(s) with available fixes\n`));
      for (const r of fixable) {
        console.log(`${ICON[r.status]} ${r.label}`);
        await applyFix(r);
      }
      console.log('');
    }
  } else if (results.some(r => r.autoFix && r.status === 'fail')) {
    console.log(c.dim('Run with --fix to attempt auto-fixes for known issues.\n'));
  }

  // Exit code
  const criticalOk = isCriticalOk(results);
  if (FLAG_STRICT) {
    process.exit(counts.fail > 0 ? 1 : 0);
  } else {
    process.exit(criticalOk ? 0 : 1);
  }
}

/** Critical checks: node, .env file, ADMIN_API_KEY, at least one provider key */
function isCriticalOk(results) {
  const map = Object.fromEntries(results.map(r => [r.id, r]));
  const nodeOk = map.node?.status === 'ok';
  const envOk = !map.env_file || map.env_file.status === 'ok';
  const adminOk = !map.admin_api_key || map.admin_api_key.status !== 'fail';
  const anyProvider = ['openai_key', 'anthropic_key', 'groq_key', 'elevenlabs_key'].some(
    id => map[id]?.status === 'ok'
  );
  // If no provider keys are set at all, that's handled by providers check
  const providerCheckFailed = map.providers?.status === 'fail';
  return nodeOk && envOk && adminOk && (anyProvider || !providerCheckFailed);
}

main().catch(e => {
  console.error(c.red(`Preflight error: ${e.message}`));
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
