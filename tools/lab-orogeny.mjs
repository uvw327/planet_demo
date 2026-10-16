/**
 * 造山带实验室（阶段 D）：加载 index.html 一次，然后在页面内扫
 * `orogenyBands × orogenyWidth × orogenyMountain × …` 的组合，
 * 输出「山地占比（M6）/ 山脉带形状 / 雪线一致性 / 回归红线」对比表。
 *
 * 为什么需要它：造山带参数（条数、宽度、阈值）与「山地占陆地 ≤ 12%」之间没有解析关系，
 * 只能扫。而 `recomputeTerrain()` 是纯计算链、`refresh()` 又不重建几何体，
 * 所以一次页面加载能扫几十组 —— 换页面重载一次要十几秒。
 *
 * 用法：
 *   node tools/lab-orogeny.mjs
 *   node tools/lab-orogeny.mjs --bands=4,5,6 --width=5,6 --mtn=0.30,0.35
 *   node tools/lab-orogeny.mjs --bands=5 --width=6 --mtn=0.35 --gain=0.50 --snow=0.52,0.55
 *
 * 扫完之后**自动再跑一遍 v1 口径对照**（spread 回 0.30、抬升关闭、海拔阈值 0.65），
 * 把「团块 → 带」变成一个可核验的数（带面积% / 加权长宽比）。
 * 结果同时写 tools/out/lab-orogeny.json（按 .gitignore 不入库）。
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

/** 端口探测：残留的 Chrome 会继续响应调试端口并静默给出"旧页面"的数据。 */
async function probePort(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); return !!r.ok; } catch { return false; }
}
async function pickFreePort() {
  for (let i = 0; i < 40; i++) {
    const p = 9500 + Math.floor(Math.random() * 400);
    if (!(await probePort(p))) return p;
  }
  throw new Error('找不到空闲调试端口：请先关掉残留的 headless Chrome（Get-Process chrome | Stop-Process -Force）');
}
const PORT = Number(process.env.CDP_PORT || await pickFreePort());

/* ---------- 命令行参数 ---------- */
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const nums = (s) => String(s).split(',').map((x) => x.trim())
  .filter((x) => x !== '').map(Number).filter((v) => Number.isFinite(v));

/**
 * 通用多轴扫描：给了哪几根轴就扫它们的笛卡尔积；没给的轴不参与。
 * 注意 orogenyBands 属于「会重建造山带列表」的参数，改它会重跑 sampleOrogeny，
 * 所以它比 width/mtn 贵一点，但仍远快于重载页面。
 */
const AXES = [
  // 默认扫的是阶段 D 定稿值附近的邻域：条数 4~6（5 是甜点，6 起开始交汇塌方）× 宽度 5~6
  ['orogenyBands',    nums(arg('bands',  '4,5,6'))],
  ['orogenyWidth',    nums(arg('width',  '5,6'))],
  ['orogenyMountain', nums(arg('mtn',    '0.35'))],
  ['orogenyGain',     nums(arg('gain',   ''))],
  ['orogenyMinLen',   nums(arg('minlen', ''))],
  ['orogenyMaxLen',   nums(arg('maxlen', ''))],
  ['orogenyPeakMin',  nums(arg('peakmin', ''))],
  ['orogenyPeakMax',  nums(arg('peakmax', ''))],
  ['orogenyLandZ',    nums(arg('landz',  ''))],
  ['tempSnow',        nums(arg('snow',   ''))],
  ['elevationSpread', nums(arg('spread', ''))],
].filter(([, vs]) => vs.length);

let COMBOS = [{}];
for (const [key, vs] of AXES) {
  const next = [];
  for (const base of COMBOS) for (const v of vs) next.push({ ...base, [key]: v });
  COMBOS = next;
}
const AXIS_KEYS = AXES.map(([k]) => k);
const OUT = arg('json', path.join(ROOT, 'tools', 'out', 'lab-orogeny.json'));

/* ---------- 启动 headless Chromium 并连 CDP ---------- */
const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'cdp-orogeny-'));
const child = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--disable-gpu-sandbox', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--window-size=800,600', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
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
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };

