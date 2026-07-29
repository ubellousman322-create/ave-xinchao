import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelClient } from '../src/model-client.js';

function classifierWith(content) {
  const client = new ModelClient({
    enabled: true,
    apiKey: 'test-only',
    baseUrl: 'http://127.0.0.1:1/v1',
    name: 'classifier-test',
    timeoutMs: 1000,
    maxInputChars: 12000,
    maxOutputTokens: 500,
  });
  client.request = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
  return client;
}

test('interaction classifier sanitizes model output and keeps no plaintext', async () => {
  const client = classifierWith(`\`\`\`json
  {"interactions":[
    {"type":"CONFLICT","intensity":1.4,"confidence":0.7},
    {"type":"conflict","intensity":0.4,"confidence":0.92},
    {"type":"ignored","intensity":0.6,"confidence":0.44},
    {"type":"invented","intensity":1,"confidence":1},
    {"type":"reassurance","intensity":0.5,"confidence":0.8},
    {"type":"sharing","intensity":0.7,"confidence":0.6},
    {"type":"reflection","intensity":0.5,"confidence":0.5},
    {"type":"affection","intensity":0.5,"confidence":0.46}
  ]}
  \`\`\``);
  const result = await client.classifyInteraction({
    userText: 'private user plaintext',
    assistantText: 'private assistant plaintext',
  });
  assert.deepEqual(result.interactions, [
    { type: 'conflict', intensity: 0.4, confidence: 0.92 },
    { type: 'reassurance', intensity: 0.5, confidence: 0.8 },
    { type: 'sharing', intensity: 0.7, confidence: 0.6 },
    { type: 'reflection', intensity: 0.5, confidence: 0.5 },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private .* plaintext/);
});

test('disabled interaction classifier fails closed without a model request', async () => {
  const client = new ModelClient({ enabled: false, apiKey: '', name: 'none' });
  const result = await client.classifyInteraction({ userText: 'u', assistantText: 'a' });
  assert.deepEqual(result, { interactions: [], source: 'disabled', model: null });
});
