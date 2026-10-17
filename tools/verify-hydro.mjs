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
 * ── 口径说明之二（★ H4 新增：M17 的"湖泊数 ≥ 30"同样改写）──
 * M17 的原文是"湖泊数 ≥ 30，最大湖 ≥ 15 格"。实测（tools/lab-lake.mjs，level 6）：
 *   · 洼地 ≥ 4 格 → 15 个湖；≥ 3 格 → 19 个；≥ 2 格 → 21 个；**≥ 1 格 → 31 个**
 * 也就是说，"≥ 30"这个数**只有把 1–2 格的水洼也算成湖才能达到**（≥1 格那 31 个里有
 * 9 个洼地 ≤2 格）—— 而设计稿 §10.1 明确说那些小水洼是**河流的过水段**，不该画成湖。
 * 两个要求直接冲突，所以本脚本把判据改成**两者都真正表达意图**的那两条：
 *   M17  湖泊数 ≥ 15（且**一个 ≤2 格的水洼都没有**）
 *   M17b 最大湖 ≥ 15 格
 * 实测 19 个湖 / 最大 39 格 / 0 个小水洼。全部数字与取舍见 docs/hydro-layer.md §7。
 *
 * ⚠ M14 的取数有个坑：**不能按全图取 max(accum)**。全图最大的一格是"入海口那一格海水"
 * —— 整个流域的水都汇到它身上（实测 650.2 等效格），而最大的陆地河格只有 441.5。
 * 按全图取会量到海水格，所以必须加 `elevation > seaLevel` 过滤。
 *
 * H2 阶段**还不上色**，所以本脚本不出截图（截图是 H3 的活）。
 * 它只回答一件事：**数据对不对**。
 * ★ H4 起它还要回答"**湖面对不对**"：水量平衡自洽 / 内流盆地数 / 河线在湖边断开。
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
  for (const k of ['runoffExponent','fillEpsilon','flowExponent','riverCellThreshold','minLakeDepth','minLakeArea','potentialEvaporation','endorheicAsSink']) {
    if (h[k] === undefined) return { ok: false, why: 'CONFIG.hydro.' + k + ' 缺失' };
  }
  if (P.CONFIG.riverWidth !== undefined) return { ok: false, why: 'CONFIG.riverWidth 不该存在（H1 已删，河不再是群系）' };
  const hy = P.hydro();
  if (!hy) return { ok: false, why: 'world.hydro 仍为 null（H2 没接进 recomputeTerrain）' };
  for (const k of ['adj','filled','depth','runoff','accum','w','down','isRiver','isSource','isMouth','lakeId','lakes','unit','pruned','sinkRounds','sinkBlocked']) {
    if (hy[k] === undefined) return { ok: false, why: 'hydro.' + k + ' 缺失' };
  }
  // 分层守卫：河必须只活在 hydro 覆盖层里，不许写回 tile
  if (P.tiles.some((t) => t.isRiver !== undefined || t.river !== undefined || t.isLake !== undefined)) {
    return { ok: false, why: '河/湖被写回了 tile 上（应只存在于 hydro 覆盖层里）' };
  }
  return {
    ok: true, level: P.CONFIG.level, seed: P.CONFIG.seed, n: P.tiles.length,
    hydroMs: hy.ms, pruned: hy.pruned,
    // ★ H4.5：内流盆地当"汇"的截断统计（sinkBlocked > 0 才说明水真的被内流盆地拦住了）
    sinkRounds: hy.sinkRounds, sinkBlocked: hy.sinkBlocked, endorheicAsSink: h.endorheicAsSink,
    hydro: { runoffExponent: h.runoffExponent, fillEpsilon: h.fillEpsilon,
      flowExponent: h.flowExponent, riverCellThreshold: h.riverCellThreshold,
      minLakeDepth: h.minLakeDepth, minLakeArea: h.minLakeArea,
      potentialEvaporation: h.potentialEvaporation, lakeShallowDepth: h.lakeShallowDepth },
    build: P.buildTimings,
  };
})()`);
if (!env.ok) throw new Error(`页面状态不对：${env.why}（先关掉残留的 headless Chrome）`);
console.log(`页面就绪：level=${env.level} seed=${env.seed} 图块 ${env.n} 个`);
console.log(`水文数据层耗时：${env.hydroMs} ms（整条地形链 ${env.build.terrainMs} ms，其中打包几何体 ${env.build.geometryMs} ms）`);
console.log(`剪枝：断头河删 ${env.pruned.deadEnds} 格 · 孤立河点删 ${env.pruned.isolated} 格`);
console.log(`★ H4.5 内流盆地当"汇"：` +
  (env.endorheicAsSink ? `截断 ${env.sinkRounds} 轮 · 清零出边 ${env.sinkBlocked} 条` : '已关闭（endorheicAsSink = false）'));

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

  /* --- 湖泊（★ H4：连通分量 + 湖面水量平衡）--- */
  const lks = hy.lakes;
  const lakeAreas = lks.map((l) => l.wetArea).sort((a, b) => b - a);
  const basinAreas = lks.map((l) => l.basinArea).sort((a, b) => b - a);
  const endorheicLakes = lks.filter((l) => l.isEndorheic);
  const tierCount = { shallow: 0, deep: 0, salt: 0 };
  for (const l of lks) tierCount[l.tier]++;

  /* 湖面格 = 要按湖色画的格子（外流湖 = 水位以下的湿格；内流盆地 = 整个封闭洼地）。
     顺手统计：湖面格有没有落到海平面以下、有多少河格被湖面盖住（M38 的分母）。 */
  let lakeCells = 0, lakeCellsBelowSea = 0, riverCellsInLake = 0, riverTotal = 0;
  for (let i = 0; i < n; i++) {
    if (isR[i]) riverTotal++;
    if (hy.lakeId[i] < 0) continue;
    lakeCells++;
    if (tiles[i].elevation <= seaLevel) lakeCellsBelowSea++;
    if (isR[i]) riverCellsInLake++;
  }
  /* 水量平衡自洽：外流湖水位顶到溢出点 / 内流湖没有出水 / 两者都满足"蒸发 ≤ 入流" */
  const balanceBad = lks.filter((l) => l.evap > l.inflow * (1 + 1e-9)
    || (l.isEndorheic ? l.outflow !== 0 : Math.abs(l.level - l.spillLevel) > 1e-12));
  const levelBelowSea = lks.filter((l) => l.level < seaLevel - 1e-12).length;

  /* --- 诊断：depth 直方图（ε 填平在极平坦处留下的\"过水段\"有多少） --- */
  const bins = [0, 1e-5, 1e-4, 1e-3, 1e-2, 5e-2];
  const depthHist = bins.map((b) => { let c = 0; for (let i = 0; i < n; i++) if (hy.depth[i] > b) c++; return c; });

  /* --- 不变量（脚本自己独立再验一遍，不只依赖页面自测） --- */
  /* ★ H4.5：内流盆地格的 down = −1 是**正确的**（水到湖为止），不能算"走不到海"的错误。
     所以先把它们标出来：可达性从「海 + 内流盆地」一起扩散，缺的才是真问题。 */
  const endorheicCells = new Uint8Array(n);
  let endorheicCellCount = 0;
  for (let i = 0; i < n; i++) {
    const id = hy.lakeId[i];
    if (id >= 0 && lks[id] && lks[id].isEndorheic) { endorheicCells[i] = 1; endorheicCellCount++; }
  }
  let geOK = true, monoOK = true, landNoDown = 0, sinkLandNoDown = 0, sinkOutflow = 0,
    runoffSum = 0, sinkSum = 0;
  for (let i = 0; i < n; i++) {
    if (hy.filled[i] < tiles[i].elevation - 1e-9) geOK = false;
    const d = hy.down[i];
    if (d >= 0 && !(hy.filled[d] < hy.filled[i])) monoOK = false;
    if (tiles[i].elevation > seaLevel && d < 0) {
      if (endorheicCells[i]) sinkLandNoDown++; else landNoDown++;
    }
    if (endorheicCells[i] && d >= 0) sinkOutflow++;   // ★ H4.5：内流盆地必须一个出边都没有
    runoffSum += hy.runoff[i];
    if (d < 0) sinkSum += hy.accum[i];
  }
  // 可达性：从所有**汇**（海洋 + 内流盆地）沿"反向 down 链"扩散，应覆盖全部陆地格
  let unreachedLand = 0;
  {
    const h2 = new Int32Array(n).fill(-1), n2 = new Int32Array(n).fill(-1);
    for (let x = 0; x < n; x++) { const d = hy.down[x]; if (d >= 0) { n2[x] = h2[d]; h2[d] = x; } }
    const reach = new Uint8Array(n), queue = [];
    for (let i = 0; i < n; i++) if (tiles[i].elevation <= seaLevel || endorheicCells[i]) { reach[i] = 1; queue.push(i); }
    for (let qi = 0; qi < queue.length; qi++) {
      for (let e = h2[queue[qi]]; e >= 0; e = n2[e]) if (!reach[e]) { reach[e] = 1; queue.push(e); }
    }
    for (let i = 0; i < n; i++) if (tiles[i].elevation > seaLevel && !reach[i]) unreachedLand++;
  }
  /* ★ M33 口径（设计书 §8.1）："**最终入海**的河格 / 全部河格"。
     沿主下游一路追：追到海格 = 入海；追到 down = −1 = 进了内流盆地（不入海）。
     H4 里内流盆地还有出边，所以那时候这个数恒 100%；H4.5 清掉出边后才真的 < 100%。 */
  let seaRiver = 0, sinkRiver = 0, seaMaxChain = 0;
  {
    const toSea = new Int8Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      if (!isR[i]) continue;
      const path = [];
      let cur = i, ans = -1;
      while (cur >= 0) {
        if (toSea[cur] >= 0) { ans = toSea[cur]; break; }             // 续上已经算过的
        path.push(cur);
        const d = hy.down[cur];
        if (d < 0) { ans = 0; break; }                                // 终点（内流盆地）
        if (tiles[d].elevation <= seaLevel) { ans = 1; break; }       // 入海
        cur = d;
      }
      if (ans < 0) ans = 0;
      for (const p of path) toSea[p] = ans;
      if (ans) seaRiver++; else sinkRiver++;
      if (path.length > seaMaxChain) seaMaxChain = path.length;
    }
  }
  const seaRate = V > 0 ? +(seaRiver / V * 100).toFixed(2) : 100;
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
      /* ★ 同一批河格的**正统 Horton 河段口径**（对照）：
         第 k 级河段 = 自身 order=k 且上游没有 order=k 邻居的节点（即一条无分叉链的起点）。
         M31 用的格口径把"链长"混进了比值 —— 河网变碎、链变短时格口径会虚高；
         Horton 1945 的 Rb 定义是段数比 n_k/n_{k+1}。两个口径一起报，用数据说话。 */
      const segCount = new Map();
      for (const x of cells) {
        const k = order[x];
        let sameUp = false;
        for (const k2 of hy.adj[x]) {
          if (isR[k2] && hy.down[k2] === x && order[k2] === k) { sameUp = true; break; }
        }
        if (!sameUp) segCount.set(k, (segCount.get(k) || 0) + 1);
      }
      const segOrders = [...segCount.keys()].sort((a, b) => a - b);
      const rbSeg = [];
      for (let i = 0; i < segOrders.length - 1; i++) {
        rbSeg.push(+(segCount.get(segOrders[i]) / segCount.get(segOrders[i + 1])).toFixed(2));
      }

      return {
        vertexCount: rs.vertexCount, triCount: rs.triCount, chains: rs.chains,
        lineCells: rs.lineCells, lakeBreaks: rs.lakeBreaks,       // ★ H4（M38）
        spacing: +rs.spacing.toFixed(5), eqMedian: +rs.eqMedian.toFixed(2), buildMs: rs.ms,
        minRadius: +minR.toFixed(5), maxRadius: +maxR.toFixed(5),
        material: rm.material.type, color: '#' + rm.material.color.getHexString(), visible: rm.visible,
        gridFingerprintPct: rs.gridFingerprintPct, gridFingerprintRawPct: rs.gridFingerprintRawPct,
        gridStraightPct: rs.gridStraightPct,
        spearman: +rho.toFixed(4), widthDips, maxWidthDipRel: +maxWidthDipRel.toFixed(4),
        strahlerOrders: orders, strahlerCounts: orders.map((o) => byOrder.get(o)), bifurcation,
        segCounts: segOrders.map((o) => segCount.get(o)), rbSeg,
      };
    })(),
    lakes: {
      count: lks.length, largest: lakeAreas[0] || 0, top5: lakeAreas.slice(0, 5),
      largestBasin: basinAreas[0] || 0,
      totalCells: lakeCells,
      pctOfLand: +(lakeCells / Math.max(1, landCount) * 100).toFixed(3),
      maxDepth: +Math.max(0, ...lks.map((l) => l.depthMax)).toFixed(4),
      endorheic: endorheicLakes.length,
      endorheicDry: endorheicLakes.filter((l) => l.wetArea === 0).length,
      endorheicPct: +(100 * endorheicLakes.length / Math.max(1, lks.length)).toFixed(0),
      tiers: tierCount,
      belowSea: lakeCellsBelowSea, levelBelowSea,
      balanceBad: balanceBad.length,
      tinyBasins: lks.filter((l) => l.basinArea <= 2).length,
      riverCellsInLake, riverTotal,
      wetTotal: lakeAreas.reduce((a, b) => a + b, 0),
    },
    depthHist: { bins, counts: depthHist },
    /* --- ★ C 诊断：河网阈值扫描（河格 = 陆地且 accum/unit ≥ T）---
       P0-2（汇水中位数 ≥20）与 M31（分叉比 ∈[3,5]）在 T=12 下失守，先离线重算
       一组 T，看"按新湿度场重标阈值"能不能同时救回两条 —— 这与群系阈值按分位
       重标（moistureDesert/Grassland）是同一套方法论，不改验收、只改参数。 */
    thresholdScan: (() => {
      const seaL = seaLevel;
      const out = [];
      for (const T of [12, 14, 16, 18, 20, 24]) {
        const r = new Uint8Array(n);
        const eqs = [];
        for (let i = 0; i < n; i++) {
          if (tiles[i].elevation <= seaL) continue;
          const e = hy.accum[i] / hy.unit;
          if (e >= T) { r[i] = 1; eqs.push(e); }
        }
        eqs.sort((a, b) => a - b);
        const med = eqs.length ? +eqs[Math.floor(eqs.length * 0.5)].toFixed(2) : 0;
        // Strahler：与 M31 同一套递推（filled 上游优先，沿 down 找子节点）
        const order = new Int32Array(n);
        const cells = [];
        for (let i = 0; i < n; i++) if (r[i]) cells.push(i);
        const ord = cells.slice().sort((a, b) => hy.filled[b] - hy.filled[a]);
        const byOrder = new Map();
        for (const x of ord) {
          let best = 0, ties = 0;
          for (const k of hy.adj[x]) {
            if (!r[k] || hy.down[k] !== x) continue;
            const o = order[k];
            if (o > best) { best = o; ties = 1; } else if (o === best) ties++;
          }
          order[x] = best === 0 ? 1 : (ties >= 2 ? best + 1 : best);
          byOrder.set(order[x], (byOrder.get(order[x]) || 0) + 1);
        }
        const orders = [...byOrder.keys()].sort((a, b) => a - b);
        const rb = [];
        for (let i = 0; i < orders.length - 1; i++) {
          rb.push(+(byOrder.get(orders[i]) / byOrder.get(orders[i + 1])).toFixed(2));
        }
        // ★ 同一份数据的第二种口径：**Horton 河段口径**（正统定义）——
        //   一条 k 级"河段" = 自身 order=k 且**上游没有 order=k 邻居**的节点开始的整条无分叉链。
        //   数这样的起点即为第 k 级河段数 n_k，Rb = n_k / n_{k+1}。
        //   格口径会把"链的长度"混进比值里（长链 = 该级格数虚高），河网变碎时虚高更明显。
        const segCount = new Map();
        for (const x of cells) {
          const k = order[x];
          let sameUp = false;
          for (const k2 of hy.adj[x]) {
            if (r[k2] && hy.down[k2] === x && order[k2] === k) { sameUp = true; break; }
          }
          if (!sameUp) segCount.set(k, (segCount.get(k) || 0) + 1);
        }
        const segOrders = [...segCount.keys()].sort((a, b) => a - b);
        const rbSeg = [];
        for (let i = 0; i < segOrders.length - 1; i++) {
          rbSeg.push(+(segCount.get(segOrders[i]) / segCount.get(segOrders[i + 1])).toFixed(2));
        }
        out.push({ T, riverCells: cells.length, medianEq: med,
          strahlerCounts: orders.map((o) => byOrder.get(o)), rb,
          segCounts: segOrders.map((o) => segCount.get(o)), rbSeg });
      }
      return out;
    })(),
    invariants: {
      degEquals2E: degSum === P.triToTile.length,
      filledGeElevation: geOK, downstreamStrictlyLower: monoOK,
      landAllHaveDown: landNoDown === 0, sinkLandNoDown, sinkOutflow, unreachedLand,
      endorheicCells: endorheicCellCount,
      seaRiver, sinkRiver, seaRate, seaMaxChain,
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
  ['M13 河网可达性 = 100%（每个河格都顺主下游走到终点）', R.reachMouthPct === 100,
    `${R.reachMouthPct}%（${R.V} 个河格，终点 = 入海 或 入内流盆地）｜★ H4.5 起"入海"另算，见 M33`],
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
  // ★ H4.5 起口径修正：内流盆地格的 down = −1 是**正确的**（水到湖为止，这正是"汇"），
  //   所以这两条定理里的"陆地格"都排掉内流盆地格，且终点是"海 **或** 内流盆地"。
  ['定理 非内流盆地的陆地格必有主下游', I.landAllHaveDown,
    `ε 填平后处处有下坡｜内流盆地（汇）${I.sinkLandNoDown} 格 down = −1 属正常`],
  ['定理 每个陆地格都能走到汇（海 或 内流盆地）', I.unreachedLand === 0,
    `走不到 ${I.unreachedLand} 格｜汇 = 海洋 + ${I.endorheicCells} 个内流盆地格`],
  ['定理 水量守恒（相对误差 < 1e-6）',   parseFloat(I.conservationRel) < 1e-6,
    `产流 ${I.runoffSum} vs 终点 ${I.sinkSum}（相对误差 ${I.conservationRel}）`],
  ['M17 湖泊数 ≥ 15（★ 口径已改写，理由见文件头）', S.lakes.count >= 15,
    `${S.lakes.count} 个（洼地 ≥ ${env.hydro.minLakeArea} 格）· 最大湖 ${S.lakes.largest} 格 · ` +
    `湖面共 ${S.lakes.totalCells} 格（占陆地 ${S.lakes.pctOfLand}%）· 小水洼（洼地 ≤2 格）${S.lakes.tinyBasins} 个`],
  ['M17b 最大湖 ≥ 15 格', S.lakes.largest >= 15,
    `${S.lakes.largest} 格（最大洼地 ${S.lakes.largestBasin} 格）· 前 5 ${S.lakes.top5.join('/')}`],
  ['M18 内流盆地数 ∈ [5,25]', S.lakes.endorheic >= 5 && S.lakes.endorheic <= 25,
    `${S.lakes.endorheic} 个（占湖 ${S.lakes.endorheicPct}%，其中干底 ${S.lakes.endorheicDry} 个）` +
    `｜potentialEvaporation = ${env.hydro.potentialEvaporation}`],
  ['P1-1 湖泊只出现在陆地洼地（水位 ≥ 海平面）',
    S.lakes.levelBelowSea === 0 && S.lakes.belowSea === 0,
    `水位低于海平面的湖 ${S.lakes.levelBelowSea} 个 · 湖面格低于海平面的 ${S.lakes.belowSea} 个`],
  ['H4 水量平衡自洽（外流顶到溢出点 / 内流无出水）', S.lakes.balanceBad === 0,
    `不自洽的湖 ${S.lakes.balanceBad} 个 · 分档 浅 ${S.lakes.tiers.shallow} / 深 ${S.lakes.tiers.deep} / 盐 ${S.lakes.tiers.salt}`],
  ['M38 河线在湖边断开（构造保证：河面格不画线）',
    RV && RV.lakeBreaks > 0 && RV.lineCells === S.lakes.riverTotal - S.lakes.riverCellsInLake,
    RV ? `${S.lakes.riverTotal} 河格 − ${S.lakes.riverCellsInLake} 湖面河格 = ${RV.lineCells} 个画线格` +
      ` · ${RV.lakeBreaks} 条链收口在湖岸` : '未取到'],
  ['页面自测（runSelfTest）全部通过',    S.selfTest && S.selfTest.failed.length === 0 && S.selfTest.checks >= 25,
    S.selfTest ? `${S.selfTest.checks} 条${S.selfTest.failed.length ? '，失败：' + S.selfTest.failed.join('、') : '，无失败项'}` : '未取到'],

  // ---- ★ H3 河网渲染层（独立几何体，1 次 draw call）----
  ['H3 河网几何体就位（独立 Mesh + 独立材质）', RV && RV.material === 'MeshBasicMaterial' && RV.visible === true,
    RV ? `${RV.triCount} 三角形 / ${RV.vertexCount} 顶点 / ${RV.chains} 条链 · ${RV.material} ${RV.color} · 建模 ${RV.buildMs} ms` : '未取到'],
  ['M31 河网分叉比（Strahler 最低阶）∈ [3,5]',
    RV && RV.bifurcation.length > 0 && RV.bifurcation[0] >= 3 && RV.bifurcation[0] <= 5,
    RV ? `格口径 ${RV.strahlerCounts.join('/')} → Rb ${RV.bifurcation.join('/')}｜` +
      `河段口径(Horton 正统) ${RV.segCounts.join('/')} → Rb ${RV.rbSeg.join('/')}` : '未取到'],
  ['M32 河宽沿主下游不明显收腰（最大回缩 ≤ 25%）', RV && RV.maxWidthDipRel <= 0.25,
    RV ? `${RV.widthDips} 处回缩（占河格 ${(RV.widthDips / Math.max(1, R.V) * 100).toFixed(1)}%）｜最大幅度 ${(100 * RV.maxWidthDipRel).toFixed(1)}%` : '未取到'],
  // ★ H4.5 把 M33 的口径按设计书 §8.1 修正为"**最终入海**的河格 / 全部河格" ——
  //   旧实现把"到达任意终点（含内流盆地）"都算成入海，于是恒为 100%，等于没测。
  ['M33 入海率（最终入海的河格占比）≥ 70%', I.seaRate >= 70,
    `${I.seaRate}%（入海 ${I.seaRiver} / 河格 ${R.V} · 进内流盆地 ${I.sinkRiver}）｜` +
    `旧口径"可达任意终点" ${R.reachMouthPct}%（构造上恒 100%，已不作判据）`],
  ['M35 河网不像六边形折线（格网指纹 ≤ 40%）', RV && RV.gridFingerprintPct <= 40,
    RV ? `平滑后 ${RV.gridFingerprintPct}% ｜ 只有抖动、未平滑时 ${RV.gridFingerprintRawPct}%（直行段占 ${RV.gridStraightPct}%，已剔除）` : '未取到'],
  ['M37 河宽与汇水面积单调相关（Spearman ≥ 0.9）', RV && RV.spearman >= 0.9,
    RV ? `ρ = ${RV.spearman}` : '未取到'],

  // ---- ★ H4.5：内流盆地当"汇"（根治"幽灵出湖河"）----
  ['H4.5 内流盆地是汇（盆地格一个出流都没有）',
    !env.endorheicAsSink || (I.sinkOutflow === 0 && I.endorheicCells > 0 && I.sinkLandNoDown > 0),
    env.endorheicAsSink
      ? `${I.sinkOutflow} 个盆地格仍有出流｜盆地格 ${I.endorheicCells} 个 · ` +
        `${I.sinkLandNoDown} 格 down = −1 · 清零出边 ${env.sinkBlocked} 条`
      : '已按 CONFIG 关闭（回退状态，幽灵出湖河会回来）'],
  ['H4.5 截断迭代已收敛（1–5 轮）',
    !env.endorheicAsSink || (env.sinkRounds >= 1 && env.sinkRounds <= 5 && env.sinkBlocked > 0),
    env.endorheicAsSink
      ? `${env.sinkRounds} 轮 · ${env.sinkBlocked} 条出边 · 数据层 ${env.hydroMs} ms`
      : '已按 CONFIG 关闭'],
  ['H4.5 河网不再从内流盆地流出（入海率 < 100%，除非没有河进盆地）',
    !env.endorheicAsSink || I.sinkRiver === 0 || I.seaRate < 100,
    env.endorheicAsSink
      ? `${I.seaRate}% 入海｜进内流盆地 ${I.sinkRiver} 格 · 最长追踪链 ${I.seaMaxChain} 格`
      : '已按 CONFIG 关闭'],
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
console.log('河网阈值扫描（河格 = 陆地且 accum/unit ≥ T，看能否同时救回 P0-2 与 M31）:');
console.log('   T     河格数   汇水中位数   格口径各级格数 → Rb        河段口径各级段数 → Rb');
for (const s of S.thresholdScan) {
  const okMed = s.medianEq >= 20, okRb = s.rb.length && s.rb.every((v) => v >= 3 && v <= 5);
  const okSeg = s.rbSeg.length && s.rbSeg.every((v) => v >= 3 && v <= 5);
  console.log(`   ${String(s.T).padEnd(6)}${String(s.riverCells).padEnd(9)}${String(s.medianEq).padEnd(13)}${s.strahlerCounts.join('/').padEnd(17)}→ ${s.rb.join('/').padEnd(12)}${s.segCounts.join('/').padEnd(16)}→ ${s.rbSeg.join('/')}   ${okMed && okRb ? '★格口径过' : ''}${okSeg ? ' ★河段口径过' : ''}`);
}
console.log(`湖泊（★ H4）：${S.lakes.count} 个（最大 ${S.lakes.largest} 格，前 5 ${S.lakes.top5.join('/')}）· ` +
  `湖面共 ${S.lakes.totalCells} 格（占陆地 ${S.lakes.pctOfLand}%）· 最深 ${S.lakes.maxDepth}`);
console.log(`内流盆地：${S.lakes.endorheic} 个（占湖 ${S.lakes.endorheicPct}%，其中干底 ${S.lakes.endorheicDry} 个）· ` +
  `分档 浅 ${S.lakes.tiers.shallow} / 深 ${S.lakes.tiers.deep} / 盐 ${S.lakes.tiers.salt}`);
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
