/**
 * H3/H4 截图：河网渲染层（三角带）+ 湖泊 / 内流盆地（顶点色覆盖层）。
 *
 * 七组图：
 *   ① 全球 4 视角（群系 + 河网 + 湖面叠在上面）—— 整体观感
 *   ② 「只留河线」2 视角（全部图块刷成背景色）—— 一眼判断是不是**树枝状水系**
 *   ③ 聚焦：转到「汇水面积最大的那一格」（主干）并推近，-full / -only 各一张
 *      —— 看"河是穿过格子的线，不是填满格子的色块"
 *   ④ 宽度-流量散点图（页内 canvas 画，不依赖 WebGL）
 *   ⑤ climateCoupling = 0 的对照图（全河等宽）—— 证明"粗细确实受降雨量影响"
 *   ⑥ 阈值对照（T=12/20/30）
 *   ⑦ ★ H4：湖泊清单图（页内 canvas）+ 只留湖面 + 最大湖/最大内流盆地近景 + 湖泊层开关对照
 *
 * 用法：node tools/shot-river.mjs
 * 输出：docs/river-shots/*.png、tools/out/shot-river.json（后者不入库）
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
const OUT = path.join(ROOT, 'docs', 'river-shots');
const GLOBE_ANGLES = [0, 90, 180, 270];
const ONLY_ANGLES = [0, 180];

async function probePort(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); return !!r.ok; } catch { return false; }
}
async function pickFreePort() {
  for (let i = 0; i < 40; i++) { const p = 9500 + Math.floor(Math.random() * 400); if (!(await probePort(p))) return p; }
  throw new Error('找不到空闲调试端口：先关掉残留的 headless Chrome（Get-Process chrome | Stop-Process -Force）');
}
const PORT = Number(process.env.CDP_PORT || await pickFreePort());

const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'cdp-river-shot-'));
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
let ready = false;
for (let i = 0; i < 180; i++) {
  await sleep(1000);
  try { if (await evaluate('!!(window.__PLANET__ && window.__PLANET__.tiles)')) { ready = true; break; } } catch { /* 瞬时异常继续等 */ }
}
if (!ready) throw new Error('页面 180 秒未就绪（先关掉残留的 headless Chrome）');
await sleep(2000);
// ★ 就绪后再确认一次：页面崩溃 / 被重新导航会让 __PLANET__ 又消失，
//   那时 env 求值会抛一个非常迷惑的 "Cannot read properties of undefined (reading 'CONFIG')"
const afterReady = await evaluate('({ hasP: !!window.__PLANET__, href: String(location.href).slice(-40) })');
if (!afterReady.hasP) throw new Error(`页面就绪 2 秒后 __PLANET__ 消失（href=${afterReady.href}）`);

const env = await evaluate(`(() => {
  const P = window.__PLANET__;
  if (!P) return { ok: false, why: '没有 __PLANET__' };
  const C = P.CONFIG;
  if (C.riverWidth !== undefined) return { ok: false, why: 'CONFIG.riverWidth 仍在：页面是 H1 之前的版本' };
  if (!C.hydro || C.hydro.riverWidthScale === undefined) return { ok: false, why: 'CONFIG.hydro 里没有 H3 渲染参数' };
  if (!P.river || !P.riverMesh) return { ok: false, why: '__PLANET__.river / riverMesh 缺失：河网渲染层还没落地' };
  if (!P.river()) return { ok: false, why: '河网几何体没建出来' };
  return { ok: true, level: C.level, tiles: P.tiles.length };
})()`);
if (!env.ok) throw new Error(`页面状态不对：${env.why}（先关掉残留的 headless Chrome）`);
console.log(`页面就绪：level=${env.level}，图块 ${env.tiles} 个`);

/* ★★ 耗时必须在**零截图会话**里量。headless SwiftShader 的 Page.captureScreenshot
   会把渲染器主线程拖慢：实测同一台机器、同一个页面，refresh() 正常 105–201 ms，
   但在截图会话里会偶发 6–35 秒（H3 提交同样中招，纯计算对照仍稳定 → 与水文代码无关）。
   所以耗时读数放在**第一张截图之前**，截图会话之后再量一次仅作对照。 */
const cleanTiming = await evaluate(`(() => {
  const P = window.__PLANET__, out = [];
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now(); P.refresh(); const t1 = performance.now();
    out.push({ all: +(t1 - t0).toFixed(1), hydro: P.hydro().ms, river: P.river().ms });
  }
  return out;
})()`);
const range = (arr) => `${Math.min(...arr)}–${Math.max(...arr)} ms`;
console.log(`耗时（零截图会话 · 5 次 refresh）：整条 ${range(cleanTiming.map((r) => r.all))}｜` +
  `水文 ${range(cleanTiming.map((r) => r.hydro))}｜河网重建 ${range(cleanTiming.map((r) => r.river))}`);

