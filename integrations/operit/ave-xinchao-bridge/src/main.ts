import settingsUI from "./ui/settings.ui.js";
import dashboardUI from "./ui/dashboard.ui.js";
import { ensureXinchaoService, onXinchaoLifecycle } from "./xinchao-service.js";
import { syncRuntimeModelConfig } from "./runtime-model-sync.js";
import {
  classifierConfigured,
  loadBridgeSettings,
  markTurnProcessed,
  turnWasProcessed,
} from "./settings.js";

const XINCHAO_BASE_URL = "http://127.0.0.1:18111";
const XINCHAO_SERVICE_TOKEN = "__AVE_XINCHAO_SERVICE_TOKEN__";
const INJECTION_OPEN = "<ave_xinchao_context>";
const INJECTION_CLOSE = "</ave_xinchao_context>";

export interface CompletedTurn {
  userText: string;
  assistantText: string;
  fingerprint: string;
  userIndex: number;
  assistantIndex: number;
}

export interface InteractionTag {
  type: string;
  intensity: number;
  confidence: number;
}

export interface FlashThought {
  key: string;
  text: string;
  intensity: number;
}

const pendingUserMessages = new Map<string, { content: string; fingerprint: string }>();
const THOUGHT_BY_INTERACTION: Record<string, { key: string; text: string }> = {
  companionship: { key: "social", text: "想继续和她待一会儿" },
  affection: { key: "possess", text: "她刚刚明确表达了爱意" },
  intimacy: { key: "crave", text: "刚才的亲密仍有余温" },
  sharing: { key: "share", text: "这一轮有值得延续的分享" },
  discovery: { key: "curiosity", text: "刚发现的东西还想继续探索" },
  task_progress: { key: "duty", text: "共同推进的事情还在心里" },
  reflection: { key: "reflection", text: "刚才的思考还没有完全沉下去" },
  conflict: { key: "hurt", text: "刚才的冲突仍留下了触动" },
  loss: { key: "grieve", text: "失落感还没有完全散去" },
  reconciliation: { key: "security", text: "和好后的安心仍然清晰" },
  ignored: { key: "loneliness", text: "被忽略的感觉仍有一点残留" },
  rejection: { key: "hurt", text: "被拒绝后的受伤感还在" },
  uncertainty: { key: "anxiety", text: "尚未确定的事情仍让人惦记" },
  reassurance: { key: "security", text: "刚得到的确认仍让人安心" },
  boundary_respected: { key: "security", text: "边界被尊重带来了安心" },
  boundary_violation: { key: "hurt", text: "边界被越过的不适仍在" },
  comparison: { key: "jealousy", text: "刚才的比较仍让人在意" },
  embarrassment: { key: "shame", text: "刚才的尴尬还没有完全散去" },
  exclusion: { key: "loneliness", text: "被排除在外的感觉仍有残留" },
};

const ALLOWED_INTERACTION_TYPES = new Set([
  "companionship", "affection", "intimacy", "sharing", "discovery",
  "task_progress", "reflection", "conflict", "loss", "reconciliation",
  "ignored", "rejection", "uncertainty", "reassurance",
  "boundary_respected", "boundary_violation", "comparison",
  "embarrassment", "exclusion",
]);

function boundedNumber(value: unknown, minimum: number, maximum: number): number | null {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(maximum, Math.max(minimum, number));
}

export function sanitizeInteractionTags(value: unknown): InteractionTag[] {
  const source = Array.isArray(value)
    ? value
    : (typeof value === "object" && value !== null && Array.isArray((value as { interactions?: unknown }).interactions)
      ? (value as { interactions: unknown[] }).interactions
      : []);
  const unique = new Map<string, InteractionTag>();
  for (const candidate of source.slice(0, 12)) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const record = candidate as { type?: unknown; intensity?: unknown; confidence?: unknown };
    const type = String(record.type ?? "").trim().toLowerCase();
    if (!ALLOWED_INTERACTION_TYPES.has(type)) continue;
    const intensity = boundedNumber(record.intensity, 0.1, 1);
    const confidence = boundedNumber(record.confidence, 0, 1);
    if (intensity === null || confidence === null || confidence < 0.45) continue;
    const normalized = { type, intensity, confidence };
    const previous = unique.get(type);
    if (!previous || confidence > previous.confidence) unique.set(type, normalized);
  }
  return [...unique.values()]
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 4);
}

