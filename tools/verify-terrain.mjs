/**
 * 地形地基验收：实机加载 index.html，量全部「陆块结构 + 群系占比」指标，
 * 逐条对照 docs/v1-biome-globe-review.md 的目标值，并检查三条"不许退步"的回归红线
 * 与渲染架构的回归（draw call / 三角形 / Mesh 数）。
 *
 * 用法：node tools/verify-terrain.mjs
 * 输出：docs/terrain-shots/terrain-stats.json + terrain-{0,90,180,270}.png
 *       指标不达标时退出码为 1。
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
const OUT = path.join(ROOT, 'docs', 'terrain-shots');

async function probePort(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); return !!r.ok; } catch { return false; }
}
async function pickFreePort() {
  for (let i = 0; i < 40; i++) { const p = 9500 + Math.floor(Math.random() * 400); if (!(await probePort(p))) return p; }
  throw new Error('找不到空闲调试端口：先关掉残留的 headless Chrome');
}
const PORT = Number(process.env.CDP_PORT || await pickFreePort());

const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'cdp-terrain-verify-'));
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
  const P = window.__PLANET__;
  if (!P) return { ok: false, why: '没有 __PLANET__' };
  if (P.CONFIG.landFraction === undefined) return { ok: false, why: 'CONFIG.landFraction 缺失' };
  if (P.CONFIG.elevationCenter !== undefined) return { ok: false, why: 'CONFIG.elevationCenter 仍在' };
  return { ok: true, level: P.CONFIG.level, seed: P.CONFIG.seed, tiles: P.tiles.length };
})()`);
if (!env.ok) throw new Error(`页面状态不对：${env.why}（先关掉残留的 headless Chrome）`);
console.log(`页面就绪：level=${env.level} seed=${env.seed} 图块 ${env.tiles} 个`);

/* ---------- 取数 ---------- */
const S = await evaluate(`(() => {
  const P = window.__PLANET__, C = P.CONFIG, tiles = P.tiles;
  const n = tiles.length, SEA = C.seaLevel, MTN_LV = 0.65;
  const round = (v, d = 3) => +v.toFixed(d);
  const pct = (arr, q) => { const a = Array.from(arr).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))] : 0; };

  // 邻接：两格共享 >= 2 个对偶顶点 ⇔ 共边
  const byVert = new Map();
  for (const t of tiles) for (const vi of t.vertexIndices) { let a = byVert.get(vi); if (!a) { a = []; byVert.set(vi, a); } a[a.length] = t; }
  const adj = new Array(n);
  for (const t of tiles) {
    const cnt = new Map();
    for (const vi of t.vertexIndices) for (const o of byVert.get(vi)) if (o !== t) cnt.set(o, (cnt.get(o) || 0) + 1);
    const s = []; for (const [o, c] of cnt) if (c >= 2) s.push(o.index);
    adj[t.index] = s;
  }
  const comps = (pred) => {
    const seen = new Uint8Array(n), out = [];
    for (const t of tiles) {
      const i0 = t.index; if (!pred(tiles[i0]) || seen[i0]) continue;
      const st = [i0]; seen[i0] = 1; let c = 0;
      while (st.length) { const i = st.pop(); c++; for (const j of adj[i]) if (!seen[j] && pred(tiles[j])) { seen[j] = 1; st.push(j); } }
      out.push(c);
    }
    out.sort((a, b) => b - a); return out;
  };

  let land = 0, mtnSnow = 0, clsLand = 0, zeroLand = 0, coastEdges = 0;
  const bio = {}, elevs = [];
  for (const t of tiles) {
    bio[t.biome] = (bio[t.biome] || 0) + 1;
    elevs.push(t.elevation);
    if (t.elevation <= SEA) continue;
    land++; elevs.length;
    if (t.elevation > MTN_LV) mtnSnow++;
    if (t.moisture === 0) zeroLand++;
    if (!(t.elevation > MTN_LV || t.temperature < C.tempIce || t.river
          || t.temperature < C.tempTundra || t.temperature < C.tempTaiga)) clsLand++;
    for (const j of adj[t.index]) if (tiles[j].elevation <= SEA) coastEdges++;
  }
  const lc = comps((t) => t.elevation > SEA);
  const sc = comps((t) => t.elevation <= SEA);
  const landTotal = lc.reduce((s, v) => s + v, 0);
  const seaTotal = sc.reduce((s, v) => s + v, 0);
  const ofLand = (k) => bio[k] ? round(bio[k] / land * 100, 2) : 0;
  const ofSea = (k) => bio[k] ? round(bio[k] / (n - land) * 100, 2) : 0;

  // 纬向剖面（M26 温度单调性 + 阶段 A 的湿度红线）
  const BUCK = 10, lat = [];
  for (let b = 0; b < BUCK; b++) lat.push({ n: 0, landN: 0, temp: 0, moist: 0, s2: 0, zero: 0 });
  for (const t of tiles) {
    const b = Math.min(BUCK - 1, Math.floor(Math.abs(t.latitude) * BUCK));
    const r = lat[b]; r.n++; r.temp += t.temperature;
    if (t.elevation > SEA) { r.landN++; r.moist += t.moisture; r.s2 += t.moisture * t.moisture; if (t.moisture === 0) r.zero++; }
  }
  const latProfile = lat.map((r, b) => {
    const m = r.landN ? r.moist / r.landN : 0;
    return { lat: '0.' + b, n: r.n, landN: r.landN, temp: round(r.temp / r.n), moistLand: round(m),
      moistStd: r.landN ? round(Math.sqrt(Math.max(0, r.s2 / r.landN - m * m)), 4) : 0,
      zeroPct: r.landN ? round(r.zero / r.landN * 100, 1) : 0 };
  });
  let tempMonoOK = true, prev = null;
  for (const r of latProfile) { if (prev !== null && r.temp > prev + 1e-9) tempMonoOK = false; prev = r.temp; }

  // 副热带陆地带（P0-1 的主战场）
  const sub = [];
  for (const t of tiles) { const al = Math.abs(t.latitude); if (t.elevation > SEA && al >= 0.25 && al <= 0.55) sub.push(t.moisture); }
  const subMean = sub.reduce((s, v) => s + v, 0) / (sub.length || 1);
  const subStd = Math.sqrt(sub.reduce((s, v) => s + (v - subMean) ** 2, 0) / (sub.length || 1));

  // 湿度直方图（20 bin）—— 检验是否仍堆积在某个值
  const BINS = 20, hist = new Array(BINS).fill(0); let hn = 0;
  for (const t of tiles) if (t.elevation > SEA) { hist[Math.min(BINS - 1, Math.floor(t.moisture * BINS))]++; hn++; }
  const histPct = hist.map((c) => round(c / hn * 100, 1));

  // 三条"不许退步"的回归红线
  let rainforestHighLat = 0, iceLowLat = 0, snowLowLat = 0, rfAdjIce = 0;
  const rfLat = [];
  for (const t of tiles) {
    const al = Math.abs(t.latitude);
    if (t.biome === 'rainforest') { rfLat.push(al); if (al > 0.6) rainforestHighLat++; }
    if (t.biome === 'ice' && al < 0.85) iceLowLat++;
    if (t.biome === 'snow' && al < 0.3) snowLowLat++;
    for (const j of adj[t.index]) {
      const b2 = tiles[j].biome;
      if ((t.biome === 'rainforest' && b2 === 'ice') || (t.biome === 'ice' && b2 === 'rainforest')) rfAdjIce++;
    }
  }

  const info = P.renderer.info;
  let meshCount = 0; P.scene.traverse((o) => { if (o.isMesh) meshCount++; });

  return {
    level: C.level, seed: C.seed, n,
    // 参数快照（验收时的真实生效值）
    params: {
      landFraction: C.landFraction, elevationSpread: C.elevationSpread, seaLevel: C.seaLevel,
      continentScale: C.continentScale, continentOctaves: C.continentOctaves, continentWeight: C.continentWeight,
      detailScale: C.detailScale, detailOctaves: C.detailOctaves,
    },
    // M1–M5
    M1_landPct: round(land / n * 100, 2),
    landCount: land,
    M2_largestLandPctOfLand: round(lc[0] / landTotal * 100, 1),
    M3_singleTileIslands: lc.filter((v) => v === 1).length,
    M4_grasslandPctOfLand: ofLand('grassland'),
    M5_desertPctOfLand: ofLand('desert'),
    // 陆块 / 海洋结构
    landBlocks: lc.length,
    landBlocksOver1Pct: lc.filter((v) => v / landTotal >= 0.01).length,
    landTop5Pct: lc.slice(0, 5).map((v) => round(v / landTotal * 100, 1)),
    coastRoughness: round(coastEdges / Math.sqrt(land), 2),
    oceanBlocks: sc.length,
    largestOceanPctOfOcean: round(sc[0] / seaTotal * 100, 1),
    // 山地与气候参与度
    mtnSnowPctOfLand: round(mtnSnow / land * 100, 2),
    clsLandPctOfLand: round(clsLand / land * 100, 2),
    // 阶段 A 的红线（不许退步）
    stageA: {
      zeroLandPct: round(zeroLand / land * 100, 2),
      subtropicLand: { n: sub.length, mean: round(subMean, 4), std: round(subStd, 4),
        zeroPct: round(sub.filter((v) => v === 0).length / (sub.length || 1) * 100, 1) },
      maxBinPct: Math.max(...histPct),
      moistureHist: histPct,
    },
    // 群系占比
    biome: bio,
    biomeOfLand: {
      forest: ofLand('forest'), rainforest: ofLand('rainforest'), taiga: ofLand('taiga'),
      tundra: ofLand('tundra'), ice: ofLand('ice'), mountain: ofLand('mountain'),
      snow: ofLand('snow'), river: ofLand('river'), desert: ofLand('desert'), grassland: ofLand('grassland'),
    },
    biomeOfSea: { ocean: ofSea('ocean'), seaIce: ofSea('seaIce') },
    kinds: Object.keys(bio).length,
    latProfile,
    elevationQuantiles: { p05: round(pct(elevs, 0.05)), p50: round(pct(elevs, 0.5)), p62: round(pct(elevs, 0.62), 4), p95: round(pct(elevs, 0.95)), max: round(Math.max(...elevs)) },
    regression: { tempMonoOK, rainforestHighLat, rainforestLatP95: round(pct(rfLat, 0.95)), iceLowLat, snowLowLat, rfAdjIce },
    render: { drawCalls: info.render.calls, triangles: info.render.triangles, meshCount, geometries: info.memory.geometries },
  };
})()`);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'terrain-stats.json'), JSON.stringify(S, null, 2), 'utf8');

