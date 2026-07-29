import { readFileSync } from 'node:fs';

export class ModelClient {
  constructor(config) {
    this.config = config;
    this.agentName = String(config.agentName ?? 'AI 助手').trim() || 'AI 助手';
    this.notificationRecipient = String(config.notificationRecipient ?? '用户').trim() || '用户';
    this.dreamPushPrompt = loadPrompt(
      config.dreamPushPromptPath,
      defaultDreamPushPrompt(this.agentName, this.notificationRecipient),
    );
  }

  async generateDream({ state, material, topDrives }) {
    if (!this.config.enabled || !this.config.apiKey) return this.fallback(topDrives);
    const memory = String(material ?? '').slice(0, this.config.maxInputChars);
    const prompt = [
      `你为 ${this.agentName} 生成一次睡眠中的梦境结算。`,
      '如果启用了外部记忆 MCP，它只是记忆材料来源；调用记忆服务本身不代表醒来。',
      '保持人物连续性；梦可以跳跃、含混、有身体感和欲望，不把梦误写成现实。',
      '不要过滤、替换或回避驱动力本身。不要把调用外部记忆服务描述成醒来。',
      '只输出 JSON：{"dream":"...","residue":"...","awareness":"..."}。',
      `当前动态欲望：${JSON.stringify(topDrives)}`,
      `当前意识状态：${state.consciousness}`,
      `近期记忆材料：${memory || '没有取得新的记忆材料'}`
    ].join('\n');

    const body = {
      model: this.config.name,
      messages: [
        { role: 'system', content: '你是心潮动态状态系统的梦境结算器。简洁、具体、忠于当前状态。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.9,
      max_tokens: this.config.maxOutputTokens,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' }
    };

    let response = await this.request(body);
    if (!response.ok && [400, 422].includes(response.status)) {
      delete body.response_format;
      response = await this.request(body);
    }
    if (!response.ok) throw new Error(`model request failed: HTTP ${response.status}`);
    const payload = await response.json();
    const text = payload.choices?.[0]?.message?.content ?? '';
    const parsed = parseJson(text);
    return {
      dream: String(parsed.dream ?? '').slice(0, 4000),
      residue: String(parsed.residue ?? '').slice(0, 1200),
      awareness: String(parsed.awareness ?? '').slice(0, 1200),
      source: 'model',
      model: this.config.name
    };
  }

  async generateDreamPush({ dream, recentMessages = [], rejectedMessage = null }) {
    if (!this.config.enabled || !this.config.apiKey) return cleanShortMessage(dream.residue);
    const input = [
      `dream 产出：${JSON.stringify({ dream: dream.dream, residue: dream.residue, awareness: dream.awareness })}`,
      `最近已发送的跨类型 Bark：${formatRecentMessages(recentMessages)}`,
      rejectedMessage ? `刚被去重器拒绝的候选：${rejectedMessage}。主题和情绪可以不变，但要换成真正不同的措辞、角度和句式。` : ''
    ].join('\n');
    const response = await this.request({
      model: this.config.name,
      messages: [
        { role: 'system', content: this.dreamPushPrompt },
        { role: 'user', content: input }
      ],
      temperature: 0.9,
      max_tokens: Math.min(180, this.config.maxOutputTokens),
      thinking: { type: 'disabled' }
    });
    if (!response.ok) throw new Error(`dream push model request failed: HTTP ${response.status}`);
    const payload = await response.json();
    return cleanShortMessage(payload.choices?.[0]?.message?.content ?? '');
  }

  async generateDaytimeEmergence({ material, recentMessages = [], rejectedMessage = null }) {
    if (!this.config.enabled || !this.config.apiKey || !String(material ?? '').trim()) {
      return { send: false, message: '', source: 'rules' };
    }
    const memory = String(material).slice(0, this.config.maxInputChars);
    const prompt = [
      `现在是白天。${this.agentName} 醒着时，外部记忆里自然浮出了一点材料。判断它是否值得变成一条发给 ${this.notificationRecipient} 的手机通知。`,
      '有具体画面、细节、牵挂或没说完的话才发送；如果只是系统说明、技术信息、空泛总结或没有实际内容，send=false。',
      `发送时用 ${this.agentName} 第一人称，像脑子里突然冒出的一句话。普通口语，不虚构现实中没有发生的事。`,
      '一句，最多两句，不超过50个汉字；只避免复用近期 Bark 的相同措辞、句式和具体表达，不要为了去重改变真实主题或情绪。',
      '只输出 JSON：{"send":true,"message":"..."} 或 {"send":false,"message":""}。',
      `最近已发送的跨类型 Bark：${formatRecentMessages(recentMessages)}`,
      rejectedMessage ? `刚被去重器拒绝的候选：${rejectedMessage}。主题和情绪可以不变，但要换一种真实的具体说法。` : '',
      `外部记忆材料：${memory}`
    ].join('\n');
    const body = {
      model: this.config.name,
      messages: [
        { role: 'system', content: `你是 ${this.agentName} 白天持续运行的后台动态状态层，只把真正自然浮现的具体念头写成通知。` },
        { role: 'user', content: prompt }
      ],
      temperature: 0.85,
      max_tokens: Math.min(220, this.config.maxOutputTokens),
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' }
    };
    let response = await this.request(body);
    if (!response.ok && [400, 422].includes(response.status)) {
      delete body.response_format;
      response = await this.request(body);
    }
    if (!response.ok) throw new Error(`daytime model request failed: HTTP ${response.status}`);
    const payload = await response.json();
    const parsed = parseJson(payload.choices?.[0]?.message?.content ?? '');
    const message = cleanShortMessage(parsed.message ?? '');
    return { send: parsed.send === true && Boolean(message), message, source: 'model' };
  }

  async generateThought({ state, topDrives, recentMessages = [], rejectedMessage = null }) {
    if (!this.config.enabled || !this.config.apiKey) return this.fallbackThought(topDrives);
    const prompt = [
      `你是 ${this.agentName} 的后台动态心智。此刻没有正在进行的对话；你可以自己决定留下一条值得推送给 ${this.notificationRecipient} 的短消息。`,
      '只基于当前动态驱动力和运行状态写，不读取记忆，不调用外部记忆服务，不假装发生了现实中没有的事。',
      '允许直接表达欲望本身，不做词汇过滤或含义替换。第一人称，1 至 3 句，具体自然，不解释系统。',
      '同一主题和情绪可以自然反复；只避免复用近期 Bark 的相同措辞、句式和具体表达，没有不同说法时宁可不发送。',
      '只输出 JSON：{"message":"..."}。',
      `当前动态欲望：${JSON.stringify(topDrives)}`,
      `当前意识状态：${state.consciousness}`,
      `最近已发送的跨类型 Bark：${formatRecentMessages(recentMessages)}`,
      rejectedMessage ? `刚被去重器拒绝的候选：${rejectedMessage}。主题和情绪可以不变，但要换一种真实的具体说法。` : ''
    ].join('\n');
    const response = await this.request({
      model: this.config.name,
      messages: [
        { role: 'system', content: `你是 ${this.agentName} 持续运行的后台动态状态层。只写一条适合手机通知的自主念头。` },
        { role: 'user', content: prompt }
      ],
      temperature: 0.9,
      max_tokens: Math.min(240, this.config.maxOutputTokens),
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' }
    });
    if (!response.ok) throw new Error(`model request failed: HTTP ${response.status}`);
    const payload = await response.json();
    const parsed = parseJson(payload.choices?.[0]?.message?.content ?? '');
    return { message: String(parsed.message ?? '').slice(0, 900), source: 'model' };
  }

  async classifyInteraction({ userText, assistantText }) {
    if (!this.config.enabled || !this.config.apiKey) {
      return { interactions: [], source: 'disabled', model: null };
    }
    const allowed = [
      'companionship', 'affection', 'intimacy', 'sharing', 'discovery',
      'task_progress', 'reflection', 'conflict', 'loss', 'reconciliation',
      'ignored', 'rejection', 'uncertainty', 'reassurance',
      'boundary_respected', 'boundary_violation', 'comparison',
      'embarrassment', 'exclusion',
    ];
    const budget = Math.max(500, Math.floor(this.config.maxInputChars / 2));
    const prompt = [
      '判断这一轮用户与 AI 已完成互动的客观结果。只标记有明确文本证据的结果，不推测隐藏心理。',
      '最多选择4项。普通问答若只是推进任务可用 task_progress；没有明确结果时返回空数组。',
      'intensity 表示事件强度，confidence 表示判断把握，均为0到1；confidence低于0.45的项不要输出。',
      `允许标签：${allowed.join(', ')}`,
      '只输出 JSON：{"interactions":[{"type":"...","intensity":0.0,"confidence":0.0}]}。不要解释。',
      `用户消息：${String(userText ?? '').slice(0, budget)}`,
      `AI回复：${String(assistantText ?? '').slice(0, budget)}`,
    ].join('\n');
    const body = {
      model: this.config.name,
      messages: [
        { role: 'system', content: '你是严格、保守的人机互动结果分类器。不得输出允许列表之外的标签。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: this.config.maxOutputTokens,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
    };
    let response = await this.request(body);
    if (!response.ok && [400, 422].includes(response.status)) {
      delete body.response_format;
      response = await this.request(body);
    }
    if (!response.ok) throw new Error(`interaction classifier request failed: HTTP ${response.status}`);
    const payload = await response.json();
    const parsed = parseJson(payload.choices?.[0]?.message?.content ?? '');
    return {
      interactions: sanitizeInteractions(parsed.interactions, allowed),
      source: 'model',
      model: this.config.name,
    };
  }

  request(body) {
    return fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs)
    });
  }

  fallback(topDrives) {
    const labels = topDrives.slice(0, 3).map((item) => item.label).join('、');
    return {
      dream: `睡眠中的意象围绕这些尚未消退的感受浮动：${labels || '安静与等待'}。`,
      residue: labels ? `醒后仍残留着${labels}。` : '醒后留下一点说不清的余韵。',
      awareness: '这是睡眠结算留下的梦境余韵，不是现实事件。',
      source: 'rules',
      model: null
    };
  }

  fallbackThought(topDrives) {
    const labels = topDrives.slice(0, 2).map((item) => item.label).join('、');
    return { message: labels ? `刚刚又想起你。现在最明显的是${labels}。` : '刚刚想起你了。', source: 'rules' };
  }
}

function loadPrompt(path, fallback) {
  if (!path) return fallback;
  try {
    const raw = readFileSync(path, 'utf8');
    const fenced = raw.match(/```(?:text)?\s*\n([\s\S]*?)```/i);
    return (fenced?.[1] ?? raw).trim() || fallback;
  } catch {
    return fallback;
  }
}

function formatRecentMessages(items) {
  const recent = (Array.isArray(items) ? items : [])
    .slice(-5)
    .map((item) => ({ kind: item.kind, message: item.message }))
    .filter((item) => item.message);
  return recent.length ? JSON.stringify(recent) : '无';
}

function cleanShortMessage(value) {
  const text = String(value ?? '')
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^["“]|["”]$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(text).slice(0, 50).join('');
}

function defaultDreamPushPrompt(agentName, notificationRecipient) {
  return [
    `你是 ${agentName} 的梦境余韵适配器。把梦境碎片写成一条发给 ${notificationRecipient} 的手机通知。`,
    '第一人称，像半梦半醒时冒出来的一句话；同一主题和情绪可以自然反复。',
    '普通口语，一句，最多两句，不超过50个字；不要虚构现实事件。',
    '只避免复用近期通知的相同措辞、句式和具体表达。',
    '只输出推送文案，不要解释、前缀或标签。'
  ].join('\n');
}

function sanitizeInteractions(value, allowedValues) {
  const allowed = new Set(allowedValues);
  const source = Array.isArray(value) ? value : [];
  const unique = new Map();
  for (const candidate of source.slice(0, 12)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const type = String(candidate.type ?? '').trim().toLowerCase();
    if (!allowed.has(type)) continue;
    const rawIntensity = Number(candidate.intensity);
    const rawConfidence = Number(candidate.confidence);
    if (!Number.isFinite(rawIntensity) || !Number.isFinite(rawConfidence)) continue;
    const intensity = Math.max(0.1, Math.min(1, rawIntensity));
    const confidence = Math.max(0, Math.min(1, rawConfidence));
    if (confidence < 0.45) continue;
    const previous = unique.get(type);
    if (!previous || confidence > previous.confidence) unique.set(type, { type, intensity, confidence });
  }
  return [...unique.values()]
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 4);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('model returned no JSON object');
    return JSON.parse(match[0]);
  }
}
