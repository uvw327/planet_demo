/**
 * 河网形状诊断实验室 —— 把水文数据层的结果**正交投影**成一张 2D 图，直接看河网是"树枝"还是"糊片"。
 *
 * 为什么需要它：H2 只产出数据，三维画面上还没有河线。若只靠"河格平均度 3.62"这类数字，
 * 很难判断 H3 会不会渲染成一团色块。把每格的"格心 → 主下游格心"线段画在 2D 平面上，
 * 是最便宜的判形方式（不需要任何三维渲染），也能当 H3 的前后对比基线。
 *
 * 读图口径：
 *   - 灰绿点 = 陆地（给海岸线参照）· 暗青点 = 湖 · 亮蓝线段 = 河道，线宽 ∝ accum^0.42
 *   - 理想形状：**树枝状水系**（一条主干 + 逐级汇入的支流，分叉清晰、互不相交）
 *   - 坏形状：整片糊成色块、大量平行短线（说明阈值切出的是一块二维区域，不是一维河道）
 *
 * 用法：
 *   node tools/lab-hydro-map.mjs                       # 用页面当前参数
 *   node tools/lab-hydro-map.mjs --t 20                # 覆盖 riverCellThreshold
 *   node tools/lab-hydro-map.mjs --t 20 --f 1.4        # 同时覆盖 flowExponent
 * 输出：docs/hydro-shots/river-network-t<阈值>-f<指数>.png，并在控制台打印该参数下的量测。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toUrl = (p) => 'file:///' + p.replace(/\\/g, '/');
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/matt/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const PAGE = toUrl(path.join(ROOT, 'index.html'));

/** 解析 `--t 20 --f 1.4` 形式的命令行覆盖项。 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--t') out.threshold = Number(argv[++i]);
    else if (k === '--f') out.flowExponent = Number(argv[++i]);
  }
  return out;
}
const OVERRIDE = parseArgs(process.argv.slice(2));

async function probePort(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); return r.ok; } catch { return false; }
}
async function pickFreePort() {
  for (let i = 0; i < 40; i++) {
    const p = 9500 + Math.floor(Math.random() * 400);
    if (!(await probePort(p))) return p;
  }
  throw new Error('无空闲端口');
}

const PORT = await pickFreePort();
const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'cdp-hydromap-'));
const child = spawn(CHROME, [
  '--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--disable-gpu-sandbox', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--window-size=1280,800', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitJson(url, tries = 60, method = 'GET') {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { method }); if (r.ok) return await r.json(); } catch { /* 继续等 */ }
    await sleep(250);
  }
  throw new Error(`CDP 未就绪：${url}`);
}

await waitJson(`http://127.0.0.1:${PORT}/json/version`);
const tab = await waitJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, 20, 'PUT');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: PAGE });
let ready = false;
for (let i = 0; i < 180; i++) {
  await sleep(1000);
  if (await evaluate('!!(window.__PLANET__ && window.__PLANET__.hydro && window.__PLANET__.hydro())')) { ready = true; break; }
}
if (!ready) throw new Error('页面 180 秒内未就绪');
await sleep(1200);

const overrideJson = JSON.stringify(OVERRIDE);
const result = await evaluate(`(() => {
  const P = window.__PLANET__;
  const ov = ${overrideJson};
  if (ov.threshold !== undefined) P.CONFIG.hydro.riverCellThreshold = ov.threshold;
  if (ov.flowExponent !== undefined) P.CONFIG.hydro.flowExponent = ov.flowExponent;
  if (Object.keys(ov).length) P.refresh();   // 同步重算地形链 + 水文

  const tiles = P.tiles, hy = P.hydro();
  const W = 1400, H = 1400, R = 0.44 * W;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#05070d'; g.fillRect(0, 0, W, H);
  const px = (c) => [W / 2 + c.x * R, H / 2 - c.y * R];
  const front = (c) => c.z > 0.06;          // 只画朝向镜头的那半个球

  // 陆地底色：给出海岸线参照，方便判断"河是不是真的往海里流"
  g.fillStyle = 'rgba(70,92,60,0.55)';
  for (const t of tiles) {
    if (t.elevation <= P.CONFIG.seaLevel || !front(t.center)) continue;
    const [x, y] = px(t.center);
    g.beginPath(); g.arc(x, y, 3.2, 0, 6.2832); g.fill();
  }
  // 湖泊：H4 才做水面，这里先画出来看位置是否合理（应在洼地、不该在坡上）
  g.fillStyle = 'rgba(60,120,150,0.75)';
  for (const t of tiles) {
    if (hy.lakeId[t.index] < 0 || !front(t.center)) continue;
    const [x, y] = px(t.center);
    g.beginPath(); g.arc(x, y, 4, 0, 6.2832); g.fill();
  }
  // 河网：每格一条"格心 → 主下游格心"的线段，线宽 ∝ accum^0.42（与设计稿的宽度律一致）
  const unit = hy.unit || 1;
  g.strokeStyle = 'rgba(90,180,255,0.95)'; g.lineCap = 'round';
  for (const t of tiles) {
    if (!hy.isRiver[t.index] || !front(t.center)) continue;
    const d = hy.down[t.index];
    if (d < 0) continue;
    g.lineWidth = Math.max(1.0, Math.min(9, 0.55 * Math.pow(hy.accum[t.index] / unit, 0.42)));
    const [x1, y1] = px(t.center), [x2, y2] = px(tiles[d].center);
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  }

  // 同参数下的量测：河格数 / 河格平均度 / 度分布 / 汇水中位数（判断"树"还是"片"）
  const n = tiles.length;
  const isR = hy.isRiver;
  let V = 0, degSum = 0, deg3 = 0;
  const degHist = [0, 0, 0, 0, 0, 0, 0];
  const accs = [];
  for (let i = 0; i < n; i++) {
    if (!isR[i]) continue;
    V++;
    let d = 0;
    for (const k of hy.adj[i]) if (isR[k]) d++;
    degSum += d; degHist[d]++; if (d >= 3) deg3++;
    accs.push(hy.accum[i] / unit);
  }
  accs.sort((a, b) => a - b);
  const med = accs.length ? accs[accs.length >> 1] : 0;
  return {
    dataUrl: cv.toDataURL('image/png'),
    stats: {
      threshold: P.CONFIG.hydro.riverCellThreshold,
      flowExponent: P.CONFIG.hydro.flowExponent,
      riverCount: V,
      cellDegAvg: +(degSum / Math.max(1, V)).toFixed(2),
      degGe3Pct: +(100 * deg3 / Math.max(1, V)).toFixed(1),
      degHist,
      medianAccum: +med.toFixed(2),
      ms: +hy.ms.toFixed(0),
    },
  };
})()`);

const s = result.stats;
const outDir = path.join(ROOT, 'docs', 'hydro-shots');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `river-network-t${s.threshold}-f${s.flowExponent}.png`);
fs.writeFileSync(outFile, Buffer.from(result.dataUrl.split(',')[1], 'base64'));

console.log(`阈值 ${s.threshold} · flowExponent ${s.flowExponent}`);
console.log(`河格 ${s.riverCount} 个 · 河格平均度 ${s.cellDegAvg}（树≈2）· 度≥3 占 ${s.degGe3Pct}%`);
console.log(`度分布 [0..6] = [${s.degHist.join(', ')}] · 汇水中位数 ${s.medianAccum} 等效格 · 耗时 ${s.ms} ms`);
console.log(`已写出 ${path.relative(ROOT, outFile).replace(/\\/g, '/')}`);

try { ws.close(); } catch { /* 忽略 */ }
try { child.kill(); } catch { /* 忽略 */ }
