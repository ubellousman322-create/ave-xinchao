"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureXinchaoService = ensureXinchaoService;
exports.onXinchaoLifecycle = onXinchaoLifecycle;
const runtime_model_sync_js_1 = require("./runtime-model-sync.js");
let ensurePromise = null;
let lastHealthyAt = 0;
const ENSURE_COMMAND = [
    "cd /root/ave-xinchao || exit 21",
    "mkdir -p run state",
    "if timeout 1 bash -lc '</dev/tcp/127.0.0.1/18111' 2>/dev/null; then echo online; exit 0; fi",
    "nohup bash -lc 'cd /root/ave-xinchao && set -a && source .env && set +a && exec node src/server.js' >> run/server-18111.log 2>&1 </dev/null &",
    "echo $! > run/server.pid",
    "for i in $(seq 1 30); do",
    "  if timeout 1 bash -lc '</dev/tcp/127.0.0.1/18111' 2>/dev/null; then echo started; exit 0; fi",
    "  sleep 0.1",
    "done",
    "echo startup-timeout >&2",
    "exit 22",
].join("\n");
async function ensureXinchaoService(force = false) {
    if (!force && Date.now() - lastHealthyAt < 30000)
        return;
    if (ensurePromise)
        return ensurePromise;
    ensurePromise = (async () => {
        const result = await Tools.System.terminal.hiddenExec(ENSURE_COMMAND, {
            executorKey: "ave_xinchao_service",
            timeoutMs: 7000,
        });
        if (result.timedOut || Number(result.exitCode) !== 0) {
            throw new Error(`心潮服务启动失败（${Number(result.exitCode)}）`);
        }
        lastHealthyAt = Date.now();
    })();
    try {
        await ensurePromise;
    }
    finally {
        ensurePromise = null;
    }
}
async function onXinchaoLifecycle(event) {
    if (event.eventName !== "application_on_create" && event.eventName !== "application_on_foreground") {
        return null;
    }
    try {
        await ensureXinchaoService(true);
        await (0, runtime_model_sync_js_1.syncRuntimeModelConfig)(true);
        console.log("ave-xinchao-bridge:service", JSON.stringify({ event: event.eventName, online: true, modelSynced: true }));
    }
    catch (error) {
        console.log("ave-xinchao-bridge:service-failed", String(error).slice(0, 180));
    }
    return null;
}
