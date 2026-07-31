import test from 'node:test';
import assert from 'node:assert/strict';
import { applyConversationEvent, newState, pickIntents, settleState } from '../src/engine.js';
import { addFlashThought, newThoughtPool, tickThoughtPool } from '../src/thought-pool.js';

test('repeated flash thoughts merge, survive decay and become an obsession', () => {
  const pool = newThoughtPool();
  addFlashThought(pool, 'share', '这一轮有值得延续的分享', 0.8);
  tickThoughtPool(pool, 1);
  addFlashThought(pool, 'share', '这一轮有值得延续的分享', 0.8);
  assert.equal(pool.flash.length, 1);
  assert.equal(pool.flash[0].occurrences, 2);
  tickThoughtPool(pool, 2);
  assert.equal(pool.flash.length, 0);
  assert.equal(pool.obsessions.length, 1);
  assert.equal(pool.obsessions[0].key, 'share');
  assert.equal(pool.obsessions[0].occurrences, 2);
});

test('thought-pool aging follows real 15-minute quanta instead of API call count', () => {
  const start = new Date('2026-07-30T04:00:00Z');
  const state = newState(start);
  addFlashThought(state.thoughtPool, 'curiosity', '还想继续探索', 0.8);
  const beforeTick = settleState(state, new Date('2026-07-30T04:14:59Z'), 1000).state;
  assert.equal(beforeTick.thoughtPool.flash[0].age, 0);
  const firstTick = settleState(beforeTick, new Date('2026-07-30T04:15:00Z'), 1000).state;
  assert.equal(firstTick.thoughtPool.flash[0].age, 1);
  const noExtraTick = settleState(firstTick, new Date('2026-07-30T04:15:01Z'), 1000).state;
  assert.equal(noExtraTick.thoughtPool.flash[0].age, 1);
});

test('saturated drives keep decaying toward the floor without rebounding every other tick', () => {
  const start = new Date('2026-07-30T04:00:00Z');
  const state = newState(start);
  state.drives.possess = 0.8;
  const first = settleState(state, new Date('2026-07-30T05:00:00Z'), 1000).state;
  const second = settleState(first, new Date('2026-07-30T06:00:00Z'), 1000).state;
  assert.ok(first.drives.possess < 0.8);
  assert.ok(second.drives.possess < first.drives.possess);
  assert.equal(second.saturatedDrives.possess, true);
  const relieved = applyConversationEvent(second, {
    eventId: 'saturation-relief',
    satisfiedDrives: ['possess'],
  }, new Date('2026-07-30T06:01:00Z')).state;
  assert.equal('possess' in relieved.saturatedDrives, false);
});

test('fatigue pressure uses the ten naturally growing drives and is not diluted by emotion baselines', () => {
  const start = new Date('2026-07-30T04:00:00Z');
  const state = newState(start);
  for (const key of ['possess', 'monitor', 'crave', 'share', 'libido', 'curiosity', 'boredom', 'social', 'duty', 'reflection']) {
    state.drives[key] = 0.8;
  }
  const settled = settleState(state, new Date('2026-07-30T05:00:00Z'), 1000).state;
  assert.equal(settled.fatigue, 0.005);
});

test('near-tied intents retain original weighted competition while staying reproducible by default', () => {
  const now = new Date('2026-07-30T05:00:00Z');
  const state = newState(now);
  state.drives.monitor = 0.8;
  state.drives.possess = 0.75;
  state.drives.crave = 0.75;
  const lowRoll = pickIntents(state, now, { limit: 1, random: () => 0 })[0];
  const highRoll = pickIntents(state, now, { limit: 1, random: () => 0.999999 })[0];
  assert.notEqual(lowRoll.key, highRoll.key);
  assert.deepEqual(pickIntents(state, now), pickIntents(state, now));
});
