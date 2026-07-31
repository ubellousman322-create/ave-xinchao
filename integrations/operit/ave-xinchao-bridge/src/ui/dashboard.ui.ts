import type { ComposeDslContext, ComposeNode } from "../../../types/compose-dsl";
import {
  DashboardSnapshot,
  DIMENSIONS,
  INTERACTION_LABELS,
  dominantEmotion,
  loadDashboardSnapshot,
} from "../dashboard-data";

const BACKGROUND = "#040718";
const DEEP_SPACE = "#020510";
const TEXT = "#D6D9E4";
const MUTED = "#8992AA";
const SOFT = "#AAB4C8";
const STAR = "#B9C5D8";
const LINE = "#344165";
const TRACK = "#293552";
const BAR = "#7182A5";
const ERROR = "#A77A86";
const EMOTION_KEYS = ["security", "grieve", "anger", "anxiety", "hurt", "loneliness", "jealousy", "shame"];
const EMOTION_BASELINES: Record<string, number> = {
  security: 0.15,
  grieve: 0.03,
  anger: 0.02,
  anxiety: 0.03,
  hurt: 0.02,
  loneliness: 0.03,
  jealousy: 0.01,
  shame: 0.01,
};

let backgroundPath = "";

interface StarPoint {
  key: string;
  label: string;
  value: number;
  delta: number;
  x: number;
  y: number;
}

function useValue<T>(ctx: ComposeDslContext, key: string, initial: T) {
  const state = ctx.useState<T>(key, initial);
  return { value: state[0], set: state[1] };
}

function clamp(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function percent(value: unknown): string {
  return `${Math.round(clamp(value) * 100)}%`;
}

function signed(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) < 0.0005) return "-";
  return `${number > 0 ? "+" : ""}${number.toFixed(3)}`;
}

function shortTime(value: string | null | undefined): string {
  const date = new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) return "-";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "'");
}

function shortIntentLabel(label: string | undefined): string {
  const labels: Record<string, string> = {
    "想靠近并建立连接": "靠近与连接",
    "想确认她的近况": "确认近况",
    "想分享自己的发现和感受": "分享发现与感受",
    "想进行身体亲密": "身体亲密",
    "想一起探索新东西": "共同探索",
    "想聊天和接触热闹": "聊天与热闹",
    "想推进未完成的事情": "推进事情",
    "想沉淀并理解自己": "沉淀整理",
  };
  return labels[String(label ?? "")] ?? String(label ?? "");
}

function constellationPoints(snapshot: DashboardSnapshot, group: "relationship" | "autonomous"): StarPoint[] {
  const positions: Array<[number, number]> = [[48, 70], [112, 40], [182, 66], [250, 38], [302, 112]];
  return DIMENSIONS
    .filter(item => item.group === group)
    .map((dimension, index) => ({
      key: dimension.key,
      label: dimension.shortLabel,
      value: clamp(snapshot.state.drives?.[dimension.key] ?? 0),
      delta: Number(snapshot.recentChanges[dimension.key] ?? 0),
      x: positions[index][0],
      y: positions[index][1],
    }));
}

function emotionPoints(snapshot: DashboardSnapshot): StarPoint[] {
  const positions: Array<[number, number]> = [[38, 45], [112, 32], [186, 57], [262, 35], [306, 93], [74, 108], [154, 112], [232, 116]];
  return EMOTION_KEYS.map((key, index) => {
    const dimension = DIMENSIONS.find(item => item.key === key);
    return {
      key,
      label: dimension?.shortLabel ?? key,
      value: clamp(snapshot.state.drives?.[key] ?? 0),
      delta: Number(snapshot.recentChanges[key] ?? 0),
      x: positions[index][0],
      y: positions[index][1],
    };
  });
}

