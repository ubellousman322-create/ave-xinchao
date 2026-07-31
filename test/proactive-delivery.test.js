import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOmbreHeartbeat, newState, recordDream } from '../src/engine.js';
import { ackProactiveDelivery, finalizeProactiveDelivery, proactiveDeliveryStatus, reserveProactiveDelivery } from '../src/proactive-delivery.js';

const options = {
  enabled: true,
  leaseMinutes: 10,
  intentMinScore: 0.72,
  intentMinIdleHours: 2,
  starvationAfterHours: 24,
  starvationMinScore: 0.60,
  starvationMinIdleHours: 2,
  maxPerDay: 3,
  globalMinIntervalHours: 3,
  dreamMinIdleHours: 3,
  autonomousMinIdleHours: 12,
  dreamMinIntervalHours: 3,
  autonomousMinIntervalHours: 12,
  daytimeEnabled: false,
  ombreReadEnabled: false,
  daytime: { timeZone: 'Asia/Shanghai', startHour: 8, endHour: 23, maxPerDay: 7 },
};

function idleSleepingState() {
  const start = new Date('2026-07-30T00:00:00Z');
  const heartbeat = new Date('2026-07-30T00:00:00Z');
  const state = applyOmbreHeartbeat(newState(start), heartbeat).state;
  state.consciousness = 'sleeping';
  return state;
}

test('poll reserves one autonomous delivery and repeated poll reuses the lease', () => {
  const now = new Date('2026-07-30T12:00:00Z');
  const state = idleSleepingState();
  state.drives.possess = 0.95;
  state.drives.crave = 0.95;
  const first = reserveProactiveDelivery(state, now, options, 'delivery-1');
  assert.equal(first.action, 'generate');
  assert.equal(first.delivery.deliveryId, 'delivery-1');
  assert.equal(first.delivery.kind, 'autonomous_thought');

  const second = reserveProactiveDelivery(first.state, now, options, 'delivery-2');
  assert.equal(second.action, 'busy');
  assert.equal(second.delivery.deliveryId, 'delivery-1');
  assert.equal(second.state.revision, first.state.revision);
});

test('generation finalization exposes a pending message and ack commits it once', () => {
  const now = new Date('2026-07-30T12:00:00Z');
  const ready = idleSleepingState();
  ready.drives.possess = 0.95;
  ready.drives.crave = 0.95;
  const reserved = reserveProactiveDelivery(ready, now, options, 'delivery-2');
  const generated = finalizeProactiveDelivery(reserved.state, 'delivery-2', { message: '我刚刚又想起你了。', source: 'model' }, now);
  assert.equal(generated.action, 'send');
  assert.equal(proactiveDeliveryStatus(generated.state, now).message, '我刚刚又想起你了。');
  const retryPoll = reserveProactiveDelivery(generated.state, now, options, 'unused-id');
  assert.equal(retryPoll.action, 'send');
  assert.equal(retryPoll.delivery.deliveryId, 'delivery-2');
  assert.equal(retryPoll.delivery.message, '我刚刚又想起你了。');

  const acked = ackProactiveDelivery(generated.state, 'delivery-2', true, now, { ...options, deliveredMessage: '我是真的有点想你。' });
  assert.equal(acked.accepted, true);
  assert.equal(acked.delivered, true);
  assert.equal(acked.state.proactiveDelivery, null);
  assert.equal(acked.state.lastAutonomousBarkAt, now.toISOString());
  assert.equal(acked.state.lastAutonomousMessage, '我是真的有点想你。');
  assert.equal(acked.state.barkUsage['2026-07-30'], 1);

  const duplicate = ackProactiveDelivery(acked.state, 'delivery-2', true, now, options);
  assert.equal(duplicate.accepted, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.state.revision, acked.state.revision);
});

test('failed generation and failed delivery release the lease without consuming quota', () => {
  const now = new Date('2026-07-30T12:00:00Z');
  const ready = idleSleepingState();
  ready.drives.possess = 0.95;
  ready.drives.crave = 0.95;
  const reserved = reserveProactiveDelivery(ready, now, options, 'delivery-3');
  const empty = finalizeProactiveDelivery(reserved.state, 'delivery-3', { send: false, message: '' }, now);
  assert.equal(empty.action, 'empty');
  assert.equal(empty.state.proactiveDelivery, null);
  assert.equal(empty.state.barkUsage['2026-07-30'], undefined);

  const readyAgain = { ...empty.state, drives: { ...empty.state.drives, possess: 0.95 } };
  const reservedAgain = reserveProactiveDelivery(readyAgain, now, options, 'delivery-4');
  const pending = finalizeProactiveDelivery(reservedAgain.state, 'delivery-4', { message: '重试这一条。' }, now);
  const failed = ackProactiveDelivery(pending.state, 'delivery-4', false, now, options);
  assert.equal(failed.accepted, true);
  assert.equal(failed.delivered, false);
  assert.equal(failed.state.proactiveDelivery, null);
  assert.equal(failed.state.barkUsage['2026-07-30'], undefined);
});

