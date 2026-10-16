/**
 * 地形地基实验室：加载 index.html 一次，然后在页面内扫 `landFraction × continentScale`
 * 等组合，输出「海陆比 / 陆块结构 / 群系占比」对比表。
 *
 * 为什么需要它：`recomputeTerrain()` 只管「海拔 → 河流 → 气候 → 群系」这条纯计算链，
 * 而默认 `enableHeightOffset === false` 时海拔不参与顶点坐标（球面恒为半径 1），
 * 所以改 CONFIG 后调 `__PLANET__.refresh()` 就能看到新星球 —— 一次页面加载可扫几十组。
 * 换页面重载一次要十几秒，这个出口省掉绝大部分等待。
 *
 * 用法：
 *   node tools/lab-terrain.mjs
 *   node tools/lab-terrain.mjs --lf=0.30,0.35,0.40 --cs=0.8,1.4,2.0,2.6
 *   node tools/lab-terrain.mjs --lf=0.38 --cs=2.0 --oct=2,3,4 --json=tools/out/terrain.json
 *
 * 结果同时写 tools/out/lab-terrain.json（按 .gitignore 不入库）。
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

/**
 * 端口探测：残留的 Chrome 实例会继续占着旧端口并**响应**调试请求 ——
 * 那样实验室会静默连到"页面里还跑着旧 index.html"的浏览器上，量出一堆假数据。
 * 所以这里先扫一段随机端口，只挑**没有任何浏览器在监听**的那个，再从零启动自己的 Chrome。
 */
async function probePort(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    return !!r.ok;
  } catch { return false; }
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
 * 例：--lf=0.38 --cs=1.0,1.2 --oct=2 --doct=2,3,4
 */
const AXES = [
  ['landFraction',     nums(arg('lf',     '0.36,0.38,0.40'))],
  ['continentScale',   nums(arg('cs',     '1.0,1.2'))],
  ['continentOctaves', nums(arg('oct',    ''))],
  ['detailOctaves',    nums(arg('doct',   ''))],
  ['detailScale',      nums(arg('ds',     ''))],
  ['continentWeight',  nums(arg('cw',     ''))],
  ['elevationSpread',  nums(arg('spread', ''))],
].filter(([, vs]) => vs.length);

let COMBOS = [{}];
for (const [key, vs] of AXES) {
  const next = [];
  for (const base of COMBOS) for (const v of vs) next.push({ ...base, [key]: v });
  COMBOS = next;
}
const AXIS_KEYS = AXES.map(([k]) => k);
const OUT = arg('json', path.join(ROOT, 'tools', 'out', 'lab-terrain.json'));

