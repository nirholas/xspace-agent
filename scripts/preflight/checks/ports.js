// @ts-check
import { execSync } from 'child_process';
import { check } from '../runner.js';

function portInfo(port) {
  try {
    const out = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    if (!out) return null;
    const pids = out.split('\n').filter(Boolean);
    const processes = pids.map(pid => {
      try {
        const cmd = execSync(`ps -p ${pid} -o comm= 2>/dev/null`, { encoding: 'utf8' }).trim();
        return { pid, cmd };
      } catch {
        return { pid, cmd: 'unknown' };
      }
    });
    return processes;
  } catch {
    return null;
  }
}

function isPortListening(port, host = '127.0.0.1') {
  try {
    execSync(`nc -z -w1 ${host} ${port} 2>/dev/null`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export async function run_checks() {
  const results = [];

  // Port 3000 — should be free (or held by swarm-server)
  const appPort = parseInt(process.env.PORT || '3000', 10);
  const holders = portInfo(appPort);
  if (!holders || holders.length === 0) {
    results.push(check({ id: 'port_3000', label: `port ${appPort} free`, status: 'ok' }));
  } else {
    const procs = holders.map(h => `${h.cmd}(${h.pid})`).join(', ');
    const isServer = holders.some(h => h.cmd.includes('node') || h.cmd.includes('server'));
    results.push(check({
      id: 'port_3000',
      label: `port ${appPort} occupied by ${procs}`,
      status: isServer ? 'warn' : 'fail',
      detail: isServer ? 'Looks like swarm-server is already running' : 'Another process is holding this port',
      fixHint: isServer ? 'Run: sudo systemctl stop swarm-server.service' : `Kill it: lsof -ti:${appPort} | xargs kill`,
      autoFix: isServer ? undefined : `kill_port_${appPort}`,
    }));
  }

  // Port 9223 — Chrome CDP (only relevant in connect mode)
  const browserMode = process.env.BROWSER_MODE || 'managed';
  const cdpPort = parseInt(process.env.CDP_PORT || '9223', 10);

  if (browserMode === 'connect') {
    const listening = isPortListening(cdpPort);
    results.push(check({
      id: 'port_cdp',
      label: `port ${cdpPort} (chrome CDP) ${listening ? 'listening' : 'not listening'}`,
      status: listening ? 'ok' : 'fail',
      detail: listening ? undefined : `BROWSER_MODE=connect but nothing on ${cdpPort}`,
      fixHint: listening ? undefined : 'Start Chrome with: google-chrome --remote-debugging-port=9223',
    }));
  } else {
    const listening = isPortListening(cdpPort);
    results.push(check({
      id: 'port_cdp',
      label: `port ${cdpPort} (chrome CDP) ${listening ? 'listening' : 'not needed (BROWSER_MODE=managed)'}`,
      status: 'ok',
      detail: `BROWSER_MODE=${browserMode}`,
    }));
  }

  return results;
}
