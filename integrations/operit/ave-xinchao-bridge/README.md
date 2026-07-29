# Operit：ave 心潮桥接

该 ToolPkg 在 Operit 每次发送聊天前执行两步：

1. 提取上一轮已完成的用户消息与最终 AI 回复，调用用户在私有配置页填写的 OpenAI-compatible 分类模型；
2. 将清洗后的结构化互动标签幂等提交给心潮，再从 `/v1/context?mode=turn` 读取当前状态并注入本轮。

它不会把 API Key 写入聊天、源码、心潮状态或日志。桥接日志仅记录不透明轮次指纹、标签、Context digest、长度和 revision。

## 安装前准备

- Operit ToolPkg 开发环境；
- 本机运行的心潮服务；
- 一个单独生成的 `SERVICE_TOKEN`；
- 可选的 OpenAI-compatible 分类接口（推荐低温度普通对话模型，不需要推理模型）。

## 构建与令牌注入

源码中的 `__AVE_XINCHAO_SERVICE_TOKEN__` 必须保持为占位符并提交到 Git。编译后，只在本机构建产物 `dist/main.js` 中替换它：

```bash
npx tsc -p tsconfig.json
python3 - <<'PY'
from pathlib import Path
import os
p = Path('dist/main.js')
token = os.environ['XINCHAO_SERVICE_TOKEN']
text = p.read_text()
marker = '__AVE_XINCHAO_SERVICE_TOKEN__'
if marker not in text:
    raise SystemExit('service token placeholder missing')
p.write_text(text.replace(marker, token))
PY
```

不要提交完成令牌注入后的 `dist/main.js`。当前公开目录中的构建产物仍保留占位符，只用于复现与审阅。

## 分类器配置

安装并启用 ToolPkg 后，在工具箱打开“ave 心潮桥接”：

- 启用语义分类器；
- 填写 OpenAI-compatible `/v1` 地址；
- 在密码框填写 API Key；
- 填写模型名、超时和最大输入字符数。

配置保存在 Operit 包内的 `SharedPreferences`：`ave_xinchao_bridge_private_settings`。

## 状态与轨迹

- 每轮互动即时结算，不等待 15 分钟批处理；
- 心潮会先补算自上次更新时间以来的自然增长与衰减，再应用本轮标签；
- Context 同时输出累计状态与当前 `session_id` 最近 15 分钟、最多 8 轮的标签轨迹；
- 轨迹不保存聊天正文，超时后退出轨迹，但已经形成的持续状态仍保留；
- 分类、结算或 Context 读取失败均 fail-open，不阻塞聊天发送，也不会在失败时擅自修改状态。