await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: PAGE });
for (let i = 0; i < 180; i++) { await sleep(1000); if (await evaluate('!!(window.__PLANET__ && window.__PLANET__.tiles)')) break; }
console.log('页面已就绪（index.html）');

/* ---------- 前置断言：确保量的是"当前这份代码"，而不是残留浏览器里的旧页面 ---------- */
const env = await evaluate(`(() => {
  const P = window.__PLANET__;
  if (!P) return { ok: false, why: '没有 __PLANET__：页面不是 index.html' };
  const C = P.CONFIG;
  if (C.landFraction === undefined) return { ok: false, why: 'CONFIG.landFraction 缺失：页面是地基改造之前的版本' };
  if (C.riverWidth !== undefined) return { ok: false, why: 'CONFIG.riverWidth 仍在：页面是 H1 之前的版本' };
  if (C.orogenyBands === undefined) return { ok: false, why: 'CONFIG.orogenyBands 缺失：页面是阶段 D 之前的版本' };
  if (C.tempSnow === undefined) return { ok: false, why: 'CONFIG.tempSnow 缺失：雪线还没改成温度口径' };
  if (C.orogenyLandZ === undefined) return { ok: false, why: 'CONFIG.orogenyLandZ 缺失：山带还没"种在大陆上"' };
  if (String(P.refresh).indexOf('recomputeTerrain') < 0) return { ok: false, why: 'refresh() 未走 recomputeTerrain()：页面是中间态' };
  return { ok: true, level: C.level, tiles: P.tiles.length };
})()`);
if (!env.ok) throw new Error(`页面状态不对：${env.why}（先把残留的 headless Chrome 全部关掉再跑）`);
console.log(`代码自检通过：level=${env.level}，图块 ${env.tiles} 个`);