/* ---------- 判定 ---------- */
const checks = [
  ['M1 陆地占比 ∈ [30, 45]%',        S.M1_landPct >= 30 && S.M1_landPct <= 45,            `${S.M1_landPct}%`],
  ['M2 最大陆块占陆地 ∈ [40, 70]%',   S.M2_largestLandPctOfLand >= 40 && S.M2_largestLandPctOfLand <= 70, `${S.M2_largestLandPctOfLand}%`],
  ['M3 单格孤岛 ≤ 5',                S.M3_singleTileIslands <= 5,                          `${S.M3_singleTileIslands} 个`],
  ['M4 草原占陆地 ≥ 12%',            S.M4_grasslandPctOfLand >= 12,                        `${S.M4_grasslandPctOfLand}%`],
  ['M5 沙漠占陆地 ∈ [8, 18]%',        S.M5_desertPctOfLand >= 8 && S.M5_desertPctOfLand <= 18, `${S.M5_desertPctOfLand}%`],
  ['陆块数 ≥ 3 块（含 ≥1% 陆地的）',   S.landBlocksOver1Pct >= 3,                            `${S.landBlocksOver1Pct} 块（总 ${S.landBlocks} 块）`],
  ['群系种类 ≥ 12',                  S.kinds >= 12,                                        `${S.kinds} 种`],
  ['M25 draw call ≤ 20',             S.render.drawCalls <= 20,                             `${S.render.drawCalls} 次/帧`],
  ['M25 只有 1 个 Mesh',             S.render.meshCount === 1,                             `${S.render.meshCount} 个`],
  ['M26 纬度-温度单调性',             S.regression.tempMonoOK,                              'top→赤道 逐桶不上升'],
  ['M27 雨林不越界（|lat|>0.6 计数为 0）', S.regression.rainforestHighLat === 0,            `${S.regression.rainforestHighLat} 格，p95=${S.regression.rainforestLatP95}`],
  ['M28 冰原不越界（|lat|<0.85 计数为 0）', S.regression.iceLowLat === 0,                   `${S.regression.iceLowLat} 格`],
  ['阶段A 副热带陆地"湿度=0" ≤ 5%',    S.stageA.subtropicLand.zeroPct <= 5,                 `${S.stageA.subtropicLand.zeroPct}%`],
  ['阶段A 全陆地零湿度 ≤ 5%',         S.stageA.zeroLandPct <= 5,                            `${S.stageA.zeroLandPct}%`],
  ['阶段A 湿度直方图最大 bin ≤ 30%',   S.stageA.maxBinPct <= 30,                            `${S.stageA.maxBinPct}%`],
  ['阶段A 副热带陆地湿度 std ≥ 0.10',  S.stageA.subtropicLand.std >= 0.10,                  `${S.stageA.subtropicLand.std}`],
  ['海拔分位锚定：p62 == 海平面',      Math.abs(S.elevationQuantiles.p62 - S.params.seaLevel) < 0.005, `p62=${S.elevationQuantiles.p62} vs seaLevel=${S.params.seaLevel}`],
  ['口径自洽：陆地 + 海洋群系 + 海冰 = 总数', (S.landCount + (S.biome.ocean || 0) + (S.biome.seaIce || 0)) === S.n,
    `${S.landCount} + ${S.biome.ocean || 0} + ${S.biome.seaIce || 0} = ${S.landCount + (S.biome.ocean || 0) + (S.biome.seaIce || 0)} / ${S.n}`],
];
let fail = 0;
console.log('');
for (const [name, ok, detail] of checks) {
  if (!ok) fail++;
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(34)} ${detail}`);
}
console.log('');
console.log(`陆地 ${S.M1_landPct}% · 陆块 ${S.landBlocks} 块（≥1% 的 ${S.landBlocksOver1Pct} 块，前 5 ${S.landTop5Pct.join('/')}%）· ` +
  `单格孤岛 ${S.M3_singleTileIslands} · 最大海洋占海洋 ${S.largestOceanPctOfOcean}%`);
console.log(`占陆地%：草原 ${S.M4_grasslandPctOfLand} 沙漠 ${S.M5_desertPctOfLand} 森林 ${S.biomeOfLand.forest} ` +
  `雨林 ${S.biomeOfLand.rainforest} 针叶林 ${S.biomeOfLand.taiga} 苔原 ${S.biomeOfLand.tundra} ` +
  `冰原 ${S.biomeOfLand.ice} 山脉 ${S.biomeOfLand.mountain} 雪峰 ${S.biomeOfLand.snow} 河流 ${S.biomeOfLand.river}`);
console.log(`山脉+雪峰占陆地 ${S.mtnSnowPctOfLand}%（阶段 D 的目标是 ≤12%）· 参与湿度分类的陆地 ${S.clsLandPctOfLand}% · 海岸碎度 ${S.coastRoughness}`);
console.log(`指标已写入 ${path.relative(ROOT, path.join(OUT, 'terrain-stats.json'))}`);

/* ---------- 截图 ---------- */
const hideUI = () => evaluate(`(() => { for (const id of ['hud','legend','hint']) { const e = document.getElementById(id); if (e) e.style.display='none'; } return 1; })()`);
await hideUI();
for (const a of [0, 90, 180, 270]) {
  await evaluate(`(() => { const G = window.__PLANET__.planetGroup; G.rotation.x = 0; G.rotation.y = ${a} * Math.PI / 180; return 1; })()`);
  await sleep(1300);
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `terrain-${String(a).padStart(3, '0')}.png`), Buffer.from(s.data, 'base64'));
}
console.log(`截图 → ${path.relative(ROOT, OUT)}\\terrain-{0,90,180,270}.png`);

ws.close(); child.kill(); await sleep(400);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { }
process.exit(fail ? 1 : 0);
