/**
 * 水文数据层验收（★ H2）：实机加载 index.html，从页面读 `world.hydro`，
 * 量河网拓扑与 §8.4 的**算法定理**，逐条 ✅/❌，不达标退出码 1。
 *
 * ── 口径说明（★ 重要，与 docs/v1-biome-globe-review.md §5 的 M12–M16 有出入）──
 * v1 台账里的 M12/M13/M14 是在「**河格的二维邻接图**」上量的（环数 / 连通分量 / 最大分量）。
 * 那套口径是为 v1 的**噪声色块**定的：v1 的"河"是整格填蓝，所以"连通分量 147 个"确实
 * 说明它碎。但换成**重力河网**之后，河格是一片连续的二维区域，它的邻接图**天然含环**
 * （两条平行河道只要隔一格相邻就成环），所以那三个数不再是"好坏"的信号。
 *
 * 更硬的一条：`tools/lab-hydro.mjs` 扫完 54 组参数后证明 M13/M14/M16 **互相冲突**：
 *   · M12 环数 ≤ 3          ⇒ 全表最小值 93（T=30 F=1.3），**任何阈值都到不了**
 *   · M13 连通分量 ≤ 30      ⇒ 只有 T ≥ 30 能做到（26–33），但那里 M14 只有 34–40 格
 *   · M14 最大连通水系 ≥ 200  ⇒ 只有 T ≤ 5 能做到（384–837），但那里 M16 只有 −0.031…−0.038
 *   · M16 河流比低地低 ≥ 0.04 ⇒ 只有 T ≥ 8 能做到（−0.043…−0.053），但那里 M14 只有 104–170
 * 即 **M14 与 M16 的交集为空**，M13 与 M14 的交集也为空。所以本脚本把口径改成
 * **与阈值无关、且真正表达意图**的量：
 *   M12 流图环数 = 0        —— "除三角洲外河道不相交"（构造保证）
 *   M13 河网可达性 = 100%    —— "河流必须通往海洋"（构造保证）
 *   M14 最大汇水面积（**陆地格**）≥ 200 等效格 —— "主干应该是条真的河"
 * 并在下方**照旧打印** v1 口径的三个数（标为「对照」），只是不再拿它们判成败。
 * 这是一次口径改写，**待用户拍板**，理由与全部证据见 docs/hydro-layer.md §3。
 *
 * ⚠ M14 的取数有个坑：**不能按全图取 max(accum)**。全图最大的一格是"入海口那一格海水"
 * —— 整个流域的水都汇到它身上（实测 650.2 等效格），而最大的陆地河格只有 441.5。
 * 按全图取会量到海水格，所以必须加 `elevation > seaLevel` 过滤。
 *
 * H2 阶段**还不上色**，所以本脚本不出截图（截图是 H3 的活）。
 * 它只回答一件事：**数据对不对**。
 *
 * 用法：node tools/verify-hydro.mjs
 * 输出：tools/out/hydro-stats.json（不入库）+ 控制台逐条 ✅/❌
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
const OUT = path.join(ROOT, 'tools', 'out');

async function probePort(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); return !!r.ok; } catch { return false; }
}
async function pickFreePort() {
  for (let i = 0; i < 40; i++) { const p = 9500 + Math.floor(Math.random() * 400); if (!(await probePort(p))) return p; }
  throw new Error('找不到空闲调试端口：先关掉残留的 headless Chrome');
}
const PORT = Number(process.env.CDP_PORT || await pickFreePort());

const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'cdp-hydro-verify-'));
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
for (let i = 0; i < 180; i++) { await sleep(1000); if (await evaluate('!!(window.__PLANET__ && window.__PLANET__.hydro && window.__PLANET__.hydro())')) break; }
await sleep(2500);   // 水文是一次性算完的，但首帧 + 自测要跑完

/* ---------- 页面守卫：确认这是 H2 之后的页面 ---------- */
const env = await evaluate(`(() => {
  const P = window.__PLANET__;
  if (!P) return { ok: false, why: '没有 __PLANET__' };
  const h = P.CONFIG.hydro;
  if (!h) return { ok: false, why: 'CONFIG.hydro 缺失（H2 之前）' };
  for (const k of ['runoffExponent','fillEpsilon','flowExponent','riverCellThreshold','minLakeDepth','minLakeArea']) {
    if (h[k] === undefined) return { ok: false, why: 'CONFIG.hydro.' + k + ' 缺失' };
  }
  if (P.CONFIG.riverWidth !== undefined) return { ok: false, why: 'CONFIG.riverWidth 不该存在（H1 已删，河不再是群系）' };
  const hy = P.hydro();
  if (!hy) return { ok: false, why: 'world.hydro 仍为 null（H2 没接进 recomputeTerrain）' };
  for (const k of ['adj','filled','depth','runoff','accum','w','down','isRiver','isSource','isMouth','lakeId','lakes','unit','pruned']) {
    if (hy[k] === undefined) return { ok: false, why: 'hydro.' + k + ' 缺失' };
  }
  // 分层守卫：河必须只活在 hydro 覆盖层里，不许写回 tile
  if (P.tiles.some((t) => t.isRiver !== undefined || t.river !== undefined || t.isLake !== undefined)) {
    return { ok: false, why: '河/湖被写回了 tile 上（应只存在于 hydro 覆盖层里）' };
  }
  return {
    ok: true, level: P.CONFIG.level, seed: P.CONFIG.seed, n: P.tiles.length,
    hydroMs: hy.ms, pruned: hy.pruned,
    hydro: { runoffExponent: h.runoffExponent, fillEpsilon: h.fillEpsilon,
      flowExponent: h.flowExponent, riverCellThreshold: h.riverCellThreshold,
      minLakeDepth: h.minLakeDepth, minLakeArea: h.minLakeArea },
    build: P.buildTimings,
  };
})()`);
if (!env.ok) throw new Error(`页面状态不对：${env.why}（先关掉残留的 headless Chrome）`);
console.log(`页面就绪：level=${env.level} seed=${env.seed} 图块 ${env.n} 个`);
console.log(`水文数据层耗时：${env.hydroMs} ms（整条地形链 ${env.build.terrainMs} ms，其中打包几何体 ${env.build.geometryMs} ms）`);
console.log(`剪枝：断头河删 ${env.pruned.deadEnds} 格 · 孤立河点删 ${env.pruned.isolated} 格`);