function starSvg(points: StarPoint[], selectedKey: string): string {
  const links = points.slice(0, -1).map((point, index) => {
    const next = points[index + 1];
    return `<line x1="${point.x}" y1="${point.y}" x2="${next.x}" y2="${next.y}"/>`;
  }).join("");
  const dust = [[22, 24], [78, 51], [148, 18], [222, 82], [288, 28], [324, 70], [34, 132], [126, 142], [268, 136]]
    .map(([x, y], index) => `<circle class="dust" cx="${x}" cy="${y}" r="${index % 3 === 0 ? 1 : .65}"/>`).join("");
  const nodes = points.map((point, index) => {
    const radius = 1.25 + point.value * 2.0;
    const halo = radius + 1.8 + point.value;
    const selected = point.key === selectedKey ? " selected" : "";
    const delay = `${(index * 1.28).toFixed(2)}s`;
    return `<g class="star-node${selected}" data-key="${point.key}" style="--delay:${delay}"><circle class="star-halo" cx="${point.x}" cy="${point.y}" r="${halo.toFixed(1)}"/><circle class="star-core" cx="${point.x}" cy="${point.y}" r="${radius.toFixed(1)}"/><circle class="star-center" cx="${point.x}" cy="${point.y}" r="${Math.max(.75, radius * .30).toFixed(1)}"/><path class="star-ray" d="M${point.x - radius - 2} ${point.y}H${point.x + radius + 2}M${point.x} ${point.y - radius - 2}V${point.y + radius + 2}"/><circle class="selected-ring" cx="${point.x}" cy="${point.y}" r="${(halo + 3).toFixed(1)}"/><text x="${point.x}" y="${point.y + halo + 12}" text-anchor="middle">${escapeHtml(point.label)}</text></g>`;
  }).join("");
  return `<svg class="star-svg" viewBox="0 0 340 168" preserveAspectRatio="xMidYMid meet"><defs><filter id="softStar"><feGaussianBlur stdDeviation="2.4"/></filter></defs><rect class="svg-space" width="340" height="168"/><ellipse class="svg-mist" cx="170" cy="78" rx="142" ry="82"/>${dust}<g class="links">${links}</g>${nodes}</svg>`;
}

function emotionSvg(snapshot: DashboardSnapshot, selectedKey: string): string {
  const points = emotionPoints(snapshot);
  const links = points.slice(0, -1).map((point, index) => {
    const next = points[index + 1];
    return `<line x1="${point.x}" y1="${point.y}" x2="${next.x}" y2="${next.y}"/>`;
  }).join("");
  const nodes = points.map((point, index) => {
    const layer = snapshot.state.emotions?.[point.key] ?? { mood: 0, pulse: 0 };
    const baseline = EMOTION_BASELINES[point.key] ?? 0;
    const core = 1.55 + baseline * 3.0;
    const halo = 2.2 + clamp(layer.mood) * 3.8;
    const pulse = clamp(layer.pulse);
    const selected = point.key === selectedKey ? " selected" : "";
    const delay = `${(index * .71).toFixed(2)}s`;
    return `<g class="emotion-node${selected}" data-key="${point.key}" style="--delay:${delay}"><circle class="emotion-halo" cx="${point.x}" cy="${point.y}" r="${halo.toFixed(1)}"/><circle class="star-core" cx="${point.x}" cy="${point.y}" r="${core.toFixed(1)}"/><circle class="star-center" cx="${point.x}" cy="${point.y}" r="${Math.max(.72, core * .32).toFixed(1)}"/><path class="star-ray" d="M${point.x - core - 2} ${point.y}H${point.x + core + 2}M${point.x} ${point.y - core - 2}V${point.y + core + 2}"/>${pulse > .01 ? `<circle class="emotion-pulse" cx="${point.x}" cy="${point.y}" r="${(core + 1.5).toFixed(1)}"/>` : ""}<circle class="selected-ring" cx="${point.x}" cy="${point.y}" r="${(halo + 3).toFixed(1)}"/><text x="${point.x}" y="${point.y + halo + 13}" text-anchor="middle">${escapeHtml(point.label)}</text></g>`;
  }).join("");
  return `<svg class="emotion-svg" viewBox="0 0 340 150" preserveAspectRatio="xMidYMid meet"><defs><filter id="softEmotion"><feGaussianBlur stdDeviation="2.2"/></filter></defs><rect class="svg-space" width="340" height="150"/><ellipse class="svg-mist" cx="170" cy="75" rx="150" ry="70"/><g class="links">${links}</g>${nodes}</svg>`;
}

