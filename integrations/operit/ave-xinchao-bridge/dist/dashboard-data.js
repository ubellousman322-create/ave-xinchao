"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMOTION_COLORS = exports.INTERACTION_LABELS = exports.DIMENSIONS = void 0;
exports.dominantEmotion = dominantEmotion;
exports.loadDashboardSnapshot = loadDashboardSnapshot;
const XINCHAO_BASE_URL = "http://127.0.0.1:18111";
const XINCHAO_SERVICE_TOKEN = "__AVE_XINCHAO_SERVICE_TOKEN__";
const XINCHAO_SERVICE_TOKEN_PLACEHOLDER = ["__AVE_XINCHAO_", "SERVICE_TOKEN__"].join("");
const xinchao_service_1 = require("./xinchao-service");
exports.DIMENSIONS = [
    { key: "possess", label: "想她、占有与靠近", shortLabel: "想她与靠近", group: "relationship" },
    { key: "monitor", label: "惦记她、想知道她在做什么", shortLabel: "惦记她", group: "relationship" },
    { key: "crave", label: "馋她、想黏着她", shortLabel: "想黏着她", group: "relationship" },
    { key: "share", label: "想分享自己的发现和感受", shortLabel: "想分享", group: "relationship" },
    { key: "libido", label: "性欲和身体上的渴望", shortLabel: "身体渴望", group: "relationship" },
    { key: "curiosity", label: "好奇、想探索新东西", shortLabel: "好奇探索", group: "autonomous" },
    { key: "boredom", label: "无聊、想找点事情做", shortLabel: "寻找新鲜", group: "autonomous" },
    { key: "social", label: "想聊天、想接触热闹", shortLabel: "想聊天", group: "autonomous" },
    { key: "duty", label: "责任感、想把未完成的事推进", shortLabel: "推进事情", group: "autonomous" },
    { key: "reflection", label: "想沉淀、整理和理解自己", shortLabel: "沉淀整理", group: "autonomous" },
    { key: "grieve", label: "难过与失落", shortLabel: "难过失落", group: "negative" },
    { key: "anger", label: "生气与不满", shortLabel: "生气不满", group: "negative" },
    { key: "anxiety", label: "焦虑、担忧与害怕", shortLabel: "焦虑担忧", group: "negative" },
    { key: "hurt", label: "受伤与委屈", shortLabel: "受伤委屈", group: "negative" },
    { key: "loneliness", label: "孤独与被冷落感", shortLabel: "孤独冷落", group: "negative" },
    { key: "jealousy", label: "吃醋与嫉妒", shortLabel: "吃醋嫉妒", group: "negative" },
    { key: "shame", label: "羞耻与尴尬", shortLabel: "羞耻尴尬", group: "negative" },
    { key: "security", label: "安心与信任", shortLabel: "安心信任", group: "positive" },
];
exports.INTERACTION_LABELS = {
    companionship: "陪伴",
    affection: "表达喜欢",
    intimacy: "亲密靠近",
    sharing: "分享",
    discovery: "共同发现",
    task_progress: "任务推进",
    reflection: "反思整理",
    conflict: "冲突",
    loss: "失落",
    reconciliation: "和解",
    ignored: "被忽视",
    rejection: "拒绝",
    uncertainty: "不确定",
    reassurance: "确认安心",
    boundary_respected: "边界被尊重",
    boundary_violation: "边界受侵犯",
    comparison: "比较",
    embarrassment: "尴尬",
    exclusion: "被排除",
};
exports.EMOTION_COLORS = {
    security: "#56FFD8",
    grieve: "#6EA8FF",
    anger: "#FF4F87",
    anxiety: "#B56CFF",
    hurt: "#7F8CFF",
    loneliness: "#4ED8FF",
    jealousy: "#FF62D0",
    shame: "#D68CFF",
};
const EMOTION_BASELINES = {
    grieve: 0.03,
    anger: 0.02,
    anxiety: 0.03,
    hurt: 0.02,
    loneliness: 0.03,
    jealousy: 0.01,
    shame: 0.01,
    security: 0.15,
};
async function getJson(path) {
    const token = XINCHAO_SERVICE_TOKEN.trim();
    if (!token || token === XINCHAO_SERVICE_TOKEN_PLACEHOLDER) {
        throw new Error("心潮服务令牌尚未注入");
    }
    await (0, xinchao_service_1.ensureXinchaoService)();
    const execute = async () => OkHttp.newBuilder()
        .connectTimeout(2500)
        .readTimeout(2500)
        .writeTimeout(2500)
        .retryOnConnectionFailure(false)
        .build()
        .newRequest()
        .url(`${XINCHAO_BASE_URL}${path}`)
        .method("GET")
        .header("Authorization", `Bearer ${token}`)
        .header("Accept", "application/json")
        .build()
        .execute();
    let response;
    try {
        response = await execute();
    }
    catch {
        await (0, xinchao_service_1.ensureXinchaoService)(true);
        response = await execute();
    }
    if (!response.isSuccessful())
        throw new Error(`心潮服务返回 HTTP ${response.statusCode}`);
    return JSON.parse(String(response.content ?? "{}"));
}
function activeSessionId(state) {
    const overlays = Object.values(state.sessionOverlays ?? {})
        .filter(item => item && item.sessionId)
        .sort((left, right) => Date.parse(right.updatedAt ?? right.lastConversationAt ?? "")
        - Date.parse(left.updatedAt ?? left.lastConversationAt ?? ""));
    if (overlays[0]?.sessionId)
        return String(overlays[0].sessionId);
    const events = [...(state.recentConversationEvents ?? [])].reverse();
    return String(events.find(event => event.sessionId)?.sessionId ?? "default");
}
function recentTrajectory(state, sessionId, nowMs) {
    const cutoff = nowMs - 15 * 60000;
    return (state.recentConversationEvents ?? [])
        .filter(event => {
        const at = Date.parse(event.processedAt ?? "");
        return event.sessionId === sessionId && Number.isFinite(at) && at >= cutoff && at <= nowMs;
    })
        .slice(-8)
        .map(event => ({
        at: String(event.processedAt ?? ""),
        types: (event.interactionTypes ?? [event.interactionType ?? ""])
            .map(String)
            .filter(type => Boolean(exports.INTERACTION_LABELS[type]))
            .slice(0, 4),
    }))
        .filter(event => event.types.length > 0);
}
function aggregateRecentChanges(state, nowMs) {
    const cutoff = nowMs - 6 * 3600000;
    const totals = {};
    for (const event of state.recentDriveChanges ?? []) {
        const at = Date.parse(event.at ?? "");
        if (!Number.isFinite(at) || at < cutoff || at > nowMs)
            continue;
        for (const [key, value] of Object.entries(event.deltas ?? {})) {
            totals[key] = Number(((totals[key] ?? 0) + Number(value)).toFixed(4));
        }
    }
    return totals;
}
function dominantEmotion(snapshot) {
    const drives = snapshot.state.drives ?? {};
    const emotions = snapshot.state.emotions ?? {};
    const candidates = Object.keys(EMOTION_BASELINES).map(key => {
        const value = Number(drives[key] ?? 0);
        const layer = emotions[key] ?? { mood: 0, pulse: 0 };
        const departure = Math.max(0, value - EMOTION_BASELINES[key]);
        return { key, value, mood: Number(layer.mood ?? 0), pulse: Number(layer.pulse ?? 0), score: departure };
    }).sort((left, right) => right.score - left.score);
    const selected = candidates[0] ?? { key: "security", value: 0.5, mood: 0, pulse: 0, score: 0 };
    const dimension = exports.DIMENSIONS.find(item => item.key === selected.key);
    return {
        key: selected.key,
        label: dimension?.label ?? selected.key,
        color: exports.EMOTION_COLORS[selected.key] ?? "#62F6FF",
        value: selected.value,
        mood: selected.mood,
        pulse: selected.pulse,
    };
}
async function loadDashboardSnapshot() {
    const [state, intentPayload] = await Promise.all([
        getJson("/v1/state"),
        getJson("/v1/intent"),
    ]);
    const nowMs = Date.now();
    const sessionId = activeSessionId(state);
    return {
        state,
        intent: intentPayload.intent ?? intentPayload.intents?.[0] ?? null,
        intents: Array.isArray(intentPayload.intents)
            ? intentPayload.intents.slice(0, 3)
            : (intentPayload.intent ? [intentPayload.intent] : []),
        activeSessionId: sessionId,
        trajectory: recentTrajectory(state, sessionId, nowMs),
        recentChanges: aggregateRecentChanges(state, nowMs),
        loadedAt: new Date(nowMs).toISOString(),
    };
}
