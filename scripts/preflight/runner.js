// @ts-check
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

/** @typedef {{ id: string, label: string, status: 'ok'|'fail'|'warn'|'skip', detail?: string, fixHint?: string, autoFix?: string }} CheckResult */

/** @param {Omit<CheckResult, never>} r @returns {CheckResult} */
export function check(r) {
  return {
    id: r.id,
    label: r.label,
    status: r.status,
    detail: r.detail,
    fixHint: r.fixHint,
    autoFix: r.autoFix,
  };
}

const CHECK_GROUPS = [
  { name: 'tooling', module: './checks/tooling.js' },
  { name: 'env',     module: './checks/env.js'     },
  { name: 'providers', module: './checks/providers.js' },
  { name: 'xauth',   module: './checks/xauth.js'   },
  { name: 'ports',   module: './checks/ports.js'   },
  { name: 'pulse',   module: './checks/pulse.js'   },
  { name: 'cdp',     module: './checks/cdp.js'     },
  { name: 'files',   module: './checks/files.js'   },
];

/**
 * @param {{ skip?: string[] }} opts
 * @returns {Promise<CheckResult[]>}
 */
export async function runAllChecks({ skip = [] } = {}) {
  const results = [];
  for (const group of CHECK_GROUPS) {
    if (skip.includes(group.name)) {
      results.push(check({
        id: `${group.name}_skipped`,
        label: `[${group.name}] skipped via --skip`,
        status: 'skip',
      }));
      continue;
    }
    try {
      const mod = await import(new URL(group.module, import.meta.url).href);
      const groupResults = await mod.run_checks();
      results.push(...groupResults);
    } catch (e) {
      results.push(check({
        id: `${group.name}_error`,
        label: `[${group.name}] check group threw an error`,
        status: 'fail',
        detail: e.message,
      }));
    }
  }
  return results;
}