/* ---------- 页面内：建一次邻接，定义一次分析函数，然后逐组调用 ---------- */
await evaluate(`(() => {
  const P = window.__PLANET__, C = P.CONFIG, tiles = P.tiles;
  const n = tiles.length;

  // 邻接：两格共享 >= 2 个对偶顶点 ⇔ 共边
  const byVert = new Map();
  for (const t of tiles) for (const vi of t.vertexIndices) {
    let a = byVert.get(vi); if (!a) { a = []; byVert.set(vi, a); } a[a.length] = t;
  }
  const adj = new Array(n);
  for (const t of tiles) {
    const cnt = new Map();
    for (const vi of t.vertexIndices) for (const o of byVert.get(vi)) if (o !== t) cnt.set(o, (cnt.get(o) || 0) + 1);
    const s = [];
    for (const [o, c] of cnt) if (c >= 2) s.push(o.index);
    adj[t.index] = s;
  }

  /** 连通分量（返回每个分量的图块序号表） */
  const compsOf = (pred) => {
    const seen = new Uint8Array(n), out = [];
    for (const t of tiles) {
      const i0 = t.index;
      if (!pred(tiles[i0]) || seen[i0]) continue;
      const st = [i0]; seen[i0] = 1; const acc = [];
      while (st.length) {
        const i = st.pop(); acc.push(i);
        for (const j of adj[i]) if (!seen[j] && pred(tiles[j])) { seen[j] = 1; st.push(j); }
      }
      out.push(acc);
    }
    out.sort((a, b) => b.length - a.length);
    return out;
  };

  /**
   * 点云的「伸长比」—— 山脉到底是一条**带**还是一个**团块**，就靠这个数区分。
   *   elongPCA：3D 协方差的前两个特征值之比开方。长带 ≈ 4~10，团块 ≈ 1。
   *   （球面上的点只有两个自由度，所以用"前两个特征值"天然对应"沿带 / 跨带"两轴）
   *   elongBox：把点投到质心的切平面，扫 90 个角度取**最小面积外接矩形**的长宽比。
   *             这是验收文档里「最小包围盒长宽比 ≥ 2.5」的直接实现。
   */
  const shape = (ids) => {
    const m = ids.length;
    let cx = 0, cy = 0, cz = 0;
    for (const i of ids) { const c = tiles[i].center; cx += c.x; cy += c.y; cz += c.z; }
    cx /= m; cy /= m; cz /= m;
    if (m < 3 || (cx === 0 && cy === 0 && cz === 0)) return { elongPCA: 0, elongBox: 0 };
    const cl = Math.hypot(cx, cy, cz); cx /= cl; cy /= cl; cz /= cl;

    // --- 3D 协方差 → 解析特征值（对称 3x3）---
    let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
    for (const i of ids) {
      const c = tiles[i].center;
      const dx = c.x - cx, dy = c.y - cy, dz = c.z - cz;
      xx += dx * dx; yy += dy * dy; zz += dz * dz; xy += dx * dy; xz += dx * dz; yz += dy * dz;
    }
    xx /= m; yy /= m; zz /= m; xy /= m; xz /= m; yz /= m;
    const p1 = xy * xy + xz * xz + yz * yz;
    const q = (xx + yy + zz) / 3;
    const p2 = (xx - q) ** 2 + (yy - q) ** 2 + (zz - q) ** 2 + 2 * p1;
    const p = Math.sqrt(Math.max(1e-18, p2 / 6));
    // det(B)，B = (A - qI)/p
    const bxx = (xx - q) / p, byy = (yy - q) / p, bzz = (zz - q) / p;
    const bxy = xy / p, bxz = xz / p, byz = yz / p;
    const detB = bxx * (byy * bzz - byz * byz) - bxy * (bxy * bzz - byz * bxz) + bxz * (bxy * byz - byy * bxz);
    const r = Math.max(-1, Math.min(1, detB / 2));
    const phi = Math.acos(r) / 3;
    const e1 = q + 2 * p * Math.cos(phi);
    const e3 = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);
    const e2 = 3 * q - e1 - e3;
    const elongPCA = e2 > 1e-15 ? Math.sqrt(e1 / e2) : 99;

    // --- 切平面投影 → 最小面积外接矩形 ---
    const ax = Math.abs(cx) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const e1v = { x: cy * ax.z - cz * ax.y, y: cz * ax.x - cx * ax.z, z: cx * ax.y - cy * ax.x };
    const l1 = Math.hypot(e1v.x, e1v.y, e1v.z);
    e1v.x /= l1; e1v.y /= l1; e1v.z /= l1;
    const e2v = { x: cy * e1v.z - cz * e1v.y, y: cz * e1v.x - cx * e1v.z, z: cx * e1v.y - cy * e1v.x };
    const pts = [];
    for (const i of ids) {
      const c = tiles[i].center;
      const dx = c.x - cx, dy = c.y - cy, dz = c.z - cz;
      pts.push([dx * e1v.x + dy * e1v.y + dz * e1v.z, dx * e2v.x + dy * e2v.y + dz * e2v.z]);
    }
    let best = Infinity, bestAspect = 0;
    for (let s = 0; s < 90; s++) {
      const th = s * Math.PI / 90, co = Math.cos(th), si = Math.sin(th);
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const [x, y] of pts) {
        const u = x * co + y * si, v = -x * si + y * co;
        if (u < minU) minU = u; if (u > maxU) maxU = u;
        if (v < minV) minV = v; if (v > maxV) maxV = v;
      }
      const w = maxU - minU, h = maxV - minV;
      const area = w * h;
      if (area < best) { best = area; bestAspect = Math.max(w, h) / Math.max(1e-12, Math.min(w, h)); }
    }
    return { elongPCA: +elongPCA.toFixed(2), elongBox: +bestAspect.toFixed(2) };
  };

  const SEA = C.seaLevel;

  /**
   * 分析一组参数：改 CONFIG → refresh → 全面量一遍，返回一行结果。
   *
   * 传「__v1rule: true」时切到 **v1 口径**（山地 = 全局海拔阈值 > 0.65，雪峰 > 0.80）
   * 做对照：把 elevationSpread 调回 0.30、抬升关掉，就精确复现了 v1 的"山地集合"。
   * 这样「团块 → 带」可以用一个数（面积加权长宽比）说清楚，不必靠肉眼看截图。
   */
  window.__LAB_ANALYZE = (ov) => {
    const v1rule = !!ov.__v1rule;
    const cfg = { ...ov };
    delete cfg.__v1rule;
    if (v1rule) { cfg.orogenyGain = 0; cfg.elevationSpread = 0.30; cfg.orogenyMountain = 999; }
    Object.assign(C, cfg);
    P.refresh();
    const isMtn = v1rule
      ? (t) => t.elevation > 0.65
      : (t) => t.elevation > SEA && t.orogeny >= C.orogenyMountain;
    const isSnow = v1rule ? (t) => t.elevation > 0.80 : (t) => t.biome === 'snow';

    let land = 0, mtn = 0, snow = 0, zeroLand = 0, clsLand = 0;
    let elevLand = 0, elevMtn = 0;
    const bio = {};
    for (const t of tiles) {
      bio[t.biome] = (bio[t.biome] || 0) + 1;
      if (t.elevation <= SEA) continue;
      land++; elevLand += t.elevation;
      if (isMtn(t)) { mtn++; elevMtn += t.elevation; }
      if (isSnow(t)) snow++;
      if (t.moisture === 0) zeroLand++;
      if (!(isMtn(t) || t.temperature < C.tempIce
            || t.temperature < C.tempTundra || t.temperature < C.tempTaiga)) clsLand++;
    }
    const ofLand = (k) => bio[k] ? +(bio[k] / land * 100).toFixed(2) : 0;

    // 山脉带形状：取山地集合的连通分量
    const mtnComps = compsOf(isMtn);
    const big = mtnComps.filter((c) => c.length >= 10);
    const shLargest = mtnComps.length ? shape(mtnComps[0]) : { elongPCA: 0, elongBox: 0 };
    // 形状统计用「面积加权」而非「最大分量」：
    //   几条造山带交汇处会形成一团「构造结」（长宽比接近 1），
    //   单看最大分量会被它带偏；面积加权回答的是「大多数山地格子长在什么形状里」。
    let acc = 0, accAspect = 0, accPCA = 0, bandArea = 0;
    const half = [];
    for (const c of mtnComps) {
      if (c.length < 6) { acc += c.length; continue; }   // 小碎块不参与形状统计
      const s = shape(c);
      acc += c.length; accAspect += s.elongBox * c.length; accPCA += s.elongPCA * c.length;
      if (s.elongBox >= 2.5) bandArea += c.length;
      half.push({ box: s.elongBox, pca: s.elongPCA, n: c.length });
    }
    const med = (a) => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0;
    const shHalf = {
      elongPCA: +med(half.map((s) => s.pca)).toFixed(2),
      elongBox: +med(half.map((s) => s.box)).toFixed(2),
    };

    // 陆块结构（确认没被造山带碰坏）
    const lc = compsOf((t) => t.elevation > SEA).map((c) => c.length);
    const landTotal = lc.reduce((s, v) => s + v, 0);

    // 红线：温度单调 / 雨林不越界 / 冰原不越界 / 雨林不贴冰
    const BUCK = 10, tb = new Array(BUCK).fill(0), tn = new Array(BUCK).fill(0);
    let rainforestHighLat = 0, iceLowLat = 0, rfAdjIce = 0, snowLowLat = 0;
    for (const t of tiles) {
      const al = Math.abs(t.latitude);
      const b = Math.min(BUCK - 1, Math.floor(al * BUCK));
      tb[b] += t.temperature; tn[b]++;
      if (t.biome === 'rainforest' && al > 0.6) rainforestHighLat++;
      if (t.biome === 'ice' && al < 0.85) iceLowLat++;
      if (isSnow(t) && al < 0.3) snowLowLat++;
      for (const j of adj[t.index]) {
        const b2 = tiles[j].biome;
        if ((t.biome === 'rainforest' && b2 === 'ice') || (t.biome === 'ice' && b2 === 'rainforest')) rfAdjIce++;
      }
    }
    let tempMonoOK = true, prev = null;
    for (let b = 0; b < BUCK; b++) {
      const v = tb[b] / (tn[b] || 1);
      if (prev !== null && v > prev + 1e-9) tempMonoOK = false;
      prev = v;
    }

    return {
      ov,
      v1rule,
      landPct: +(land / n * 100).toFixed(2),
      landComps: lc.length,
      largestLandPct: +(lc[0] / landTotal * 100).toFixed(1),
      islands1: lc.filter((v) => v === 1).length,
      mtnSnowPctOfLand: +(mtn / land * 100).toFixed(2),        // = M6
      mountainPctOfLand: ofLand('mountain'),
      snowPctOfLand: ofLand('snow'),
      mtnComps: mtnComps.length,
      mtnCompsOver10: big.length,
      elongLargest: shLargest.elongBox,
      elongLargestPCA: shLargest.elongPCA,
      elongHalf: shHalf.elongBox,
      elongHalfPCA: shHalf.elongPCA,
      elongWA: +(accAspect / Math.max(1, acc)).toFixed(2),        // 面积加权平均长宽比
      elongWAPCA: +(accPCA / Math.max(1, acc)).toFixed(2),
      bandAreaPct: +(bandArea / Math.max(1, mtn) * 100).toFixed(1), // 长宽比 ≥2.5 的分量覆盖的山地面积占比
      elevMtnMinusLand: +((elevMtn / (mtn || 1)) - (elevLand / land)).toFixed(3),
      snowLowLat,                                              // |lat| < 0.3 的雪峰数 → 赤道雪峰
      zeroLandPct: +(zeroLand / land * 100).toFixed(2),
      clsLandPctOfLand: +(clsLand / land * 100).toFixed(2),
      biomeOfLand: {
        desert: ofLand('desert'), grassland: ofLand('grassland'), forest: ofLand('forest'),
        rainforest: ofLand('rainforest'), taiga: ofLand('taiga'), tundra: ofLand('tundra'),
        ice: ofLand('ice'),
      },
      kinds: Object.keys(bio).length,
      regression: { tempMonoOK, rainforestHighLat, iceLowLat, rfAdjIce },
    };
  };
  return 1;
})()`);

