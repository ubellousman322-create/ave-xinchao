import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { loadConfig } from './config.js';
import { applyDriveFeedback, applyOmbreHeartbeat, barkAllowed, breathDreamContext, contactIdleAllowed, daytimeEmergenceAllowed, dreamAllowed, newState, pickIntents, proactiveBarkAllowed, recentBarkHistory, recordBark, recordDaytimeEmergence, recordDream, scheduleDaytimeEmergence, settleAndApplyConversationEvent, settleState, topDrives } from './engine.js';
import { selectUniqueBark } from './bark-dedupe.js';
import { StateStore } from './state-store.js';
import { ModelClient } from './model-client.js';
import { OmbreClient } from './ombre-client.js';
import { BarkClient } from './bark-client.js';
import { readOmbreHeartbeat } from './heartbeat-store.js';
import { buildContextEnvelope, contextDeliveryState, recordContextDelivery } from './context-envelope.js';
import { TransitionJournal } from './transition-journal.js';
import { handleMcpMessage } from './mcp-protocol.js';
import { OAuthProvider } from './oauth-provider.js';
import { recordHandoffNote } from './handoff-notes.js';
import { runtimeModelConfig, runtimeModelFingerprint, runtimeModelSafeStatus } from './runtime-model-config.js';
import { ackProactiveDelivery, finalizeProactiveDelivery, proactiveDeliveryStatus, proactiveOptions, reserveProactiveDelivery } from './proactive-delivery.js';

const config = loadConfig();
if (!config.serviceToken) throw new Error('SERVICE_TOKEN is required');

const store = new StateStore(config.statePath, () => newState());
let modelConfig = config.model;
let model = new ModelClient(modelConfig);
let runtimeModelSource = modelConfig.enabled && modelConfig.apiKey ? 'environment' : 'disabled';
let runtimeModelSyncedAt = runtimeModelSource === 'environment' ? new Date().toISOString() : null;
let runtimeModelConfigFingerprint = runtimeModelFingerprint(modelConfig);
const interactionClassifier = new ModelClient(config.interactionClassifier);
const ombre = new OmbreClient(config.ombre);
const bark = new BarkClient(config.bark);
const journal = new TransitionJournal(config.journalPath);
const oauth = new OAuthProvider(config.oauth, (event, fields = {}) => log(event, fields));
await oauth.init();
let cyclePromise = null;