fs.mkdirSync(OUT, { recursive: true });
const shots = {};
/** 探针：当前有多少格被涂成了背景色（= 群系筛选还开着 → 星球会"消失"） */
const bgCount = () => evaluate(`(() => {
  const bg = window.__PLANET__.scene.background;
  return window.__PLANET__.tiles.filter((t) => t.baseColor.r === bg.r && t.baseColor.g === bg.g && t.baseColor.b === bg.b).length;
})()`);
const snap = async (name, expectFilter = false) => {
  const bg = await bgCount();
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(s.data, 'base64'));
  const warn = (!expectFilter && bg > 3000) ? ' ⚠ 筛选未关' : '';
  console.log(`     · ${name}.png（背景色格数 ${bg}${expectFilter ? '，预期内（只留河线）' : ''}${warn}）`);
  return `${name}.png`;
};
/** 只隐藏 HUD/图例/提示，保留星空与星球 */
const hideUI = () => evaluate(`(() => { for (const id of ['hud','legend','hint']) { const e = document.getElementById(id); if (e) e.style.display='none'; } return 1; })()`);
const setRotation = (a) => evaluate(`(() => { const G = window.__PLANET__.planetGroup; G.rotation.set(0, ${a} * Math.PI / 180, 0); return 1; })()`);
/** 只留河线：把全部图块刷成背景色（河网是独立几何体，不受顶点色筛选影响） */
const onlyRivers = () => evaluate(`window.__PLANET__.setVisibleBiomes(['__none__'])`);
const allBiomes = () => evaluate(`window.__PLANET__.setVisibleBiomes(null)`);

/* ---------- ① 全球 4 视角（群系 + 河网） ---------- */
await hideUI();
shots.globe = [];
for (const a of GLOBE_ANGLES) {
  await setRotation(a); await sleep(1200);
  shots.globe.push(await snap(`river-full-a${String(a).padStart(3, '0')}`));
  console.log(`√ 全球 a=${a}°`);
}

/* ---------- ② 只留河线（判断"树枝状 vs 蛛网"） ---------- */
await onlyRivers();
shots.only = [];
for (const a of ONLY_ANGLES) {
  await setRotation(a); await sleep(1200);
  shots.only.push(await snap(`river-only-a${String(a).padStart(3, '0')}`, true));
  console.log(`√ 只留河线 a=${a}°`);
}
await allBiomes();

/* ---------- ③ 聚焦「汇水面积最大的那一格」（主干） ---------- */
const focusOn = (idx) => evaluate(`(() => {
  const P = window.__PLANET__, t = P.tiles[${idx}], c = t.center;
  const r = Math.hypot(c.x, c.z);
  const d = P.camera.position.clone().normalize();
  P.planetGroup.rotation.set(Math.atan2(d.z, d.y) - Math.atan2(r, c.y), -Math.atan2(c.x, c.z), 0);
  P.setHovered(${idx});
  return { index: ${idx}, biome: t.biome, elevation: +t.elevation.toFixed(3),
           accum: +P.hydro().accum[${idx}].toFixed(1) };
})()`);
/** 挑汇水面积最大的河格（= 最粗的主干），就是"最粗的河"所在处 */
const trunk = await evaluate(`(() => {
  const P = window.__PLANET__, hy = P.hydro();
  let best = -1;
  for (let i = 0; i < P.tiles.length; i++) if (hy.isRiver[i] && (best < 0 || hy.accum[i] > hy.accum[best])) best = i;
  return best;
})()`);
const CAM0 = await evaluate(`window.__PLANET__.camera.position.length()`);
const resetZoom = () => evaluate(`(() => {
  const P = window.__PLANET__;
  P.camera.position.setLength(${CAM0});
  P.controls.update();
  return P.camera.position.length();
})()`);

const info = await focusOn(trunk);
await resetZoom();
await sleep(1300);
const near = { ...info };
near.far = await snap('river-close-far');
for (let k = 0; k < 4; k++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: -400, button: 'none', modifiers: 0 });
  await sleep(250);
}
await sleep(1300);
near.near = await snap('river-close-near');
await onlyRivers();
await sleep(1200);
near.nearOnly = await snap('river-close-near-only', true);
await allBiomes();
await resetZoom();
console.log(`√ 聚焦主干 #${info.index}：群系=${info.biome} 海拔=${info.elevation} 汇水=${info.accum}`);

