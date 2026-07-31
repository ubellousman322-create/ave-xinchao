import test from 'node:test';
import assert from 'node:assert/strict';
import { OmbreClient } from '../src/ombre-client.js';

test('automatic dream writes identify themselves and never impersonate manual memory', async () => {
  const client = new OmbreClient({
    writeEnabled: true,
    readEnabled: false,
    url: 'http://unused.invalid/mcp',
    token: '',
    breathMaxResults: 3,
    breathMaxTokens: 800,
  });
  let captured;
  client.call = async (name, args) => {
    captured = { name, args };
    return { result: { content: [{ type: 'text', text: '已保存 abcdef123456' }] } };
  };

  await client.storeDream({
    dream: '一盏灯',
    residue: '安静',
    awareness: '记得回来',
  });

  assert.equal(captured.name, 'hold');
  assert.equal(captured.args.auto, true);
  assert.equal(captured.args.source, 'xinchao-dream');
  assert.equal(captured.args.importance, 7);
  assert.equal(captured.args.tags, 'dream');
});


test('stateless MCP servers initialize once without requiring a session header', async () => {
  const client = new OmbreClient({
    url: 'http://stateless.invalid/mcp',
    token: '',
    readEnabled: true,
    writeEnabled: false,
    breathMaxResults: 3,
    breathMaxTokens: 800,
  });
  const calls = [];
  client.post = async (payload) => {
    calls.push(payload.method);
    if (payload.method === 'initialize') return { result: { protocolVersion: '2025-06-18' } };
    if (payload.method === 'tools/call') return { result: { content: [{ type: 'text', text: '近期材料' }] } };
    return null;
  };
  assert.equal(await client.recentMaterial(), '近期材料');
  assert.equal(await client.daytimeMaterial(), '近期材料');
  assert.equal(calls.filter((method) => method === 'initialize').length, 1);
  assert.equal(client.sessionId, null);
  assert.equal(client.initialized, true);
});
