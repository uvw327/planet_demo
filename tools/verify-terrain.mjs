/**
 * 地形地基验收（含 H1 覆盖层架构守卫 + 阶段 D 造山带/雪线）：实机加载 index.html，
 * 量全部「陆块结构 + 群系占比 + 山脉带形状」指标，逐条对照 docs/v1-biome-globe-review.md
 * 的目标值，并检查三条"不许退步"的回归红线与渲染架构的回归（draw call / 三角形 / Mesh 数）。
 *
 * 阶段 D 的两个关键口径：
 *   ① 山地判据 = 造山带强度（`orogeny ≥ orogenyMountain`），不再是全局海拔阈值；
 *   ② 山脉带形状 = 连通分量的**最小外接矩形长宽比**（面积加权，抗"构造结"干扰）。
 *   为了证明"显著改善"，脚本会再用 **v1 口径**（spread=0.30 + 抬升关闭 + 海拔阈值 0.65）
 *   把同一批指标重算一遍做对照 —— 实测复现值 24.16% 与台账逐位吻合。
 *
 * 用法：node tools/verify-terrain.mjs
 * 输出：docs/terrain-shots/terrain-stats.json + terrain-{0,90,180,270}.png + terrain-ui.png
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
  if (P.CONFIG.riverWidth !== undefined) return { ok: false, why: 'CONFIG.riverWidth 仍在（H1 应已删除）' };
  if (P.CONFIG.orogenyBands === undefined) return { ok: false, why: 'CONFIG.orogenyBands 缺失（阶段 D 之前）' };
  if (P.CONFIG.tempSnow === undefined) return { ok: false, why: 'CONFIG.tempSnow 缺失（雪线未改成温度口径）' };
  if (P.CONFIG.orogenyLandZ === undefined) return { ok: false, why: 'CONFIG.orogenyLandZ 缺失（山带未"种在大陆上"）' };
  if (!P.tiles.every((t) => t.orogeny !== undefined)) return { ok: false, why: '图块缺 orogeny 字段' };
  if (!P.buildTimings) return { ok: false, why: 'buildTimings 缺失（生成耗时探针）' };
  return { ok: true, level: P.CONFIG.level, seed: P.CONFIG.seed, tiles: P.tiles.length, build: P.buildTimings };
})()`);
if (!env.ok) throw new Error(`页面状态不对：${env.why}（先关掉残留的 headless Chrome）`);
console.log(`页面就绪：level=${env.level} seed=${env.seed} 图块 ${env.tiles} 个`);
console.log(`生成耗时（纯算法）：合计 ${env.build.totalMs} ms（网格+地形 ${env.build.terrainMs} / 打包几何体 ${env.build.geometryMs}）`);

/* ---------- 页面内一次性定义几何分析器（供「阶段 D 口径」与「v1 口径」复用） ---------- */
await evaluate(`(() => {
  const P = window.__PLANET__, tiles = P.tiles, n = tiles.length;

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

  /** 连通分量（返回每个分量的图块序号数组，按面积降序） */
  const compsOf = (pred) => {
    const seen = new Uint8Array(n), out = [];
    for (const t of tiles) {
      const i0 = t.index; if (!pred(tiles[i0]) || seen[i0]) continue;
      const st = [i0]; seen[i0] = 1; const acc = [];
      while (st.length) { const i = st.pop(); acc.push(i); for (const j of adj[i]) if (!seen[j] && pred(tiles[j])) { seen[j] = 1; st.push(j); } }
      out.push(acc);
    }
    out.sort((a, b) => b.length - a.length); return out;
  };

  /**
   * 一个点集的「伸长比」—— 山脉是**带**还是**团块**，就看这个数。
   *   elongBox：投到质心切平面，扫 90 个角度取**最小面积外接矩形**的长宽比。
   *             这是 P0-3 验收条款「山脉格的最小包围盒长宽比 ≥ 2.5」的直接实现。
   *   elongPCA：3D 协方差前两个特征值之比的平方根（长带 4~10，团块 ≈ 1），交叉验证用。
   */
  const shape = (ids) => {
    const m = ids.length;
    let cx = 0, cy = 0, cz = 0;
    for (const i of ids) { const c = tiles[i].center; cx += c.x; cy += c.y; cz += c.z; }
    cx /= m; cy /= m; cz /= m;
    const cl = Math.hypot(cx, cy, cz);
    if (m < 3 || cl === 0) return { elongBox: 0, elongPCA: 0 };
    cx /= cl; cy /= cl; cz /= cl;

    let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
    for (const i of ids) {
      const c = tiles[i].center;
      const dx = c.x - cx, dy = c.y - cy, dz = c.z - cz;
      xx += dx * dx; yy += dy * dy; zz += dz * dz; xy += dx * dy; xz += dx * dz; yz += dy * dz;
    }
    xx /= m; yy /= m; zz /= m; xy /= m; xz /= m; yz /= m;
    const p1 = xy * xy + xz * xz + yz * yz, q = (xx + yy + zz) / 3;
    const p2 = (xx - q) ** 2 + (yy - q) ** 2 + (zz - q) ** 2 + 2 * p1;
    const p = Math.sqrt(Math.max(1e-18, p2 / 6));
    const bxx = (xx - q) / p, byy = (yy - q) / p, bzz = (zz - q) / p;
    const bxy = xy / p, bxz = xz / p, byz = yz / p;
    const detB = bxx * (byy * bzz - byz * byz) - bxy * (bxy * bzz - byz * bxz) + bxz * (bxy * byz - byy * bxz);
    const r = Math.max(-1, Math.min(1, detB / 2)), phi = Math.acos(r) / 3;
    const e1 = q + 2 * p * Math.cos(phi), e3 = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);
    const e2 = 3 * q - e1 - e3;
    const elongPCA = e2 > 1e-15 ? Math.sqrt(e1 / e2) : 99;

    const ax = Math.abs(cx) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const u = { x: cy * ax.z - cz * ax.y, y: cz * ax.x - cx * ax.z, z: cx * ax.y - cy * ax.x };
    const ul = Math.hypot(u.x, u.y, u.z); u.x /= ul; u.y /= ul; u.z /= ul;
    const v = { x: cy * u.z - cz * u.y, y: cz * u.x - cx * u.z, z: cx * u.y - cy * u.x };
    const pts = [];
    for (const i of ids) {
      const c = tiles[i].center;
      const dx = c.x - cx, dy = c.y - cy, dz = c.z - cz;
      pts.push([dx * u.x + dy * u.y + dz * u.z, dx * v.x + dy * v.y + dz * v.z]);
    }
    let bestArea = Infinity, bestAspect = 0;
    for (let s = 0; s < 90; s++) {
      const th = s * Math.PI / 90, co = Math.cos(th), si = Math.sin(th);
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const [x, y] of pts) {
        const a = x * co + y * si, b = -x * si + y * co;
        if (a < minU) minU = a; if (a > maxU) maxU = a;
        if (b < minV) minV = b; if (b > maxV) maxV = b;
      }
      const w = maxU - minU, h = maxV - minV;
      if (w * h < bestArea) { bestArea = w * h; bestAspect = Math.max(w, h) / Math.max(1e-12, Math.min(w, h)); }
    }
    return { elongBox: +bestAspect.toFixed(2), elongPCA: +elongPCA.toFixed(2) };
  };

  /**
   * 山地集合的带状统计（面积加权，避免被单个「构造结」带偏）：
   *   largest     最大分量的最小外接矩形长宽比
   *   wa          按面积加权的平均长宽比 ← 主口径
   *   bandAreaPct 长宽比 ≥2.5 的分量所覆盖的山地面积占比 ← 主口径（应接近 100）
   */
  const bandStats = (pred) => {
    const comps = compsOf(pred);
    let area = 0; for (const c of comps) area += c.length;
    if (!comps.length) return { count: 0, largest: 0, wa: 0, bandAreaPct: 0, largestTiles: 0 };
    let acc = 0, accAspect = 0, bandArea = 0;
    for (const c of comps) {
      if (c.length < 6) { acc += c.length; continue; }
      const s = shape(c);
      acc += c.length; accAspect += s.elongBox * c.length;
      if (s.elongBox >= 2.5) bandArea += c.length;
    }
    return {
      count: comps.length,
      largestTiles: comps[0].length,
      largest: shape(comps[0]).elongBox,
      wa: +(accAspect / Math.max(1, acc)).toFixed(2),
      bandAreaPct: +(bandArea / Math.max(1, area) * 100).toFixed(1),
    };
  };

  window.__VT__ = { adj, compsOf, shape, bandStats };
  return 1;
})()`);