/* ---------- ④ 宽度-流量散点图（页内 canvas） ---------- */
const scatter = await evaluate(`(() => {
  const P = window.__PLANET__, C = P.CONFIG.hydro, hy = P.hydro();
  const rs = P.river();
  const cells = [];
  for (let i = 0; i < P.tiles.length; i++) if (hy.isRiver[i]) cells.push(i);
  const W = 960, H = 640, ML = 78, MR = 26, MT = 46, MB = 58;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#0b1220'; g.fillRect(0, 0, W, H);
  const xmin = Math.log10(6), xmax = Math.log10(700);
  const ymax = C.riverMaxWidth * 1.1;
  const X = (eq) => ML + (Math.log10(eq) - xmin) / (xmax - xmin) * (W - ML - MR);
  const Y = (w) => H - MB - w / ymax * (H - MT - MB);
  // 网格
  g.strokeStyle = '#1e2b40'; g.lineWidth = 1;
  for (const eq of [10, 20, 50, 100, 200, 500]) {
    g.beginPath(); g.moveTo(X(eq), MT); g.lineTo(X(eq), H - MB); g.stroke();
    g.fillStyle = '#5b7089'; g.font = '13px sans-serif'; g.textAlign = 'center';
    g.fillText(eq + '', X(eq), H - MB + 20);
  }
  for (let w = 0.2; w <= ymax; w += 0.2) {
    g.beginPath(); g.moveTo(ML, Y(w)); g.lineTo(W - MR, Y(w)); g.stroke();
    g.fillStyle = '#5b7089'; g.font = '13px sans-serif'; g.textAlign = 'right';
    g.fillText(w.toFixed(1), ML - 10, Y(w) + 4);
  }
  // 散点
  const unit = hy.unit || 1;
  g.fillStyle = 'rgba(83,184,255,0.85)';
  for (const i of cells) {
    const eq = hy.accum[i] / unit;
    g.beginPath(); g.arc(X(eq), Y(rs.widths[i] / rs.spacing), 2.1, 0, 6.2832); g.fill();
  }
  // 理论曲线
  g.strokeStyle = '#ffd45e'; g.lineWidth = 1.6; g.beginPath();
  for (let k = 0; k <= 200; k++) {
    const eq = Math.pow(10, xmin + (xmax - xmin) * k / 200);
    const w = Math.min(C.riverMaxWidth, Math.max(C.riverMinWidth,
      C.riverWidthScale * Math.pow(eq, C.riverWidthExponent)));
    k ? g.lineTo(X(eq), Y(w)) : g.moveTo(X(eq), Y(w));
  }
  g.stroke();
  // 中位流量竖线
  g.strokeStyle = '#7fd3a8'; g.setLineDash([5, 4]); g.beginPath();
  g.moveTo(X(rs.eqMedian), MT); g.lineTo(X(rs.eqMedian), H - MB); g.stroke(); g.setLineDash([]);
  // 文字
  g.fillStyle = '#cfe2ee'; g.font = 'bold 17px sans-serif'; g.textAlign = 'left';
  g.fillText('河宽 ↔ 汇水面积（H3 实测，' + cells.length + ' 个河格）', ML, 26);
  g.fillStyle = '#5b7089'; g.font = '14px sans-serif';
  g.fillText('横轴：汇水面积（等效格，对数）', W / 2 - 110, H - 14);
  g.save(); g.translate(20, H / 2 + 70); g.rotate(-Math.PI / 2);
  g.fillText('纵轴：河宽（格）', 0, 0); g.restore();
  g.fillStyle = '#ffd45e'; g.fillText('黄线 = riverWidthScale × accum^0.42', ML + 6, MT + 22);
  g.fillStyle = '#7fd3a8'; g.fillText('绿虚线 = 中位流量（climateCoupling=0 的等宽值）', ML + 6, MT + 42);
  return { dataUrl: cv.toDataURL('image/png'), cells: cells.length, eqMedian: +rs.eqMedian.toFixed(2) };
})()`);
fs.writeFileSync(path.join(OUT, 'river-width-vs-accum.png'),
  Buffer.from(scatter.dataUrl.split(',')[1], 'base64'));
console.log(`     · river-width-vs-accum.png（${scatter.cells} 个河格，中位 ${scatter.eqMedian} 等效格）`);

