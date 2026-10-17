/**
 * H3 截图：河网渲染层（三角带）。
 *
 * 五组图：
 *   ① 全球 4 视角（群系 + 河网叠在上面）—— 整体观感
 *   ② 「只留河线」2 视角（全部图块刷成背景色）—— 一眼判断是不是**树枝状水系**
 *   ③ 聚焦：转到「汇水面积最大的那一格」（主干）并推近，-full / -only 各一张
 *      —— 看"河是穿过格子的线，不是填满格子的色块"
 *   ④ 宽度-流量散点图（页内 canvas 画，不依赖 WebGL）
 *   ⑤ climateCoupling = 0 的对照图（全河等宽）—— 证明"粗细确实受降雨量影响"
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
for (let i = 0; i < 180; i++) { await sleep(1000); if (await evaluate('!!(window.__PLANET__ && window.__PLANET__.tiles)')) break; }
await sleep(2000);

const env = await evaluate(`(() => {
  const P = window.__PLANET__, C = P.CONFIG;
  if (!P) return { ok: false, why: '没有 __PLANET__' };
  if (C.riverWidth !== undefined) return { ok: false, why: 'CONFIG.riverWidth 仍在：页面是 H1 之前的版本' };
  if (!C.hydro || C.hydro.riverWidthScale === undefined) return { ok: false, why: 'CONFIG.hydro 里没有 H3 渲染参数' };
  if (!P.river || !P.riverMesh) return { ok: false, why: '__PLANET__.river / riverMesh 缺失：河网渲染层还没落地' };
  if (!P.river()) return { ok: false, why: '河网几何体没建出来' };
  return { ok: true, level: C.level, tiles: P.tiles.length };
})()`);
if (!env.ok) throw new Error(`页面状态不对：${env.why}（先关掉残留的 headless Chrome）`);
console.log(`页面就绪：level=${env.level}，图块 ${env.tiles} 个`);

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
console.log(`draw call = ${stats.drawCalls}｜Mesh ${stats.meshCount} 个｜三角形 ${stats.triangles}`);
console.log(`生成耗时：${JSON.stringify(stats.buildTimings)}`);
console.log(`页面自测：${stats.selfTest ? `${stats.selfTest.passed}/${stats.selfTest.total} 通过` : '（无 selfTest）'}`);
if (stats.selfTest && stats.selfTest.failed.length) {
  for (const f of stats.selfTest.failed) console.log(`  ✗ ${f.name}：${f.detail}`);
}
if (stats.drawCalls > 3) console.log(`⚠ draw call ${stats.drawCalls} > 3：河网层把预算撑破了`);

const out = path.join(ROOT, 'tools', 'out', 'shot-river.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ page: 'index.html', trunk: info, near, thresholds, shots, stats }, null, 2));
console.log(`\n截图 → ${path.relative(ROOT, OUT)}\\*.png`);

ws.close(); child.kill(); await sleep(400);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { }
process.exit(0);
