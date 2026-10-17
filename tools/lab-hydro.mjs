/**
 * 水文调参实验室（★ H2 起）：一次页面加载内扫 `riverCellThreshold × flowExponent
 * × runoffExponent`，把 M12–M16 与河网结构指标列成表。
 *
 * 为什么必须扫参而不是"改一个数看一眼"：河网密度、最大水系长度、连通分量数
 * 三者是**同一个阈值**的三个侧面（阈值 ↓ → 河更多、主干更长、但也更容易糊成一片），
 * 单看一个数会顾此失彼。这张表是把"甜点"找出来的唯一办法。
 *
 * ★ 本脚本会打印**两套图论口径**，因为它们的含义完全不同：
 *   - 流图（flow graph）：节点 = 河格，边 = x → 主下游 down[x]。这是"水怎么走"。
 *     构造上每个节点出度 ≤ 1 ⇒ **必然是森林，环数恒为 0**，连通分量数 = 河口的个数。
 *   - 格邻接图（cell graph）：节点 = 河格，边 = 两格在球面网格上相邻。
 *     这是"河占了多少片地"。**二维区域天然含环**，所以环数不为 0 是正常的，
 *     v1 台账里的 M12/M13/M14 就是这个口径（当时河流是噪声色块，所以才碎）。
 *
 * 用法：node tools/lab-hydro.mjs
 *       轴可用环境变量覆盖：HY_T=3,5,8  HY_F=1.0,1.1  HY_R=1.5
 * 输出：tools/out/lab-hydro.json（不入库）+ 控制台表格
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

const numList = (s, dflt) => (s ? s.split(',').map(Number).filter((x) => Number.isFinite(x)) : dflt);
const AX_T = numList(process.env.HY_T, [3, 5, 8, 12, 20, 30]);
const AX_F = numList(process.env.HY_F, [1.0, 1.1, 1.3]);
const AX_R = numList(process.env.HY_R, [1.0, 1.5, 2.0]);

async function probePort(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); return !!r.ok; } catch { return false; }
}
async function pickFreePort() {
  for (let i = 0; i < 40; i++) { const p = 9500 + Math.floor(Math.random() * 400); if (!(await probePort(p))) return p; }
  throw new Error('找不到空闲调试端口：先关掉残留的 headless Chrome');
}
const PORT = Number(process.env.CDP_PORT || await pickFreePort());

const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'cdp-hydro-lab-'));
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
await sleep(1500);

/* ---------- 页面内指标分析器（只返回纯值，不回传 TypedArray） ---------- */
await evaluate(`window.__HY__ = (() => {
  const P = window.__PLANET__;
  return {
    metrics() {
      const tiles = P.tiles, hy = P.hydro(), n = tiles.length, isR = hy.isRiver;
      const sea = P.CONFIG.seaLevel;

      // --- 流图：节点 = 河格，边 = x → 主下游（仅当主下游也是河格） ---
      let V = 0;
      const downR = new Int32Array(n).fill(-1);
      for (let i = 0; i < n; i++) if (isR[i]) { V++; const d = hy.down[i]; if (d >= 0 && isR[d]) downR[i] = d; }

      // 反向链（head/next），用于从"根"（无河下游的河格）出发做反向 BFS
      const head = new Int32Array(n).fill(-1), next = new Int32Array(n).fill(-1);
      const roots = [];
      for (let i = 0; i < n; i++) {
        if (!isR[i]) continue;
        if (downR[i] >= 0) { next[i] = head[downR[i]]; head[downR[i]] = i; }
        else roots.push(i);
      }
      const sizes = [];
      const reach = new Uint8Array(n);
      for (const r of roots) {
        let size = 0; const q = [r]; reach[r] = 1;
        for (let qi = 0; qi < q.length; qi++) {
          size++;
          for (let e = head[q[qi]]; e >= 0; e = next[e]) if (!reach[e]) { reach[e] = 1; q.push(e); }
        }
        sizes.push(size);
      }
      sizes.sort((a, b) => b - a);

      // --- 格邻接图（v1 台账口径）：连通分量 + 环数（E − V + C） ---
      const seen = new Uint8Array(n);
      const ccomps = [];
      let isolated = 0, twiceE = 0;
      for (let i = 0; i < n; i++) if (isR[i]) for (const k of hy.adj[i]) if (isR[k]) twiceE++;
      for (let s = 0; s < n; s++) {
        if (!isR[s] || seen[s]) continue;
        const st = [s]; seen[s] = 1; let size = 0;
        while (st.length) {
          const x = st.pop(); size++;
          let d = 0;
          for (const k of hy.adj[x]) if (isR[k]) { d++; if (!seen[k]) { seen[k] = 1; st.push(k); } }
          if (d === 0) isolated++;
        }
        ccomps.push(size);
      }
      ccomps.sort((a, b) => b - a);
      const cE = twiceE / 2, cC = ccomps.length;
      const cellCycles = cE - V + cC;

      // --- ★ 河格是"线"还是"片"：度分布 ---
      // 1D 河网（树）的平均度 ≈ 2（森林恒有 2E = 2(V−C)）；度 ≥ 3 的比例高 = 糊成二维片。
      let degSum = 0, deg3 = 0;
      const degHist = [0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < n; i++) {
        if (!isR[i]) continue;
        let d = 0;
        for (const k of hy.adj[i]) if (isR[k]) d++;
        degSum += d; degHist[d]++; if (d >= 3) deg3++;
      }

      // --- 海拔 / 汇水 ---
      const meanOf = (a) => a.reduce((s, t) => s + t.elevation, 0) / (a.length || 1);
      const riverTiles = tiles.filter((t) => isR[t.index]);
      const lowland = tiles.filter((t) => t.biome === 'forest' || t.biome === 'grassland' || t.biome === 'desert');
      const eq = riverTiles.map((t) => hy.accum[t.index] / hy.unit).sort((a, b) => a - b);
      const q = (p) => (eq.length ? eq[Math.min(eq.length - 1, Math.floor(eq.length * p))] : 0);

      let sources = 0, mouths = 0, landCount = 0;
      for (let i = 0; i < n; i++) { if (hy.isSource[i]) sources++; if (hy.isMouth[i]) mouths++; }
      for (const t of tiles) if (t.elevation > sea) landCount++;

      const wet = tiles.filter((t) => t.biome === 'rainforest');
      const dry = tiles.filter((t) => t.biome === 'desert');
      const dens = (arr) => (arr.length ? arr.filter((t) => isR[t.index]).length / arr.length : 0);

      // ★ H4：湖的"面积"现在有两个口径 —— wetArea（水位以下的湿格）与 basinArea（整个洼地）。
      //   扫参时看 wetArea（真正的"湖"），内流盆地数另记一列。
      const lakeAreas = hy.lakes.map((l) => l.wetArea).sort((a, b) => b - a);

      return {
        V, E: cE,
        // 流图（"水怎么走"）——环数恒为 0（森林），分量数 = 河口/终点个数
        flowComps: sizes.length, flowLargest: sizes[0] || 0, flowTop5: sizes.slice(0, 5),
        flowRootsNoRiverDown: roots.length,
        // 格邻接图（v1 台账口径）
        cellComps: cC, cellLargest: ccomps[0] || 0, cellCycles,
        cellDegAvg: +(degSum / Math.max(1, V)).toFixed(2),
        cellDeg3Pct: +(deg3 / Math.max(1, V) * 100).toFixed(1),
        degHist,
        pruned: hy.pruned,
        isolated, isolatedPct: +(isolated / Math.max(1, V) * 100).toFixed(2),
        sources, mouths, landCount,
        densityOfLand: +(V / Math.max(1, landCount) * 100).toFixed(2),
        elevGap: +(meanOf(riverTiles) - meanOf(lowland)).toFixed(4),
        accumMedianEq: +q(0.5).toFixed(1), accumMaxEq: +q(1).toFixed(1),
        wetDry: +(dens(wet) / Math.max(1e-9, dens(dry))).toFixed(1),
        lakes: hy.lakes.length, lakeLargest: lakeAreas[0] || 0,
        endorheic: hy.lakes.filter((l) => l.isEndorheic).length,
        ms: hy.ms,
      };
    },
  };
})()`);