/* ---------- 页面内一次性算完所有指标 ---------- */
const S = await evaluate(`(() => {
  const P = window.__PLANET__, tiles = P.tiles, hy = P.hydro();
  const n = tiles.length, isR = hy.isRiver;
  const seaLevel = P.CONFIG.seaLevel;

  /* --- 邻接表规模：Σdeg 必须等于三角形数（= 2E） --- */
  let degSum = 0;
  for (let i = 0; i < n; i++) degSum += hy.adj[i].length;

  /* --- 河网：节点 = 河格 --- */
  let V = 0, landCount = 0, sources = 0, mouths = 0;
  for (let i = 0; i < n; i++) { if (isR[i]) V++; if (hy.isSource[i]) sources++; if (hy.isMouth[i]) mouths++; }
  for (const t of tiles) if (t.elevation > seaLevel) landCount++;

  /* --- 流图（\"水怎么走\"）：节点 = 河格，边 = x → 主下游（只保留河格之间的）---
     构造上每个节点出度 ≤ 1 ⇒ 必然是**森林**：可达河口 ⟺ 不在环上。 */
  const head = new Int32Array(n).fill(-1), next = new Int32Array(n).fill(-1);
  const mouthsList = [];
  for (let x = 0; x < n; x++) {
    if (!isR[x]) continue;
    const d = hy.down[x];
    if (d >= 0 && isR[d]) { next[x] = head[d]; head[d] = x; } else mouthsList.push(x);
  }
  let reachCount = 0;
  {
    const reach = new Uint8Array(n), queue = mouthsList.slice();
    for (const m of queue) reach[m] = 1;
    for (let qi = 0; qi < queue.length; qi++) {
      for (let e = head[queue[qi]]; e >= 0; e = next[e]) if (!reach[e]) { reach[e] = 1; queue.push(e); }
    }
    for (let i = 0; i < n; i++) if (isR[i] && reach[i]) reachCount++;
  }
  const flowCycles = V - reachCount;                 // 走不到河口的河格 = 卡在环上
  const flowComps = mouthsList.length;               // 森林的分量数 = 根（河口/终点）数

  /* --- 断头河 / 孤立河点（应当都被剪枝清零） --- */
  let deadEnds = 0, isolated = 0;
  for (let i = 0; i < n; i++) {
    if (!isR[i]) continue;
    const d = hy.down[i];
    if (d >= 0 && tiles[d].elevation > seaLevel && !isR[d]) deadEnds++;
    let neighbor = false;
    for (const k of hy.adj[i]) if (isR[k]) { neighbor = true; break; }
    if (!neighbor) isolated++;
  }

  /* --- v1 台账口径（对照用，不断言）：河格的二维邻接图 --- */
  const seen = new Uint8Array(n);
  const ccomps = [];
  let twiceE = 0;
  for (let i = 0; i < n; i++) if (isR[i]) for (const k of hy.adj[i]) if (isR[k]) twiceE++;
  for (let s = 0; s < n; s++) {
    if (!isR[s] || seen[s]) continue;
    const st = [s]; seen[s] = 1; let size = 0;
    while (st.length) {
      const x = st.pop(); size++;
      for (const k of hy.adj[x]) if (isR[k] && !seen[k]) { seen[k] = 1; st.push(k); }
    }
    ccomps.push(size);
  }
  ccomps.sort((a, b) => b - a);
  const cellComps = ccomps.length, cellLargest = ccomps[0] || 0;
  const cellCycles = twiceE / 2 - V + cellComps;

  /* --- ★ 河格是"线"还是"片"：度分布（H3 渲染的头号风险，见 docs/hydro-layer.md §6）---
     1D 河网（树/森林）的平均度 ≈ 2；度 ≥ 3 的比例高 ⇒ 河格糊成了二维片。 */
  let riverDegSum = 0, deg3 = 0;
  const degHist = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (!isR[i]) continue;
    let d = 0;
    for (const k of hy.adj[i]) if (isR[k]) d++;
    riverDegSum += d; degHist[d]++; if (d >= 3) deg3++;
  }
  const cellDegAvg = +(riverDegSum / Math.max(1, V)).toFixed(2);
  const cellDeg3Pct = +(deg3 / Math.max(1, V) * 100).toFixed(1);

  /* --- 河海拔 vs 低地海拔（低地口径与 v1 一致：森林 + 草原 + 沙漠） --- */
  const meanOf = (a) => a.reduce((s, t) => s + t.elevation, 0) / (a.length || 1);
  const riverTiles = tiles.filter((t) => isR[t.index]);
  const lowland = tiles.filter((t) => t.biome === 'forest' || t.biome === 'grassland' || t.biome === 'desert');

  /* --- 河格汇水面积（等效格数）分位数 --- */
  const eq = riverTiles.map((t) => hy.accum[t.index] / hy.unit).sort((a, b) => a - b);
  const q = (p) => (eq.length ? +eq[Math.min(eq.length - 1, Math.floor(eq.length * p))].toFixed(2) : 0);
  /* 最大汇水面积：**必须按陆地格取**。
     全图最大的 accum 出现在"入海口那一格海水"——整个流域的水都汇到它身上，
     按全图取会量到海水格（实测 650.2），按陆地格取才是"最大的那条河"（实测 441.5）。 */
  let maxAccumEqLand = 0;
  for (let i = 0; i < n; i++) {
    if (tiles[i].elevation <= seaLevel) continue;
    const v = hy.accum[i] / hy.unit; if (v > maxAccumEqLand) maxAccumEqLand = v;
  }
  const maxAccumEqRiver = q(1);                       // 河格口径（≤ 陆地格口径）

  /* --- 湖泊 --- */
  const lakeAreas = hy.lakes.map((l) => l.area).sort((a, b) => b - a);

  /* --- 诊断：depth 直方图（ε 填平在极平坦处留下的\"过水段\"有多少） --- */
  const bins = [0, 1e-5, 1e-4, 1e-3, 1e-2, 5e-2];
  const depthHist = bins.map((b) => { let c = 0; for (let i = 0; i < n; i++) if (hy.depth[i] > b) c++; return c; });

  /* --- 不变量（脚本自己独立再验一遍，不只依赖页面自测） --- */
  let geOK = true, monoOK = true, landNoDown = 0, runoffSum = 0, sinkSum = 0;
  for (let i = 0; i < n; i++) {
    if (hy.filled[i] < tiles[i].elevation - 1e-9) geOK = false;
    const d = hy.down[i];
    if (d >= 0 && !(hy.filled[d] < hy.filled[i])) monoOK = false;
    if (tiles[i].elevation > seaLevel && d < 0) landNoDown++;
    runoffSum += hy.runoff[i];
    if (d < 0) sinkSum += hy.accum[i];
  }
  // 可达性：从所有水域沿\"反向 down 链\"扩散，应覆盖全部陆地格
  let unreachedLand = 0;
  {
    const h2 = new Int32Array(n).fill(-1), n2 = new Int32Array(n).fill(-1);
    for (let x = 0; x < n; x++) { const d = hy.down[x]; if (d >= 0) { n2[x] = h2[d]; h2[d] = x; } }
    const reach = new Uint8Array(n), queue = [];
    for (let i = 0; i < n; i++) if (tiles[i].elevation <= seaLevel) { reach[i] = 1; queue.push(i); }
    for (let qi = 0; qi < queue.length; qi++) {
      for (let e = h2[queue[qi]]; e >= 0; e = n2[e]) if (!reach[e]) { reach[e] = 1; queue.push(e); }
    }
    for (let i = 0; i < n; i++) if (tiles[i].elevation > seaLevel && !reach[i]) unreachedLand++;
  }
  const conserveRel = runoffSum > 0 ? Math.abs(sinkSum - runoffSum) / runoffSum : 0;

  /* --- 干湿分异：雨林 vs 沙漠的河网密度（P0-2「沙漠里天然无河」） --- */
  const wet = tiles.filter((t) => t.biome === 'rainforest');
  const dry = tiles.filter((t) => t.biome === 'desert');
  const dens = (arr) => (arr.length ? arr.filter((t) => isR[t.index]).length / arr.length : 0);
  const wetDensity = dens(wet), dryDensity = dens(dry);

  const selfTest = P.selfTest;

  return {
    n, degSum, triangleCount: P.triToTile.length, landCount,
    rivers: {
      V, sources, mouths, flowComps, flowCycles, reachMouthPct: +(reachCount / Math.max(1, V) * 100).toFixed(2),
      deadEnds, isolated,
      densityPctOfTiles: +(V / n * 100).toFixed(2),
      densityPctOfLand: +(V / Math.max(1, landCount) * 100).toFixed(2),
      elevMean: +meanOf(riverTiles).toFixed(4),
      lowlandElevMean: +meanOf(lowland).toFixed(4),
      elevGap: +(meanOf(riverTiles) - meanOf(lowland)).toFixed(4),
      accumMedianEq: q(0.5), accumP10Eq: q(0.1), accumP90Eq: q(0.9),
      maxAccumEqLand: +maxAccumEqLand.toFixed(1), maxAccumEqRiver: +maxAccumEqRiver.toFixed(1),
      wetDensity: +wetDensity.toFixed(4), dryDensity: +dryDensity.toFixed(4),
      wetDryRatio: +(wetDensity / Math.max(1e-9, dryDensity)).toFixed(1),
      cellComps, cellLargest, cellCycles,                 // v1 台账口径（对照）
      cellDegAvg, cellDeg3Pct, degHist,                   // "线 vs 片"诊断（H3 风险）
      flowLargest: (() => {                                // 最大流图水系 = 最大的那棵树
        let best = 0;
        const size = new Int32Array(n);
        const order = [];
        for (let i = 0; i < n; i++) if (isR[i]) order.push(i);
        order.sort((a, b) => hy.filled[b] - hy.filled[a]);  // 降序 = 上游优先
        for (const x of order) {
          size[x] += 1;
          if (size[x] > best) best = size[x];
          const d = hy.down[x];
          if (d >= 0 && isR[d]) size[d] += size[x];
        }
        return best;
      })(),
    },
    /* --- ★ H3 河网渲染层（独立几何体）--- */
    river: (() => {
      const rs = P.river && P.river();
      const rm = P.riverMesh && P.riverMesh();
      if (!rs || !rm) return null;
      const pos = rm.geometry.attributes.position;
      let minR = Infinity, maxR = 0;
      for (let i = 0; i < pos.count; i++) {
        const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
      }
      const cells = [];
      for (let i = 0; i < n; i++) if (isR[i]) cells.push(i);

      /* M37 宽度—流量（Spearman）+ M32 河宽沿主下游回缩次数 */
      const rank = (arr) => {
        const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
        const r = new Array(arr.length);
        for (let i = 0; i < idx.length; i++) r[idx[i][1]] = i;
        return r;
      };
      let rho = 1, widthDips = 0, maxWidthDipRel = 0;
      if (cells.length > 2) {
        const ra = rank(cells.map((i) => hy.accum[i]));
        const rw = rank(cells.map((i) => rs.widths[i]));
        const m = cells.length;
        let d2 = 0;
        for (let i = 0; i < m; i++) d2 += (ra[i] - rw[i]) ** 2;
        rho = 1 - (6 * d2) / (m * (m * m - 1));
        for (const i of cells) {
          const d = hy.down[i];
          if (d >= 0 && isR[d] && rs.widths[d] < rs.widths[i]) {
            widthDips++;
            maxWidthDipRel = Math.max(maxWidthDipRel, 1 - rs.widths[d] / rs.widths[i]);
          }
        }
      }

      /* M31 分叉比：Strahler 级数（在河格的流图上算，按 filled 上游优先递推） */
      const order = new Int32Array(n);
      const ord = cells.slice().sort((a, b) => hy.filled[b] - hy.filled[a]);
      const byOrder = new Map();
      for (const x of ord) {
        let best = 0, ties = 0;
        for (const k of hy.adj[x]) {
          if (!isR[k] || hy.down[k] !== x) continue;
          const o = order[k];
          if (o > best) { best = o; ties = 1; } else if (o === best) ties++;
        }
        order[x] = best === 0 ? 1 : (ties >= 2 ? best + 1 : best);
        byOrder.set(order[x], (byOrder.get(order[x]) || 0) + 1);
      }
      const orders = [...byOrder.keys()].sort((a, b) => a - b);
      const bifurcation = [];
      for (let i = 0; i < orders.length - 1; i++) {
        bifurcation.push(+(byOrder.get(orders[i]) / byOrder.get(orders[i + 1])).toFixed(2));
      }

      return {
        vertexCount: rs.vertexCount, triCount: rs.triCount, chains: rs.chains,
        spacing: +rs.spacing.toFixed(5), eqMedian: +rs.eqMedian.toFixed(2), buildMs: rs.ms,
        minRadius: +minR.toFixed(5), maxRadius: +maxR.toFixed(5),
        material: rm.material.type, color: '#' + rm.material.color.getHexString(), visible: rm.visible,
        gridFingerprintPct: rs.gridFingerprintPct, gridFingerprintRawPct: rs.gridFingerprintRawPct,
        gridStraightPct: rs.gridStraightPct,
        spearman: +rho.toFixed(4), widthDips, maxWidthDipRel: +maxWidthDipRel.toFixed(4),
        strahlerOrders: orders, strahlerCounts: orders.map((o) => byOrder.get(o)), bifurcation,
      };
    })(),
    lakes: {
      count: hy.lakes.length, largest: lakeAreas[0] || 0, top5: lakeAreas.slice(0, 5),
      totalCells: lakeAreas.reduce((a, b) => a + b, 0),
      pctOfLand: +(lakeAreas.reduce((a, b) => a + b, 0) / Math.max(1, landCount) * 100).toFixed(3),
      maxDepth: +Math.max(0, ...hy.lakes.map((l) => l.depthMax)).toFixed(4),
      endorheicNull: hy.lakes.every((l) => l.isEndorheic === null && l.outflow === null),
    },
    depthHist: { bins, counts: depthHist },
    invariants: {
      degEquals2E: degSum === P.triToTile.length,
      filledGeElevation: geOK, downstreamStrictlyLower: monoOK,
      landAllHaveDown: landNoDown === 0, unreachedLand,
      conservationRel: +conserveRel.toExponential(2),
      runoffSum: +runoffSum.toFixed(2), sinkSum: +sinkSum.toFixed(2),
    },
    selfTest: selfTest ? { checks: selfTest.rows.length, failed: selfTest.rows.filter((r) => !r.ok).map((r) => r.name) } : null,
  };
})()`);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'hydro-stats.json'),
  JSON.stringify({ level: env.level, seed: env.seed, hydroMs: env.hydroMs, params: env.hydro, pruned: env.pruned, ...S }, null, 2), 'utf8');