/* ---------- ⑤ climateCoupling = 0 对照（全河等宽） ---------- */
await setRotation(0);
await onlyRivers();
await evaluate(`(() => { const P = window.__PLANET__; P.CONFIG.hydro.climateCoupling = 0; P.refresh(); return 1; })()`);
await onlyRivers();          // ★ refresh() 会把顶点色重置回群系色，必须重新筛
await sleep(1400);
const coupling0 = await snap('river-climate-coupling-0', true);
await evaluate(`(() => { const P = window.__PLANET__; P.CONFIG.hydro.climateCoupling = 1; P.refresh(); return 1; })()`);
await onlyRivers();
await sleep(1400);
const coupling1 = await snap('river-climate-coupling-1', true);
await allBiomes();
console.log(`√ climateCoupling 0 / 1 对照（${coupling0} / ${coupling1}）`);

/* ---------- ⑥ 阈值对照（H2 头号风险：T=12 的河网偏"二维片"） ----------
 * 改 riverCellThreshold 之后河段集合本身就变了 —— 这正是设计稿 §10.3 说的
 * "refresh() 不再是零几何体成本"。同一视角、只留河线，三张图直接对比。 */
await setRotation(0);
await onlyRivers();
const thresholds = [];
for (const T of [12, 20, 30]) {
  await evaluate(`(() => { const P = window.__PLANET__; P.CONFIG.hydro.riverCellThreshold = ${T}; P.refresh(); return 1; })()`);
  await onlyRivers();
  await sleep(1500);
  const r = await evaluate(`(() => { const P = window.__PLANET__, hy = P.hydro(), rs = P.river();
    let V = 0, deg3 = 0, degSum = 0;
    for (let i = 0; i < P.tiles.length; i++) {
      if (!hy.isRiver[i]) continue;
      V++; let d = 0;
      for (const k of hy.adj[i]) if (hy.isRiver[k]) d++;
      degSum += d; if (d >= 3) deg3++;
    }
    return { V, meanDeg: +(degSum / Math.max(1, V)).toFixed(2), deg3Pct: +(100 * deg3 / Math.max(1, V)).toFixed(1),
             tri: rs.triCount, chains: rs.chains, fp: rs.gridFingerprintPct, raw: rs.gridFingerprintRawPct };
  })()`);
  thresholds.push({ T, ...r, file: await snap(`river-threshold-t${T}`, true) });
  console.log(`√ T=${T}：河格 ${r.V}｜平均度 ${r.meanDeg}（度≥3 占 ${r.deg3Pct}%）｜${r.tri} 三角形 / ${r.chains} 条链｜指纹 ${r.fp}%`);
}
await evaluate(`(() => { const P = window.__PLANET__; P.CONFIG.hydro.riverCellThreshold = 12; P.refresh(); return 1; })()`);
await allBiomes();
await sleep(1200);

/* ---------- ⑦ 湖泊与内流盆地（★ H4）----------
 * 六件证据：
 *   · lake-inventory.png      —— 页内 canvas 出的**湖泊清单图**（等距圆柱投影 + 按湿面积排序的表）
 *   · lake-only-a000.png      —— 只留湖面格（湖面是**顶点色覆盖**，0 draw call）
 *   · lake-close / -off / -on —— 最大湖的**同机位三张**（湖在 → 消失 → 回来：开关可逆）
 *   · lake-salt-close.png     —— 最大内流盆地的近景（灰青盐碱滩）
 *   · sink-off / sink-on      —— ★ H4.5 内流盆地当"汇"的同机位两张
 *                                （关：幽灵出湖河回来 → 开：那条河消失，河网断在湖岸） */
await setRotation(0);
await allBiomes();
await sleep(800);

