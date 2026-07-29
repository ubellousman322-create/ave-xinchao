export interface BridgeSettings {
  classifierEnabled: boolean;
  classifierBaseUrl: string;
  classifierApiKey: string;
  classifierModel: string;
  classifierTimeoutMs: number;
  classifierMaxInputChars: number;
}

const PREFS_NAME = "ave_xinchao_bridge_private_settings";
const SETTINGS_KEY = "classifier_v1";

export const DEFAULT_SETTINGS: BridgeSettings = {
  classifierEnabled: false,
  classifierBaseUrl: "",
  classifierApiKey: "",
  classifierModel: "",
  classifierTimeoutMs: 12000,
  classifierMaxInputChars: 12000,
};

function text(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function number(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function sanitize(input: Partial<BridgeSettings> | null | undefined): BridgeSettings {
  return {
    classifierEnabled: Boolean(input?.classifierEnabled),
    classifierBaseUrl: text(input?.classifierBaseUrl, 500).replace(/\/+$/, ""),
    classifierApiKey: text(input?.classifierApiKey, 1000),
    classifierModel: text(input?.classifierModel, 200),
    classifierTimeoutMs: number(input?.classifierTimeoutMs, 12000, 1000, 60000),
    classifierMaxInputChars: number(input?.classifierMaxInputChars, 12000, 1000, 24000),
  };
}

function prefs() {
  const context = Java.getApplicationContext();
  if (!context) throw new Error("application context unavailable");
  return context.getSharedPreferences(PREFS_NAME, 0);
}

export function loadBridgeSettings(): BridgeSettings {
  try {
    const raw = String(prefs().getString(SETTINGS_KEY, "") || "").trim();
    return raw ? sanitize(JSON.parse(raw) as Partial<BridgeSettings>) : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveBridgeSettings(input: Partial<BridgeSettings>): BridgeSettings {
  const next = sanitize({ ...loadBridgeSettings(), ...input });
  prefs().edit().putString(SETTINGS_KEY, JSON.stringify(next)).apply();
  return next;
}

export function classifierConfigured(settings = loadBridgeSettings()): boolean {
  return Boolean(
    settings.classifierEnabled &&
    settings.classifierBaseUrl &&
    settings.classifierApiKey &&
    settings.classifierModel
  );
}

const PROCESSED_KEY = "processed_turns_v1";

export function processedTurnFingerprints(): string[] {
  try {
    const raw = String(prefs().getString(PROCESSED_KEY, "") || "").trim();
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean).slice(-128) : [];
  } catch {
    return [];
  }
}

export function turnWasProcessed(fingerprint: string): boolean {
  return processedTurnFingerprints().includes(String(fingerprint));
}

export function markTurnProcessed(fingerprint: string): void {
  const value = String(fingerprint).trim();
  if (!value) return;
  const next = [...processedTurnFingerprints().filter(item => item !== value), value].slice(-128);
  prefs().edit().putString(PROCESSED_KEY, JSON.stringify(next)).apply();
}