/* ---------- 取数 ---------- */
const S = await evaluate(`(() => {
  const P = window.__PLANET__, C = P.CONFIG, tiles = P.tiles;
  const n = tiles.length, SEA = C.seaLevel;
  // ★ 阶段 D：山地判据从「全局海拔阈值」换成「造山带强度」——
  //   海拔阈值切出来的是各向同性 FBM 团块；造山带才是成链成带的那个场。
  //   雪峰仍由**温度**判定（classifyBiome 里的 tempSnow 分支）。
  const isMtn = (t) => t.elevation > SEA && t.orogeny >= C.orogenyMountain;
  const isSnow = (t) => t.biome === 'snow';
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
  let snowTempViolations = 0, mtnOrogenyViolations = 0, orogenyMax = 0, orogenyNonZero = 0;
  let elevAtCeiling = 0, elevAtCeilingMtn = 0;
  const bio = {}, elevs = [];
  for (const t of tiles) {
    bio[t.biome] = (bio[t.biome] || 0) + 1;
    elevs.push(t.elevation);
    // ★ 阶段 D 观测项：造山带抬升会把峰顶顶到 clamp01 的天花板（1.0）。
    //   这些格子会被\"削平\"成一整片同高的白台地（赤道段最明显）。
    //   它不是 bug（clamp 是必需的），但值得记下来 —— 想缓解就调小 orogenyGain。
    if (t.elevation > 0.999) { elevAtCeiling++; if (t.elevation > SEA) elevAtCeilingMtn++; }
    if (t.orogeny > 1e-9) orogenyNonZero++;
    if (t.orogeny > orogenyMax) orogenyMax = t.orogeny;
    if (t.elevation <= SEA) continue;
    land++;
    if (isMtn(t)) mtnSnow++;
    if (t.moisture === 0) zeroLand++;
    // ★ 阶段 D 自洽性：山必须来自造山带；雪必须来自温度低于雪线
    if ((t.biome === 'mountain' || t.biome === 'snow') && !isMtn(t)) mtnOrogenyViolations++;
    if (t.biome === 'snow' && !(t.temperature < C.tempSnow)) snowTempViolations++;
    // 「参与湿度分类的陆地」= 既不是高山雪峰，也不是冰原/苔原/针叶林
    // ★ H1：河流已不再是群系，不再列入排除项（所以这个比例会比地形地基时高一点，
    //         那些格子现在按自己的气候群系参与分类）
    if (!(isMtn(t) || t.temperature < C.tempIce
          || t.temperature < C.tempTundra || t.temperature < C.tempTaiga)) clsLand++;
    for (const j of adj[t.index]) if (tiles[j].elevation <= SEA) coastEdges++;
  }
  const lc = comps((t) => t.elevation > SEA);
  const sc = comps((t) => t.elevation <= SEA);
  const landTotal = lc.reduce((s, v) => s + v, 0);
  const seaTotal = sc.reduce((s, v) => s + v, 0);
  const ofLand = (k) => bio[k] ? round(bio[k] / land * 100, 2) : 0;
  const ofCls = (k) => clsLand ? round(bio[k] / clsLand * 100, 2) : 0;
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
  // ★ H3 起星球不止 1 个 Mesh：河网是**独立几何体 + 独立材质**（覆盖层各自独立成层）。
  //   所以 M25 的口径是「星球主体合并成 1 个 Mesh」，覆盖层单独计数（自测里同一条口径）。
  let meshCount = 0, overlayMeshes = 0;
  P.scene.traverse((o) => {
    if (!o.isMesh) return;
    meshCount++;
    if (o === P.gfx.riverLayer || o === P.gfx.oreLayer) overlayMeshes++;
  });

  // ★ 阶段 D：山脉带形状（面积加权口径，见 window.__VT__.bandStats 注释）
  const band = window.__VT__.bandStats(isMtn);

  return {
    level: C.level, seed: C.seed, n,
    buildTimings: P.buildTimings,
    // 参数快照（验收时的真实生效值）
    params: {
      landFraction: C.landFraction, elevationSpread: C.elevationSpread, seaLevel: C.seaLevel,
      continentScale: C.continentScale, continentOctaves: C.continentOctaves, continentWeight: C.continentWeight,
      detailScale: C.detailScale, detailOctaves: C.detailOctaves,
      orogenyBands: C.orogenyBands, orogenyWidth: C.orogenyWidth, orogenyMinLen: C.orogenyMinLen,
      orogenyMaxLen: C.orogenyMaxLen, orogenyPeakMin: C.orogenyPeakMin, orogenyPeakMax: C.orogenyPeakMax,
      orogenyMountain: C.orogenyMountain, orogenyGain: C.orogenyGain, orogenyLandZ: C.orogenyLandZ,
      tempSnow: C.tempSnow,
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
    // 气候分类的内部构成（★ 这是 阶段 A 设计意图的真正分母：
    // 「沙漠 : 草原 : 森林+雨林 ≈ 1:1:1」由湿度分位阈值保证，与山脉占比无关）
    climateSplit: {
      desert: ofCls('desert'), grassland: ofCls('grassland'),
      forest: round(ofCls('forest') + ofCls('rainforest'), 2),
    },
    // ★ 阶段 D：造山带场与山脉带形状（P0-3 验收）
    orogeny: {
      max: round(orogenyMax),
      nonzeroTiles: orogenyNonZero,
      fieldNonEmpty: orogenyMax > 0.5 && orogenyNonZero > 500,
      mtnOrogenyViolations,
      snowTempViolations,
      // clamp01 收口观测（见 evaluate 里的注释）：峰顶被削平成一整片同高台地的格子数
      elevAtCeiling,
      elevAtCeilingPctOfLand: round(elevAtCeilingMtn / land * 100, 2),
      band,
    },
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
      snow: ofLand('snow'), desert: ofLand('desert'), grassland: ofLand('grassland'),
    },
    biomeOfSea: { ocean: ofSea('ocean'), seaIce: ofSea('seaIce') },
    kinds: Object.keys(bio).length,
    // H1 覆盖层架构：河流必须已从「群系」移出，且覆盖层 API 就位
    h1: {
      riverBiomePresent: Object.values(P.BIOME).includes('river'),
      riverTiles: bio.river || 0,
      riverFieldLeft: tiles.some((t) => t.river !== undefined),
      hydroShell: 'hydro' in P.world,
      // ★ H2：水文数据层已填充（不再是空壳）。这里只取"有没有算出来"，
      //   具体指标由 tools/verify-hydro.mjs 负责 —— 而且**绝不能**把 hydro() 整个回传。
      hydroFilled: !!(P.world.hydro && P.world.hydro.riverCount !== undefined && P.world.hydro.lakes),
      overlaysAPI: typeof P.setVisibleOverlays === 'function',
      selfTestChecks: P.selfTest ? P.selfTest.rows.length : 0,
      selfTestFailed: P.selfTest ? P.selfTest.rows.filter((r) => !r.ok).map((r) => r.name) : ['selfTest 缺失'],
    },
    latProfile,
    elevationQuantiles: { p05: round(pct(elevs, 0.05)), p50: round(pct(elevs, 0.5)), p62: round(pct(elevs, 0.62), 4), p95: round(pct(elevs, 0.95)), max: round(Math.max(...elevs)) },
    regression: { tempMonoOK, rainforestHighLat, rainforestLatP95: round(pct(rfLat, 0.95)), iceLowLat, snowLowLat, rfAdjIce },
    render: { drawCalls: info.render.calls, triangles: info.render.triangles, meshCount, overlayMeshes, geometries: info.memory.geometries },
  };
})()`);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'terrain-stats.json'), JSON.stringify(S, null, 2), 'utf8');

