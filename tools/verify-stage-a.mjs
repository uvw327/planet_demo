/**
 * 阶段 A（P0-1 湿度悬崖）验收脚本：
 *   ① 实机加载 index.html，用 window.__PLANET__ 直取 tiles
 *   ② 输出阶段 A 的验收指标（零湿度占比 / 副热带湿度标准差 / 群系占比 / 纬向剖面 / 越界检查）
 *   ③ 截多视角图，保存到 docs/stage-a-shots/
 * 用法：node verify-a.mjs
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
const PAGE = toUrl(process.env.PLANET_PAGE || path.join(ROOT, 'index.html'));
const PORT = 9415;
const OUT = path.join(ROOT, 'docs', 'stage-a-shots');

const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'cdp-a-'));
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
await send('Page.navigate', { url: PAGE });
for (let i = 0; i < 180; i++) {
  await sleep(1000);
  if (await evaluate('!!(window.__PLANET__ && window.__PLANET__.tiles)')) break;
}
await sleep(2500);
console.log('LOADED tiles =', await evaluate('window.__PLANET__.tiles.length'));

fs.mkdirSync(OUT, { recursive: true });

// ── 统计 ──
const stats = await evaluate(`(() => {
  const P = window.__PLANET__, C = P.CONFIG, tiles = P.tiles;
  const SEA = C.seaLevel, SNOW_LV = 0.80, MTN_LV = 0.65;
  const n = tiles.length;

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

  const bio = {};
  for (const t of tiles) {
    let r = bio[t.biome]; if (!r) { r = bio[t.biome] = { count: 0, latAbs: [], elevs: [], tempSum: 0, moistSum: 0 }; }
    const al = Math.abs(t.latitude);
    r.count++; r.latAbs[r.latAbs.length] = al; r.elevs[r.elevs.length] = t.elevation;
    r.tempSum += t.temperature; r.moistSum += t.moisture;
  }
  const pct = (arr, q) => { const a = Array.from(arr).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))] : 0; };
  const round = (v, d = 3) => +v.toFixed(d);

  let land = 0;
  for (const t of tiles) if (t.elevation > SEA) land++;
  const bioOut = {};
  for (const k of Object.keys(bio)) {
    const r = bio[k];
    bioOut[k] = {
      count: r.count, pctOfAll: round(r.count / n * 100, 2),
      pctOfLand: t_(r.count, k),
      latAbsQ: [pct(r.latAbs, 0.05), pct(r.latAbs, 0.5), pct(r.latAbs, 0.95)].map((v) => round(v)),
      temp: round(r.tempSum / r.count), moist: round(r.moistSum / r.count),
      elev: round(pct(r.elevs, 0.5)),
    };
  }
  function t_(c, k) { return (k === 'ocean' || k === 'seaIce') ? round(c / (n - land) * 100, 2) : round(c / land * 100, 2); }

  // 纬向剖面（温度 / 湿度 / 陆地湿度标准差 / 零湿度占比 / 各群系计数）
  const BUCK = 10, latBucket = [];
  for (let b = 0; b < BUCK; b++) latBucket.push({ n: 0, landN: 0, temp: 0, moist: 0, s2: 0, zero: 0, desert: 0, grassland: 0, forest: 0, rainforest: 0, taiga: 0, tundra: 0, ice: 0 });
  for (const t of tiles) {
    const b = Math.min(BUCK - 1, Math.floor(Math.abs(t.latitude) * BUCK));
    const r = latBucket[b];
    r.n++; r.temp += t.temperature;
    if (t.elevation > SEA) {
      r.landN++; r.moist += t.moisture; r.s2 += t.moisture * t.moisture;
      if (t.moisture === 0) r.zero++;
      for (const k of ['desert', 'grassland', 'forest', 'rainforest', 'taiga', 'tundra', 'ice']) if (t.biome === k) r[k]++;
    }
  }
  const latProfile = latBucket.map((r, b) => {
    const m = r.landN ? r.moist / r.landN : 0;
    return {
      lat: b + '0-' + (b + 1) + '0%', n: r.n, landN: r.landN,
      temp: round(r.temp / r.n), moistLand: round(m),
      moistStd: r.landN ? round(Math.sqrt(Math.max(0, r.s2 / r.landN - m * m)), 4) : 0,
      zeroPct: r.landN ? round(r.zero / r.landN * 100, 1) : 0,
      desert: r.desert, grassland: r.grassland, forest: r.forest, rainforest: r.rainforest,
      taiga: r.taiga, tundra: r.tundra, ice: r.ice,
    };
  });

  // 副热带陆地带（|lat| 0.25~0.55）—— P0-1 的主战场
  const sub = [];
  for (const t of tiles) { const al = Math.abs(t.latitude); if (t.elevation > SEA && al >= 0.25 && al <= 0.55) sub[sub.length] = t.moisture; }
  const subMean = sub.reduce((s, v) => s + v, 0) / (sub.length || 1);
  const subStd = Math.sqrt(sub.reduce((s, v) => s + (v - subMean) * (v - subMean), 0) / (sub.length || 1));
  const subZero = sub.filter((v) => v === 0).length;

  // 湿度=0 的陆地总数
  let zeroLand = 0;
  for (const t of tiles) if (t.elevation > SEA && t.moisture === 0) zeroLand++;

  // 「参与湿度分类的陆地」的湿度分位（阈值标定依据）
  const cls = [];
  for (const t of tiles) {
    if (t.elevation <= SEA) continue;
    if (t.elevation > MTN_LV || t.temperature < C.tempIce || t.river || t.temperature < C.tempTundra || t.temperature < C.tempTaiga) continue;
    cls.push(t.moisture);
  }
  const clsSorted = Array.from(cls).sort((a, b) => a - b);
  const cq = (p) => clsSorted.length ? round(clsSorted[Math.min(clsSorted.length - 1, Math.floor(p * (clsSorted.length - 1)))], 4) : 0;

  // 不许退步的三条回归红线
  let rainforestHighLat = 0, iceLowLat = 0, snowLowLat = 0, equatorSnow = 0;
  let tempMonoOK = true, prevT = null;
  for (const r of latProfile) { if (prevT !== null && r.temp > prevT + 1e-9) tempMonoOK = false; prevT = r.temp; }
  for (const t of tiles) {
    const al = Math.abs(t.latitude);
    if (t.biome === 'rainforest' && al > 0.6) rainforestHighLat++;
    if (t.biome === 'ice' && al < 0.85) iceLowLat++;
    if (t.biome === 'snow' && al < 0.3) snowLowLat++;
    if (t.biome === 'snow' && al < 0.3) equatorSnow++;
  }
  const rfLat = [];
  for (const t of tiles) if (t.biome === 'rainforest') rfLat.push(Math.abs(t.latitude));

  // 邻接不合理：雨林 ↔ 冰原 / 沙漠 ↔ 雨林 直接相邻
  let rfAdjIce = 0, desertAdjRainforest = 0, desertAdjIce = 0;
  for (const t of tiles) {
    for (const j of adj.get(t.index)) {
      const o = tiles[j], b1 = t.biome, b2 = o.biome;
      if ((b1 === 'rainforest' && b2 === 'ice') || (b1 === 'ice' && b2 === 'rainforest')) rfAdjIce++;
      if ((b1 === 'desert' && b2 === 'rainforest') || (b1 === 'rainforest' && b2 === 'desert')) desertAdjRainforest++;
      if ((b1 === 'desert' && b2 === 'ice') || (b1 === 'ice' && b2 === 'desert')) desertAdjIce++;
    }
  }

  // 直方图（检验「是否仍然堆积在某个值」）—— 全陆地，20 个 bin
  const BINS = 20, hist = new Array(BINS).fill(0);
  let histN = 0;
  for (const t of tiles) if (t.elevation > SEA) { hist[Math.min(BINS - 1, Math.floor(t.moisture * BINS))]++; histN++; }
  const histPct = hist.map((c) => round(c / histN * 100, 1));
  const maxBinPct = Math.max(...histPct);

  return {
    n, land, landPct: round(land / n * 100, 2), seaPct: round((n - land) / n * 100, 2),
    bio: bioOut,
    latProfile,
    subtropicLand: { n: sub.length, mean: round(subMean, 4), std: round(subStd, 4), zeroPct: round(subZero / (sub.length || 1) * 100, 1) },
    zeroLandPct: round(zeroLand / land * 100, 2),
    clsCount: cls.length, clsPctOfLand: round(cls.length / land * 100, 1),
    clsPercentiles: { p05: cq(0.05), p15: cq(0.15), p25: cq(0.25), p35: cq(0.35), p50: cq(0.5), p65: cq(0.65), p75: cq(0.75), p85: cq(0.85), p95: cq(0.95) },
    moistureHist: histPct, maxBinPct,
    regression: { tempMonoOK, rainforestHighLat, rainforestLatP95: round(pct(rfLat, 0.95)), iceLowLat, snowLowLat, equatorSnow },
    anomalies: { rfAdjIce, desertAdjRainforest, desertAdjIce },
  };
})()`);

fs.writeFileSync(path.join(OUT, 'stage-a-stats.json'), JSON.stringify(stats, null, 2), 'utf8');
console.log(JSON.stringify(stats, null, 2));

// ── 截图 ──
const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, `stage-a-${name}.png`), Buffer.from(s.data, 'base64')); };
const setRot = async (xDeg, yDeg) => {
  await evaluate(`(() => { const g = window.__PLANET__.tiles[0].mesh.parent; g.rotation.x = ${xDeg}*Math.PI/180; g.rotation.y = ${yDeg}*Math.PI/180; return 1; })()`);
  await sleep(1400);
};
const hideUI = () => evaluate(`(() => { for (const id of ['hud','legend','hint']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } return 1; })()`);

await setRot(0, 0);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 400, button: 'none' });
await sleep(1500);
await shot('ui-default');

await hideUI();
await setRot(0, 0); await shot('a0');
await setRot(0, 90); await shot('a90');
await setRot(0, 180); await shot('a180');
await setRot(0, 270); await shot('a270');
await setRot(37, 0); await shot('subtropic-front');   // 把副热带干旱带转到正面
await setRot(90, 0); await shot('north');
await setRot(-90, 0); await shot('south');

await evaluate(`(() => { const ts = window.__PLANET__.tiles; for (const t of ts) t.mesh.visible = (t.biome === 'desert' || t.biome === 'grassland'); return 1; })()`);
await setRot(0, 0); await sleep(400); await shot('desert-grassland');
await evaluate(`(() => { const ts = window.__PLANET__.tiles; for (const t of ts) t.mesh.visible = true; return 1; })()`);
await sleep(800);

await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: -500 });
await sleep(400);
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: -500 });
await sleep(1600); await shot('close');

ws.close(); child.kill(); await sleep(500);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { }
process.exit(0);
