// @ts-check
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { check, ROOT } from '../runner.js';

const VALID_AI_PROVIDERS = ['openai', 'openai-chat', 'claude', 'groq'];
const VALID_STT_PROVIDERS = ['groq', 'openai'];
const VALID_TTS_PROVIDERS = ['elevenlabs', 'openai', 'browser'];

export async function run_checks() {
  const results = [];

  // .env file discoverable
  const envPath = path.join(ROOT, '.env');
  const envExists = existsSync(envPath);
  results.push(check({
    id: 'env_file',
    label: envExists ? `.env loaded from ${envPath}` : '.env file not found',
    status: envExists ? 'ok' : 'fail',
    detail: envExists ? undefined : `Expected at ${envPath}`,
    fixHint: envExists ? undefined : `cp ${path.join(ROOT, '.env.example')} ${envPath}  and fill in your values`,
  }));

  // ADMIN_API_KEY
  const adminKey = process.env.ADMIN_API_KEY;
  if (adminKey) {
    results.push(check({
      id: 'admin_api_key',
      label: `ADMIN_API_KEY set (${adminKey.length} chars)`,
      status: adminKey.length >= 16 ? 'ok' : 'warn',
      detail: adminKey.length < 16 ? 'Key seems short — consider a longer random value' : undefined,
    }));
  } else {
    results.push(check({
      id: 'admin_api_key',
      label: 'ADMIN_API_KEY not set',
      status: 'fail',
      fixHint: 'Generate with: openssl rand -hex 32  and add to .env',
    }));
  }

  // HOST sanity
  const host = process.env.HOST;
  if (host) {
    const sane = host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0';
    results.push(check({
      id: 'host',
      label: `HOST=${host}`,
      status: sane ? 'ok' : 'warn',
      detail: sane ? undefined : 'Unusual HOST value — verify this is intentional',
    }));
  } else {
    results.push(check({ id: 'host', label: 'HOST not set (defaults to 0.0.0.0)', status: 'ok' }));
  }

  // PORT
  const port = process.env.PORT || '3000';
  results.push(check({
    id: 'port_env',
    label: `PORT=${port}`,
    status: 'ok',
  }));

  // AI_PROVIDER
  const aiProvider = process.env.AI_PROVIDER;
  if (aiProvider) {
    const valid = VALID_AI_PROVIDERS.includes(aiProvider);
    results.push(check({
      id: 'ai_provider',
      label: `AI_PROVIDER=${aiProvider}`,
      status: valid ? 'ok' : 'fail',
      detail: valid ? undefined : `Must be one of: ${VALID_AI_PROVIDERS.join(', ')}`,
      fixHint: valid ? undefined : `Set AI_PROVIDER to one of: ${VALID_AI_PROVIDERS.join(', ')}`,
    }));
  } else {
    results.push(check({ id: 'ai_provider', label: 'AI_PROVIDER not set (defaults to openai)', status: 'ok' }));
  }

  // STT_PROVIDER
  const sttProvider = process.env.STT_PROVIDER;
  if (sttProvider && !VALID_STT_PROVIDERS.includes(sttProvider)) {
    results.push(check({
      id: 'stt_provider',
      label: `STT_PROVIDER=${sttProvider} — invalid`,
      status: 'fail',
      fixHint: `Set STT_PROVIDER to one of: ${VALID_STT_PROVIDERS.join(', ')}`,
    }));
  }

  // TTS_PROVIDER
  const ttsProvider = process.env.TTS_PROVIDER;
  if (ttsProvider && !VALID_TTS_PROVIDERS.includes(ttsProvider)) {
    results.push(check({
      id: 'tts_provider',
      label: `TTS_PROVIDER=${ttsProvider} — invalid`,
      status: 'fail',
      fixHint: `Set TTS_PROVIDER to one of: ${VALID_TTS_PROVIDERS.join(', ')}`,
    }));
  }

  return results;
}