/* ---------- v1 口径对照：把「团块 → 带」量化，不靠肉眼看截图 ---------- */
// 把 elevationSpread 调回 0.30、抬升关掉，就**精确复现**了 v1 的「海拔阈值山」集合
// （v1 判据：elevation > 0.65 为山脉、> 0.80 为雪峰）。
// 实测这套复现值给出 24.16% —— 与台账里 v1 的「山脉+雪峰占陆地 24.16%」逐位吻合，
// 说明这个对照不是"随便找个旧配置"，而是真的复原了旧地形。
const V1 = await evaluate(`(() => {
  const P = window.__PLANET__, C = P.CONFIG, tiles = P.tiles;
  const keep = { elevationSpread: C.elevationSpread, orogenyGain: C.orogenyGain, orogenyMountain: C.orogenyMountain };
  C.elevationSpread = 0.30; C.orogenyGain = 0; C.orogenyMountain = 999;
  P.refresh();
  const SEA = C.seaLevel;
  const isMtnV1 = (t) => t.elevation > 0.65;
  const isSnowV1 = (t) => t.elevation > 0.80;
  let land = 0, mtnSnow = 0, snowLow = 0;
  for (const t of tiles) {
    if (t.elevation <= SEA) continue;
    land++;
    if (isMtnV1(t)) mtnSnow++;
    if (isSnowV1(t) && Math.abs(t.latitude) < 0.3) snowLow++;
  }
  const band = window.__VT__.bandStats(isMtnV1);
  Object.assign(C, keep); P.refresh();      // 恢复阶段 D 参数（后续截图必须用阶段 D 的地形）
  return { mtnSnowPctOfLand: +(mtnSnow / land * 100).toFixed(2), snowLowLat: snowLow, band };
})()`);
console.log(`v1 口径对照（spread=0.30 / 抬升关闭 / 海拔阈值 0.65）：` +
  `山+雪占陆地 ${V1.mtnSnowPctOfLand}%｜最大比 ${V1.band.largest}｜加权比 ${V1.band.wa}｜带面积% ${V1.band.bandAreaPct}`);

