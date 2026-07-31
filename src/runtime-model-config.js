import { createHash } from 'node:crypto';

const clamp = (value, minimum, maximum, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
};

function clean(value, maximum) {
  return String(value ?? '').replace(/[\r\n\0]/g, '').trim().slice(0, maximum);
}

function normalizedBaseUrl(value) {
  const raw = clean(value, 500).replace(/\/+$/, '');
  let url;
  try { url = new URL(raw); } catch { throw new Error('runtime model base_url must be a valid URL'); }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('runtime model base_url must use HTTPS or loopback HTTP');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('runtime model base_url cannot contain credentials, query or fragment');
  }
  return url.toString().replace(/\/$/, '');
}

export function runtimeModelConfig(input = {}, identity = {}) {
  if (input.enabled === false) return null;
  const baseUrl = normalizedBaseUrl(input.baseUrl ?? input.base_url);
  const apiKey = clean(input.apiKey ?? input.api_key, 2000);
  const name = clean(input.name ?? input.model, 200);
  if (!apiKey) throw new Error('runtime model api_key is required');
  if (!name) throw new Error('runtime model name is required');
  return {
    enabled: true,
    baseUrl,
    apiKey,
    name,
    timeoutMs: clamp(input.timeoutMs ?? input.timeout_ms, 1000, 120000, 30000),
    maxInputChars: clamp(input.maxInputChars ?? input.max_input_chars, 1000, 50000, 12000),
    maxOutputTokens: clamp(input.maxOutputTokens ?? input.max_output_tokens, 100, 4000, 650),
    dreamPushPromptPath: identity.dreamPushPromptPath,
    agentName: identity.agentName,
    notificationRecipient: identity.notificationRecipient,
  };
}

export function runtimeModelSafeStatus(config, source = 'disabled', syncedAt = null) {
  const configured = Boolean(config?.enabled && config?.apiKey && config?.baseUrl && config?.name);
  return {
    configured,
    source: configured ? source : 'disabled',
    model: configured ? String(config.name) : null,
    syncedAt: configured ? syncedAt : null,
  };
}

export function runtimeModelFingerprint(config) {
  if (!config) return '';
  return createHash('sha256')
    .update([config.baseUrl, config.name, config.apiKey].join('\u001f'), 'utf8')
    .digest('hex')
    .slice(0, 16);
}