const inv = await evaluate(`(() => {
  const P = window.__PLANET__, hy = P.hydro(), C = P.CONFIG, tiles = P.tiles;
  const TIER = { shallow: '#4f93c9', deep: '#26619c', salt: '#74a8a0' };
  const W = 1180, H = 720;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#0b1220'; g.fillRect(0, 0, W, H);

  /* --- 左：等距圆柱投影（只画陆地格 + 湖面格） --- */
  const MW = 660, MH = 300, MX = 30, MY = 76;
  g.fillStyle = '#101a2b'; g.fillRect(MX, MY, MW, MH);
  const X = (t) => MX + (Math.atan2(t.center.x, t.center.z) / (2 * Math.PI) + 0.5) * MW;
  const Y = (t) => MY + (0.5 - Math.asin(Math.max(-1, Math.min(1, t.center.y))) / Math.PI) * MH;
  g.fillStyle = '#1d2c42';
  for (const t of tiles) {
    if (t.elevation <= C.seaLevel) continue;
    g.fillRect(X(t) - 1.5, Y(t) - 1.5, 3, 3);
  }
  for (let i = 0; i < tiles.length; i++) {
    const lid = hy.lakeId[i];
    if (lid < 0) continue;
    const l = hy.lakes[lid], t = tiles[i];
    g.fillStyle = TIER[l.tier];
    g.fillRect(X(t) - 2.6, Y(t) - 2.6, 5.2, 5.2);
    if (l.isEndorheic) {          // 内流盆地加黄框：一眼看出"干湿分异"的位置
      g.strokeStyle = '#ffd45e'; g.lineWidth = 1;
      g.strokeRect(X(t) - 2.6, Y(t) - 2.6, 5.2, 5.2);
    }
  }
  g.fillStyle = '#cfe2ee'; g.font = 'bold 17px sans-serif'; g.textAlign = 'left';
  g.fillText('湖泊清单图（等距圆柱投影）· 黄框 = 内流盆地', MX, 30);
  g.fillStyle = '#5b7089'; g.font = '14px sans-serif';
  g.fillText('灰点 = 陆地格（海拔 > 海平面）· 色块 = 湖面格（按水位分档）', MX, 54);
  g.fillStyle = TIER.shallow; g.fillText('■ 浅湖', MX, MY + MH + 24);
  g.fillStyle = TIER.deep;    g.fillText('■ 深湖', MX + 70, MY + MH + 24);
  g.fillStyle = TIER.salt;    g.fillText('■ 内流湖 / 盐碱滩', MX + 140, MY + MH + 24);

  /* --- 右：按湿面积排序的表（标注内流/外流） --- */
  const rows = hy.lakes.slice().sort((a, b) => b.wetArea - a.wetArea);
  const TX = MX + MW + 26, TY = 76, RH = 30;
  g.fillStyle = '#cfe2ee'; g.font = 'bold 15px sans-serif';
  g.fillText('湖', TX, TY - 30); g.fillText('湿/洼', TX + 34, TY - 30);
  g.fillText('档位', TX + 96, TY - 30); g.fillText('水位', TX + 168, TY - 30);
  g.fillText('深', TX + 232, TY - 30); g.fillText('入流/蒸发', TX + 276, TY - 30);
  g.font = '14px sans-serif';
  for (let k = 0; k < Math.min(rows.length, 19); k++) {
    const l = rows[k], y = TY + k * RH;
    g.fillStyle = '#8aa2bb'; g.fillText('#' + l.id, TX, y);
    g.fillStyle = '#e6eef7'; g.fillText(l.wetArea + '/' + l.basinArea, TX + 34, y);
    g.fillStyle = TIER[l.tier]; g.fillText(l.tier === 'salt' ? '盐湖' : (l.tier === 'shallow' ? '浅湖' : '深湖'), TX + 96, y);
    g.fillStyle = '#e6eef7'; g.fillText(l.level.toFixed(3), TX + 168, y);
    g.fillText(l.depthMean.toFixed(4), TX + 232, y);
    g.fillStyle = l.isEndorheic ? '#ffd45e' : '#8aa2bb';
    g.fillText(l.inflow.toFixed(1) + '/' + l.evap.toFixed(1) + (l.isEndorheic ? ' 内流' : ' 外流'), TX + 276, y);
  }
  g.fillStyle = '#5b7089'; g.font = '13px sans-serif';
  g.fillText('入流/蒸发同一量纲（1 ≈ 陆地平均产流）；内流湖的蒸发追平了入流，所以水位停在溢出点以下',
    MX, H - 16);
  return {
    dataUrl: cv.toDataURL('image/png'),
    count: hy.lakes.length,
    endorheic: hy.lakes.filter((l) => l.isEndorheic).length,
    top: rows.slice(0, 8).map((l) => ({ id: l.id, wet: l.wetArea, basin: l.basinArea, tier: l.tier,
      endorheic: l.isEndorheic, level: +l.level.toFixed(4), depth: +l.depthMean.toFixed(4),
      inflow: +l.inflow.toFixed(2), evap: +l.evap.toFixed(2) })),
  };
})()`);
fs.writeFileSync(path.join(OUT, 'lake-inventory.png'), Buffer.from(inv.dataUrl.split(',')[1], 'base64'));
console.log(`     · lake-inventory.png（${inv.count} 个湖，内流 ${inv.endorheic} 个）`);

/* 只留湖面格（顶点色覆盖 —— 河网那种独立几何体是刷不掉的，湖面能刷掉就说明它走的是顶点色） */
const onlyLakes = () => evaluate(`window.__PLANET__.setVisibleBiomes(['__lake__'])`);
await onlyLakes();
await sleep(1200);
shots.lakeOnly = await snap('lake-only-a000', true);
await allBiomes();
console.log('√ 只留湖面 a=0°');

