/**
 * 阶段 D 截图：造山带 + 温度雪线。
 *
 * 三组图：
 *   ① 全球 6 个视角（默认配色，看整体观感）
 *   ② 「只显示山脉 / 雪峰」4 个视角（其余格子刷成背景色）
 *      —— 这是「成带 vs 团块」最直接的视觉证据，可与 docs/v1-shots/ 对照
 *   ③ 聚焦镜头：把球面转到「造山带强度最高的一格」正对镜头并推近，
 *      看一条山的内部结构（山脊、雪线、两侧群系过渡）
 *
 * 用法：node tools/shot-orogeny.mjs
 * 输出：docs/orogeny-shots/*.png、tools/out/shot-orogeny.json（不入库）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toUrl = (p) => 'file:///' + p.replace(/\\/g, '/');
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/matt/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const PAGE = toUrl(process.env.PLANET_PAGE || path.join(ROOT, 'index.html'));
const OUT = path.join(ROOT, 'docs', 'orogeny-shots');
const GLOBE_ANGLES = [0, 60, 120, 180, 240, 300];
const BAND_ANGLES = [0, 90, 180, 270];

async function probePort(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); return !!r.ok; } catch { return false; }
}
async function pickFreePort() {
  for (let i = 0; i < 40; i++) { const p = 9500 + Math.floor(Math.random() * 400); if (!(await probePort(p))) return p; }
  throw new Error('找不到空闲调试端口：先关掉残留的 headless Chrome（Get-Process chrome | Stop-Process -Force）');
}
const PORT = Number(process.env.CDP_PORT || await pickFreePort());

const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'cdp-orogeny-shot-'));
const child = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--disable-gpu-sandbox', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--window-size=1280,800', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitJson(url, tries = 60, method = 'GET') {
  for (let i = 0; i < tries; i++) { try { const r = await fetch(url, { method }); if (r.ok) return await r.json(); } catch { } await sleep(250); }
  throw new Error('CDP 未就绪');
}
await waitJson(`http://127.0.0.1:${PORT}/json/version`);
const tab = await waitJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, 20, 'PUT');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0; const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: PAGE });
for (let i = 0; i < 180; i++) { await sleep(1000); if (await evaluate('!!(window.__PLANET__ && window.__PLANET__.tiles)')) break; }
await sleep(2000);

const env = await evaluate(`(() => {
  const P = window.__PLANET__, C = P.CONFIG;
  if (!P) return { ok: false, why: '没有 __PLANET__' };
  if (C.riverWidth !== undefined) return { ok: false, why: 'CONFIG.riverWidth 仍在：页面是 H1 之前的版本' };
  if (C.orogenyBands === undefined) return { ok: false, why: 'CONFIG.orogenyBands 缺失：页面是阶段 D 之前的版本' };
  if (C.tempSnow === undefined) return { ok: false, why: 'CONFIG.tempSnow 缺失：雪线还没改成温度口径' };
  return { ok: true, level: C.level, tiles: P.tiles.length };
})()`);
if (!env.ok) throw new Error(`页面状态不对：${env.why}（先关掉残留的 headless Chrome）`);
console.log(`页面就绪：level=${env.level}，图块 ${env.tiles} 个`);

fs.mkdirSync(OUT, { recursive: true });
const shots = {};
/** 探针：当前有多少格被涂成了背景色（= 群系筛选还开着 → 画面里星球会\"消失\"） */
const bgCount = () => evaluate(`(() => {
  const bg = window.__PLANET__.scene.background;
  return window.__PLANET__.tiles.filter((t) => t.baseColor.r === bg.r && t.baseColor.g === bg.g && t.baseColor.b === bg.b).length;
})()`);
const snap = async (name, expectFilter = false) => {
  const bg = await bgCount();
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(s.data, 'base64'));
  const warn = (!expectFilter && bg > 3000) ? ' ⚠ 筛选未关' : '';
  console.log(`     · ${name}.png（背景色格数 ${bg}${expectFilter ? '，预期内（山地隔离）' : ''}${warn}）`);
  return `${name}.png`;
};
/** 只隐藏 HUD/图例/提示，保留星空与星球 */
const hideUI = () => evaluate(`(() => { for (const id of ['hud','legend','hint']) { const e = document.getElementById(id); if (e) e.style.display='none'; } return 1; })()`);
const setRotation = (a) => evaluate(`(() => { const G = window.__PLANET__.planetGroup; G.rotation.set(0, ${a} * Math.PI / 180, 0); return 1; })()`);

