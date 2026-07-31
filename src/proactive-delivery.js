import { randomUUID } from 'node:crypto';
import { barkAllowed, contactIdleAllowed, daytimeEmergenceAllowed, pickIntents, recordBark, recordDaytimeEmergence, recentBarkHistory, scheduleDaytimeEmergence } from './engine.js';

const iso = (value) => new Date(value).toISOString();

function dayKey(now) {
  return iso(now).slice(0, 10);
}

function parseTime(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

function activeDelivery(state, now) {
  const delivery = state.proactiveDelivery;
  if (!delivery || !delivery.deliveryId) return null;
  const expiresAt = parseTime(delivery.expiresAt);
  if (expiresAt !== null && expiresAt <= now.getTime()) return null;
  return delivery;
}

function dailyProactiveCount(state, now) {
  const day = dayKey(now);
  return Number(state.barkUsage?.[day] ?? 0) + Number(state.daytimeEmergenceUsage?.[day] ?? 0);
}

function lastDeliveryAt(state) {
  return recentBarkHistory(state).at(-1)?.at ?? null;
}

function starvationActive(state, now, options) {
  const anchor = parseTime(lastDeliveryAt(state) ?? state.proactiveStartedAt);
  if (anchor === null) return false;
  const afterHours = Number(options.starvationAfterHours ?? 24);
  return now.getTime() - anchor >= afterHours * 3_600_000;
}

function globalGate(state, now, options, idleHours) {
  if (!contactIdleAllowed(state, now, idleHours)) return 'contact_active';
  if (dailyProactiveCount(state, now) >= options.maxPerDay) return 'daily_quota';
  const lastAt = parseTime(lastDeliveryAt(state));
  if (lastAt !== null && now.getTime() - lastAt < options.globalMinIntervalHours * 3_600_000) {
    return 'global_cooldown';
  }
  return null;
}

function unexpressedDream(state) {
  const dream = state.recentDreams?.at(-1);
  if (!dream?.id || !dream.residue) return null;
  const dreamAt = parseTime(dream.createdAt);
  const pushedAt = parseTime(state.lastDreamBarkAt);
  if (dreamAt === null || (pushedAt !== null && pushedAt >= dreamAt)) return null;
  return dream;
}

function triggerCandidates(state, now, options) {
  const candidates = [];
  const dream = unexpressedDream(state);
  if (dream && !globalGate(state, now, options, options.dreamMinIdleHours)
      && barkAllowed(state, now, options.dreamMinIntervalHours, options.maxPerDay, 'dream')) {
    candidates.push({
      kind: 'dream',
      trigger: 'dream_residue',
      dreamId: dream.id,
      dreamCreatedAt: dream.createdAt,
    });
  }

  const intent = pickIntents(state, now)[0] ?? null;
  const starvation = starvationActive(state, now, options);
  const intentThreshold = Number(starvation ? (options.starvationMinScore ?? 0.60) : (options.intentMinScore ?? 0.72));
  const intentIdleHours = Number(starvation ? (options.starvationMinIdleHours ?? 2) : (options.intentMinIdleHours ?? 2));
  if (intent && intent.score >= intentThreshold
      && !globalGate(state, now, options, intentIdleHours)
      && barkAllowed(state, now, options.autonomousMinIntervalHours, options.maxPerDay, 'autonomous_thought')) {
    candidates.push({
      kind: 'autonomous_thought',
      trigger: starvation ? 'starvation_intent' : 'intent_threshold',
      threshold: intentThreshold,
      intent: { key: intent.key, score: intent.score, label: intent.label },
    });
  }

  if (options.daytimeEnabled && options.ombreReadEnabled
      && daytimeEmergenceAllowed(state, now, options.daytime)
      && !globalGate(state, now, options, options.dreamMinIdleHours)) {
    candidates.push({
      kind: 'daytime_emergence',
      trigger: 'daytime_schedule',
    });
  }

  return candidates;
}

function deliveryView(delivery) {
  if (!delivery) return null;
  return {
    deliveryId: delivery.deliveryId,
    kind: delivery.kind,
    trigger: delivery.trigger,
    message: delivery.message ?? null,
    source: delivery.source ?? null,
    expiresAt: delivery.expiresAt,
  };
}

export function proactiveOptions(config) {
  return {
    enabled: config.proactive?.enabled !== false,
    leaseMinutes: config.proactive?.leaseMinutes ?? 20,
    intentMinScore: config.proactive?.intentMinScore ?? 0.72,
    intentMinIdleHours: config.proactive?.intentMinIdleHours ?? 2,
    starvationAfterHours: config.proactive?.starvationAfterHours ?? 24,
    starvationMinScore: config.proactive?.starvationMinScore ?? 0.60,
    starvationMinIdleHours: config.proactive?.starvationMinIdleHours ?? 2,
    maxPerDay: config.proactive?.maxPerDay ?? 3,
    globalMinIntervalHours: config.proactive?.globalMinIntervalHours ?? 3,
    dreamMinIdleHours: config.heartbeat.dreamMinIdleHours,
    dreamMinIntervalHours: config.bark.minIntervalHours,
    autonomousMinIntervalHours: config.bark.autonomousMinIntervalHours,
    daytimeEnabled: config.daytime.enabled,
    ombreReadEnabled: config.ombre.readEnabled,
    daytime: config.daytime,
  };
}

export function reserveProactiveDelivery(input, now = new Date(), options = {}, deliveryId = randomUUID()) {
  const state = structuredClone(input);
  const current = activeDelivery(state, now);
  if (current) {
    return {
      state,
      action: current.status === 'pending' ? 'send' : 'busy',
      delivery: deliveryView(current),
      reason: current.status === 'pending' ? 'already_reserved' : 'generation_in_progress',
    };
  }

  if (state.proactiveDelivery) {
    state.proactiveDelivery = null;
    state.revision += 1;
  }
  if (!state.proactiveStartedAt) {
    state.proactiveStartedAt = iso(now);
    state.revision += 1;
  }
  if (options.enabled === false) return { state, action: 'skip', reason: 'disabled' };

  const trigger = triggerCandidates(state, now, options)[0];
  if (!trigger) return { state, action: 'skip', reason: 'no_eligible_trigger' };

  const expiresAt = new Date(now.getTime() + Math.max(1, Number(options.leaseMinutes) || 10) * 60_000);
  state.proactiveDelivery = {
    deliveryId: String(deliveryId),
    status: 'generating',
    kind: trigger.kind,
    trigger,
    createdAt: iso(now),
    expiresAt: iso(expiresAt),
    message: null,
    source: null,
  };
  state.revision += 1;
  return { state, action: 'generate', delivery: deliveryView(state.proactiveDelivery) };
}

export function finalizeProactiveDelivery(input, deliveryId, candidate, now = new Date()) {
  const state = structuredClone(input);
  const delivery = state.proactiveDelivery;
  if (!delivery || delivery.deliveryId !== String(deliveryId) || delivery.status !== 'generating') {
    return { state, action: 'stale', reason: 'delivery_not_generating' };
  }
  if (parseTime(delivery.expiresAt) !== null && parseTime(delivery.expiresAt) <= now.getTime()) {
    state.proactiveDelivery = null;
    state.revision += 1;
    return { state, action: 'expired', reason: 'generation_lease_expired' };
  }

  const message = String(candidate?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 900);
  if (!message || candidate?.send === false) {
    state.proactiveDelivery = null;
    state.revision += 1;
    return { state, action: 'empty', reason: 'candidate_empty' };
  }

  state.proactiveDelivery = {
    ...delivery,
    status: 'pending',
    message,
    source: String(candidate?.source ?? 'unknown').slice(0, 40),
    generatedAt: iso(now),
  };
  state.revision += 1;
  return { state, action: 'send', delivery: deliveryView(state.proactiveDelivery) };
}

export function ackProactiveDelivery(input, deliveryId, delivered, now = new Date(), options = {}) {
  const state = structuredClone(input);
  const requestedId = String(deliveryId ?? '');
  if (!requestedId) return { state, accepted: false, reason: 'delivery_id_required' };
  if (!state.proactiveDelivery && state.lastProactiveAck?.deliveryId === requestedId) {
    return { state, accepted: true, duplicate: true, delivered: state.lastProactiveAck.delivered };
  }

  const delivery = state.proactiveDelivery;
  if (!delivery || delivery.deliveryId !== requestedId || delivery.status !== 'pending') {
    return { state, accepted: false, reason: 'delivery_not_pending' };
  }
  if (parseTime(delivery.expiresAt) !== null && parseTime(delivery.expiresAt) <= now.getTime()) {
    state.proactiveDelivery = null;
    state.revision += 1;
    return { state, accepted: false, reason: 'delivery_expired' };
  }

  const wasDelivered = delivered === true;
  if (wasDelivered) {
    const deliveredMessage = String(options.deliveredMessage ?? '').replace(/\s+/g, ' ').trim().slice(0, 900);
    const message = deliveredMessage || delivery.message;
    let next;
    if (delivery.kind === 'daytime_emergence') {
      next = recordDaytimeEmergence(state, message, now, options.timeZone ?? 'Asia/Shanghai');
      next = scheduleDaytimeEmergence(next, now, options.daytimeMinIntervalHours ?? 2, options.daytimeMaxIntervalHours ?? 3);
    } else {
      next = recordBark(state, now, { kind: delivery.kind, message });
    }
    next.proactiveDelivery = null;
    next.lastProactiveAck = { deliveryId: requestedId, delivered: true, at: iso(now) };
    return { state: next, accepted: true, delivered: true, kind: delivery.kind };
  }

  state.proactiveDelivery = null;
  state.lastProactiveAck = { deliveryId: requestedId, delivered: false, at: iso(now) };
  state.revision += 1;
  return { state, accepted: true, delivered: false, kind: delivery.kind };
}

export function proactiveDeliveryStatus(state, now = new Date()) {
  const delivery = activeDelivery(state, now);
  return delivery ? deliveryView(delivery) : null;
}