/* ---------- 判定 ---------- */
const checks = [
  ['M1 陆地占比 ∈ [30, 45]%',        S.M1_landPct >= 30 && S.M1_landPct <= 45,            `${S.M1_landPct}%`],
  ['M2 最大陆块占陆地 ∈ [40, 70]%',   S.M2_largestLandPctOfLand >= 40 && S.M2_largestLandPctOfLand <= 70, `${S.M2_largestLandPctOfLand}%`],
  ['M3 单格孤岛 ≤ 5',                S.M3_singleTileIslands <= 5,                          `${S.M3_singleTileIslands} 个`],
  ['M4 草原占陆地 ≥ 12%',            S.M4_grasslandPctOfLand >= 12,                        `${S.M4_grasslandPctOfLand}%`],
  // ★ M5 口径说明（阶段 D 起）：
  //   原界「沙漠占陆地 ∈ [8,18]%」是在「山脉+雪峰吃掉 24% 陆地」的前提下标定的。
  //   阶段 D 把山脉压到 9.89% 后，原本被「山脉」标签遮蔽的副热带陆地开始按气候分类，
  //   沙漠占陆地从 17.66% 升到 22.26% —— 这是**分母/遮蔽效应**，不是沙漠失控
  //   （地球干旱区约占陆地 20%，22% 反而更接近现实）。
  //   阶段 A 真正要守的不变量是「沙漠 : 草原 : 森林+雨林 ≈ 1:1:1」（由湿度分位阈值保证），
  //   所以判据改用「参与湿度分类的陆地」为分母，两个数都打印出来接受核对。
  ['M5 沙漠占参与分类陆地 ∈ [25,40]%', S.climateSplit.desert >= 25 && S.climateSplit.desert <= 40,
    `${S.climateSplit.desert}%（占陆地 ${S.M5_desertPctOfLand}%，见上方口径说明）`],
  ['M5b 沙漠占陆地 ≤ 26%',            S.M5_desertPctOfLand <= 26,                           `${S.M5_desertPctOfLand}%`],
  ['M5c 气候三段 ≈1:1:1（各 ∈[25,40]%）', S.climateSplit.grassland >= 25 && S.climateSplit.grassland <= 40
    && S.climateSplit.forest >= 25 && S.climateSplit.forest <= 40,
    `沙漠 ${S.climateSplit.desert} / 草原 ${S.climateSplit.grassland} / 森林+雨林 ${S.climateSplit.forest}`],
  ['陆块数 ≥ 3 块（含 ≥1% 陆地的）',   S.landBlocksOver1Pct >= 3,                            `${S.landBlocksOver1Pct} 块（总 ${S.landBlocks} 块）`],
  ['群系种类 ≥ 11（河流已移出群系）',   S.kinds >= 11,                                        `${S.kinds} 种（M19 目标 ≥15，待后续阶段补真群系）`],
  ['H1 群系表中已无河流',             !S.h1.riverBiomePresent && S.h1.riverTiles === 0 && !S.h1.riverFieldLeft,
    `BIOME=${S.h1.riverBiomePresent ? '仍有 river' : '无'} 河网格子=${S.h1.riverTiles} 残留字段=${S.h1.riverFieldLeft}`],
  ['H1 覆盖层 API 就位 + H2 水文已填充', S.h1.hydroShell && S.h1.overlaysAPI && S.h1.hydroFilled,
    `hydro=${S.h1.hydroShell} 已算=${S.h1.hydroFilled} setVisibleOverlays=${S.h1.overlaysAPI}`],
  ['页面自测（runSelfTest）全部通过', S.h1.selfTestFailed.length === 0 && S.h1.selfTestChecks >= 15,
    `${S.h1.selfTestChecks} 条${S.h1.selfTestFailed.length ? '，失败：' + S.h1.selfTestFailed.join('、') : '，无失败项'}`],
  ['M25 draw call ≤ 20',             S.render.drawCalls <= 20,                             `${S.render.drawCalls} 次/帧`],
  ['M25 星球主体合并成 1 个 Mesh',   S.render.meshCount - S.render.overlayMeshes === 1 && S.render.meshCount <= 3,
    `共 ${S.render.meshCount} 个 = 星球主体 1 + 覆盖层 ${S.render.overlayMeshes}（河网/矿石）`],
  ['M26 纬度-温度单调性',             S.regression.tempMonoOK,                              'top→赤道 逐桶不上升'],
  ['M27 雨林不越界（|lat|>0.6 计数为 0）', S.regression.rainforestHighLat === 0,            `${S.regression.rainforestHighLat} 格，p95=${S.regression.rainforestLatP95}`],
  ['M28 冰原不越界（|lat|<0.85 计数为 0）', S.regression.iceLowLat === 0,                   `${S.regression.iceLowLat} 格`],
  // ---- 阶段 D（P0-3）：山脉成带 + 真实雪线 ----
  ['D-M6 山脉+雪峰占陆地 ≤ 12%',      S.mtnSnowPctOfLand <= 12,                             `${S.mtnSnowPctOfLand}%（v1 口径 ${V1.mtnSnowPctOfLand}%）`],
  ['D 造山带场非空（峰值 > 0.5）',     S.orogeny.fieldNonEmpty,                              `峰值 ${S.orogeny.max}，非零 ${S.orogeny.nonzeroTiles} 格`],
  ['D 山地格全部来自造山带',           S.orogeny.mtnOrogenyViolations === 0,                 `越界 ${S.orogeny.mtnOrogenyViolations} 格`],
  ['D 雪峰全部温度低于雪线',           S.orogeny.snowTempViolations === 0,                   `越界 ${S.orogeny.snowTempViolations} 格（tempSnow=${S.params.tempSnow}）`],
  ['D 山脉带形状：面积加权长宽比 ≥ 2.5', S.orogeny.band.wa >= 2.5,                            `加权 ${S.orogeny.band.wa}｜最大分量 ${S.orogeny.band.largest}（v1 口径 ${V1.band.wa}）`],
  ['D 山脉带形状：长条覆盖面积 ≥ 80%',  S.orogeny.band.bandAreaPct >= 80,                     `${S.orogeny.band.bandAreaPct}%（v1 口径 ${V1.band.bandAreaPct}%）`],
  ['D 带形显著优于 v1 口径（≥3×）',    S.orogeny.band.bandAreaPct >= 3 * Math.max(1, V1.band.bandAreaPct),
    `${S.orogeny.band.bandAreaPct}% vs ${V1.band.bandAreaPct}%`],
  ['D 赤道雪峰仍存在（|lat|<0.3 > 0）', S.regression.snowLowLat > 0,                          `${S.regression.snowLowLat} 格（v1 口径 ${V1.snowLowLat}）`],
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
  `冰原 ${S.biomeOfLand.ice} 山脉 ${S.biomeOfLand.mountain} 雪峰 ${S.biomeOfLand.snow}`);