/* ---------- 启动 headless Chromium 并连 CDP ---------- */
const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'cdp-terrain-'));
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
  if (C.elevationCenter !== undefined) return { ok: false, why: 'CONFIG.elevationCenter 仍在：CONFIG 是旧版' };
  if (String(P.refresh).indexOf('recomputeTerrain') < 0) return { ok: false, why: 'refresh() 未走 recomputeTerrain()：页面是中间态' };
  return { ok: true, level: C.level, tiles: P.tiles.length };
})()`);
if (!env.ok) throw new Error(`页面状态不对：${env.why}（先把残留的 headless Chrome 全部关掉再跑）`);
console.log(`代码自检通过：level=${env.level}，图块 ${env.tiles} 个`);

/* ---------- 页面内：建一次邻接，然后扫全部组合 ---------- */
const RAW = await evaluate(`(() => {
  const P = window.__PLANET__, C = P.CONFIG, tiles = P.tiles;
  const n = tiles.length;

  // 邻接：两格共享 >= 2 个对偶顶点 ⇔ 在球面网格上共边（与 shot-v1.mjs 同一判据）
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

  // 连通分量：返回各分量格数，降序
  const comps = (pred) => {
    const seen = new Uint8Array(n), out = [];
    for (const t of tiles) {
      const i0 = t.index;
      if (!pred(tiles[i0]) || seen[i0]) continue;
      const st = [i0]; seen[i0] = 1; let c = 0;
      while (st.length) {
        const i = st.pop(); c++;
        for (const j of adj[i]) if (!seen[j] && pred(tiles[j])) { seen[j] = 1; st.push(j); }
      }
      out.push(c);
    }
    out.sort((a, b) => b - a);
    return out;
  };

  const SEA = C.seaLevel, SNOW_LV = 0.80, MTN_LV = 0.65;
  const COMBOS = ${JSON.stringify(COMBOS)};
  const out = [];

  for (const ov of COMBOS) {
    Object.assign(C, ov);
    P.refresh();

    let land = 0, mtnSnow = 0, clsLand = 0;
    const bio = {};
    for (const t of tiles) {
      bio[t.biome] = (bio[t.biome] || 0) + 1;
      if (t.elevation <= SEA) continue;
      land++;
      if (t.elevation > MTN_LV) mtnSnow++;
      // 「参与湿度分类的陆地」= 既不是高山雪峰，也不是冰原/河流/苔原/针叶林
      if (!(t.elevation > MTN_LV || t.temperature < C.tempIce || t.river
            || t.temperature < C.tempTundra || t.temperature < C.tempTaiga)) clsLand++;
    }

    const lc = comps((t) => t.elevation > SEA);
    const sc = comps((t) => t.elevation <= SEA);
    const landTotal = lc.reduce((s, v) => s + v, 0);
    const seaTotal  = sc.reduce((s, v) => s + v, 0);
    const ofLand = (k) => bio[k] ? +(bio[k] / land * 100).toFixed(2) : 0;

    // 海岸线碎度：陆海相邻边数 ÷ √陆地格数（尺度无关，越大 → 海岸线越犬牙交错）
    let coastEdges = 0;
    for (const t of tiles) {
      if (t.elevation <= SEA) continue;
      for (const j of adj[t.index]) if (tiles[j].elevation <= SEA) coastEdges++;
    }

    out.push({
      ov,
      land, landPct: +(land / n * 100).toFixed(2),
      landComps: lc.length,
      largestLandPct: +(lc[0] / landTotal * 100).toFixed(1),
      landTop3Pct: +(lc.slice(0, 3).reduce((s, v) => s + v, 0) / landTotal * 100).toFixed(1),
      landTop: lc.slice(0, 5).map((v) => +(v / landTotal * 100).toFixed(1)),
      islands1: lc.filter((v) => v === 1).length,
      oceanComps: sc.length,
      largestOceanPct: +(sc[0] / seaTotal * 100).toFixed(1),
      coastRoughness: +(coastEdges / Math.sqrt(land)).toFixed(3),
      mtnSnowPctOfLand: +(mtnSnow / land * 100).toFixed(2),
      clsLandPctOfLand: +(clsLand / land * 100).toFixed(2),
      biomeOfLand: {
        desert: ofLand('desert'), grassland: ofLand('grassland'), forest: ofLand('forest'),
        rainforest: ofLand('rainforest'), taiga: ofLand('taiga'), tundra: ofLand('tundra'),
        ice: ofLand('ice'), mountain: ofLand('mountain'), snow: ofLand('snow'), river: ofLand('river'),
      },
      kinds: Object.keys(bio).length,
    });
  }
  return out;
})()`);

/* ---------- 打印对比表 ---------- */
const pad = (s, w) => String(s).padEnd(w);
const padl = (s, w) => String(s).padStart(w);
const SHORT = {
  landFraction: 'lf', continentScale: 'cs', continentOctaves: 'cOct', detailOctaves: 'dOct',
  detailScale: 'dScale', continentWeight: 'cW', elevationSpread: 'spread',
};
const cols = [
  ...AXIS_KEYS.map((k) => [SHORT[k] || k, 7]),
  ['陆地%', 8], ['陆块', 6], ['最大陆块%', 10], ['前3大陆和%', 11], ['单格岛', 7],
  ['海岸碎度', 9], ['山+雪%', 8], ['湿度分类陆地%', 14], ['草原%', 7], ['沙漠%', 7],
];
console.log('');
console.log(COMBOS.length + ' 组组合');
console.log(cols.map(([h, w]) => pad(h, w)).join(''));
console.log(cols.map(([, w]) => '─'.repeat(w)).join(''));
for (const r of RAW) {
  const o = r.ov;
  const cells = [
    ...AXIS_KEYS.map((k) => pad(o[k], 7)),
    pad(r.landPct, 8), pad(r.landComps, 6), pad(r.largestLandPct, 10), pad(r.landTop3Pct, 11),
    pad(r.islands1, 7), pad(r.coastRoughness, 9), pad(r.mtnSnowPctOfLand, 8),
    pad(r.clsLandPctOfLand, 14), pad(r.biomeOfLand.grassland, 7), pad(r.biomeOfLand.desert, 7),
  ];
  console.log(cells.join(''));
}
console.log('');
console.log('前 5 大陆（占陆地 %）＋ 海洋结构：');
for (const r of RAW) {
  const o = r.ov;
  console.log(`  [${AXIS_KEYS.map((k) => `${SHORT[k] || k}=${o[k]}`).join(' ')}] → ` +
    `${pad(r.landTop.join(' / '), 34)}  海洋块 ${pad(r.oceanComps, 3)} 最大海洋 ${padl(r.largestOceanPct, 5)}%`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ page: 'index.html', combos: COMBOS, results: RAW }, null, 2));
console.log(`\n明细已写入 ${path.relative(ROOT, OUT)}`);

ws.close();
child.kill();
process.exit(0);
