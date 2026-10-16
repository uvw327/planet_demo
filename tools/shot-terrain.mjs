/**
 * 地形地基对比截图：同一页面内切换「多大陆 / 陆地占比」候选参数，各截 4 个视角。
 *
 * 为什么能在一次加载里截完：`__PLANET__.refresh()` 会重跑整条
 * 「海拔 → 气候 → 群系 → 顶点色」，而默认 `enableHeightOffset === false` 时
 * 海拔不参与顶点坐标，所以换参数不需要重建几何体。
 *
 * 用法：
 *   node tools/shot-terrain.mjs                    # 跑内置候选组
 *   node tools/shot-terrain.mjs --set=cs=2.0,lf=0.34   # 追加一组临时候选（写进 tools/out/）
 *
 * 输出：docs/terrain-shots/<组名>-<角度>.png，以及 tools/out/shot-terrain.json（不入库）
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
const OUT = path.join(ROOT, 'docs', 'terrain-shots', 'candidates');
const ANGLES = [0, 90, 180, 270];

/* ---------- 候选组 ---------- */
// ref = 完全不覆盖（即当前 index.html 的默认值），作为"只降陆地占比、不改大陆噪声"的对照
const GROUPS = [
  { name: 'ref-默认',    ov: {} },
  { name: 'A-cs1.0',    ov: { continentScale: 1.0, continentOctaves: 2, detailOctaves: 2 } },
  { name: 'B-cs1.2',    ov: { continentScale: 1.2, continentOctaves: 2, detailOctaves: 2 } },
  { name: 'C-cs1.2-d6', ov: { continentScale: 1.2, continentOctaves: 2, detailOctaves: 6 } },
];
for (const a of process.argv.filter((x) => x.startsWith('--set='))) {
  const parts = a.slice(6).split(',').map((kv) => kv.split('='));
  const ov = {}; for (const [k, v] of parts) ov[k] = Number(v);
  GROUPS.push({ name: 'X-' + parts.map(([k, v]) => `${k}${v}`).join('-'), ov });
}

async function probePort(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); return !!r.ok; } catch { return false; }
}
async function pickFreePort() {
  for (let i = 0; i < 40; i++) { const p = 9500 + Math.floor(Math.random() * 400); if (!(await probePort(p))) return p; }
  throw new Error('找不到空闲调试端口：先关掉残留的 headless Chrome');
}
const PORT = Number(process.env.CDP_PORT || await pickFreePort());

const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'cdp-terrain-shot-'));
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
  if (P.CONFIG.landFraction === undefined) return { ok: false, why: 'CONFIG.landFraction 缺失：页面是地基改造之前的版本' };
  if (P.CONFIG.elevationCenter !== undefined) return { ok: false, why: 'CONFIG.elevationCenter 仍在：CONFIG 是旧版' };
  return { ok: true, level: P.CONFIG.level, tiles: P.tiles.length };
})()`);
if (!env.ok) throw new Error(`页面状态不对：${env.why}（先关掉残留的 headless Chrome）`);
console.log(`页面就绪：level=${env.level}，图块 ${env.tiles} 个`);

fs.mkdirSync(OUT, { recursive: true });
const hideUI = () => evaluate(`(() => { for (const id of ['hud','legend','hint']) { const e = document.getElementById(id); if (e) e.style.display='none'; } return 1; })()`);

/** 把覆盖项写回 CONFIG，重跑地形链，并返回群系计数 */
const applyOverrides = (ov) => evaluate(`(() => {
  const P = window.__PLANET__, C = P.CONFIG;
  // 先把上一组的覆盖项恢复成"当前 index.html 的出厂默认"（页面加载时已存下来）
  for (const k of Object.keys(P.__defaults)) C[k] = P.__defaults[k];
  Object.assign(C, ${JSON.stringify(ov)});
  P.refresh();
  const bio = {};
  for (const t of P.tiles) bio[t.biome] = (bio[t.biome] || 0) + 1;
  return { continentScale: C.continentScale, continentOctaves: C.continentOctaves,
           detailOctaves: C.detailOctaves, landFraction: C.landFraction, bio };
})()`);

// 记录出厂默认值（第一组之前存一次，之后各组都从它出发，避免参数互相污染）
await evaluate(`(() => {
  const P = window.__PLANET__;
  P.__defaults = P.__defaults || JSON.parse(JSON.stringify({
    landFraction: P.CONFIG.landFraction, elevationSpread: P.CONFIG.elevationSpread,
    continentScale: P.CONFIG.continentScale, continentOctaves: P.CONFIG.continentOctaves,
    continentWeight: P.CONFIG.continentWeight,
    detailScale: P.CONFIG.detailScale, detailOctaves: P.CONFIG.detailOctaves,
  }));
  return 1;
})()`);

await hideUI();
const report = [];
for (const g of GROUPS) {
  const info = await applyOverrides(g.ov);
  await sleep(900);
  for (const a of ANGLES) {
    await evaluate(`(() => { const G = window.__PLANET__.planetGroup; G.rotation.x = 0; G.rotation.y = ${a} * Math.PI / 180; return 1; })()`);
    await sleep(1300);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${g.name}-${String(a).padStart(3, '0')}.png`), Buffer.from(s.data, 'base64'));
  }
  report.push({ name: g.name, ov: g.ov, ...info });
  console.log(`√ ${g.name}：continentScale=${info.continentScale} cOct=${info.continentOctaves} ` +
    `dOct=${info.detailOctaves} 陆地 ${info.landFraction} → ` +
    Object.entries(info.bio).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(' · '));
}

fs.mkdirSync(path.join(ROOT, 'tools', 'out'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'tools', 'out', 'shot-terrain.json'), JSON.stringify(report, null, 2));
console.log(`\n截图 → ${path.relative(ROOT, OUT)}\\<组名>-<角度>.png`);

ws.close(); child.kill(); await sleep(400);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { }
process.exit(0);