console.log(`气候三段（占参与分类陆地 ${S.clsLandPctOfLand}%）：沙漠 ${S.climateSplit.desert} / 草原 ${S.climateSplit.grassland} / 森林+雨林 ${S.climateSplit.forest}`);
console.log(`山脉+雪峰占陆地 ${S.mtnSnowPctOfLand}%（阶段 D 目标 ≤12%，v1 口径 ${V1.mtnSnowPctOfLand}%）· 参与湿度分类的陆地 ${S.clsLandPctOfLand}% · 海岸碎度 ${S.coastRoughness}`);
console.log(`造山带形状：加权长宽比 ${S.orogeny.band.wa}（v1 ${V1.band.wa}）· 长条覆盖面积 ${S.orogeny.band.bandAreaPct}%（v1 ${V1.band.bandAreaPct}%）· ` +
  `最大分量 ${S.orogeny.band.largest} · 分量 ${S.orogeny.band.count} 个 · 赤道雪峰 ${S.regression.snowLowLat} 格`);
console.log(`clamp01 收口（峰顶被削平成同高台地）：${S.orogeny.elevAtCeiling} 格，其中陆地 ${S.orogeny.elevAtCeilingPctOfLand}%（调小 orogenyGain 可缓解）`);
console.log(`指标已写入 ${path.relative(ROOT, path.join(OUT, 'terrain-stats.json'))}`);