function coreSvg(snapshot: DashboardSnapshot): string {
  const emotion = dominantEmotion(snapshot);
  const radius = (5.2 + clamp(emotion.pulse) * 1.7).toFixed(1);
  const stars = [
    [22, 24, .75, .34], [48, 88, 1.0, .46], [70, 42, .65, .28], [82, 142, 1.15, .56],
    [103, 24, .9, .38], [109, 172, .75, .32], [126, 58, .85, .40], [130, 196, 1.0, .46],
    [210, 32, .7, .30], [220, 72, 1.2, .56], [234, 174, .8, .36], [258, 48, 1.0, .44],
    [274, 128, .75, .30], [292, 82, 1.1, .52], [310, 188, .7, .28], [324, 30, .85, .36],
  ].map(([cx, cy, size, opacity]) => `<circle class="core-star" cx="${cx}" cy="${cy}" r="${size}" opacity="${opacity}"/>`).join("");
  return `<svg class="core-svg" viewBox="0 0 340 244" preserveAspectRatio="xMidYMid meet"><defs><radialGradient id="coreGlow"><stop offset="0" stop-color="#F5F7FA" stop-opacity=".96"/><stop offset=".25" stop-color="#C7D3E3" stop-opacity=".36"/><stop offset="1" stop-color="#7182A5" stop-opacity="0"/></radialGradient><filter id="coreBlur"><feGaussianBlur stdDeviation="3.4"/></filter></defs><rect class="svg-space" width="340" height="244"/><ellipse class="core-mist" cx="170" cy="112" rx="150" ry="102"/>${stars}<circle class="core-wave wave-one" cx="170" cy="112" r="35"/><circle class="core-wave wave-two" cx="170" cy="112" r="35"/><circle class="core-wave wave-three" cx="170" cy="112" r="35"/><circle class="core-wave wave-four" cx="170" cy="112" r="35"/><g class="orbit outer"><ellipse cx="170" cy="112" rx="82" ry="43"/><circle cx="250" cy="112" r="1.8"/><circle cx="110" cy="83" r="1.2"/></g><g class="orbit inner"><ellipse cx="170" cy="112" rx="60" ry="60"/><circle cx="170" cy="52" r="1.2"/></g><circle class="core-aura" cx="170" cy="112" r="34"/><circle class="core-light" cx="170" cy="112" r="${radius}" fill="url(#coreGlow)"/><circle cx="170" cy="112" r="2.1" fill="#F5F7FA"/></svg>`;
}

function progress(value: number): string {
  return `<div class="progress"><span style="width:${clamp(value) * 100}%"></span></div>`;
}

function readings(points: StarPoint[]): string {
  return points.map(point => `<button class="reading" data-key="${point.key}"><span class="reading-title">${escapeHtml(point.label)}</span><span class="reading-value">${percent(point.value)} <em>近6h ${signed(point.delta)}</em></span>${progress(point.value)}</button>`).join("");
}

function emotionReadings(snapshot: DashboardSnapshot): string {
  return EMOTION_KEYS.map(key => {
    const dimension = DIMENSIONS.find(item => item.key === key);
    const layer = snapshot.state.emotions?.[key] ?? { mood: 0, pulse: 0 };
    const current = Number(snapshot.state.drives?.[key] ?? 0);
    const baseline = EMOTION_BASELINES[key] ?? 0;
    return `<button class="reading emotion-reading" data-key="${key}"><span class="reading-title">${escapeHtml(dimension?.shortLabel ?? key)}</span><span class="reading-value">当前 ${current.toFixed(3)}</span>${progress(current)}<span class="layers"><i>基线 ${baseline.toFixed(2)}</i><i>持续 ${Number(layer.mood).toFixed(3)}</i><i>瞬时 ${Number(layer.pulse).toFixed(3)}</i></span></button>`;
  }).join("");
}

