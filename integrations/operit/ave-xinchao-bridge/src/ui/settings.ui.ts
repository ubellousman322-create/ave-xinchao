import type { ComposeDslContext, ComposeNode } from "../../../types/compose-dsl";
import { loadBridgeSettings, saveBridgeSettings } from "../settings";

function state<T>(ctx: ComposeDslContext, key: string, initial: T) {
  const pair = ctx.useState<T>(key, initial);
  return { value: pair[0], set: pair[1] };
}

function field(
  ctx: ComposeDslContext,
  label: string,
  value: string,
  onValueChange: (value: string) => void,
  options: { placeholder?: string; password?: boolean; enabled?: boolean } = {}
): ComposeNode {
  return ctx.UI.TextField({
    label,
    value,
    placeholder: options.placeholder ?? "",
    onValueChange,
    singleLine: true,
    isPassword: options.password ?? false,
    enabled: options.enabled ?? true,
  });
}

export default function Screen(ctx: ComposeDslContext): ComposeNode {
  const initial = loadBridgeSettings();
  const enabled = state(ctx, "classifierEnabled", initial.classifierEnabled);
  const baseUrl = state(ctx, "classifierBaseUrl", initial.classifierBaseUrl);
  const apiKey = state(ctx, "classifierApiKey", initial.classifierApiKey);
  const model = state(ctx, "classifierModel", initial.classifierModel);
  const timeout = state(ctx, "classifierTimeoutMs", String(initial.classifierTimeoutMs));
  const maxInput = state(ctx, "classifierMaxInputChars", String(initial.classifierMaxInputChars));
  const status = state(ctx, "saveStatus", "");

  const save = () => {
    const saved = saveBridgeSettings({
      classifierEnabled: enabled.value,
      classifierBaseUrl: baseUrl.value,
      classifierApiKey: apiKey.value,
      classifierModel: model.value,
      classifierTimeoutMs: Number(timeout.value),
      classifierMaxInputChars: Number(maxInput.value),
    });
    timeout.set(String(saved.classifierTimeoutMs));
    maxInput.set(String(saved.classifierMaxInputChars));
    const complete = Boolean(saved.classifierBaseUrl && saved.classifierApiKey && saved.classifierModel);
    status.set(complete ? "已保存，分类器配置完整。" : "已保存，但接口地址、API Key 或模型名尚未填完整。");
    void ctx.showToast("ave 心潮分类器设置已保存");
  };

  return ctx.UI.LazyColumn(
    { fillMaxSize: true, padding: 16, spacing: 14 },
    [
      ctx.UI.Text({ text: "ave 心潮桥接", style: "headlineSmall", fontWeight: "bold" }),
      ctx.UI.Text({
        text: "这里填写互动分类模型。API Key 使用密码框，并保存在 Operit 包内私有配置中，不会写入聊天、仓库或心潮状态。",
        style: "bodyMedium",
        color: "onSurfaceVariant",
      }),
      ctx.UI.Surface(
        { fillMaxWidth: true, shape: { cornerRadius: 10 }, containerColor: "surfaceVariant", alpha: 0.42 },
        [ctx.UI.Row(
          { fillMaxWidth: true, padding: 14, verticalAlignment: "center", horizontalArrangement: "spaceBetween" },
          [
            ctx.UI.Column({ weight: 1, spacing: 3 }, [
              ctx.UI.Text({ text: "启用语义分类器", style: "titleMedium" }),
              ctx.UI.Text({ text: "关闭时不会发送聊天内容，也不会调用模型。", style: "bodySmall", color: "onSurfaceVariant" }),
            ]),
            ctx.UI.Switch({ checked: enabled.value, onCheckedChange: enabled.set }),
          ]
        )]
      ),
      field(ctx, "OpenAI 兼容接口地址", baseUrl.value, baseUrl.set, {
        placeholder: "https://example.com/v1",
        enabled: enabled.value,
      }),
      field(ctx, "API Key", apiKey.value, apiKey.set, {
        placeholder: apiKey.value ? "已填写" : "sk-...",
        password: true,
        enabled: enabled.value,
      }),
      field(ctx, "模型名", model.value, model.set, {
        placeholder: "gemini-flash / gpt-4o-mini / ...",
        enabled: enabled.value,
      }),
      field(ctx, "超时（毫秒）", timeout.value, timeout.set, { enabled: enabled.value }),
      field(ctx, "每轮最大输入字符数", maxInput.value, maxInput.set, { enabled: enabled.value }),
      ctx.UI.Text({
        text: "模型只接收上一轮用户消息与最终 AI 回复，返回最多 4 个结构化标签。低置信度、非法标签和越界数值会被丢弃；模型不能直接修改任何情绪值。",
        style: "bodySmall",
        color: "onSurfaceVariant",
      }),
      ctx.UI.Button({ text: "保存设置", fillMaxWidth: true, onClick: save }),
      status.value ? ctx.UI.Text({ text: status.value, style: "bodyMedium", color: "primary" }) : ctx.UI.Spacer({ height: 1 }),
    ]
  );
}