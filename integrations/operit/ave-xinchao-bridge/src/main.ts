import settingsUI from "./ui/settings.ui.js";
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
  if (tags.length === 0) {
    markTurnProcessed(turn.fingerprint);
    console.log("ave-xinchao-bridge:settle", JSON.stringify({ fingerprint: turn.fingerprint, tags: 0, applied: false }));
    return;
  }
  const result = await postJson(
    `${XINCHAO_BASE_URL}/v1/conversation-event`,
    XINCHAO_SERVICE_TOKEN,
    {
      event_id: `operit-${turn.fingerprint}`,
      session_id: chatId,
      interactions: tags,
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

export function registerToolPkg(): boolean {
  ToolPkg.registerToolboxUiModule({
    id: "ave_xinchao_bridge_settings",
    runtime: "compose_dsl",
    screen: settingsUI,
    params: {},
    title: { zh: "ave 心潮桥接", en: "ave Xinchao Bridge" },
  });
  ToolPkg.registerPromptFinalizeHook({
    id: "ave_xinchao_history_probe",
    function: onPromptFinalize,
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
  const chatHistory = Array.isArray(payload.chatHistory) ? payload.chatHistory : [];
  const preparedHistory = Array.isArray(payload.preparedHistory) ? payload.preparedHistory : [];
  const history = chatHistory.length > 0 ? chatHistory : preparedHistory;
  const chatId = compact(payload.chatId, 120) || "default";
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
