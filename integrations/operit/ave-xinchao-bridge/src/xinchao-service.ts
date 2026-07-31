import { syncRuntimeModelConfig } from "./runtime-model-sync.js";
let ensurePromise: Promise<void> | null = null;
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

export async function ensureXinchaoService(force = false): Promise<void> {
  if (!force && Date.now() - lastHealthyAt < 30_000) return;
  if (ensurePromise) return ensurePromise;
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
  } finally {
    ensurePromise = null;
  }
}

export async function onXinchaoLifecycle(
  event: ToolPkg.AppLifecycleHookEvent
): Promise<null> {
  if (event.eventName !== "application_on_create" && event.eventName !== "application_on_foreground") {
    return null;
  }
  try {
    await ensureXinchaoService(true);
    await syncRuntimeModelConfig(true);
    console.log("ave-xinchao-bridge:service", JSON.stringify({ event: event.eventName, online: true, modelSynced: true }));
  } catch (error) {
    console.log("ave-xinchao-bridge:service-failed", String(error).slice(0, 180));
  }
  return null;
}