function log(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

async function updateState(meta, mutate) {
  let before;
  const after = await store.update((current) => {
    before = structuredClone(current);
    return mutate(current);
  });
  try {
    await journal.recordTransition({
      before,
      after,
      type: meta.type,
      source: meta.source,
      sessionId: meta.sessionId,
      eventId: meta.eventId,
      details: meta.details,
      force: meta.force,
      at: meta.at,
    });
  } catch (error) {
    log('transition_journal_failed', { type: meta.type, message: error.message });
  }
  return after;
}

async function synchronizeOmbreHeartbeat() {
  let recordedAt;
  try {
    recordedAt = await readOmbreHeartbeat(config.heartbeat.filePath);
  } catch (error) {
    log('ombre_heartbeat_read_failed', { message: error.message });
    return null;
  }
  if (!recordedAt) return null;

  let observed = false;
  const state = await updateState({
    type: 'ombre_heartbeat',
    source: 'ombre-file',
    at: new Date(recordedAt),
  }, (current) => {
    const previous = Date.parse(current.lastHeartbeatAt ?? '');
    if (Number.isFinite(previous) && previous >= recordedAt.getTime()) return current;
    observed = true;
    return applyOmbreHeartbeat(current, recordedAt).state;
  });
  if (observed) log('ombre_heartbeat_observed', { revision: state.revision });
  return state;
}

async function runCycle() {
  if (cyclePromise) return cyclePromise;
  cyclePromise = (async () => {
    const now = new Date();
    await synchronizeOmbreHeartbeat();
    let settled;
    await updateState({
      type: 'settle',
      source: 'timer',
      at: now,
    }, (state) => {
      settled = settleState(state, now, config.sleepAfterMinutes, config.settle);
      return settled.state;
    });

    let state = settled.state;
    let dreamCreated = false;
    let barkSent = false;
    let daytimeSent = false;
    // Dream residue follows a short quiet period; autonomous contact remains
    // reserved for a genuine long absence.
    const dreamContactIsIdle = contactIdleAllowed(state, now, config.heartbeat.dreamMinIdleHours);
    const proactiveContactIsIdle = contactIdleAllowed(state, now, config.heartbeat.proactiveMinIdleHours);

    if (dreamAllowed(state, now, config.dreamMinIntervalHours, config.dreamMaxPerDay)) {
      let material = '';
      if (!config.shadowMode && config.ombre.readEnabled) {
        try { material = await ombre.recentMaterial(); }
        catch (error) { log('ombre_read_failed', { message: error.message }); }
      }

      let generated;
      if (config.shadowMode) {
        generated = new ModelClient({ ...config.model, enabled: false }).fallback(topDrives(state));
      } else {
        try {
          generated = await model.generateDream({ state, material, topDrives: topDrives(state) });
        } catch (error) {
          log('dream_model_failed', { message: error.message });
          generated = new ModelClient({ ...config.model, enabled: false }).fallback(topDrives(state));
        }
      }

      const dream = { id: randomUUID(), createdAt: now.toISOString(), ...generated, ombreBucketId: null };
      if (!config.shadowMode && config.ombre.writeEnabled) {
        try { dream.ombreBucketId = await ombre.storeDream(dream); }
        catch (error) { log('ombre_write_failed', { message: error.message }); }
      }

      state = await updateState({
        type: 'dream_recorded',
        source: config.shadowMode ? 'rule-seed' : 'model',
        details: { dreamCreated: true },
        at: now,
      }, (latest) => {
        if (!dreamAllowed(latest, now, config.dreamMinIntervalHours, config.dreamMaxPerDay)) return latest;
        return recordDream(latest, dream);
      });
      dreamCreated = true;
      log('dream_settled', { source: dream.source, shadow: config.shadowMode, usedBreath: Boolean(material), revision: state.revision });

      if (!config.shadowMode && config.bark.enabled && dreamContactIsIdle && barkAllowed(state, now, config.bark.minIntervalHours, config.bark.maxPerDay, 'dream')) {
        try {
          let modelFailed = false;
          const selected = await selectUniqueBark({
            state,
            onRejected: ({ attempt, similarity }) => log('bark_duplicate_rejected', { kind: 'dream', attempt, similarity }),
            generate: async ({ recentMessages, rejectedMessage }) => {
              if (modelFailed) return dream.residue;
              try {
                return await model.generateDreamPush({ dream, recentMessages, rejectedMessage });
              } catch (error) {
                modelFailed = true;
                log('dream_push_model_failed', { message: error.message });
                return dream.residue;
              }
            },
          });
          if (selected.reason === 'duplicate') {
            log('bark_duplicate_skipped', { kind: 'dream', attempts: selected.attempts });
          }
          if (selected.message) {
            const result = await bark.send(selected.message);
            if (result.sent) {
              state = await updateState({
                type: 'bark_sent',
                source: 'bark',
                details: { barkSent: true, kind: 'dream' },
                at: now,
              }, (latest) => recordBark(latest, now, { kind: 'dream', message: selected.message }));
              barkSent = true;
              log('bark_sent', { kind: 'dream', revision: state.revision });
            }
          }
        } catch (error) { log('bark_failed', { kind: 'dream', message: error.message }); }
      }
    }

    if (!config.shadowMode && config.bark.enabled && proactiveContactIsIdle && !dreamCreated && proactiveBarkAllowed(state, now, config.bark.autonomousMinIntervalHours, config.bark.maxPerDay, config.bark.minDrive)) {
      let selected;
      let modelFailed = false;
      try {
        selected = await selectUniqueBark({
          state,
          onRejected: ({ attempt, similarity }) => log('bark_duplicate_rejected', { kind: 'autonomous_thought', attempt, similarity }),
          generate: async ({ recentMessages, rejectedMessage }) => {
            if (modelFailed) return new ModelClient({ ...config.model, enabled: false }).fallbackThought(topDrives(state));
            try {
              return await model.generateThought({ state, topDrives: topDrives(state), recentMessages, rejectedMessage });
            } catch (error) {
              modelFailed = true;
              log('thought_model_failed', { message: error.message });
              return new ModelClient({ ...config.model, enabled: false }).fallbackThought(topDrives(state));
            }
          },
        });
      } catch (error) {
        log('thought_model_failed', { message: error.message });
        selected = { message: '', reason: 'empty', attempts: 1 };
      }
      if (selected.reason === 'duplicate') {
        log('bark_duplicate_skipped', { kind: 'autonomous_thought', attempts: selected.attempts });
      }
      if (selected.message) {
        try {
          const result = await bark.send(selected.message);
          if (result.sent) {
            state = await updateState({
              type: 'bark_sent',
              source: 'bark',
              details: { barkSent: true, kind: 'autonomous_thought' },
              at: now,
            }, (latest) => recordBark(latest, now, { kind: 'autonomous_thought', message: selected.message }));
            barkSent = true;
            log('bark_sent', { kind: 'autonomous_thought', source: selected.candidate?.source, revision: state.revision });
          }
        } catch (error) { log('bark_failed', { kind: 'autonomous_thought', message: error.message }); }
      }
    }

    if (!state.nextDaytimeEmergenceAt && config.daytime.enabled) {
      state = await updateState({
        type: 'daytime_emergence_scheduled',
        source: 'timer',
        at: now,
      }, (latest) => scheduleDaytimeEmergence(latest, now, config.daytime.minIntervalHours, config.daytime.maxIntervalHours));
      log('daytime_emergence_scheduled', { nextAt: state.nextDaytimeEmergenceAt, revision: state.revision });
    } else if (!config.shadowMode && config.daytime.enabled && config.ombre.readEnabled && config.bark.enabled && daytimeEmergenceAllowed(state, now, config.daytime)) {
      let selected = { message: '', candidate: { source: 'none' }, reason: 'empty', attempts: 1 };
      try {
        const material = await ombre.daytimeMaterial();
        if (material.trim()) {
          selected = await selectUniqueBark({
            state,
            onRejected: ({ attempt, similarity }) => log('bark_duplicate_rejected', { kind: 'daytime_emergence', attempt, similarity }),
            generate: ({ recentMessages, rejectedMessage }) => model.generateDaytimeEmergence({ material, recentMessages, rejectedMessage }),
          });
        }
      } catch (error) {
        log('daytime_emergence_failed', { message: error.message });
      }
      if (selected.reason === 'duplicate') {
        log('bark_duplicate_skipped', { kind: 'daytime_emergence', attempts: selected.attempts });
      }
      if (selected.message) {
        try {
          const result = await bark.send(selected.message);
          if (result.sent) {
            state = await updateState({
              type: 'daytime_emergence_sent',
              source: 'bark',
              details: { daytimeSent: true },
              at: now,
            }, (latest) => recordDaytimeEmergence(latest, selected.message, now, config.daytime.timeZone));
            daytimeSent = true;
            log('bark_sent', { kind: 'daytime_emergence', source: selected.candidate?.source, revision: state.revision });
          }
        } catch (error) {
          log('bark_failed', { kind: 'daytime_emergence', message: error.message });
        }
      } else {
        log('daytime_emergence_skipped', { reason: selected.reason === 'duplicate' ? 'duplicate' : 'no_pushworthy_material' });
      }
      state = await updateState({
        type: 'daytime_emergence_scheduled',
        source: 'timer',
        at: now,
      }, (latest) => scheduleDaytimeEmergence(latest, now, config.daytime.minIntervalHours, config.daytime.maxIntervalHours));
      log('daytime_emergence_scheduled', { nextAt: state.nextDaytimeEmergenceAt, revision: state.revision });
    }
    return { state, dreamCreated, barkSent, daytimeSent };
  })().finally(() => { cyclePromise = null; });
  return cyclePromise;
}

function safeEqual(supplied, expected) {
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function auditEventFingerprint(value) {
  const eventId = String(value ?? '').trim();
  return eventId
    ? createHash('sha256').update(eventId, 'utf8').digest('hex').slice(0, 24)
    : '';
}

function authorized(request) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  return safeEqual(supplied, config.serviceToken);
}

function mcpPath(url) {
  return url.pathname === '/mcp' || url.pathname.startsWith('/mcp/');
}

function transportSessionId(request, initialize = false) {
  const supplied = String(request.headers['mcp-session-id'] ?? '').trim();
  if (!initialize && /^[A-Za-z0-9._~-]{1,120}$/.test(supplied)) return supplied;
  return `mcp-${randomUUID()}`;
}

function negotiatedProtocolVersion(request, payload, result) {
  const supported = new Set(['2025-03-26', '2025-06-18']);
  const values = [
    result?.body?.result?.protocolVersion,
    request.headers['mcp-protocol-version'],
    payload?.params?.protocolVersion,
  ];
  return values.find((value) => supported.has(String(value))) ?? '2025-06-18';
}

function mcpAuthorized(request, url) {
  if (authorized(request)) return true;
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  if (oauth.validateAccessToken(bearer)) return true;
  if (!config.mcp.pathToken || !url.pathname.startsWith('/mcp/')) return false;
  const supplied = decodeURIComponent(url.pathname.slice('/mcp/'.length));
  return safeEqual(supplied, config.mcp.pathToken);
}

async function body(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new Error('request body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function send(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function sendMcp(response, status, value, extraHeaders = {}) {
  const headers = {
    'Cache-Control': 'no-store',
    ...extraHeaders,
  };
  if (value == null) {
    response.writeHead(status, headers);
    return response.end();
  }
  response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
  return response.end(JSON.stringify(value));
}

async function createContextEnvelope({
  sessionId,
  mode = 'session_start',
  maxTokens = config.context.defaultMaxTokens,
  force = false,
  now = new Date(),
}) {
  let state = await store.read();
  const delivery = contextDeliveryState(state, sessionId, mode, now, config.context.handoffOnceHours);
  let ombreText = '';
  let ombreWarning = '';
  if (
    mode === 'session_start'
    && (!delivery.alreadyDelivered || force)
    && config.context.ombreEnabled
    && config.ombre.readEnabled
  ) {
    try {
      ombreText = await ombre.recentContinuityMaterial(config.context.ombreMaxTokens);
    } catch (error) {
      ombreWarning = 'ombre_unavailable';
      log('context_ombre_read_failed', { message: error.message });
    }
  }
  const envelope = buildContextEnvelope({
    state,
    sessionId,
    mode,
    ombreText,
    maxTokens,
    ttlMinutes: config.context.ttlMinutes,
    now,
    alreadyDelivered: delivery.alreadyDelivered,
    force,
  });
  if (envelope.delivered) {
    state = await updateState({
      type: 'context_delivery',
      source: 'context-adapter',
      sessionId,
      details: {
        delivered: true,
        force,
        mode,
        ombreIncluded: Boolean(ombreText),
        estimatedTokens: envelope.estimatedTokens,
        sectionCount: envelope.sections.length,
      },
      at: now,
    }, (current) => recordContextDelivery(current, {
      sessionId,
      mode,
      digest: envelope.digest,
      deliveredAt: now,
    }));
  }
  try {
    await journal.recordContext({
      mode,
      sessionId,
      digest: envelope.digest,
      estimatedTokens: envelope.estimatedTokens,
      sectionCount: envelope.sections.length,
      delivered: envelope.delivered,
      alreadyDelivered: envelope.alreadyDelivered,
      ombreIncluded: Boolean(ombreText),
      at: now,
    });
  } catch (error) {
    log('context_audit_failed', { message: error.message });
  }
  return ombreWarning ? { ...envelope, warnings: [ombreWarning] } : envelope;
}

async function recordConversationEvent(event, source = 'api', now = new Date()) {
  let applied;
  const auditDetails = {};
  const state = await updateState({
    type: source === 'heartbeat' ? 'conversation_heartbeat' : 'conversation_event',
    source: source === 'mcp' ? 'mcp' : 'api',
    sessionId: event.sessionId ?? event.session_id,
    eventId: auditEventFingerprint(event.eventId ?? event.event_id),
    details: auditDetails,
    at: now,
  }, (current) => {
    applied = settleAndApplyConversationEvent(current, event, now, {
      sleepAfterMinutes: config.sleepAfterMinutes,
      settle: config.settle,
      interaction: config.interaction,
    });
    Object.assign(auditDetails, {
      changed: applied.changed,
      duplicate: applied.duplicate,
      interactionApplied: applied.interaction?.applied,
      reasonCode: applied.interaction?.reasonCode,
      settledHours: Number(applied.settled.elapsedHours.toFixed(4)),
    });
    return applied.state;
  });
  return {
    revision: state.revision,
    consciousness: state.consciousness,
    pendingAwareness: state.pendingAwareness,
    sessionId: applied.sessionId || null,
    sessionCreated: applied.sessionCreated,
    duplicate: applied.duplicate,
    interaction: applied.interaction,
    settledHours: Number(applied.settled.elapsedHours.toFixed(4)),
  };
}

const proactiveConfig = proactiveOptions(config);

async function generateProactiveCandidate(delivery, state) {
  const recentMessages = recentBarkHistory(state);
  if (delivery.kind === 'dream') {
    const dream = state.recentDreams?.find((item) => item.id === delivery.trigger.dreamId);
    if (!dream) return { send: false, message: '', source: 'missing_dream' };
    let modelFailed = false;
    const selected = await selectUniqueBark({
      state,
      generate: async ({ rejectedMessage }) => {
        if (modelFailed) return dream.residue;
        try {
          return await model.generateDreamPush({ dream, recentMessages, rejectedMessage });
        } catch (error) {
          modelFailed = true;
          log('proactive_dream_model_failed', { message: error.message });
          return dream.residue;
        }
      },
    });
    return selected.message ? { message: selected.message, source: selected.candidate?.source ?? 'model' } : { send: false, message: '', source: selected.reason ?? 'empty' };
  }
  if (delivery.kind === 'autonomous_thought') {
    const intent = delivery.trigger.intent;
    let modelFailed = false;
    const selected = await selectUniqueBark({
      state,
      generate: async ({ rejectedMessage }) => {
        if (modelFailed) return new ModelClient({ ...modelConfig, enabled: false }).fallbackThought(topDrives(state));
        try {
          return await model.generateThought({ state, topDrives: topDrives(state), recentMessages, rejectedMessage });
        } catch (error) {
          modelFailed = true;
          log('proactive_thought_model_failed', { intent: intent?.key, message: error.message });
          return new ModelClient({ ...modelConfig, enabled: false }).fallbackThought(topDrives(state));
        }
      },
    });
    return selected.message ? { message: selected.message, source: selected.candidate?.source ?? 'model' } : { send: false, message: '', source: selected.reason ?? 'empty' };
  }
  if (delivery.kind === 'daytime_emergence') {
    const material = await ombre.daytimeMaterial();
    if (!material.trim()) return { send: false, message: '', source: 'no_pushworthy_material' };
    const selected = await selectUniqueBark({
      state,
      generate: ({ rejectedMessage }) => model.generateDaytimeEmergence({ material, recentMessages, rejectedMessage }),
    });
    return selected.message ? { message: selected.message, source: selected.candidate?.source ?? 'model' } : { send: false, message: '', source: selected.reason ?? 'empty' };
  }
  return { send: false, message: '', source: 'unknown_kind' };
}

async function pollProactiveDelivery(now = new Date()) {
  await runCycle();
  let reservation;
  let state;
  await updateState({ type: 'proactive_poll', source: 'operit', at: now }, (current) => {
    reservation = reserveProactiveDelivery(current, now, proactiveConfig);
    state = reservation.state;
    return state;
  });
  if (reservation.action === 'send') {
    return { action: 'send', reason: reservation.reason, delivery: reservation.delivery };
  }
  if (reservation.action === 'skip' || reservation.action === 'busy') {
    return { action: 'skip', reason: reservation.reason, delivery: null };
  }
  try {
    const candidate = await generateProactiveCandidate(reservation.delivery, state);
    let finalized;
    await updateState({
      type: 'proactive_candidate',
      source: 'model',
      details: { kind: reservation.delivery.kind, candidateSource: candidate.source ?? null },
      at: now,
    }, (current) => {
      finalized = finalizeProactiveDelivery(current, reservation.delivery.deliveryId, candidate, new Date());
      return finalized.state;
    });
    return { action: finalized.action, reason: finalized.reason ?? null, delivery: finalized.delivery ?? null };
  } catch (error) {
    let released;
    await updateState({ type: 'proactive_candidate_failed', source: 'model', at: now, details: { message: error.message } }, (current) => {
      released = finalizeProactiveDelivery(current, reservation.delivery.deliveryId, { send: false, message: '', source: 'error' }, new Date());
      return released.state;
    });
    log('proactive_candidate_failed', { kind: reservation.delivery.kind, message: error.message });
    return { action: 'skip', reason: 'candidate_generation_failed', delivery: null };
  }
}

async function ackProactiveDeliveryRequest(payload, now = new Date()) {
  let applied;
  const state = await updateState({
    type: 'proactive_ack',
    source: 'operit',
    eventId: auditEventFingerprint(payload.deliveryId),
    details: { delivered: payload.delivered === true },
    at: now,
  }, (current) => {
    applied = ackProactiveDelivery(current, payload.deliveryId, payload.delivered === true, now, {
      timeZone: config.daytime.timeZone,
      deliveredMessage: payload.message,
      daytimeMinIntervalHours: config.daytime.minIntervalHours,
      daytimeMaxIntervalHours: config.daytime.maxIntervalHours,
    });
    return applied.state;
  });
  return { ...applied, revision: state.revision, delivery: proactiveDeliveryStatus(state, now) };
}

async function saveHandoffNote(note, source = 'mcp', now = new Date()) {
  let applied;
  const state = await updateState({
    type: 'handoff_note',
    source,
    sessionId: note.sessionId,
    eventId: auditEventFingerprint(note.eventId),
    details: {
      noteLength: String(note.note ?? '').length,
      ttlHours: note.ttlHours,
    },
    at: now,
  }, (current) => {
    applied = recordHandoffNote(current, { ...note, now });
    return applied.state;
  });
  return {
    revision: state.revision,
    duplicate: applied.duplicate,
    noteLength: applied.noteLength,
  };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') {
      return send(response, 200, {
        ok: true,
        system: 'xinchao-dynamic-mind',
        mode: config.shadowMode ? 'shadow' : 'active',
        version: '2.3.1',
        proactiveDelivery: config.proactive.enabled ? 'poll_ack' : 'disabled',
      });
    }
    if (await oauth.handle(request, response, url)) return;
    if (config.mcp.enabled && mcpPath(url)) {
      if (!mcpAuthorized(request, url)) {
        if (oauth.enabled) response.setHeader('WWW-Authenticate', oauth.wwwAuthenticate());
        return sendMcp(response, 401, { error: 'unauthorized' });
      }
      if (request.method === 'DELETE') {
        return sendMcp(response, 204, null, {
          'Mcp-Session-Id': transportSessionId(request),
          'MCP-Protocol-Version': '2025-06-18',
        });
      }
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST, DELETE');
        return sendMcp(response, 405, { error: 'method not allowed' });
      }
      const payload = await body(request);
      const sessionId = transportSessionId(request, payload?.method === 'initialize');
      const result = await handleMcpMessage(payload, {
        defaultSessionId: sessionId,
        context: async (args) => {
          if (!config.context.enabled) throw new Error('心潮 Context Envelope 当前未启用');
          return createContextEnvelope(args);
        },
        event: async (event) => {
          const result = await recordConversationEvent(event, 'mcp');
          return {
            revision: result.revision,
            consciousness: result.consciousness,
            sessionId: result.sessionId,
            sessionCreated: result.sessionCreated,
            duplicate: result.duplicate,
            interaction: result.interaction,
            settledHours: result.settledHours,
          };
        },
        handoffNote: async (note) => saveHandoffNote(note, 'mcp'),
      });
      if (payload?.method === 'initialize' || payload?.method === 'tools/call') {
        log('mcp_request', {
          method: payload.method,
          tool: payload?.params?.name ? String(payload.params.name).slice(0, 80) : undefined,
          session: auditEventFingerprint(sessionId),
          status: result.status,
        });
      }
      return sendMcp(response, result.status, result.body, {
        'Mcp-Session-Id': sessionId,
        'MCP-Protocol-Version': negotiatedProtocolVersion(request, payload, result),
      });
    }
    if (!authorized(request)) return send(response, 401, { error: 'unauthorized' });

    if (request.method === 'GET' && url.pathname === '/v1/runtime-model') {
      return send(response, 200, runtimeModelSafeStatus(modelConfig, runtimeModelSource, runtimeModelSyncedAt));
    }
    if (request.method === 'POST' && url.pathname === '/v1/runtime-model/test') {
      if (!modelConfig.enabled || !modelConfig.apiKey) return send(response, 503, { ok: false, error: 'runtime model disabled' });
      try {
        const generated = await model.generateDream({
          state: { consciousness: 'awake' },
          material: '',
          topDrives: [],
        });
        return send(response, 200, {
          ok: generated.source === 'model',
          source: generated.source,
          model: generated.model ?? modelConfig.name,
          outputPresent: Boolean(generated.dream || generated.residue || generated.awareness),
        });
      } catch (error) {
        log('runtime_model_test_failed', { model: modelConfig.name, message: error.message });
        return send(response, 502, { ok: false, error: 'runtime model test failed', model: modelConfig.name });
      }
    }
    if (request.method === 'POST' && url.pathname === '/v1/runtime-model') {
      const payload = await body(request);
      const next = runtimeModelConfig(payload, {
        dreamPushPromptPath: config.model.dreamPushPromptPath,
        agentName: config.identity.agentName,
        notificationRecipient: config.identity.notificationRecipient,
      });
      const nextFingerprint = runtimeModelFingerprint(next);
      const changed = nextFingerprint !== runtimeModelConfigFingerprint;
      modelConfig = next ?? { ...config.model, enabled: false, apiKey: '' };
      model = new ModelClient(modelConfig);
      runtimeModelConfigFingerprint = nextFingerprint;
      runtimeModelSource = next ? 'bridge' : 'disabled';
      runtimeModelSyncedAt = next ? new Date().toISOString() : null;
      log('runtime_model_updated', {
        configured: Boolean(next),
        source: runtimeModelSource,
        model: next?.name ?? null,
        changed,
      });
      return send(response, 200, {
        ...runtimeModelSafeStatus(modelConfig, runtimeModelSource, runtimeModelSyncedAt),
        changed,
      });
    }

    if (request.method === 'GET' && url.pathname === '/v1/state') {
      return send(response, 200, await store.read());
    }
    if (request.method === 'GET' && url.pathname === '/v1/breath-context') {
      const state = await store.read();
      return send(response, 200, {
        ...breathDreamContext(state, new Date()),
        generatedAt: new Date().toISOString(),
      });
    }
    if (request.method === 'GET' && url.pathname === '/v1/context') {
      if (!config.context.enabled) return send(response, 503, { error: 'context envelope disabled' });
      const now = new Date();
      const sessionId = String(url.searchParams.get('session_id') ?? 'default').trim().slice(0, 120) || 'default';
      const requestedMode = String(url.searchParams.get('mode') ?? 'session_start').trim().toLowerCase();
      const mode = ['session_start', 'turn', 'inspect'].includes(requestedMode) ? requestedMode : 'session_start';
      const force = ['1', 'true', 'yes', 'on'].includes(String(url.searchParams.get('force') ?? '').toLowerCase());
      const maxTokens = Number(url.searchParams.get('max_tokens') ?? config.context.defaultMaxTokens);
      return send(response, 200, await createContextEnvelope({
        sessionId,
        mode,
        maxTokens,
        force,
        now,
      }));
    }
    if (request.method === 'GET' && url.pathname === '/v1/intent') {
      const state = await store.read();
      const intents = pickIntents(state);
      return send(response, 200, {
        intent: intents[0] ?? null,
        intents,
        topDrives: topDrives(state),
        thoughtPool: state.thoughtPool ?? null,
        fatigue: state.fatigue ?? 0,
      });
    }
    if (request.method === 'POST' && url.pathname === '/v1/proactive/poll') {
      return send(response, 200, await pollProactiveDelivery(new Date()));
    }
    if (request.method === 'POST' && url.pathname === '/v1/proactive/ack') {
      const payload = await body(request);
      return send(response, 200, await ackProactiveDeliveryRequest(payload, new Date()));
    }
    if (request.method === 'GET' && url.pathname === '/v1/proactive/status') {
      const state = await store.read();
      return send(response, 200, { delivery: proactiveDeliveryStatus(state, new Date()), revision: state.revision });
    }
    if (request.method === 'POST' && url.pathname === '/v1/settle') {
      const result = await runCycle();
      return send(response, 200, { revision: result.state.revision, consciousness: result.state.consciousness, dreamCreated: result.dreamCreated, barkSent: result.barkSent, daytimeSent: result.daytimeSent });
    }
    if (request.method === 'POST' && url.pathname === '/v1/classify-interaction') {
      if (!config.interactionClassifier.enabled) {
        return send(response, 503, { error: 'interaction classifier disabled' });
      }
      const payload = await body(request);
      const userText = String(payload.user_text ?? payload.userText ?? '').slice(0, config.interactionClassifier.maxInputChars);
      const assistantText = String(payload.assistant_text ?? payload.assistantText ?? '').slice(0, config.interactionClassifier.maxInputChars);
      if (!userText.trim() || !assistantText.trim()) {
        return send(response, 400, { error: 'user_text and assistant_text are required' });
      }
      try {
        const classified = await interactionClassifier.classifyInteraction({ userText, assistantText });
        return send(response, 200, classified);
      } catch (error) {
        log('interaction_classifier_failed', { message: error.message });
        return send(response, 502, { error: 'interaction classifier failed' });
      }
    }
    if (request.method === 'POST' && (url.pathname === '/v1/conversation-event' || url.pathname === '/v1/heartbeat')) {
      const event = await body(request);
      const source = url.pathname === '/v1/heartbeat' ? 'heartbeat' : 'api';
      return send(response, 200, await recordConversationEvent(event, source));
    }
    if (request.method === 'POST' && url.pathname === '/v1/drive-feedback') {
      const payload = await body(request);
      const now = new Date();
      const state = await updateState({
        type: 'drive_feedback',
        source: 'api',
        eventId: payload.eventId ?? payload.event_id,
        at: now,
      }, (current) => applyDriveFeedback(current, payload.driveDeltas ?? {}, now));
      return send(response, 200, { revision: state.revision, topDrives: topDrives(state) });
    }
    return send(response, 404, { error: 'not found' });
  } catch (error) {
    log('request_failed', { message: error.message });
    return send(response, 400, { error: error.message });
  }
});

server.listen(config.port, '0.0.0.0', async () => {
  await store.read();
  log('service_started', { port: config.port, shadow: config.shadowMode, modelEnabled: Boolean(modelConfig.enabled && modelConfig.apiKey), barkEnabled: config.bark.enabled });
});

const timer = setInterval(() => runCycle().catch((error) => log('cycle_failed', { message: error.message })), config.settleIntervalMinutes * 60_000);
timer.unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