/* ---------- ① 全球 6 视角 ---------- */
await hideUI();
shots.globe = [];
for (const a of GLOBE_ANGLES) {
  await setRotation(a); await sleep(1200);
  shots.globe.push(await snap(`globe-a${String(a).padStart(3, '0')}`));
  console.log(`√ 全球 a=${a}°`);
}

/* ---------- ② 只显示山脉 + 雪峰（成带的视觉证据） ---------- */
await evaluate(`window.__PLANET__.setVisibleBiomes(['mountain','snow'])`);
shots.band = [];
for (const a of BAND_ANGLES) {
  await setRotation(a); await sleep(1200);
  shots.band.push(await snap(`band-a${String(a).padStart(3, '0')}`, true));
  console.log(`√ 山地隔离 a=${a}°`);
}
await evaluate(`window.__PLANET__.setVisibleBiomes(null)`);

/* ---------- ③ 聚焦：转到「造山带峰值格」并推近 ---------- */
/**
 * 把球面转到指定格子正对镜头。
 * 推导：planetGroup.rotation 用默认 XYZ 序 → v' = Rx(Ry(v))。
 *   先绕 Y 转 yaw = −atan2(c.x, c.z) 让该格落到 (0, c.y, r)（r = √(c.x²+c.z²)）；
 *   再绕 X 转 pitch，把 (c.y, r) 在 (y,z) 平面里转到相机的 (y,z) 方向。
 */
const focusOn = (idx) => evaluate(`(() => {
  const P = window.__PLANET__, t = P.tiles[${idx}], c = t.center;
  const r = Math.hypot(c.x, c.z);
  const d = P.camera.position.clone().normalize();
  P.planetGroup.rotation.set(Math.atan2(d.z, d.y) - Math.atan2(r, c.y), -Math.atan2(c.x, c.z), 0);
  P.setHovered(${idx});
  return { index: ${idx}, orogeny: +t.orogeny.toFixed(3), biome: t.biome,
           elevation: +t.elevation.toFixed(3), temperature: +t.temperature.toFixed(3),
           latitude: +t.latitude.toFixed(3), moisture: +t.moisture.toFixed(3) };
})()`);

/** 挑「山地峰值格」：优先低纬（能看到雪线与两侧群系过渡），再挑高纬（极地山带全是雪）
 *  避开 elevation ≈ 1.0 的 clamp 收口格 —— 那些格顶被削平成同高台地，
 *  近景里会是一大片纯白，看不出山脊与雪线（clamp 格数本身另有指标记录）。 */
const picks = await evaluate(`(() => {
  const P = window.__PLANET__, C = P.CONFIG;
  const mtn = P.tiles.filter((t) => t.elevation > C.seaLevel && t.orogeny >= C.orogenyMountain && t.elevation < 0.995);
  const pick = (pred) => { let b = null; for (const t of mtn) if (pred(t) && (!b || t.orogeny > b.orogeny)) b = t; return b; };
  const low = pick((t) => Math.abs(t.latitude) < 0.35) || pick(() => true);
  const high = pick((t) => Math.abs(t.latitude) > 0.60) || low;
  return [low.index, high.index];
})()`);
/**
 * 恢复初始镜头距离。
 * ★ 必须做：OrbitControls 的滚轮缩放是**累积**的，第一个聚焦推近 4 档之后，
 *   第二个聚焦如果不复位，它的 "-far" 截图其实是 "-near" 视角（曾经就是这么错的）。
 */
const CAM0 = await evaluate(`window.__PLANET__.camera.position.length()`);
const resetZoom = () => evaluate(`(() => {
  const P = window.__PLANET__;
  P.camera.position.setLength(${CAM0});
  P.controls.update();
  return P.camera.position.length();
})()`);

