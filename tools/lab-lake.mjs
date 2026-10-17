/**
 * 湖泊标定实验室（★ H4）：一次页面加载内扫
 * `potentialEvaporation × minLakeArea × minLakeDepth`，把 M17 / M18 与湖的
 * 结构指标列成表。
 *
 * 为什么必须扫参：
 *   - `potentialEvaporation`（潜在蒸发强度）是**内流盆地数量的唯一旋钮**（M18 目标 5–25）。
 *     它和 `minLakeArea/minLakeDepth` 是耦合的：阈值把"过水段"滤掉之后剩下的洼地变少，
 *     可供"变干"的候选湖也变少 —— 单看一个数会顾此失彼（设计稿 §10.1/§10.2）。
 *   - `lakeShallowDepth`（浅湖/深湖分档）要看 depthMean 的**分布**才能定，不能拍脑袋。
 *
 * 用法：node tools/lab-lake.mjs
 *       轴可用环境变量覆盖：LK_PE=0.5,1,2,4  LK_AREA=2,4,6  LK_DEPTH=0.001,0.002
 * 输出：tools/out/lab-lake.json（不入库）+ 控制台表格
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
const AX_PE = numList(process.env.LK_PE, [0.5, 1, 2, 3, 4, 6, 8]);
const AX_AREA = numList(process.env.LK_AREA, [2, 3, 4, 6]);
const AX_DEPTH = numList(process.env.LK_DEPTH, [0.001, 0.002]);

async function probePort(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); return !!r.ok; } catch { return false; }
}
async function pickFreePort() {
  for (let i = 0; i < 40; i++) { const p = 9500 + Math.floor(Math.random() * 400); if (!(await probePort(p))) return p; }
  throw new Error('找不到空闲调试端口：先关掉残留的 headless Chrome');
}
const PORT = Number(process.env.CDP_PORT || await pickFreePort());

const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'cdp-lake-lab-'));
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

/* ---------- 页面内湖分析器（只返回纯值，不回传 TypedArray） ---------- */
await evaluate(`window.__LK__ = (() => {
  const P = window.__PLANET__;
  return {
    metrics() {
      const tiles = P.tiles, hy = P.hydro(), n = tiles.length;
      const lks = hy.lakes;
      const sea = P.CONFIG.seaLevel;
      const areas = lks.map((l) => l.wetArea).sort((a, b) => b - a);
      const basins = lks.map((l) => l.basinArea).sort((a, b) => b - a);
      const depths = lks.map((l) => l.depthMean).sort((a, b) => a - b);
      const inflows = lks.map((l) => l.inflow).sort((a, b) => a - b);
      const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);

      let endorheic = 0, wetCells = 0, lakeCells = 0, riverInLake = 0, belowSea = 0;
      for (const l of lks) if (l.isEndorheic) endorheic++;
      for (let i = 0; i < n; i++) {
        if (hy.lakeId[i] < 0) continue;
        lakeCells++;
        if (tiles[i].elevation <= sea) belowSea++;
        if (hy.isRiver[i]) riverInLake++;
      }
      for (const l of lks) wetCells += l.wetArea;

      // 干底盆地（水位低到没有明水）与"有明水的内流湖"
      const dryBasins = lks.filter((l) => l.isEndorheic && l.wetArea === 0).length;

      // "小水洼污染度"：设计稿 §10.1 警告过 —— 阈值一降就会冒出一堆 1–3 格的水洼，
      // 它们其实是**河流的过水段**，不该画成湖。所以把"很小的湖"单独数出来。
      const tinyBasin = lks.filter((l) => l.basinArea <= 2).length;
      const tinyWet = lks.filter((l) => l.wetArea <= 2).length;
      const topWet = areas.slice(0, 8);

      // 渲染分档（用当前 lakeShallowDepth）
      const tiers = { shallow: 0, deep: 0, salt: 0 };
      for (const l of lks) tiers[l.tier]++;

      const rs = P.river();
      // 最大的几个湖的档位 —— 用来判断"最大的湖有没有被误判成盐湖"
      const byWet = lks.slice().sort((a, b) => b.wetArea - a.wetArea).slice(0, 5)
        .map((l) => l.wetArea + (l.isEndorheic ? '盐' : (l.tier === 'shallow' ? '浅' : '深')));
      return {
        lakes: lks.length, endorheic, dryBasins, tinyBasin, tinyWet, topWet, top5: byWet,
        endorheicPct: +(100 * endorheic / Math.max(1, lks.length)).toFixed(0),
        maxWet: areas[0] || 0, maxBasin: basins[0] || 0,
        wetCells, lakeCells, riverInLake, belowSea,
        depthP50: +q(depths, 0.5).toFixed(4), depthMax: +(depths[depths.length - 1] || 0).toFixed(4),
        inflowP50: +q(inflows, 0.5).toFixed(2), inflowMax: +(inflows[inflows.length - 1] || 0).toFixed(2),
        tiers,
        lakeBreaks: rs ? rs.lakeBreaks : -1,
        lineCells: rs ? rs.lineCells : -1,
        ms: hy.ms,
      };
    },
  };
})()`);