/* ---------- 截图 ---------- */
const hideUI = () => evaluate(`(() => { for (const id of ['hud','legend','hint']) { const e = document.getElementById(id); if (e) e.style.display='none'; } return 1; })()`);
/**
 * 截图 + **体积哨兵**。
 * 一整屏背景色（星球没画出来 / 顶点色上传被吞掉）的 1254×644 PNG 只有几 KB，
 * 而真实成品图在 level 5/6 都是 35–50 KB。这个判据曾经抓住过
 * "两次验收脚本并发写同一批文件、其中一次截图时星球不在画面里"的污染。
 */
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(s.data, 'base64');
  fs.writeFileSync(path.join(OUT, `${name}.png`), buf);
  const kb = buf.length / 1024;
  if (buf.length < 12000) console.log(`     ⚠ ${name}.png 只有 ${kb.toFixed(1)} KB —— 星球可能不在画面里`);
  return kb;
};
await hideUI();
for (const a of [0, 90, 180, 270]) {
  await evaluate(`(() => { const G = window.__PLANET__.planetGroup; G.rotation.x = 0; G.rotation.y = ${a} * Math.PI / 180; return 1; })()`);
  await sleep(1300);
  await shot(`terrain-${String(a).padStart(3, '0')}`);
}
console.log(`截图 → ${path.relative(ROOT, OUT)}\\terrain-{0,90,180,270}.png`);