/* 最大湖 / 最大内流盆地的近景 */
const pick = await evaluate(`(() => {
  const P = window.__PLANET__, hy = P.hydro();
  const deepestCell = (l) => {
    let c = -1;
    for (let i = 0; i < P.tiles.length; i++) {
      if (hy.lakeId[i] !== l.id) continue;
      if (c < 0 || P.tiles[i].elevation < P.tiles[c].elevation) c = i;
    }
    return c;
  };
  const byWet = hy.lakes.slice().sort((a, b) => b.wetArea - a.wetArea)[0];
  const salts = hy.lakes.filter((l) => l.isEndorheic).sort((a, b) => b.basinArea - a.basinArea);
  const salt = salts[0] || null;
  return {
    lake: { id: byWet.id, cell: deepestCell(byWet), wet: byWet.wetArea, tier: byWet.tier,
      endorheic: byWet.isEndorheic, biome: P.tiles[deepestCell(byWet)].biome },
    salt: salt ? { id: salt.id, cell: deepestCell(salt), basin: salt.basinArea, wet: salt.wetArea,
      biome: P.tiles[deepestCell(salt)].biome } : null,
  };
})()`);

/* 推近一档：滚轮 deltaY = -400 约一档，累积若干次 */
async function zoomIn(times) {
  for (let k = 0; k < times; k++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: -400, button: 'none', modifiers: 0 });
    await sleep(250);
  }
}
async function nearShot(tag, cell, times = 3) {
  await focusOn(cell);
  await evaluate(`window.__PLANET__.setHovered(-1)`);     // 去掉悬停提亮，免得把湖色盖掉
  await resetZoom();
  await zoomIn(times);
  await sleep(1300);
  const r = await snap(tag);
  return r;
}

/* 最大湖近景，然后**同一机位**关掉湖泊层再拍 —— 这一对才是"开关真的生效"的证据。
   最后再恢复一次、同机位拍第三张，证明开关是**可逆**的（顶点色覆盖层的常见坑：一关就回不来）。 */
shots.lakeClose = await nearShot('lake-close', pick.lake.cell);
await evaluate(`window.__PLANET__.setVisibleOverlays(['river','ore'])`);
await sleep(1200);
shots.lakeCloseOff = await snap('lake-close-off');
await evaluate(`window.__PLANET__.setVisibleOverlays(null)`);
await sleep(1200);
shots.lakeCloseOn = await snap('lake-close-on');
console.log(`√ 近景：最大湖 #${pick.lake.id}（湿 ${pick.lake.wet} 格 / ${pick.lake.tier}）` +
  `｜同机位 on/off/on 三张（lake-close / -off / -on）`);

if (pick.salt) {
  await nearShot('lake-salt-close', pick.salt.cell);
  console.log(`√ 近景：最大内流盆地 #${pick.salt.id}（洼地 ${pick.salt.basin} 格 / 湿 ${pick.salt.wet} 格）`);
}

/* ★ H4.5：内流盆地当"汇"的开关对照（同机位两张）——
   off（幽灵出湖河回来：盐湖边上流出一条河）→ on（那条河消失，河网断在湖岸）。
   ★ 聚焦哪一格？不是"入流河最多的盆地"，而是**幽灵河最长的那个盆地** ——
     先两态各跑一次 refresh，把"关时有河、开时没河"的格子 diff 出来（= 幽灵河格），
     再按它们沿 down 链的终点分到各内流盆地，取格数最多的那个。
     否则会聚焦到一个只有 2 格入流的小盆地，两张图看不出任何差别。
   开关 = CONFIG.hydro.endorheicAsSink，所以这一步能单独体验、单独回退。 */
