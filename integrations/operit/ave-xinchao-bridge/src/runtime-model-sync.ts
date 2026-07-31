import { classifierConfigured, loadBridgeSettings } from "./settings.js";

const XINCHAO_BASE_URL = "http://127.0.0.1:18111";
const XINCHAO_SERVICE_TOKEN = "__AVE_XINCHAO_SERVICE_TOKEN__";
let syncPromise: Promise<RuntimeModelStatus> | null = null;
let lastSyncedAt = 0;
let lastFingerprint = "";

export interface RuntimeModelStatus {
  configured: boolean;
  source: string;
  model: string | null;
  syncedAt: string | null;
  changed?: boolean;
}

function fingerprint(parts: string[]): string {
  let hash = 0x811c9dc5;
  for (const char of parts.join("\u001f")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export async function syncRuntimeModelConfig(force = false): Promise<RuntimeModelStatus> {
  const settings = loadBridgeSettings();
  const configured = classifierConfigured(settings);
  const currentFingerprint = configured
    ? fingerprint([
      settings.classifierBaseUrl,
      settings.classifierModel,
      settings.classifierApiKey,
      String(settings.classifierTimeoutMs),
      String(settings.classifierMaxInputChars),
    ])
    : "disabled";
  if (!force && currentFingerprint === lastFingerprint && Date.now() - lastSyncedAt < 30_000) {
    return { configured, source: configured ? "bridge" : "disabled", model: configured ? settings.classifierModel : null, syncedAt: null };
  }
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    const payload = configured ? {
      enabled: true,
      base_url: settings.classifierBaseUrl,
      api_key: settings.classifierApiKey,
      model: settings.classifierModel,
      timeout_ms: Math.max(30000, settings.classifierTimeoutMs),
      max_input_chars: settings.classifierMaxInputChars,
      max_output_tokens: 650,
    } : { enabled: false };
    const response = await OkHttp.newBuilder()
      .connectTimeout(5000)
      .readTimeout(8000)
      .writeTimeout(8000)
      .retryOnConnectionFailure(false)
      .build()
      .newRequest()
      .url(`${XINCHAO_BASE_URL}/v1/runtime-model`)
      .method("POST")
      .header("Authorization", `Bearer ${XINCHAO_SERVICE_TOKEN}`)
      .header("Content-Type", "application/json")
      .header("Accept", "application/json")
      .body(JSON.stringify(payload), "json")
      .build()
      .execute();
    if (!response.isSuccessful()) throw new Error(`runtime model sync HTTP ${response.statusCode}`);
    const result = JSON.parse(String(response.content ?? "{}")) as RuntimeModelStatus;
    lastFingerprint = currentFingerprint;
    lastSyncedAt = Date.now();
    console.log("ave-xinchao-bridge:model-sync", JSON.stringify({
      configured: Boolean(result.configured),
      source: String(result.source ?? ""),
      model: String(result.model ?? "").slice(0, 120),
      changed: Boolean(result.changed),
    }));
    return result;
  })();
  try {
    return await syncPromise;
  } finally {
    syncPromise = null;
  }
}