const rows = [];
for (const T of AX_T) {
  for (const F of AX_F) {
    for (const R of AX_R) {
      await evaluate(`(() => { const h = window.__PLANET__.CONFIG.hydro;
        h.riverCellThreshold = ${T}; h.flowExponent = ${F}; h.runoffExponent = ${R};
        window.__PLANET__.refresh(); return 1; })()`);
      const m = await evaluate('window.__HY__.metrics()');
      rows.push({ T, F, R, ...m });
      process.stdout.write('.');
    }
  }
}
process.stdout.write('\n');

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'lab-hydro.json'), JSON.stringify({ axes: { T: AX_T, F: AX_F, R: AX_R }, rows }, null, 2), 'utf8');

const pad = (s, w) => String(s).padEnd(w);
console.log('');
console.log(pad('T', 4) + pad('F', 5) + pad('R', 5) + pad('河格', 6) + pad('占陆地%', 8) +
  pad('流分量', 7) + pad('流最大', 7) + pad('格分量', 7) + pad('格最大', 7) + pad('格环', 6) +
  pad('平均度', 7) + pad('度≥3%', 7) + pad('孤立%', 7) + pad('中位汇水', 9) + pad('干湿比', 7) + pad('海拔差', 8) + pad('湖', 4) + 'ms');
for (const r of rows) {
  console.log(pad(r.T, 4) + pad(r.F, 5) + pad(r.R, 5) + pad(r.V, 6) + pad(r.densityOfLand, 8) +
    pad(r.flowComps, 7) + pad(r.flowLargest, 7) +
    pad(r.cellComps, 7) + pad(r.cellLargest, 7) + pad(r.cellCycles, 6) +
    pad(r.cellDegAvg, 7) + pad(r.cellDeg3Pct, 7) +
    pad(r.isolatedPct, 7) + pad(r.accumMedianEq, 9) +
    pad(r.wetDry, 7) + pad(r.elevGap, 8) + pad(r.lakes, 4) + r.ms);
}

// 目标：河网要像**线**不像**片**（平均度 ≈ 2、环数低）、主干要长、孤立率 ≤ 2%
const score = (r) => -r.cellDegAvg * 100 - r.cellCycles / Math.max(1, r.V) * 50
  + Math.min(r.flowLargest, 120) * 0.3 - Math.max(0, r.isolatedPct - 2) * 30;
const best = rows.slice().sort((a, b) => score(b) - score(a))[0];
console.log('');
console.log(`本批"最像线（平均度低、环少）且主干不短"的一行：T=${best.T} F=${best.F} R=${best.R}` +
  ` → 河格 ${best.V}（占陆地 ${best.densityOfLand}%）· 平均度 ${best.cellDegAvg} · 度≥3 ${best.cellDeg3Pct}% · ` +
  `格环 ${best.cellCycles} · 流图最大水系 ${best.flowLargest} 格 · 孤立 ${best.isolatedPct}% · 海拔差 ${best.elevGap}`);
console.log(`已写出 ${path.relative(ROOT, path.join(OUT, 'lab-hydro.json'))}（${rows.length} 行）`);

try { ws.close(); } catch { }
try { child.kill(); } catch { }