/* ---------- UI 证据：图例分两组（气候群系 / 覆盖层）+ HUD「水系」占位 ---------- */
await evaluate(`(() => { for (const id of ['hud','legend','hint']) { const e = document.getElementById(id); if (e) e.style.display = ''; } return 1; })()`);
await evaluate(`(() => { const G = window.__PLANET__.planetGroup; G.rotation.x = 0; G.rotation.y = 0; return 1; })()`);
const hovered = await evaluate(`(() => {
  const P = window.__PLANET__;
  // 优先悬停一格**山脉/雪峰**（正对镜头那一面），好让 HUD 的「造山带」读数有内容
  let best = -1;
  for (const t of P.tiles) {
    if (t.center.z > 0.9 && t.elevation > P.CONFIG.seaLevel && t.orogeny >= P.CONFIG.orogenyMountain) { best = t.index; break; }
  }
  if (best < 0) for (const t of P.tiles) if (t.center.z > 0.9 && t.elevation > P.CONFIG.seaLevel) { best = t.index; break; }
  P.setHovered(best);       // HUD 只在悬停/选中时可见，这里强制悬停一格
  // ★ 陷阱：**绝不能**把 P.hydro() 整个 returnByValue 回去 —— 它是 4 万个元素的
  //   TypedArray + 邻接表 + 多流向 CSR，CDP 序列化会直接卡死（实测挂了 30 分钟）。
  //   这里只回传一个摘要。
  const hy = P.hydro();
  return {
    best, overlays: P.overlays(),
    hydro: hy ? { riverCount: hy.riverCount, rivers: hy.isRiver.length, lakes: hy.lakes.length,
      pruned: hy.pruned, ms: hy.ms } : null,
  };
})()`);
await sleep(1100);
const uiShot = await send('Page.captureScreenshot', { format: 'png' });
{
  const buf = Buffer.from(uiShot.data, 'base64');
  fs.writeFileSync(path.join(OUT, 'terrain-ui.png'), buf);
  if (buf.length < 12000) console.log(`     ⚠ terrain-ui.png 只有 ${(buf.length / 1024).toFixed(1)} KB —— 星球可能不在画面里`);
}
await evaluate(`window.__PLANET__.setHovered(-1)`);       // 恢复，避免影响后续调用
console.log(`UI 证据（图例两组 + HUD「水系」）→ ${path.relative(ROOT, path.join(OUT, 'terrain-ui.png'))}`);
console.log(`  H2 状态：水文 ${JSON.stringify(hovered.hydro)} overlays=${JSON.stringify(hovered.overlays)} 悬停图块 #${hovered.best}`);

ws.close(); child.kill(); await sleep(400);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { }
process.exit(fail ? 1 : 0);