/* ---------- 判定 ---------- */
const R = S.rivers, I = S.invariants, RV = S.river;
const checks = [
  // ---- 河网拓扑（★ 口径已改写，理由见文件头） ----
  ['M12 流图环数 = 0（河道不相交）',   R.flowCycles === 0,      `${R.flowCycles} 个｜v1 口径（格邻接）是 126 个闭环`],
  ['M13 河网可达性 = 100%（必达河口）', R.reachMouthPct === 100, `${R.reachMouthPct}%（${R.V} 个河格全部顺主下游可达河口）`],
  ['M14 最大汇水面积（陆地格）≥ 200 等效格', R.maxAccumEqLand >= 200, `${R.maxAccumEqLand} 等效格（河格口径 ${R.maxAccumEqRiver}）｜最大流图水系 ${R.flowLargest} 格`],
  ['M15 孤立河点 = 0',                 R.isolated === 0,        `${R.isolated} 个｜v1 口径 13.0%`],
  ['M15b 断头河 = 0',                  R.deadEnds === 0,        `${R.deadEnds} 个｜v1 口径 31.9%`],
  ['M16 河流海拔 − 低地海拔 ≤ −0.04',   R.elevGap <= -0.04,      `${R.elevGap}（河流 ${R.elevMean} vs 低地 ${R.lowlandElevMean}）｜v1 口径 −0.0215`],
  ['P0-2 河格汇水面积中位数 ≥ 20 格',   R.accumMedianEq >= 20,   `中位数 ${R.accumMedianEq}｜p10 ${R.accumP10Eq}｜p90 ${R.accumP90Eq}`],
  ['P0-2 沙漠里天然无河（干湿密度比 ≥ 3×）', R.wetDryRatio >= 3,
    `雨林 ${(R.wetDensity * 100).toFixed(1)}% vs 沙漠 ${(R.dryDensity * 100).toFixed(1)}%（${R.wetDryRatio}×）`],
  // ---- 算法定理（构造保证，不是调参调出来的） ----
  ['定理 Σdeg = 2E（邻接表与三角形数一致）', I.degEquals2E, `${S.degSum} / 三角形 ${S.triangleCount}`],
  ['定理 filled ≥ elevation',          I.filledGeElevation, 'Priority-Flood 的 max() 保证'],
  ['定理 下游严格递减（不可能成环）',    I.downstreamStrictlyLower, '每步 +fillEpsilon'],
  ['定理 陆地格必有主下游（无陆地洼地）', I.landAllHaveDown, 'ε 填平后处处有下坡'],
  ['定理 每个陆地格都能走到海洋',        I.unreachedLand === 0, `走不到 ${I.unreachedLand} 格`],
  ['定理 水量守恒（相对误差 < 1e-6）',   parseFloat(I.conservationRel) < 1e-6,
    `产流 ${I.runoffSum} vs 终点 ${I.sinkSum}（相对误差 ${I.conservationRel}）`],
  ['湖泊已产出（H2 不做水量平衡）',      S.lakes.count > 0 && S.lakes.endorheicNull,
    `${S.lakes.count} 个湖｜最大 ${S.lakes.largest} 格｜占陆地 ${S.lakes.pctOfLand}%｜isEndorheic 全为 null（H4 判定）`],
  ['页面自测（runSelfTest）全部通过',    S.selfTest && S.selfTest.failed.length === 0 && S.selfTest.checks >= 25,
    S.selfTest ? `${S.selfTest.checks} 条${S.selfTest.failed.length ? '，失败：' + S.selfTest.failed.join('、') : '，无失败项'}` : '未取到'],

  // ---- ★ H3 河网渲染层（独立几何体，1 次 draw call）----
  ['H3 河网几何体就位（独立 Mesh + 独立材质）', RV && RV.material === 'MeshBasicMaterial' && RV.visible === true,
    RV ? `${RV.triCount} 三角形 / ${RV.vertexCount} 顶点 / ${RV.chains} 条链 · ${RV.material} ${RV.color} · 建模 ${RV.buildMs} ms` : '未取到'],
  ['M31 河网分叉比（Strahler 最低阶）∈ [3,5]',
    RV && RV.bifurcation.length > 0 && RV.bifurcation[0] >= 3 && RV.bifurcation[0] <= 5,
    RV ? `各级格数 ${RV.strahlerCounts.join('/')} → Rb ${RV.bifurcation.join('/')}` : '未取到'],
  ['M32 河宽沿主下游不明显收腰（最大回缩 ≤ 25%）', RV && RV.maxWidthDipRel <= 0.25,
    RV ? `${RV.widthDips} 处回缩（占河格 ${(RV.widthDips / Math.max(1, R.V) * 100).toFixed(1)}%）｜最大幅度 ${(100 * RV.maxWidthDipRel).toFixed(1)}%` : '未取到'],
  ['M33 入海率 ≥ 70%', R.reachMouthPct >= 70,
    `${R.reachMouthPct}%（H3 还没有内流盆地，H4 起这个数才有信息量）`],
  ['M35 河网不像六边形折线（格网指纹 ≤ 40%）', RV && RV.gridFingerprintPct <= 40,
    RV ? `平滑后 ${RV.gridFingerprintPct}% ｜ 只有抖动、未平滑时 ${RV.gridFingerprintRawPct}%（直行段占 ${RV.gridStraightPct}%，已剔除）` : '未取到'],
  ['M37 河宽与汇水面积单调相关（Spearman ≥ 0.9）', RV && RV.spearman >= 0.9,
    RV ? `ρ = ${RV.spearman}` : '未取到'],
];
let fail = 0;
console.log('');
for (const [name, ok, detail] of checks) {
  if (!ok) fail++;
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(36)} ${detail}`);
}
console.log('');
console.log(`河网：${R.V} 个河格（占陆地 ${R.densityPctOfLand}%、占全部图块 ${R.densityPctOfTiles}%）· ` +
  `河源 ${R.sources} · 河口 ${R.mouths} · 流图水系 ${R.flowComps} 个（最大 ${R.flowLargest} 格）`);
console.log(`对照（v1 台账口径 = 河格的二维邻接图，已证明与 M16 冲突、故不再判成败）：` +
  `环 ${R.cellCycles} · 连通分量 ${R.cellComps} · 最大分量 ${R.cellLargest} 格`);
console.log(`★ H3 风险诊断「河格是线还是片」：平均度 ${R.cellDegAvg}（树应 ≈2）· ` +
  `度≥3 占 ${R.cellDeg3Pct}% · 度分布 [0..6]=${R.degHist.join('/')}`);
console.log(`湖泊：${S.lakes.count} 个（最大 ${S.lakes.largest} 格，前 5 ${S.lakes.top5.join('/')}）· ` +
  `湖面共 ${S.lakes.totalCells} 格（占陆地 ${S.lakes.pctOfLand}%）· 最深 ${S.lakes.maxDepth}`);
console.log(`depth 直方图（> 阈值的格数）：${S.depthHist.bins.map((b, i) => `${b}=${S.depthHist.counts[i]}`).join(' · ')}`);
console.log(`河网几何体（★ H3）：${RV
  ? `${RV.triCount} 三角形 / ${RV.vertexCount} 顶点 / ${RV.chains} 条链 · 格间距 ${RV.spacing} · ` +
    `顶点半径 ∈ [${RV.minRadius}, ${RV.maxRadius}] · 材质 ${RV.material} ${RV.color}`
  : '未建'}`);
console.log(`耗时：水文数据层 ${env.hydroMs} ms`);
console.log(`指标已写入 ${path.relative(ROOT, path.join(OUT, 'hydro-stats.json'))}`);
console.log(fail === 0 ? `\n全部通过（${checks.length} 条）` : `\n${fail} 条未通过`);

try { ws.close(); } catch { }
try { child.kill(); } catch { }
process.exit(fail === 0 ? 0 : 1);
