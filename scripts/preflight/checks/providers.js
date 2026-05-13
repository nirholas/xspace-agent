// @ts-check
import { check } from '../runner.js';

const TIMEOUT_MS = 3000;

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(tid);
  }
}

async function checkOpenAI(key) {
  try {
    const res = await fetchWithTimeout('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 200) {
      const data = await res.json();
      const models = data.data?.map(m => m.id) || [];
      const realtime = models.find(id => id.includes('realtime'));
      const detail = realtime ? `model: ${realtime} reachable` : `${models.length} models visible`;
      return check({ id: 'openai_key', label: `OPENAI_API_KEY: valid (${detail})`, status: 'ok' });
    }
    if (res.status === 401) {
      return check({ id: 'openai_key', label: 'OPENAI_API_KEY: invalid (401)', status: 'fail', fixHint: 'Check your key at platform.openai.com' });
    }
    if (res.status === 429) {
      return check({ id: 'openai_key', label: 'OPENAI_API_KEY: rate-limited (429)', status: 'warn', detail: 'Key is set but quota may be exhausted' });
    }
    return check({ id: 'openai_key', label: `OPENAI_API_KEY: HTTP ${res.status}`, status: 'warn' });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'timeout' : e.message;
    return check({ id: 'openai_key', label: `OPENAI_API_KEY: unreachable (${msg})`, status: 'warn', detail: 'Network issue or firewall' });
  }
}

async function checkAnthropic(key) {
  try {
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
    });
    if (res.status === 200) {
      return check({ id: 'anthropic_key', label: 'ANTHROPIC_API_KEY: valid', status: 'ok' });
    }
    if (res.status === 401 || res.status === 403) {
      return check({ id: 'anthropic_key', label: `ANTHROPIC_API_KEY: invalid (${res.status})`, status: 'fail', fixHint: 'Check your key at console.anthropic.com' });
    }
    return check({ id: 'anthropic_key', label: `ANTHROPIC_API_KEY: HTTP ${res.status}`, status: 'warn' });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'timeout' : e.message;
    return check({ id: 'anthropic_key', label: `ANTHROPIC_API_KEY: unreachable (${msg})`, status: 'warn' });
  }
}

async function checkGroq(key) {
  try {
    const res = await fetchWithTimeout('https://api.groq.com/openai/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 200) {
      return check({ id: 'groq_key', label: 'GROQ_API_KEY: valid', status: 'ok' });
    }
    if (res.status === 401) {
      return check({ id: 'groq_key', label: 'GROQ_API_KEY: invalid (401)', status: 'fail', fixHint: 'Check your key at console.groq.com' });
    }
    return check({ id: 'groq_key', label: `GROQ_API_KEY: HTTP ${res.status}`, status: 'warn' });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'timeout' : e.message;
    return check({ id: 'groq_key', label: `GROQ_API_KEY: unreachable (${msg})`, status: 'warn' });
  }
}

async function checkElevenLabs(key) {
  try {
    const res = await fetchWithTimeout('https://api.elevenlabs.io/v1/voices', {
      method: 'GET',
      headers: { 'xi-api-key': key },
    });
    if (res.status === 200) {
      const data = await res.json();
      const count = data.voices?.length ?? 0;
      return check({ id: 'elevenlabs_key', label: `ELEVENLABS_API_KEY: valid (${count} voices visible)`, status: 'ok' });
    }
    if (res.status === 401) {
      return check({ id: 'elevenlabs_key', label: 'ELEVENLABS_API_KEY: invalid (401)', status: 'fail', fixHint: 'Check your key at elevenlabs.io' });
    }
    return check({ id: 'elevenlabs_key', label: `ELEVENLABS_API_KEY: HTTP ${res.status}`, status: 'warn' });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'timeout' : e.message;
    return check({ id: 'elevenlabs_key', label: `ELEVENLABS_API_KEY: unreachable (${msg})`, status: 'warn' });
  }
}

export async function run_checks() {
  const results = [];

  // Run sequentially to avoid rate-limit bursts
  if (process.env.OPENAI_API_KEY) {
    results.push(await checkOpenAI(process.env.OPENAI_API_KEY));
  }
  if (process.env.ANTHROPIC_API_KEY) {
    results.push(await checkAnthropic(process.env.ANTHROPIC_API_KEY));
  }
  if (process.env.GROQ_API_KEY) {
    results.push(await checkGroq(process.env.GROQ_API_KEY));
  }
  if (process.env.ELEVENLABS_API_KEY) {
    results.push(await checkElevenLabs(process.env.ELEVENLABS_API_KEY));
  }

  if (results.length === 0) {
    results.push(check({
      id: 'providers',
      label: 'No provider API keys set — at least one required',
      status: 'fail',
      fixHint: 'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GROQ_API_KEY in .env',
    }));
  }

  return results;
}