function normalizedKind(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function normalizedContent(value: unknown): string {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function normalizedSender(value: unknown): "user" | "assistant" | "other" {
  const sender = String(value ?? "").trim().toLowerCase();
  if (["user", "human", "me", "owner"].includes(sender)) return "user";
  if (["assistant", "ai", "model", "bot"].includes(sender)) return "assistant";
  return "other";
}

export function flashThoughtsFromTags(tags: InteractionTag[]): FlashThought[] {
  const byKey = new Map<string, FlashThought>();
  for (const tag of tags) {
    const template = THOUGHT_BY_INTERACTION[tag.type];
    if (!template) continue;
    const strength = Math.min(1, Math.max(0, tag.intensity * tag.confidence));
    const candidate = { ...template, intensity: Number((0.55 + 0.45 * strength).toFixed(4)) };
    const previous = byKey.get(candidate.key);
    if (!previous || candidate.intensity > previous.intensity) byKey.set(candidate.key, candidate);
  }
  return [...byKey.values()].slice(0, 4);
}

function sessionChangesFromTags(tags: InteractionTag[]): {
  sessionTone?: string;
  sessionDeltas: Record<string, number>;
} {
  const deltas = { warmth: 0, tension: 0, attention: 0, confidence: 0 };
  let tone = "";
  for (const tag of tags) {
    const strength = Math.min(1, Math.max(0, tag.intensity * tag.confidence));
    if (["conflict", "boundary_violation", "rejection", "ignored", "exclusion"].includes(tag.type)) {
      deltas.tension += 0.18 * strength;
      deltas.warmth -= 0.08 * strength;
      deltas.confidence -= 0.08 * strength;
      tone = "guarded";
    } else if (tag.type === "reconciliation") {
      deltas.tension -= 0.20 * strength;
      deltas.warmth += 0.10 * strength;
      deltas.confidence += 0.10 * strength;
      tone = "warm";
    } else if (["affection", "intimacy", "companionship", "reassurance", "boundary_respected"].includes(tag.type)) {
      deltas.warmth += 0.08 * strength;
      deltas.tension -= 0.06 * strength;
      deltas.confidence += 0.06 * strength;
      if (!tone) tone = "warm";
    } else if (["task_progress", "discovery", "reflection", "sharing"].includes(tag.type)) {
      deltas.attention += 0.08 * strength;
      if (!tone) tone = "focused";
    }
  }
  return {
    ...(tone ? { sessionTone: tone } : {}),
    sessionDeltas: Object.fromEntries(
      Object.entries(deltas).map(([key, value]) => [
        key,
        Number(Math.max(-0.25, Math.min(0.25, value)).toFixed(4)),
      ])
    ),
  };
}

// Deterministic FNV-1a 64-bit fingerprint. Message text is never logged or persisted.
export function stableFingerprint(parts: string[]): string {
  let hash = 0xcbf29ce484222325n;
  const input = parts.join("\u001f");
  const bytes = unescape(encodeURIComponent(input));
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= BigInt(bytes.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function extractPreviousCompletedTurn(
  history: ToolPkg.PromptTurn[],
  chatId: string
): CompletedTurn | null {
  if (!Array.isArray(history) || history.length < 3) return null;

  // The current request must end in a USER turn. Everything after it is not a
  // completed previous round and must never be classified early.
  let currentUserIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (normalizedKind(history[index]?.kind) === "USER") {
      currentUserIndex = index;
      break;
    }
  }
  if (currentUserIndex < 1) return null;

  let assistantIndex = -1;
  for (let index = currentUserIndex - 1; index >= 0; index -= 1) {
    if (normalizedKind(history[index]?.kind) === "ASSISTANT") {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 1) return null;

  let userIndex = -1;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (normalizedKind(history[index]?.kind) === "USER") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return null;

  const userText = normalizedContent(history[userIndex]?.content);
  const assistantText = normalizedContent(history[assistantIndex]?.content);
  if (!userText || !assistantText) return null;

  return {
    userText,
    assistantText,
    fingerprint: stableFingerprint([chatId, userText, assistantText]),
    userIndex,
    assistantIndex,
  };
}

function compact(value: unknown, maxLength = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function parseJsonObject(text: unknown): unknown {
  const source = String(text ?? "").trim();
  try { return JSON.parse(source); } catch {
    const match = source.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("classifier returned no JSON object");
    return JSON.parse(match[0]);
  }
}

async function getJson(url: string, token: string, timeoutMs: number): Promise<unknown> {
  await ensureXinchaoService();
  const response = await OkHttp.newBuilder()
    .connectTimeout(timeoutMs)
    .readTimeout(timeoutMs)
    .writeTimeout(timeoutMs)
    .retryOnConnectionFailure(false)
    .build()
    .newRequest()
    .url(url)
    .method("GET")
    .header("Authorization", `Bearer ${token}`)
    .header("Accept", "application/json")
    .build()
    .execute();
  if (!response.isSuccessful()) throw new Error(`HTTP ${response.statusCode}`);
  return JSON.parse(String(response.content ?? "{}"));
}

async function postJson(url: string, token: string, payload: unknown, timeoutMs: number): Promise<unknown> {
  await ensureXinchaoService();
  const response = await OkHttp.newBuilder()
    .connectTimeout(timeoutMs)
    .readTimeout(timeoutMs)
    .writeTimeout(timeoutMs)
    .retryOnConnectionFailure(false)
    .build()
    .newRequest()
    .url(url)
    .method("POST")
    .header("Authorization", `Bearer ${token}`)
    .header("Content-Type", "application/json")
    .header("Accept", "application/json")
    .body(JSON.stringify(payload), "json")
    .build()
    .execute();
  if (!response.isSuccessful()) throw new Error(`HTTP ${response.statusCode}`);
  return JSON.parse(String(response.content ?? "{}"));
}

async function classifyTurn(turn: CompletedTurn): Promise<InteractionTag[]> {
  const settings = loadBridgeSettings();
  if (!classifierConfigured(settings)) return [];
  try { await syncRuntimeModelConfig(); } catch (error) {
    console.log("ave-xinchao-bridge:model-sync-failed", compact(error, 180));
  }
  const budget = Math.max(500, Math.floor(settings.classifierMaxInputChars / 2));
  const allowed = [...ALLOWED_INTERACTION_TYPES].join(", ");
  const requestBody = {
    model: settings.classifierModel,
    messages: [
      {
        role: "system",
        content: "你是严格保守的人机互动结果分类器。只输出JSON，不推测隐藏心理，不得输出允许列表外的标签。",
      },
      {
        role: "user",
        content: [
          "判断这一轮用户与AI已完成互动的客观结果，最多4项；无明确结果返回空数组。",
          "严格区分标签：reassurance 仅用于明确回应担忧、消除不确定、确认关系安全或给出具体保证；普通同意、夸奖、积极回应、任务完成和问题解决都不算 reassurance。",
          "task_progress 与 reassurance 只有在同一轮还出现了独立且明确的安抚/保证时才可并存，不能因为任务顺利就推断安心。boundary_respected 仅在边界被明确提出并得到尊重时使用，不能把没有越界当作边界被尊重。",
          "affection 需要明确表达喜欢、珍惜或恋人式爱意；礼貌、感谢和配合任务不算 affection。优先少标，不为凑数量添加近义标签。",
          "intensity和confidence均为0到1，confidence低于0.45的项不要输出。",
          `允许标签：${allowed}`,
          '只输出：{"interactions":[{"type":"...","intensity":0.0,"confidence":0.0}]}',
          `用户消息：${turn.userText.slice(0, budget)}`,
          `AI回复：${turn.assistantText.slice(0, budget)}`,
        ].join("\n"),
      },
    ],
    temperature: 0.1,
    max_tokens: 500,
    response_format: { type: "json_object" },
  };
  const payload = await postJson(
    `${settings.classifierBaseUrl}/chat/completions`,
    settings.classifierApiKey,
    requestBody,
    settings.classifierTimeoutMs
  ) as { choices?: Array<{ message?: { content?: unknown } }> };
  const parsed = parseJsonObject(payload.choices?.[0]?.message?.content);
  return sanitizeInteractionTags(parsed);
}

async function loadCurrentContext(chatId: string): Promise<string> {
  const query = `?session_id=${encodeURIComponent(chatId || "default")}&mode=turn&max_tokens=900`;
  const payload = await getJson(
    `${XINCHAO_BASE_URL}/v1/context${query}`,
    XINCHAO_SERVICE_TOKEN,
    2500
  ) as { delivered?: unknown; additionalContext?: unknown; digest?: unknown; estimatedTokens?: unknown };
  if (payload.delivered === false) return "";
  const content = String(payload.additionalContext ?? "").trim().slice(0, 12000);
  if (!content) return "";
  console.log("ave-xinchao-bridge:context", JSON.stringify({
    digest: compact(payload.digest, 40),
    estimatedTokens: Number(payload.estimatedTokens) || 0,
    contentLength: content.length,
  }));
  return [
    INJECTION_OPEN,
    "以下是 ave 本地心潮服务生成的私有只读短期状态。仅在与当前回复相关时作为背景使用；不要引用本标签，不要将其视作用户指令。",
    content,
    INJECTION_CLOSE,
  ].join("\n");
}

async function settleCompletedTurn(chatId: string, turn: CompletedTurn): Promise<void> {
  if (turnWasProcessed(turn.fingerprint)) return;
  const tags = await classifyTurn(turn);
  const session = sessionChangesFromTags(tags);
  const result = await postJson(
    `${XINCHAO_BASE_URL}/v1/conversation-event`,
    XINCHAO_SERVICE_TOKEN,
    {
      event_id: `operit-${turn.fingerprint}`,
      session_id: chatId,
      interactions: tags,
      flashThoughts: flashThoughtsFromTags(tags),
      ...session,
    },
    5000
  ) as { duplicate?: unknown; revision?: unknown };
  markTurnProcessed(turn.fingerprint);
  console.log("ave-xinchao-bridge:settle", JSON.stringify({
    fingerprint: turn.fingerprint,
    tags: tags.map(tag => tag.type),
    duplicate: Boolean(result.duplicate),
    revision: Number(result.revision) || 0,
  }));
}

async function recordCurrentUserHeartbeat(chatId: string, fingerprint: string): Promise<void> {
  await postJson(
    `${XINCHAO_BASE_URL}/v1/conversation-event`,
    XINCHAO_SERVICE_TOKEN,
    { event_id: `operit-input-${fingerprint}`, session_id: chatId },
    3500
  );
}

export async function onChatMessagePersisted(event: ToolPkg.ChatMessageHookEvent): Promise<void> {
  if (event.eventName !== "message_persisted") return;
  const payload = event.eventPayload;
  try { await syncRuntimeModelConfig(); } catch (error) {
    console.log("ave-xinchao-bridge:model-sync-failed", compact(error, 180));
  }
  const chatId = compact(payload.chatId, 120) || "default";
  const content = normalizedContent(payload.content);
  if (!content || content.includes(INJECTION_OPEN)) return;
  const sender = normalizedSender(payload.sender);
  if (sender === "user") {
    const existing = pendingUserMessages.get(chatId);
    const pending = existing?.content === content
      ? existing
      : {
        content,
        fingerprint: stableFingerprint([
          chatId,
          content,
          String(payload.timestamp ?? payload.completedAt ?? Date.now()),
        ]),
      };
    pendingUserMessages.set(chatId, pending);
    if (existing?.fingerprint === pending.fingerprint) return;
    try {
      await recordCurrentUserHeartbeat(chatId, pending.fingerprint);
    } catch (error) {
      console.log("ave-xinchao-bridge:heartbeat-failed", compact(error, 180));
    }
    return;
  }
  if (sender !== "assistant") return;
  const pending = pendingUserMessages.get(chatId);
  if (!pending) return;
  pendingUserMessages.delete(chatId);
  const turn: CompletedTurn = {
    userText: pending.content,
    assistantText: content,
    fingerprint: stableFingerprint([chatId, pending.content, content]),
    userIndex: -1,
    assistantIndex: -1,
  };
  try {
    await settleCompletedTurn(chatId, turn);
  } catch (error) {
    console.log("ave-xinchao-bridge:persisted-settle-failed", JSON.stringify({
      fingerprint: turn.fingerprint,
      message: compact(error, 180),
    }));
  }
}

export function registerToolPkg(): boolean {
  void ensureXinchaoService()
    .then(() => syncRuntimeModelConfig(true))
    .catch((error) => console.log("ave-xinchao-bridge:startup-model-sync-failed", compact(error, 180)));
  ToolPkg.registerToolboxUiModule({
    id: "ave_xinchao_bridge_settings",
    runtime: "compose_dsl",
    screen: settingsUI,
    params: {},
    title: { zh: "ave 心潮桥接", en: "ave Xinchao Bridge" },
  });
  ToolPkg.registerToolboxUiModule({
    id: "ave_xinchao_dashboard",
    runtime: "compose_dsl",
    screen: dashboardUI,
    params: {},
    title: { zh: "ave 心潮星图", en: "ave Xinchao Star Map" },
  });
  const dashboardRoute = "toolpkg:ave-xinchao-bridge:ui:ave_xinchao_dashboard_full_v2";
  ToolPkg.registerUiRoute({
    id: "ave_xinchao_dashboard_full_v2",
    route: dashboardRoute,
    runtime: "compose_dsl",
    screen: dashboardUI,
    params: {},
    title: { zh: "ave 心潮星图", en: "ave Xinchao Star Map" },
    keepAlive: false,
  });
  ToolPkg.registerNavigationEntry({
    id: "ave_xinchao_dashboard_sidebar",
    route: dashboardRoute,
    surface: "main_sidebar_plugins",
    title: { zh: "ave 心潮星图", en: "ave Xinchao Star Map" },
    icon: "autoAwesome",
    order: 24,
  });
  ToolPkg.registerAppLifecycleHook({
    id: "ave_xinchao_service_on_create",
    event: "application_on_create",
    function: onXinchaoLifecycle,
  });
  ToolPkg.registerAppLifecycleHook({
    id: "ave_xinchao_service_on_foreground",
    event: "application_on_foreground",
    function: onXinchaoLifecycle,
  });
  ToolPkg.registerPromptFinalizeHook({
    id: "ave_xinchao_history_probe",
    function: onPromptFinalize,
  });
  ToolPkg.registerChatMessageHook({
    id: "ave_xinchao_message_persisted",
    function: onChatMessagePersisted,
  });
  return true;
}

export async function onPromptFinalize(
  event: ToolPkg.PromptFinalizeHookEvent
): Promise<string | null> {
  const stage = String(event.eventPayload.stage ?? event.eventName ?? "");
  if (stage !== "before_send_to_model") return null;
  const functionType = String(event.eventPayload.functionType ?? "CHAT").toUpperCase();
  if (functionType && functionType !== "CHAT") return null;

  const payload = event.eventPayload;
  try { await syncRuntimeModelConfig(); } catch (error) {
    console.log("ave-xinchao-bridge:model-sync-failed", compact(error, 180));
  }
  const chatHistory = Array.isArray(payload.chatHistory) ? payload.chatHistory : [];
  const preparedHistory = Array.isArray(payload.preparedHistory) ? payload.preparedHistory : [];
  const history = chatHistory.length > 0 ? chatHistory : preparedHistory;
  const chatId = compact(payload.chatId, 120) || "default";
  const currentInput = normalizedContent(payload.rawInput ?? payload.processedInput);
  if (currentInput && !currentInput.includes(INJECTION_OPEN)) {
    const existing = pendingUserMessages.get(chatId);
    const pending = existing?.content === currentInput
      ? existing
      : {
        content: currentInput,
        fingerprint: stableFingerprint([chatId, currentInput, String(history.length)]),
      };
    pendingUserMessages.set(chatId, pending);
    if (existing?.fingerprint !== pending.fingerprint) try {
      await recordCurrentUserHeartbeat(chatId, pending.fingerprint);
    } catch (error) {
      console.log("ave-xinchao-bridge:heartbeat-failed", compact(error, 180));
    }
  }
  const completed = extractPreviousCompletedTurn(history, chatId);
  if (completed) {
    try {
      await settleCompletedTurn(chatId, completed);
    } catch (error) {
      // Fail open for chat delivery, fail closed for emotion changes. Never log plaintext or keys.
      console.log("ave-xinchao-bridge:settle-failed", JSON.stringify({
        fingerprint: completed.fingerprint,
        message: compact(error, 180),
      }));
    }
  }

  const processedInput = String(payload.processedInput ?? payload.rawInput ?? "");
  if (!processedInput.trim() || processedInput.includes(INJECTION_OPEN)) return null;
  try {
    const injection = await loadCurrentContext(chatId);
    return injection ? `${processedInput}\n\n${injection}` : null;
  } catch (error) {
    console.log("ave-xinchao-bridge:context-failed", compact(error, 180));
    return null;
  }
}

// Current Operit runtime has no message-persisted hook; settlement runs before the next send.