const rows = [];
for (const PE of AX_PE) {
  for (const A of AX_AREA) {
    for (const D of AX_DEPTH) {
      await evaluate(`(() => { const h = window.__PLANET__.CONFIG.hydro;
        h.potentialEvaporation = ${PE}; h.minLakeArea = ${A}; h.minLakeDepth = ${D};
        window.__PLANET__.refresh(); return 1; })()`);
      const m = await evaluate('window.__LK__.metrics()');
      rows.push({ PE, A, D, ...m });
      process.stdout.write('.');
    }
  }
}
process.stdout.write('\n');

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'lab-lake.json'),
  JSON.stringify({ axes: { PE: AX_PE, A: AX_AREA, D: AX_DEPTH }, rows }, null, 2), 'utf8');

const pad = (s, w) => String(s).padEnd(w);
console.log('');
console.log(pad('PE', 6) + pad('面积', 5) + pad('深度', 8) + pad('湖数', 6) + pad('内流', 6) +
  pad('干底', 6) + pad('小洼', 6) + pad('小湖', 6) + pad('最大湖', 7) + pad('最大洼地', 9) +
  pad('湖面格', 7) + pad('河入湖', 7) +
  pad('断湖链', 7) + pad('深中位', 8) + pad('入流中位', 9) + pad('内流%', 7) + '分档(浅/深/盐) · 最大5湖');
for (const r of rows) {
  console.log(pad(r.PE, 6) + pad(r.A, 5) + pad(r.D, 8) + pad(r.lakes, 6) + pad(r.endorheic, 6) +
    pad(r.dryBasins, 6) + pad(r.tinyBasin, 6) + pad(r.tinyWet, 6) +
    pad(r.maxWet, 7) + pad(r.maxBasin, 9) + pad(r.lakeCells, 7) +
    pad(r.riverInLake, 7) + pad(r.lakeBreaks, 7) + pad(r.depthP50, 8) + pad(r.inflowP50, 9) +
    pad(r.endorheicPct, 7) +
    `${r.tiers.shallow}/${r.tiers.deep}/${r.tiers.salt} · ${r.top5.join(' ')}`);
}

// 目标（评审文档 §3 P1-1 / 设计稿 §8.1，★ M17 口径已在 H4 改写）：
//   M17   湖泊数 ≥ 15 **且没有 ≤2 格的小水洼**（旧口径"≥30"只有把过水段也算成湖才达得到，
//         与设计稿 §10.1 冲突 → 证据与取舍见 docs/hydro-layer.md §7.2）
//   M17b  最大湖 ≥ 15 格
//   M18   内流盆地 5–25 · 湖面高程 ≥ 海平面（belowSea 恒 0）
const ok = rows.filter((r) => r.lakes >= 15 && r.tinyBasin === 0 && r.maxWet >= 15
  && r.endorheic >= 5 && r.endorheic <= 25 && r.belowSea === 0);
console.log('');
if (ok.length) {
  console.log(`同时满足 M17+M17b+M18 的 ${ok.length} 行，例如：`);
  for (const r of ok.slice(0, 6)) {
    console.log(`  PE=${r.PE} 面积=${r.A} 深度=${r.D} → 湖 ${r.lakes}（小洼 ${r.tinyBasin}）· 最大湖 ${r.maxWet} 格` +
      ` · 内流 ${r.endorheic}（干底 ${r.dryBasins}）· 湖面格 ${r.lakeCells}`);
  }
} else {
  console.log('没有一行同时满足 M17+M17b+M18 —— 逐条看是哪一条没过，见上表。');
}
console.log(`已写出 ${path.relative(ROOT, path.join(OUT, 'lab-lake.json'))}（${rows.length} 行）`);

try { ws.close(); } catch { }
try { child.kill(); } catch { }
