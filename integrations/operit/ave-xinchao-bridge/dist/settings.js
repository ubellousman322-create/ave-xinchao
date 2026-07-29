"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SETTINGS = void 0;
exports.loadBridgeSettings = loadBridgeSettings;
exports.saveBridgeSettings = saveBridgeSettings;
exports.classifierConfigured = classifierConfigured;
exports.processedTurnFingerprints = processedTurnFingerprints;
exports.turnWasProcessed = turnWasProcessed;
exports.markTurnProcessed = markTurnProcessed;
const PREFS_NAME = "ave_xinchao_bridge_private_settings";
const SETTINGS_KEY = "classifier_v1";
exports.DEFAULT_SETTINGS = {
    classifierEnabled: false,
    classifierBaseUrl: "",
    classifierApiKey: "",
    classifierModel: "",
    classifierTimeoutMs: 12000,
    classifierMaxInputChars: 12000,
};
function text(value, maxLength) {
    return String(value ?? "").trim().slice(0, maxLength);
}
function number(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}
function sanitize(input) {
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
    if (!context)
        throw new Error("application context unavailable");
    return context.getSharedPreferences(PREFS_NAME, 0);
}
function loadBridgeSettings() {
    try {
        const raw = String(prefs().getString(SETTINGS_KEY, "") || "").trim();
        return raw ? sanitize(JSON.parse(raw)) : { ...exports.DEFAULT_SETTINGS };
    }
    catch {
        return { ...exports.DEFAULT_SETTINGS };
    }
}
function saveBridgeSettings(input) {
    const next = sanitize({ ...loadBridgeSettings(), ...input });
    prefs().edit().putString(SETTINGS_KEY, JSON.stringify(next)).apply();
    return next;
}
function classifierConfigured(settings = loadBridgeSettings()) {
    return Boolean(settings.classifierEnabled &&
        settings.classifierBaseUrl &&
        settings.classifierApiKey &&
        settings.classifierModel);
}
const PROCESSED_KEY = "processed_turns_v1";
function processedTurnFingerprints() {
    try {
        const raw = String(prefs().getString(PROCESSED_KEY, "") || "").trim();
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.map(String).filter(Boolean).slice(-128) : [];
    }
    catch {
        return [];
    }
}
function turnWasProcessed(fingerprint) {
    return processedTurnFingerprints().includes(String(fingerprint));
}
function markTurnProcessed(fingerprint) {
    const value = String(fingerprint).trim();
    if (!value)
        return;
    const next = [...processedTurnFingerprints().filter(item => item !== value), value].slice(-128);
    prefs().edit().putString(PROCESSED_KEY, JSON.stringify(next)).apply();
}