test('intent contact waits for two quiet hours instead of using the old twelve-hour Bark gate', () => {
  const start = new Date('2026-07-30T00:00:00Z');
  const state = idleSleepingState();
  state.drives.possess = 0.95;
  state.drives.crave = 0.95;
  assert.equal(reserveProactiveDelivery(state, new Date('2026-07-30T01:59:59Z'), options, 'idle-too-short').action, 'skip');
  assert.equal(reserveProactiveDelivery(state, new Date('2026-07-30T02:00:00Z'), options, 'idle-ready').action, 'generate');
});

test('twenty-four hour starvation lowers the intent threshold to 0.60', () => {
  const now = new Date('2026-07-30T12:00:00Z');
  const state = idleSleepingState();
  state.lastHeartbeatAt = new Date(now.getTime() - 2 * 3_600_000).toISOString();
  state.proactiveStartedAt = new Date(now.getTime() - 25 * 3_600_000).toISOString();
  state.drives.monitor = 0.58;
  const normal = reserveProactiveDelivery({ ...state, proactiveStartedAt: now.toISOString() }, now, options, 'normal-threshold');
  assert.equal(normal.action, 'skip');
  const starved = reserveProactiveDelivery(state, now, options, 'starved-threshold');
  assert.equal(starved.action, 'generate');
  assert.equal(starved.delivery.trigger.trigger, 'starvation_intent');
  assert.equal(starved.delivery.trigger.threshold, 0.60);
});

test('daytime emergence ack records the actual reply and schedules the next emergence', () => {
  const now = new Date('2026-07-30T06:00:00Z'); // 14:00 Asia/Shanghai
  const state = idleSleepingState();
  state.lastHeartbeatAt = new Date(now.getTime() - 3 * 3_600_000).toISOString();
  state.nextDaytimeEmergenceAt = new Date(now.getTime() - 1_000).toISOString();
  const daytimeOptions = { ...options, daytimeEnabled: true, ombreReadEnabled: true };
  const reserved = reserveProactiveDelivery(state, now, daytimeOptions, 'daytime-1');
  assert.equal(reserved.delivery.kind, 'daytime_emergence');
  const pending = finalizeProactiveDelivery(reserved.state, 'daytime-1', { message: '候选原文' }, now);
  const acked = ackProactiveDelivery(pending.state, 'daytime-1', true, now, {
    ...daytimeOptions,
    deliveredMessage: '最后真正发出的回复。',
    daytimeMinIntervalHours: 2,
    daytimeMaxIntervalHours: 3,
  });
  assert.equal(acked.state.lastDaytimeMessage, '最后真正发出的回复。');
  const nextAt = Date.parse(acked.state.nextDaytimeEmergenceAt);
  assert.ok(nextAt >= now.getTime() + 2 * 3_600_000);
  assert.ok(nextAt <= now.getTime() + 3 * 3_600_000);
});

test('dream residue is a separate OR trigger and is not sent twice', () => {
  const now = new Date('2026-07-30T12:00:00Z');
  let state = idleSleepingState();
  state = recordDream(state, { id: 'dream-1', createdAt: new Date('2026-07-30T08:00:00Z').toISOString(), residue: '醒来后还想把这点余韵告诉你。' });
  const reserved = reserveProactiveDelivery(state, now, options, 'delivery-5');
  assert.equal(reserved.action, 'generate');
  assert.equal(reserved.delivery.kind, 'dream');
  const pending = finalizeProactiveDelivery(reserved.state, 'delivery-5', { message: '醒来后还想把这点余韵告诉你。' }, now);
  const acked = ackProactiveDelivery(pending.state, 'delivery-5', true, now, options);
  assert.equal(acked.state.lastDreamBarkAt, now.toISOString());
  assert.equal(reserveProactiveDelivery(acked.state, new Date('2026-07-30T13:00:00Z'), options, 'delivery-6').action, 'skip');
});