function dashboardHtml(snapshot: DashboardSnapshot): string {
  const dominant = dominantEmotion(snapshot);
  const relationship = constellationPoints(snapshot, "relationship");
  const autonomous = constellationPoints(snapshot, "autonomous");
  const background = backgroundPath ? `url("file://${backgroundPath.replace(/\\/g, "/")}")` : "none";
  const trajectory = snapshot.trajectory;
  const trajectoryLabels = trajectory.map(point => point.types.map(type => escapeHtml(INTERACTION_LABELS[type] ?? type)).join(" + ")).filter(Boolean);
  const tabs = [
    ["overview", "星核"], ["relationship", "关系"], ["autonomous", "自主"], ["emotions", "情绪"], ["trajectory", "脉搏"],
  ].map(([key, label], index) => `<button class="tab${index === 0 ? " active" : ""}" data-view="${key}"><span></span>${label}</button>${index < 4 ? `<b class="tab-line"></b>` : ""}`).join("");
  const trailDots = trajectory.length
    ? trajectory.map((point, index) => `<span class="trail-dot" style="left:${trajectory.length === 1 ? 50 : (index / (trajectory.length - 1)) * 100}%"></span>`).join("")
    : "";
  const trailTimes = trajectory.map(point => `<i>${shortTime(point.at)}</i>`).join("");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>
:root{color-scheme:dark}*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#040718;color:#D6D9E4;font-family:sans-serif}body{background-image:linear-gradient(rgba(4,7,24,.48),rgba(4,7,24,.82)),${background};background-position:center top;background-size:cover;background-attachment:fixed}button{font:inherit;color:inherit}main{padding:12px 12px 42px}.mast{display:flex;align-items:center;gap:10px;padding:4px 6px 12px}.mast-copy{flex:1}.mast h1{margin:0;color:#D6D9E4;font-size:24px}.mast p{margin:5px 0 0;color:#8992AA;font-size:12px;line-height:1.35}.refresh{width:34px;height:34px;border:1px solid #344165;border-radius:50%;background:rgba(13,21,48,.72);font-size:18px}.tabs{display:flex;align-items:center;position:sticky;top:0;z-index:9;padding:8px 0 11px;background:rgba(4,7,24,.78);backdrop-filter:blur(5px)}.tab{flex:1;padding:5px 0;border:0;background:transparent;color:#8992AA;font-size:14px}.tab span{display:block;width:8px;height:8px;margin:0 auto 5px;border-radius:50%;background:#293552}.tab.active{color:#D6DFEB;font-weight:700}.tab.active span{width:10px;height:10px;background:#D6DFEB}.tab-line{width:17px;height:1px;background:#344165}.page{display:none}.page.active{display:block}.card{margin:0 0 12px;border:1px solid rgba(52,65,101,.76);border-radius:11px;overflow:hidden;background:rgba(13,21,48,.88)}.card-head{padding:14px 15px 11px;border-left:3px solid #7182A5}.card-head h2{margin:0;font-size:21px}.card-head p{margin:5px 0 0;color:#8992AA;font-size:14px;line-height:1.45}.chart{height:192px;background:rgba(2,5,16,.80)}.core-chart{height:244px}.star-svg,.emotion-svg,.core-svg{display:block;width:100%;height:100%}.svg-space{fill:#020510}.svg-mist{fill:#7182A5;opacity:.055}.links line{stroke:#53617F;stroke-width:.7;stroke-opacity:.32}.dust{fill:#B9C5D8;opacity:.28}.star-node,.emotion-node{transform-box:fill-box;transform-origin:center;animation:twinkle 8.6s ease-in-out infinite;animation-delay:var(--delay)}.star-node text,.emotion-node text{fill:#A9B1C1;font-size:9px}.star-halo,.emotion-halo{fill:#B9C5D8;opacity:.14;filter:url(#softStar);transform-box:fill-box;transform-origin:center;animation:halo 8.6s ease-in-out infinite;animation-delay:var(--delay)}.emotion-halo{filter:url(#softEmotion);opacity:.10}.star-core{fill:#D6DFEB;opacity:.90}.star-center{fill:#F5F7FA}.star-ray{stroke:#DDE5F0;stroke-width:.45;stroke-opacity:.42}.selected-ring{display:none;fill:none;stroke:#D4DDEA;stroke-width:.72;stroke-opacity:.66}.selected .selected-ring{display:block}.emotion-pulse{fill:none;stroke:#C3D0E1;stroke-width:.7;opacity:.34;transform-box:fill-box;transform-origin:center;animation:pulse 2.5s ease-out infinite}.orbit{fill:none;stroke:#899AB9;stroke-width:1;stroke-opacity:.44;stroke-dasharray:2 7;transform-box:view-box;transform-origin:170px 112px}.orbit.outer{animation:orbit 32s linear infinite}.orbit.inner{stroke:#677592;stroke-width:.8;stroke-opacity:.28;stroke-dasharray:1 10;animation:reverseOrbit 48s linear infinite}.orbit circle{fill:#D6DFEB}.core-mist{fill:#536B9C;opacity:.07}.core-star{fill:#D6DFEB;transform-box:fill-box;transform-origin:center;animation:starFlicker 6.8s ease-in-out infinite}.core-wave{fill:none;stroke:#8497BC;stroke-width:.85;opacity:0;transform-box:view-box;transform-origin:170px 112px;animation:coreWave 8.8s cubic-bezier(.18,.54,.24,1) infinite}.wave-two{animation-delay:-2.2s}.wave-three{animation-delay:-4.4s}.wave-four{animation-delay:-6.6s}.core-aura{fill:#7182A5;opacity:.09;filter:url(#coreBlur);transform-box:view-box;transform-origin:170px 112px;animation:coreBreathe 7.4s ease-in-out infinite}.core-light{transform-box:view-box;transform-origin:170px 112px;animation:coreBreathe 7.4s ease-in-out infinite}.intent{padding:0 15px 14px;color:#AAB4C8;font-size:14px;line-height:1.5}.badges{display:flex;gap:9px;padding:0 15px 15px}.badge{flex:1;padding:9px 10px;border-radius:9px;background:rgba(17,26,56,.82);font-size:12px;color:#8992AA}.badge b{display:block;margin-top:4px;color:#D6DFEB;font-size:17px}.content{padding:13px 15px 16px}.reading{position:relative;display:block;width:100%;margin:0 0 9px;padding:11px 12px;border:0;border-left:3px solid #344165;border-radius:9px;background:rgba(17,26,56,.82);text-align:left}.reading.selected{background:rgba(23,33,66,.94);border-left-color:#D6DFEB}.reading-title{display:inline-block;color:#D6D9E4;font-size:15px}.reading-value{float:right;color:#AAB4C8;font-size:13px}.reading-value em{font-style:normal;color:#8992AA}.progress{clear:both;height:6px;margin-top:9px;border-radius:8px;overflow:hidden;background:#293552}.progress span{display:block;height:100%;border-radius:8px;background:#7182A5}.reading.selected .progress span{background:#D6DFEB}.layers{display:flex;justify-content:space-between;margin-top:7px;color:#AAB4C8;font-size:12px}.layers i{font-style:normal}.note{padding:0 15px 15px;color:#8992AA;font-size:13px;line-height:1.55}.trail{height:112px;margin:5px 15px 0;position:relative}.trail-line{position:absolute;left:0;right:0;top:46px;height:1px;background:#53617F}.trail-dot{position:absolute;top:42px;width:8px;height:8px;border-radius:50%;background:#D6DFEB;transform:translateX(-50%);box-shadow:0 0 0 7px rgba(113,130,165,.12)}.trail-times{display:flex;justify-content:space-between;padding-top:65px;color:#8992AA;font-size:11px}.trail-times i{font-style:normal}.empty{padding:28px 15px;color:#8992AA}.system{padding:14px 15px;color:#8992AA;font-size:13px;line-height:1.6}@keyframes twinkle{0%,100%{opacity:.82}50%{opacity:1}}@keyframes halo{0%,100%{transform:scale(.90);opacity:.07}50%{transform:scale(1.12);opacity:.18}}@keyframes orbit{to{transform:rotate(360deg)}}@keyframes reverseOrbit{to{transform:rotate(-360deg)}}@keyframes coreWave{0%{transform:scale(.28);opacity:.42}22%{opacity:.30}68%{opacity:.09}100%{transform:scale(2.62);opacity:0}}@keyframes starFlicker{0%,100%{opacity:.30}50%{opacity:.82}}@keyframes coreBreathe{0%,100%{transform:scale(.96)}50%{transform:scale(1.04)}}@keyframes pulse{0%{transform:scale(.75);opacity:.45}100%{transform:scale(2.2);opacity:0}}@media(prefers-reduced-motion:reduce){.star-node,.emotion-node,.star-halo,.emotion-halo,.orbit,.core-wave,.core-aura,.core-light,.emotion-pulse{animation-duration:20s}}
</style></head><body><main><header class="mast"><div class="mast-copy"><h1>心潮</h1><p>来自爱的宇宙 · AVE PRIVATE OBSERVATORY</p></div><button class="refresh" onclick="location.reload()">&#8635;</button></header><nav class="tabs">${tabs}</nav><section class="page active" data-page="overview"><div class="card"><div class="chart core-chart">${coreSvg(snapshot)}</div><div class="card-head"><h2>当前主导心潮 · ${escapeHtml(dominant.label)}</h2><p>强度 ${percent(dominant.value)} · 虚线星环以不同速度绕行</p></div><div class="intent">${snapshot.intent?.label ? `主意图 · ${escapeHtml(shortIntentLabel(snapshot.intent.label))} ${Math.round(Number(snapshot.intent.score ?? 0) * 100)}%` : "此刻暂无明确主导意图"}</div><div class="badges"><div class="badge">持续层 mood<b>${Number(dominant.mood).toFixed(3)}</b></div><div class="badge">瞬时层 pulse<b>${Number(dominant.pulse).toFixed(3)}</b></div></div></div><div class="card"><div class="system">系统脉搏 · ONLINE<br>revision ${Number(snapshot.state.revision ?? 0)} · schema ${Number(snapshot.state.schemaVersion ?? 0)} · ${escapeHtml(snapshot.state.consciousness ?? "unknown")}<br>最后结算 ${shortTime(snapshot.state.lastSettledAt)} · 本页刷新 ${shortTime(snapshot.loadedAt)}</div></div></section><section class="page" data-page="relationship"><div class="card"><div class="chart">${starSvg(relationship, relationship[0]?.key ?? "")}</div><div class="card-head"><h2>关系星群</h2><p>靠近、惦记、黏着、分享与身体渴望</p></div><div class="content">${readings(relationship)}</div><p class="note">星点和读数双向定位，核心统一为小号冰蓝白光点。</p></div></section><section class="page" data-page="autonomous"><div class="card"><div class="chart">${starSvg(autonomous, autonomous[0]?.key ?? "")}</div><div class="card-head"><h2>自主星群</h2><p>探索、社交、责任与自我整理</p></div><div class="content">${readings(autonomous)}</div><p class="note">星点固定位置，错峰呼吸，不使用厚重灰色波纹。</p></div></section><section class="page" data-page="emotions"><div class="card"><div class="card-head"><h2>情绪星图</h2><p>固定星位表达主次，观测读数保留精确层级</p></div><div class="chart">${emotionSvg(snapshot, EMOTION_KEYS[0])}</div><p class="note">基线是稳定星核，持续层是极薄的呼吸光晕，瞬时层才会扩散。</p><div class="content">${emotionReadings(snapshot)}</div></div></section><section class="page" data-page="trajectory"><div class="card"><div class="card-head"><h2>十五分钟脉搏</h2><p>保留互动顺序，不保存聊天正文</p></div>${trajectory.length ? `<div class="trail"><div class="trail-line">${trailDots}</div><div class="trail-times">${trailTimes}</div></div><p class="note">${trajectoryLabels.join(" → ")}</p>` : `<p class="empty">脉搏暂时安静。下一轮结算后会在这里亮起。</p>`}</div><div class="card"><div class="system">系统脉搏 · ONLINE<br>session ${escapeHtml(snapshot.activeSessionId.slice(0, 8))}<br>最后结算 ${shortTime(snapshot.state.lastSettledAt)} · 本页刷新 ${shortTime(snapshot.loadedAt)}</div></div></section><p class="note">星图只读取状态，不替你决定任何感受。</p></main><script>function show(view){document.querySelectorAll('.tab').forEach(function(el){el.classList.toggle('active',el.dataset.view===view)});document.querySelectorAll('.page').forEach(function(el){el.classList.toggle('active',el.dataset.page===view)});window.scrollTo(0,0)}function select(key){document.querySelectorAll('[data-key]').forEach(function(el){el.classList.toggle('selected',el.dataset.key===key)})}document.querySelectorAll('.tab').forEach(function(el){el.addEventListener('click',function(){show(el.dataset.view)})});document.querySelectorAll('.star-node,.emotion-node,.reading').forEach(function(el){el.addEventListener('click',function(){select(el.dataset.key);var row=document.querySelector('.reading[data-key="'+el.dataset.key+'"]');if(row&&el.classList.contains('star-node'))row.scrollIntoView({behavior:'smooth',block:'center'})})});select('${EMOTION_KEYS[0]}');</script></body></html>`;
}