const RAW = [];
for (const ov of COMBOS) RAW.push(await evaluate(`window.__LAB_ANALYZE(${JSON.stringify(ov)})`));
console.log(`已扫完 ${RAW.length} 组；再跑一次 v1 口径对照…`);
const V1 = await evaluate(`window.__LAB_ANALYZE(${JSON.stringify({ __v1rule: true })})`);

/* ---------- 打印对比表 ---------- */
const pad = (s, w) => String(s).padEnd(w);
const padl = (s, w) => String(s).padStart(w);
const SHORT = {
  orogenyBands: 'bands', orogenyWidth: 'width', orogenyMountain: 'mtn', orogenyGain: 'gain',
  orogenyMinLen: 'minL', orogenyMaxLen: 'maxL', orogenyPeakMin: 'pkMin', orogenyPeakMax: 'pkMax',
  tempSnow: 'snow', elevationSpread: 'spr', orogenyLandZ: 'landZ',
};
const cols = [
  ...AXIS_KEYS.map((k) => [SHORT[k] || k, 7]),
  ['陆地%', 7], ['山+雪%', 8], ['山脉%', 7], ['雪峰%', 7], ['山地块', 7],
  ['最大比', 7], ['加权比', 7], ['带面积%', 8], ['抬高', 6], ['赤道雪', 7],
  ['草%', 6], ['沙%', 6], ['分类陆地%', 10], ['红线', 5],
];
console.log('');
console.log(COMBOS.length + ' 组组合');
console.log(cols.map(([h, w]) => pad(h, w)).join(''));
console.log(cols.map(([, w]) => '─'.repeat(w)).join(''));
for (const r of RAW) {
  const o = r.ov;
  const red = (r.regression.tempMonoOK && r.regression.rainforestHighLat === 0
    && r.regression.iceLowLat === 0 && r.regression.rfAdjIce === 0) ? 'OK' : 'FAIL';
  const cells = [
    ...AXIS_KEYS.map((k) => pad(o[k], 7)),
    pad(r.landPct, 7), pad(r.mtnSnowPctOfLand, 8), pad(r.mountainPctOfLand, 7), pad(r.snowPctOfLand, 7),
    pad(r.mtnComps + '/' + r.mtnCompsOver10, 7),
    pad(r.elongLargest, 7), pad(r.elongWA, 7), pad(r.bandAreaPct, 8), pad(r.elevMtnMinusLand, 6),
    pad(r.snowLowLat, 7),
    pad(r.biomeOfLand.grassland, 6), pad(r.biomeOfLand.desert, 6), pad(r.clsLandPctOfLand, 10), pad(red, 5),
  ];
  console.log(cells.join(''));
}
console.log('');
console.log('最大比=最大山地分量的最小外接矩形长宽比｜加权比=按面积加权的平均长宽比（交汇「构造结」会拉低它）');
console.log('带面积%=长宽比 ≥2.5 的分量所覆盖的山地面积占比（验收口径 ≥2.5，即这个数应接近 100）');
console.log('抬高=山地平均海拔−陆地平均海拔（应显著为正，证明「山 = 高」）');
console.log('');
console.log('陆地结构与群系：');
for (const r of RAW) {
  const o = r.ov;
  console.log(`  [${AXIS_KEYS.map((k) => `${SHORT[k] || k}=${o[k]}`).join(' ')}] → ` +
    `陆地 ${padl(r.landPct, 5)}% 陆块 ${pad(r.landComps, 3)} 最大陆块 ${padl(r.largestLandPct, 5)}% 单格岛 ${pad(r.islands1, 2)}` +
    ` ｜ 草原 ${padl(r.biomeOfLand.grassland, 5)} 沙漠 ${padl(r.biomeOfLand.desert, 5)} 雨林 ${padl(r.biomeOfLand.rainforest, 5)} 针叶林 ${padl(r.biomeOfLand.taiga, 5)} 苔原 ${padl(r.biomeOfLand.tundra, 5)} 冰原 ${padl(r.biomeOfLand.ice, 5)} ｜ 分类陆地 ${padl(r.clsLandPctOfLand, 5)}% 零湿度 ${padl(r.zeroLandPct, 5)}%`);
}

