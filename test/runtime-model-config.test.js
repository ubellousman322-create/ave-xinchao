import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeModelConfig, runtimeModelFingerprint, runtimeModelSafeStatus } from '../src/runtime-model-config.js';

test('runtime model config accepts HTTPS and exposes only safe status', () => {
  const config = runtimeModelConfig({
    base_url: 'https://api.example.com/v1/', api_key: 'secret-key', model: 'chat-model',
    timeout_ms: 12000, max_input_chars: 12000, max_output_tokens: 650,
  }, { agentName: 'ave', notificationRecipient: '清华' });
  assert.equal(config.baseUrl, 'https://api.example.com/v1');
  assert.equal(config.apiKey, 'secret-key');
  const status = runtimeModelSafeStatus(config, 'bridge', '2026-07-30T00:00:00.000Z');
  assert.deepEqual(status, { configured: true, source: 'bridge', model: 'chat-model', syncedAt: '2026-07-30T00:00:00.000Z' });
  assert.doesNotMatch(JSON.stringify(status), /secret-key/);
  assert.equal(runtimeModelFingerprint(config).length, 16);
});

test('runtime model config rejects unsafe plaintext remote endpoints and can be disabled', () => {
  assert.throws(() => runtimeModelConfig({ base_url: 'http://example.com/v1', api_key: 'x', model: 'm' }), /HTTPS/);
  assert.equal(runtimeModelConfig({ enabled: false }), null);
  assert.deepEqual(runtimeModelSafeStatus(null), { configured: false, source: 'disabled', model: null, syncedAt: null });
});