const sinkPick = await evaluate(`(() => {
  const P = window.__PLANET__, n = P.tiles.length;
  const setState = (on) => { P.CONFIG.hydro.endorheicAsSink = on; P.refresh(); return P.hydro(); };
  const hyOff = setState(false);
  const offRivers = new Uint8Array(n);
  for (let i = 0; i < n; i++) offRivers[i] = hyOff.isRiver[i];
  const offCount = hyOff.riverCount;
  const hyOn = setState(true);
  const onCount = hyOn.riverCount;
  P.setVisibleOverlays(null); P.setVisibleBiomes(null);

  const ghost = new Map();                       // 每个内流盆地分到多少幽灵河格（−1 = 没分到）
  for (let i = 0; i < n; i++) {
    if (!offRivers[i] || hyOn.isRiver[i]) continue;
    // ★ 幽灵河是从内流盆地**流出来**的，所以沿 down 链走会**先经过**那个盆地格，
    //   再穿过填平面一路到海 —— 取的是**第一个**内流盆地格，不是链的终点。
    let cur = i, hops = 0, sinkId = -1;
    while (cur >= 0 && hops++ < 2000) {
      const id = hyOff.lakeId[cur];
      if (id >= 0 && hyOff.lakes[id].isEndorheic) { sinkId = id; break; }
      cur = hyOff.down[cur];
    }
    ghost.set(sinkId, (ghost.get(sinkId) || 0) + 1);
  }
  let bestId = -1, bestCnt = 0, ghostTotal = 0;
  for (const [id, c] of ghost) { ghostTotal += c; if (id >= 0 && c > bestCnt) { bestId = id; bestCnt = c; } }
  if (bestId < 0) {
    return { id: -1, cell: -1, ghost: 0, ghostTotal, offCount, onCount,
      blocked: hyOn.sinkBlocked, rounds: hyOn.sinkRounds, dist: [...ghost.entries()] };
  }
  let cell = -1;
  for (let i = 0; i < n; i++) {
    if (hyOff.lakeId[i] !== bestId) continue;
    if (cell < 0 || P.tiles[i].elevation < P.tiles[cell].elevation) cell = i;
  }
  return { id: bestId, cell, ghost: bestCnt, ghostTotal, offCount, onCount,
    blocked: hyOn.sinkBlocked, rounds: hyOn.sinkRounds };
})()`);

if (sinkPick && sinkPick.id >= 0) {
  const setSink = (on) => evaluate(`(() => {
    window.__PLANET__.CONFIG.hydro.endorheicAsSink = ${on};
    window.__PLANET__.refresh();
    window.__PLANET__.setVisibleOverlays(null); window.__PLANET__.setVisibleBiomes(null); })()`);
  await setSink(false);
  await sleep(1200);
  shots.sinkOff = await nearShot('sink-off', sinkPick.cell);
  await setSink(true);
  await sleep(1200);
  shots.sinkOn = await nearShot('sink-on', sinkPick.cell);
  console.log(`√ 近景：H4.5 开关对照（内流盆地 #${sinkPick.id}）` +
    `｜幽灵河共 ${sinkPick.ghostTotal} 格，其中 ${sinkPick.ghost} 格连到这个盆地` +
    `｜河格 ${sinkPick.offCount}（关）→ ${sinkPick.onCount}（开）· 清零出边 ${sinkPick.blocked} 条 · ${sinkPick.rounds} 轮收敛`);
} else if (sinkPick) {
  console.log(`△ H4.5 开关对照跳过：幽灵河共 ${sinkPick.ghostTotal} 格，但没有一格连到内流盆地` +
    `（关 ${sinkPick.offCount} 格 → 开 ${sinkPick.onCount} 格｜分布 ${JSON.stringify(sinkPick.dist)}）`);
}
await resetZoom();