/* ---------- v1 口径对照：量化「团块 → 带」 ---------- */
console.log('');
console.log('v1 口径对照（把 elevationSpread 调回 0.30、抬升关掉，精确复现 v1 的「海拔阈值山」）：');
{
  const a = V1;
  console.log(`  v1    规则：山+雪占陆地 ${padl(a.mtnSnowPctOfLand, 6)}%｜山地块 ${pad(a.mtnComps, 3)}｜` +
    `最大比 ${padl(a.elongLargest, 5)}｜加权比 ${padl(a.elongWA, 5)}｜带面积% ${padl(a.bandAreaPct, 5)}｜赤道雪 ${padl(a.snowLowLat, 4)}`);
  const best = RAW.reduce((m, r) => (r.bandAreaPct > m.bandAreaPct ? r : m), RAW[0]);
  console.log(`  本批带形最好的一行：加权比 ${padl(best.elongWA, 5)}，带面积% ${padl(best.bandAreaPct, 5)}` +
    `（${AXIS_KEYS.map((k) => `${SHORT[k] || k}=${best.ov[k]}`).join(' ')}）` +
    ` → 加权长宽比 ${best.elongWA >= 2.5 ? '≥' : '<'} 2.5 ${best.elongWA >= 2.5 ? '通过' : '未达标'}`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ page: 'index.html', combos: COMBOS, results: RAW, v1Baseline: V1 }, null, 2));
console.log(`\n明细已写入 ${path.relative(ROOT, OUT)}`);

ws.close();
child.kill();
process.exit(0);
