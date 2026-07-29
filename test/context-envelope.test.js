import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextEnvelope,
  composeStateSummary,
  contextDeliveryState,
  estimateTokens,
  recordContextDelivery,
  trimToTokenBudget,
} from '../src/context-envelope.js';
import { applyConversationEvent, newState, recordDream } from '../src/engine.js';
import { recordHandoffNote } from '../src/handoff-notes.js';

test('token trimming never exceeds the requested budget', () => {
  const input = '一段很长的中文内容 '.repeat(200);
  for (const limit of [1, 10, 50, 200]) {
    assert.ok(estimateTokens(trimToTokenBudget(input, limit)) <= limit);
  }
});

test('session-start envelope carries recent continuity without pretending to be bedrock', () => {
  const now = new Date('2026-07-28T01:00:00Z');
  let state = applyConversationEvent(newState(now), {
    sessionId: 'window-a',
    sessionState: { tone: 'focused', attention: 0.9 },
  }, now).state;
  state = recordDream(state, {
    id: 'dream-1',
    createdAt: now.toISOString(),
    awareness: '醒来记得一盏灯。',
    residue: '安静。',
  });
  state = recordHandoffNote(state, {
    sessionId: 'window-before',
    eventId: 'handoff-1',
    note: '正在测试保守召回，下一步验证线上健康。',
    now,
  }).state;
  const envelope = buildContextEnvelope({
    state,
    sessionId: 'window-a',
    ombreText: '最近发生的事：昨天把误存的技术记忆软删除了。',
    maxTokens: 300,
    now,
  });

  assert.equal(envelope.delivered, true);
  assert.deepEqual(envelope.sections.map((section) => section.id), [
    'dynamic_state',
    'handoff_notes',
    'recent_continuity',
    'dream_residue',
  ]);
  assert.match(envelope.additionalContext, /窗口短态/);
  assert.match(envelope.additionalContext, /近期交接便签（非原文）/);
  assert.match(envelope.additionalContext, /近期连续性（不替代基岩）/);
  assert.match(envelope.additionalContext, /最近发生的事/);
  assert.ok(envelope.estimatedTokens <= 300);
});

test('state orchestration limits output and surfaces real recent changes', () => {
  const now = new Date('2026-07-29T15:00:00Z');
  let state = newState(now);
  state.drives.possess = 0.78;
  state.drives.curiosity = 0.72;
  state = applyConversationEvent(state, {
    eventId: 'summary-change-1',
    interactions: [
      { type: 'ignored', intensity: 1, confidence: 1 },
      { type: 'conflict', intensity: 1, confidence: 1 },
    ],
  }, now).state;
  const summary = composeStateSummary(state, now);
  assert.ok(summary.primary.length <= 2);
  assert.ok(summary.secondary.length <= 2);
  assert.notEqual(summary.primary[0].key, 'security');
  assert.ok(summary.significantChanges.some((item) => item.key === 'hurt' && item.delta > 0));
  assert.ok(summary.significantChanges.some((item) => item.key === 'security' && item.delta < 0));

  const envelope = buildContextEnvelope({ state, sessionId: 'window-a', mode: 'turn', now });
  assert.match(envelope.additionalContext, /当前意图：/);
  assert.match(envelope.additionalContext, /主导状态：/);
  assert.match(envelope.additionalContext, /近期变化：/);
  assert.doesNotMatch(envelope.additionalContext, /当前驱力：/);
});

test('state orchestration expires changes after six hours', () => {
  const at = new Date('2026-07-29T08:00:00Z');
  const state = applyConversationEvent(newState(at), {
    eventId: 'summary-old-1',
    interactionType: 'conflict',
  }, at).state;
  const summary = composeStateSummary(state, new Date('2026-07-29T15:00:01Z'));
  assert.deepEqual(summary.significantChanges, []);
});

test('session-start delivery is suppressed within the configured window', () => {
  const now = new Date('2026-07-28T01:00:00Z');
  let state = recordContextDelivery(newState(now), {
    sessionId: 'window-a',
    mode: 'session_start',
    digest: 'abc',
    deliveredAt: now,
  });
  const delivery = contextDeliveryState(
    state,
    'window-a',
    'session_start',
    new Date('2026-07-28T02:00:00Z'),
    12,
  );
  assert.equal(delivery.alreadyDelivered, true);

  const envelope = buildContextEnvelope({
    state,
    sessionId: 'window-a',
    alreadyDelivered: delivery.alreadyDelivered,
    now: new Date('2026-07-28T02:00:00Z'),
  });
  assert.equal(envelope.delivered, false);
  assert.equal(envelope.alreadyDelivered, true);
  assert.equal(envelope.additionalContext, '');
});

test('turn envelopes are not blocked by session-start delivery state', () => {
  const now = new Date('2026-07-28T01:00:00Z');
  const state = recordContextDelivery(newState(now), {
    sessionId: 'window-a',
    mode: 'session_start',
    digest: 'abc',
    deliveredAt: now,
  });
  const delivery = contextDeliveryState(state, 'window-a', 'turn', now, 12);
  assert.equal(delivery.alreadyDelivered, false);
});