export default function DashboardScreen(ctx: ComposeDslContext): ComposeNode {
  const snapshot = useValue<DashboardSnapshot | null>(ctx, "dashboardSnapshot", null);
  const error = useValue(ctx, "dashboardError", "");
  const loading = useValue(ctx, "dashboardLoading", false);
  const initialized = useValue(ctx, "dashboardInitialized", false);

  const refresh = async () => {
    if (loading.value) return;
    loading.set(true);
    error.set("");
    try {
      snapshot.set(await loadDashboardSnapshot());
    } catch (reason) {
      error.set(String(reason instanceof Error ? reason.message : reason));
    } finally {
      loading.set(false);
    }
  };

  let content: ComposeNode;
  if (error.value) {
    content = ctx.UI.Column({ fillMaxSize: true, padding: 20, spacing: 12, backgroundColor: BACKGROUND }, [
      ctx.UI.Text({ text: "星图暂时无法连接心潮", style: "titleMedium", color: ERROR, fontWeight: "bold" }),
      ctx.UI.Text({ text: error.value, style: "bodySmall", color: TEXT }),
      ctx.UI.Button({ text: "重新连接", onClick: refresh }),
    ]);
  } else if (!snapshot.value) {
    content = ctx.UI.Column({ fillMaxSize: true, padding: 24, spacing: 12, horizontalAlignment: "center", backgroundColor: BACKGROUND }, [
      ctx.UI.CircularProgressIndicator({ color: STAR, strokeWidth: 3 }),
      ctx.UI.Text({ text: "正在观测心潮星域...", style: "bodyMedium", color: MUTED }),
    ]);
  } else {
    content = ctx.UI.WebView({
      key: `dashboard-web-${snapshot.value.state.revision ?? 0}-${snapshot.value.loadedAt}`,
      fillMaxSize: true,
      html: dashboardHtml(snapshot.value),
      baseUrl: "file:///",
      javaScriptEnabled: true,
      domStorageEnabled: false,
      allowFileAccess: true,
      allowContentAccess: false,
      nestedScrollInterop: false,
      supportZoom: false,
      builtInZoomControls: false,
      displayZoomControls: false,
    });
  }

  return ctx.UI.Box({
    fillMaxSize: true,
    backgroundColor: BACKGROUND,
    onLoad: async () => {
      if (!initialized.value) {
        initialized.set(true);
        try {
          backgroundPath = await ToolPkg.readResource("dashboard_starfield", "ave-xinchao-starfield.jpg", true);
        } catch {
          backgroundPath = "";
        }
        await refresh();
      }
    },
  }, [content]);
}