/* ---------- 汇总 ---------- */
const stats = await evaluate(`(() => {
  const P = window.__PLANET__, hy = P.hydro(), rs = P.river();
  const info = P.stats();
  const selfTest = P.selfTest;
  return {
    river: {
      vertexCount: rs.vertexCount, triCount: rs.triCount, chains: rs.chains,
      spacing: +rs.spacing.toFixed(5), buildMs: rs.ms,
      gridFingerprintPct: rs.gridFingerprintPct, gridFingerprintRawPct: rs.gridFingerprintRawPct,
      gridStraightPct: rs.gridStraightPct,
    },
    drawCalls: info.drawCalls, meshCount: info.meshCount, triangles: info.triangles,
    fps: info.fps,
    buildTimings: P.buildTimings,
    /* ★ 这里是"截图会话跑完之后"再量一次 —— 只作对照，**报告里不用这个数**：
       截图会话会把主线程拖慢（见文件上方 cleanTiming 的说明）。 */
    lateTiming: (() => {
      const t0 = performance.now();
      P.refresh();
      const t1 = performance.now();
      return { refreshMs: +(t1 - t0).toFixed(1), riverMs: P.river().ms, hydroMs: P.hydro().ms };
    })(),
    lakes: {
      count: hy.lakes.length,
      endorheic: hy.lakes.filter((l) => l.isEndorheic).length,
      endorheicDry: hy.lakes.filter((l) => l.isEndorheic && l.wetArea === 0).length,
      tiers: { shallow: hy.lakes.filter((l) => l.tier === 'shallow').length,
        deep: hy.lakes.filter((l) => l.tier === 'deep').length,
        salt: hy.lakes.filter((l) => l.tier === 'salt').length },
      largestWet: Math.max(0, ...hy.lakes.map((l) => l.wetArea)),
      lakeCells: (() => { let c = 0; for (let i = 0; i < P.tiles.length; i++) if (hy.lakeId[i] >= 0) c++; return c; })(),
      riverCellsInLake: (() => { let c = 0; for (let i = 0; i < P.tiles.length; i++) if (hy.lakeId[i] >= 0 && hy.isRiver[i]) c++; return c; })(),
      lakeBreaks: rs.lakeBreaks, lineCells: rs.lineCells,
      // ★ H4.5：内流盆地当"汇"（sinkBlocked > 0 = 水真的被内流盆地拦住了）
      sinkRounds: hy.sinkRounds, sinkBlocked: hy.sinkBlocked,
      sinkCells: (() => { let c = 0; for (let i = 0; i < P.tiles.length; i++) {
        const id = hy.lakeId[i]; if (id >= 0 && hy.lakes[id].isEndorheic) c++; } return c; })(),
      sinkRivers: (() => { let c = 0; for (let i = 0; i < P.tiles.length; i++) {
        const d = hy.down[i];
        if (hy.isRiver[i] && d >= 0) { const id = hy.lakeId[d]; if (id >= 0 && hy.lakes[id].isEndorheic) c++; } } return c; })(),
      overlays: P.overlays(),
    },
    selfTest: selfTest ? {
      total: selfTest.rows.length,
      passed: selfTest.rows.filter((r) => r.ok).length,
      failed: selfTest.rows.filter((r) => !r.ok).map((r) => ({ name: r.name, detail: r.detail })),
    } : null,
  };
})()`);
console.log('');
console.log(`河网几何体：${stats.river.triCount} 三角形 / ${stats.river.vertexCount} 顶点 / ${stats.river.chains} 条链` +
  `（建模 ${stats.river.buildMs} ms，格间距 ${stats.river.spacing}）`);
console.log(`refresh() 实测（★ 零截图会话，报告用这个）：整条 ${range(cleanTiming.map((r) => r.all))}` +
  `（水文 ${range(cleanTiming.map((r) => r.hydro))} + 河网重建 ${range(cleanTiming.map((r) => r.river))}）`);
console.log(`  对照 · 截图会话之后同一次 refresh：${stats.lateTiming.refreshMs} ms` +
  `（水文 ${stats.lateTiming.hydroMs} + 河网 ${stats.lateTiming.riverMs}）—— 只说明截图会话会拖慢主线程`);
console.log(`draw call = ${stats.drawCalls}｜Mesh ${stats.meshCount} 个｜三角形 ${stats.triangles}`);
console.log(`湖泊（★ H4）：${stats.lakes.count} 个（最大湿面积 ${stats.lakes.largestWet} 格）· ` +
  `内流 ${stats.lakes.endorheic} 个（干底 ${stats.lakes.endorheicDry}）· ` +
  `分档 浅 ${stats.lakes.tiers.shallow}/深 ${stats.lakes.tiers.deep}/盐 ${stats.lakes.tiers.salt} · ` +
  `湖面格 ${stats.lakes.lakeCells}（其中河格 ${stats.lakes.riverCellsInLake}）· ` +
  `画线格 ${stats.lakes.lineCells} · ${stats.lakes.lakeBreaks} 条链收口在湖岸`);
console.log(`★ H4.5 内流盆地当"汇"：清零出边 ${stats.lakes.sinkBlocked} 条 · ${stats.lakes.sinkRounds} 轮收敛 · ` +
  `盆地格 ${stats.lakes.sinkCells} 个 · 进盆地的河格 ${stats.lakes.sinkRivers} 个` +
  `（这些河最终不入海 → 入海率 < 100%）`);
console.log(`生成耗时：${JSON.stringify(stats.buildTimings)}`);
console.log(`页面自测：${stats.selfTest ? `${stats.selfTest.passed}/${stats.selfTest.total} 通过` : '（无 selfTest）'}`);
if (stats.selfTest && stats.selfTest.failed.length) {
  for (const f of stats.selfTest.failed) console.log(`  ✗ ${f.name}：${f.detail}`);
}
if (stats.drawCalls > 3) console.log(`⚠ draw call ${stats.drawCalls} > 3：河网层把预算撑破了`);

const out = path.join(ROOT, 'tools', 'out', 'shot-river.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ page: 'index.html', trunk: info, near, thresholds, inventory: inv.top, shots, stats }, null, 2));
console.log(`\n截图 → ${path.relative(ROOT, OUT)}\\*.png`);

ws.close(); child.kill(); await sleep(400);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { }
process.exit(0);
