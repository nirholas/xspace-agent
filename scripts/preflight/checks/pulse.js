// @ts-check
import { execSync } from 'child_process';
import { check } from '../runner.js';

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function hasPactl() {
  return !!run('which pactl 2>/dev/null');
}

export async function run_checks() {
  const results = [];

  if (!hasPactl()) {
    results.push(check({
      id: 'pulse_available',
      label: 'PulseAudio (pactl) not available — skipping pulse checks',
      status: 'skip',
      detail: 'Install pulseaudio-utils or use BROWSER_MODE=managed without audio injection',
    }));
    return results;
  }

  // List sinks
  const sinksOut = run('pactl list sinks short 2>/dev/null');
  if (!sinksOut) {
    results.push(check({
      id: 'pulse_sinks',
      label: 'pulse sinks: none (PulseAudio not running?)',
      status: 'fail',
      fixHint: 'Start PulseAudio: pulseaudio --start  OR run scripts/setup-pulse.sh',
      autoFix: 'pulse_setup',
    }));
    return results;
  }

  const sinkLines = sinksOut.split('\n').filter(Boolean);
  const sinkNames = sinkLines.map(l => l.split('\t')[1] || l.split(/\s+/)[1] || 'unknown');
  const hasVirtAgent = sinkNames.some(n => n.includes('virt_agent') || n.includes('virtual'));
  const sinkCount = sinkLines.length;

  results.push(check({
    id: 'pulse_sinks',
    label: `pulse sinks: ${sinkCount} (${sinkNames.join(', ')})`,
    status: sinkCount > 0 ? 'ok' : 'fail',
    detail: !hasVirtAgent && sinkCount > 0 ? 'No virtual sink found — audio injection may not work' : undefined,
    fixHint: !hasVirtAgent ? 'Run scripts/setup-pulse.sh to create virtual sinks' : undefined,
    autoFix: !hasVirtAgent ? 'pulse_setup' : undefined,
  }));

  // List sink-inputs (active streams)
  const inputsOut = run('pactl list sink-inputs short 2>/dev/null');
  const inputLines = inputsOut ? inputsOut.split('\n').filter(Boolean) : [];
  const inputCount = inputLines.length;

  // Check for muted sinks
  const sinksDetailOut = run('pactl list sinks 2>/dev/null');
  const mutedSinks = sinksDetailOut
    ? (sinksDetailOut.match(/Name: .+\n[\s\S]*?Mute: yes/g) || []).length
    : 0;

  results.push(check({
    id: 'pulse_inputs',
    label: `pulse sink-inputs: ${inputCount}${inputCount > 0 ? ` (${inputLines.map(l => l.split('\t')[0]).join(', ')})` : ''}`,
    status: 'ok',
    detail: inputCount === 0 ? 'No active sink-inputs — Chrome may not be connected yet' : undefined,
  }));

  if (mutedSinks > 0) {
    results.push(check({
      id: 'pulse_mute',
      label: `${mutedSinks} pulse sink(s) muted`,
      status: 'warn',
      fixHint: 'Unmute: pactl set-sink-mute @DEFAULT_SINK@ 0',
    }));
  }

  return results;
}
