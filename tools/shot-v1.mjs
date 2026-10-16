/**
 * v1（archive/v1-biome-globe.html）观察脚本：
 *   ① 注入 hook 拿到 tiles（v1 没有 __PLANET__ 导出，只能从 Mesh 的 userData.tile 反向取）
 *   ② 统计生物群系 / 气候带 / 海陆连通性 / 河网拓扑（自然角度分析用）
 *   ③ 多视角截图 + 河流层单独截图
 * 用法：node shot-v1.mjs [tag]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toUrl = (p) => 'file:///' + p.replace(/\\/g, '/');
// 换机器时用环境变量覆盖：CHROME_PATH / PLANET_PAGE
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/matt/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const PAGE = toUrl(process.env.PLANET_PAGE || path.join(ROOT, 'archive', 'v1-biome-globe.html'));
const PORT = 9405;
const OUT = path.join(ROOT, 'docs', 'v1-shots');
const TAG = process.argv[2] || 'v1';

const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'cdp-v1-'));
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
const t = await waitJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, 20, 'PUT');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };

await send('Runtime.enable');
await send('Page.enable');

// ── 注入 hook：拦截 tileMeshes.push(tileMesh)，把 tile 与 planetGroup 暴露到 window ──
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const origPush = Array.prototype.push;
  Array.prototype.push = function (...args) {
    if (args.length === 1) {
      const a = args[0];
      if (a && a.isMesh === true && a.userData && a.userData.tile) {
        // 注意：tileMeshes.push(mesh) 与 planetGroup.add(mesh) 各会 push 一次同一个 mesh，
        // 必须按对象去重，否则 tiles 数组长度翻倍、tile.index 与数组下标错位。
        const arr = window.__v1tiles || (window.__v1tiles = []);
        if (arr[arr.length - 1] !== a.userData.tile) arr[arr.length] = a.userData.tile;
        if (!window.__v1group) window.__v1group = a.parent || null;
      }
    }
    return origPush.apply(this, args);
  };
})();` });

await send('Page.navigate', { url: PAGE });
for (let i = 0; i < 180; i++) {
  await sleep(1000);
  if (await evaluate('!!window.__planetReady && !!(window.__v1tiles && window.__v1tiles.length)')) break;
}
await sleep(2500);
console.log('LOADED tiles =', await evaluate('(window.__v1tiles||[]).length'));

// ── 统计（自然角度分析）──
const stats = await evaluate(`(() => {
  const tiles = window.__v1tiles || [];
  const SEA = 0.35, SNOW_LV = 0.80, MTN_LV = 0.65;
  const n = tiles.length;

  // 邻接：两个 tile 共享 >= 2 个对偶顶点
  const byVert = new Map();
  for (const t of tiles) for (const vi of t.vertexIndices) {
    let a = byVert.get(vi); if (!a) { a = []; byVert.set(vi, a); } a[a.length] = t;
  }
  const adj = new Map();
  for (const t of tiles) {
    const cnt = new Map();
    for (const vi of t.vertexIndices) for (const o of byVert.get(vi)) if (o !== t) cnt.set(o, (cnt.get(o) || 0) + 1);
    const s = new Set();
    for (const [o, c] of cnt) if (c >= 2) s.add(o.index);
    adj.set(t.index, s);
  }
  const neighborCounts = [];
  for (const t of tiles) neighborCounts.push(adj.get(t.index).size);

  // ── 按群系统计 ──
  const bio = {};
  for (const t of tiles) {
    let r = bio[t.biome]; if (!r) { r = bio[t.biome] = { count: 0, latSum: 0, tempSum: 0, moistSum: 0, elevSum: 0, latAbs: [], elevs: [] }; }
    const al = Math.abs(t.latitude);
    r.count++; r.latSum += al; r.tempSum += t.temperature; r.moistSum += t.moisture; r.elevSum += t.elevation;
    r.latAbs[r.latAbs.length] = al; r.elevs[r.elevs.length] = t.elevation;
  }
  const pct = (arr, q) => { const a = Array.from(arr).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))] : 0; };
  const bioOut = {};
  for (const k of Object.keys(bio)) {
    const r = bio[k];
    bioOut[k] = {
      count: r.count, pct: +(r.count / n * 100).toFixed(2),
      latAbsQ: [pct(r.latAbs, 0.05), pct(r.latAbs, 0.5), pct(r.latAbs, 0.95)].map((v) => +v.toFixed(3)),
      temp: +(r.tempSum / r.count).toFixed(3), moist: +(r.moistSum / r.count).toFixed(3),
      elev: +(r.elevSum / r.count).toFixed(3),
      elevQ: [pct(r.elevs, 0.05), pct(r.elevs, 0.5), pct(r.elevs, 0.95)].map((v) => +v.toFixed(3)),
    };
  }

  // ── 纬向分桶：温度 / 湿度 随 |lat| 的变化（检验三圈环流）──
  const BUCK = 10;
  const latBucket = [];
  for (let b = 0; b < BUCK; b++) latBucket.push({ n: 0, temp: 0, moist: 0, land: 0, desert: 0, rainforest: 0, ice: 0, tundra: 0, taiga: 0, forest: 0, grassland: 0 });
  for (const t of tiles) {
    const b = Math.min(BUCK - 1, Math.floor(Math.abs(t.latitude) * BUCK));
    const r = latBucket[b];
    r.n++; r.temp += t.temperature; r.moist += t.moisture;
    if (t.elevation > SEA) { r.land++; if (t.biome === 'desert') r.desert++; if (t.biome === 'rainforest') r.rainforest++; if (t.biome === 'ice') r.ice++; if (t.biome === 'tundra') r.tundra++; if (t.biome === 'taiga') r.taiga++; if (t.biome === 'forest') r.forest++; if (t.biome === 'grassland') r.grassland++; }
  }
  const latProfile = latBucket.map((r, b) => ({
    lat: b + '0-' + (b + 1) + '0%', n: r.n,
    temp: +(r.temp / r.n).toFixed(3), moist: +(r.moist / r.n).toFixed(3),
    landPct: +(r.land / r.n * 100).toFixed(1),
    desert: r.desert, rainforest: r.rainforest, ice: r.ice, tundra: r.tundra, taiga: r.taiga, forest: r.forest, grassland: r.grassland,
  }));

  // ── 海陆连通性（岛屿 / 大陆块）──
  const comps = (pred) => {
    const seen = new Set(), out = [];
    for (const t of tiles) {
      if (!pred(t) || seen.has(t.index)) continue;
      const st = [t.index]; seen.add(t.index); let c = 0;
      while (st.length) { const i = st.pop(); c++; for (const j of adj.get(i)) if (!seen.has(j) && pred(tiles[j])) { seen.add(j); st.push(j); } }
      out.push(c);
    }
    out.sort((a, b) => b - a);
    return out;
  };
  const landComps = comps((t) => t.elevation > SEA);
  const seaComps = comps((t) => t.elevation <= SEA);
  const landTotal = landComps.reduce((s, v) => s + v, 0);
  const seaTotal = seaComps.reduce((s, v) => s + v, 0);
  const landSizeHist = {}; for (const c of landComps) { const k = c === 1 ? '1' : c <= 4 ? '2-4' : c <= 16 ? '5-16' : c <= 64 ? '17-64' : '65+'; landSizeHist[k] = (landSizeHist[k] || 0) + 1; }

  // ── 河网拓扑（关键：树状 vs 网眼 vs 散点）──
  const riv = tiles.filter((t) => t.biome === 'river');
  const rivSet = new Set(riv.map((t) => t.index));
  const deg = new Map();
  let E = 0;
  for (const t of riv) { let d = 0; for (const j of adj.get(t.index)) if (rivSet.has(j)) d++; deg.set(t.index, d); E += d; }
  E /= 2;
  const degHist = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const [, d] of deg) degHist[Math.min(6, d)]++;
  // 连通分量 + 环数（cyclomatic = E - V + C）
  const seenR = new Set(); const rivComps = [];
  for (const t of riv) {
    if (seenR.has(t.index)) continue;
    const st = [t.index]; seenR.add(t.index); let c = 0, e2 = 0;
    while (st.length) { const i = st.pop(); c++; for (const j of adj.get(i)) if (rivSet.has(j)) { e2++; if (!seenR.has(j)) { seenR.add(j); st.push(j); } } }
    rivComps.push({ v: c, e: e2 / 2 });
  }
  rivComps.sort((a, b) => b.v - a.v);
  const loops = rivComps.reduce((s, c) => s + (c.e - c.v + 1), 0);

  // ── 不合理邻接检查（雨林 ↔ 冰原）──
  let badAdj = 0;
  for (const t of tiles) {
    if (t.biome !== 'rainforest') continue;
    for (const j of adj.get(t.index)) if (tiles[j].biome === 'ice' || tiles[j].biome === 'snow') badAdj++;
  }

  // 统计与气候阈值相关的越界样本
  let rainforestHighLat = 0, iceLowLat = 0, snowLowLat = 0, riverHighElev = 0;
  for (const t of tiles) {
    const al = Math.abs(t.latitude);
    if (t.biome === 'rainforest' && al > 0.6) rainforestHighLat++;
    if (t.biome === 'ice' && al < 0.85) iceLowLat++;
    if (t.biome === 'snow' && al < 0.3) snowLowLat++;
    if (t.biome === 'river' && t.elevation > 0.62) riverHighElev++;
  }

  let land = 0, seaIce = 0, snow = 0, mtn = 0;
  for (const t of tiles) { if (t.elevation > SEA) land++; if (t.biome === 'seaIce') seaIce++; if (t.biome === 'snow') snow++; if (t.biome === 'mountain') mtn++; }

  // ── 补充证据：陆地在各纬度桶内的湿度标准差 / 绝对零湿度占比 ──
  const b2 = [];
  for (let b = 0; b < BUCK; b++) b2.push({ n: 0, s: 0, s2: 0, zero: 0 });
  for (const t of tiles) {
    if (t.elevation <= SEA) continue;
    const b = Math.min(BUCK - 1, Math.floor(Math.abs(t.latitude) * BUCK));
    const r = b2[b]; r.n++; r.s += t.moisture; r.s2 += t.moisture * t.moisture; if (t.moisture === 0) r.zero++;
  }
  const moistStd = b2.map((r) => { if (!r.n) return 0; const m = r.s / r.n; return +Math.sqrt(Math.max(0, r.s2 / r.n - m * m)).toFixed(4); });
  const moistZeroPct = b2.map((r) => (r.n ? +(r.zero / r.n * 100).toFixed(1) : 0));

  // ── 陆地海拔基线 vs 河流海拔 ──
  const landElevs = [], rivElevs = [];
  for (const t of tiles) {
    if (t.elevation > SEA) landElevs[landElevs.length] = t.elevation;
    if (t.biome === 'river') rivElevs[rivElevs.length] = t.elevation;
  }
  const qq = (a, q) => { const s = Array.from(a).sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))].toFixed(4) : 0; };
  const elevStat = (a) => ({ n: a.length, avg: +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(4), q05: qq(a, 0.05), q25: qq(a, 0.25), q50: qq(a, 0.5), q75: qq(a, 0.75), q95: qq(a, 0.95) });

  // ── 经向差异：副热带陆地带的湿度分布（平均 / 标准差 / 绝对零占比）──
  const subM = [];
  for (const t of tiles) { const al = Math.abs(t.latitude); if (t.elevation > SEA && al >= 0.25 && al <= 0.55) subM[subM.length] = t.moisture; }
  const subMean = subM.reduce((s, v) => s + v, 0) / (subM.length || 1);
  const subStd = Math.sqrt(subM.reduce((s, v) => s + (v - subMean) * (v - subMean), 0) / (subM.length || 1));
  const subZero = subM.filter((v) => v === 0).length;

  // ── 河网"是否贴谷底"：与它所在纬度桶的低地群系对比（森林/草原/沙漠）──
  const lowland = [];
  for (const t of tiles) if (t.biome === 'forest' || t.biome === 'grassland' || t.biome === 'desert') lowland[lowland.length] = t.elevation;

  return {
    n, land, landPct: +(land / n * 100).toFixed(2),
    seaPct: +((n - land) / n * 100).toFixed(2),
    seaIce, snow, mtn,
    neighborDegMin: Math.min(...neighborCounts), neighborDegMax: Math.max(...neighborCounts),
    bio: bioOut, latProfile, moistStd, moistZeroPct,
    landElev: elevStat(landElevs),
    rivElev: elevStat(rivElevs),
    lowlandElev: elevStat(lowland),
    subtropicLand: { n: subM.length, mean: +subMean.toFixed(4), std: +subStd.toFixed(4), zeroPct: +(subZero / (subM.length || 1) * 100).toFixed(1) },
    landComps: { count: landComps.length, biggest: landComps[0], biggestPct: +(landComps[0] / landTotal * 100).toFixed(2), sizeHist: landSizeHist, top: landComps.slice(0, 8), total: landTotal },
    seaComps: { count: seaComps.length, biggest: seaComps[0], biggestPct: +(seaComps[0] / seaTotal * 100).toFixed(2), top: seaComps.slice(0, 8), total: seaTotal },
    river: {
      count: riv.length, pctOfLand: +(riv.length / land * 100).toFixed(2),
      avgElev: +(riv.reduce((s, t) => s + t.elevation, 0) / riv.length).toFixed(3),
      degHist, edges: E, comps: rivComps.length, biggestComp: rivComps[0] ? rivComps[0].v : 0,
      loops, topComps: rivComps.slice(0, 8).map((c) => c.v),
      isolatedPct: +(degHist[0] / riv.length * 100).toFixed(1),
      endpointPct: +(degHist[1] / riv.length * 100).toFixed(1),
      junctionPct: +((degHist[3] + degHist[4] + degHist[5] + degHist[6]) / riv.length * 100).toFixed(1),
    },
    anomalies: { rainforestHighLat, iceLowLat, snowLowLat, riverHighElev, rainforestAdjIceOrSnow: badAdj },
  };
})()`);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${TAG}-stats.json`), JSON.stringify(stats, null, 2), 'utf8');
console.log('STATS', JSON.stringify(stats));

// ── 截图 ──
const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, `${TAG}-${name}.png`), Buffer.from(s.data, 'base64')); };
const setRot = async (xDeg, yDeg) => {
  await evaluate(`(() => { const g = window.__v1group; if (!g) return 0; g.rotation.x = ${xDeg}*Math.PI/180; g.rotation.y = ${yDeg}*Math.PI/180; return 1; })()`);
  await sleep(1400);
};
const hideUI = () => evaluate(`(() => { for (const id of ['hud','legend','hint']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } return 1; })()`);

// 带 UI 的默认视角（含悬停 HUD）
await setRot(0, 0);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 400, button: 'none' });
await sleep(1500);
await shot('ui-default');

await hideUI();
await setRot(0, 0); await shot('a0');
await setRot(0, 90); await shot('a90');
await setRot(0, 180); await shot('a180');
await setRot(0, 270); await shot('a270');
await setRot(90, 0); await shot('north');
await setRot(-90, 0); await shot('south');
await setRot(40, 0); await shot('mid40');

// 河流层单独看
await setRot(0, 0);
await evaluate(`(() => { const ts = window.__v1tiles; for (const t of ts) t.mesh.visible = (t.biome === 'river'); return 1; })()`);
await sleep(1200); await shot('river-only');
// 只留沙漠 + 热带雨林（看气候带的经向形态）
await evaluate(`(() => { const ts = window.__v1tiles; for (const t of ts) t.mesh.visible = (t.biome === 'desert' || t.biome === 'rainforest'); return 1; })()`);
await sleep(1200); await shot('desert-rainforest');
await evaluate(`(() => { const ts = window.__v1tiles; for (const t of ts) t.mesh.visible = true; return 1; })()`);
await sleep(800);

// 近景（滚轮放大）
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: -500 });
await sleep(400);
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: -500 });
await sleep(1600); await shot('close');

ws.close(); child.kill(); await sleep(500);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { }
process.exit(0);