const focus = [];
const names = ['focus-low', 'focus-high'];
for (let i = 0; i < 2; i++) {
  const info = await focusOn(picks[i]);
  await resetZoom();
  await sleep(1300);
  focus.push({ ...info, far: await snap(`${names[i]}-far`) });
  // 推近：OrbitControls 监听 wheel；headless 下用 CDP 派发真事件
  for (let k = 0; k < 4; k++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: -400, button: 'none', modifiers: 0 });
    await sleep(250);
  }
  await sleep(1300);
  focus[i].near = await snap(`${names[i]}-near`);
  await evaluate(`window.__PLANET__.setVisibleBiomes(['mountain','snow'])`);
  await sleep(1200);
  focus[i].nearBand = await snap(`${names[i]}-near-band`, true);
  await evaluate(`window.__PLANET__.setVisibleBiomes(null)`);
  console.log(`√ 聚焦 #${info.index}（${names[i]}）：orogeny=${info.orogeny} 群系=${info.biome} ` +
    `海拔=${info.elevation} 温度=${info.temperature} 纬度=${info.latitude}`);
}

/* ---------- 汇总数据（与截图同一次会话，保证是同一份页面） ---------- */
const stats = await evaluate(`(() => {
  const P = window.__PLANET__, C = P.CONFIG, tiles = P.tiles, n = tiles.length;
  const SEA = C.seaLevel;
  const bio = {}; let land = 0, mtn = 0, snow = 0, snowLow = 0, elevLand = 0, elevMtn = 0;
  for (const t of tiles) {
    bio[t.biome] = (bio[t.biome] || 0) + 1;
    if (t.elevation <= SEA) continue;
    land++; elevLand += t.elevation;
    if (t.orogeny >= C.orogenyMountain) { mtn++; elevMtn += t.elevation; }
    if (t.biome === 'snow') { snow++; if (Math.abs(t.latitude) < 0.3) snowLow++; }
  }
  const info = P.stats();
  const selfTest = P.selfTest;   // { rows, stats } —— init 时跑的那一次
  return {
    land: +(land / n * 100).toFixed(2),
    mtnSnowPctOfLand: +(mtn / land * 100).toFixed(2),
    mountainPctOfLand: +(bio.mountain / land * 100).toFixed(2),
    snowPctOfLand: +(snow / land * 100).toFixed(2),
    snowLowLat: snowLow,
    elevMtnMinusLand: +((elevMtn / mtn) - (elevLand / land)).toFixed(3),
    biomeOfLand: Object.fromEntries(Object.entries(bio).map(([k, v]) => [k, +(v / land * 100).toFixed(2)])),
    kinds: Object.keys(bio).length,
    drawCalls: info.drawCalls, triangles: info.triangles, meshCount: info.meshCount,
    selfTest: selfTest ? {
      total: selfTest.rows.length,
      passed: selfTest.rows.filter((r) => r.ok).length,
      failed: selfTest.rows.filter((r) => !r.ok).map((r) => ({ name: r.name, detail: r.detail })),
    } : null,
  };
})()`);
console.log('');
console.log(`陆地 ${stats.land}%｜山+雪占陆地 ${stats.mtnSnowPctOfLand}%（山脉 ${stats.mountainPctOfLand} / 雪峰 ${stats.snowPctOfLand}）`);
console.log(`赤道雪峰（|lat|<0.3）${stats.snowLowLat} 格｜山地平均海拔 − 陆地平均海拔 = ${stats.elevMtnMinusLand}`);
console.log(`draw call = ${stats.drawCalls}｜Mesh ${stats.meshCount} 个｜三角形 ${stats.triangles}｜群系种类 ${stats.kinds}`);
console.log(`页面自测：${stats.selfTest ? `${stats.selfTest.passed}/${stats.selfTest.total} 通过` : '（无 selfTest）'}`);
if (stats.selfTest && stats.selfTest.failed && stats.selfTest.failed.length) {
  for (const f of stats.selfTest.failed) console.log(`  ✗ ${f.name}：${f.detail}`);
}

const out = path.join(ROOT, 'tools', 'out', 'shot-orogeny.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ page: 'index.html', focus, shots, stats }, null, 2));
console.log(`\n截图 → ${path.relative(ROOT, OUT)}\\*.png`);

ws.close(); child.kill(); await sleep(400);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { }
process.exit(0);
