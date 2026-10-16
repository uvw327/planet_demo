/**
 * 阶段 A 调参实验室：加载 index.html 一次，然后在页面内改 CONFIG 并 refresh()，
 * 扫 副热带下沉强度 × 湿度扰动强度，输出关键指标。
 * 用法：node v1-lab.mjs
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
const PORT = 9411;

const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'cdp-lab-'));
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
const t = await waitJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, 20, 'PUT');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };

await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: PAGE });
for (let i = 0; i < 180; i++) { await sleep(1000); if (await evaluate('!!(window.__PLANET__ && window.__PLANET__.tiles)')) break; }
console.log('页面就绪');

const ANALYZE = `(() => {
  const P = window.__PLANET__, C = P.CONFIG, tiles = P.tiles;
  const SEA = C.seaLevel, SNOW_LV = 0.80, MTN_LV = 0.65;
  const n = tiles.length;
  let land = 0, zeroLand = 0;
  const bio = {}, cls = [], buckets = [];
  for (let b = 0; b < 10; b++) buckets.push({ n: 0, s: 0, s2: 0, zero: 0 });
  for (const t of tiles) {
    bio[t.biome] = (bio[t.biome] || 0) + 1;
    if (t.elevation <= SEA) continue;
    land++;
    const bl = Math.min(9, Math.floor(Math.abs(t.latitude) * 10));
    const r = buckets[bl];
    r.n++; r.s += t.moisture; r.s2 += t.moisture * t.moisture;
    if (t.moisture === 0) { r.zero++; zeroLand++; }
    const blocked = t.elevation > MTN_LV || t.temperature < C.tempIce || t.river
                 || t.temperature < C.tempTundra || t.temperature < C.tempTaiga;
    if (!blocked) cls.push(t.moisture);
  }
  const sorted = Array.from(cls).sort((a, b) => a - b);
  const q = (p) => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))].toFixed(4) : 0;
  const latProf = buckets.map((r) => { const m = r.n ? r.s / r.n : 0; return { mean: +m.toFixed(4), std: +(r.n ? Math.sqrt(Math.max(0, r.s2 / r.n - m * m)) : 0).toFixed(4), zeroPct: r.n ? +(r.zero / r.n * 100).toFixed(1) : 0 }; });
  return {
    land, landPct: +(land / n * 100).toFixed(2),
    zeroPctOfLand: +(zeroLand / Math.max(1, land) * 100).toFixed(2),
    clsCount: sorted.length,
    clsPctOfLand: +(sorted.length / Math.max(1, land) * 100).toFixed(1),
    q: { p05: q(0.05), p15: q(0.15), p25: q(0.25), p35: q(0.35), p50: q(0.5), p65: q(0.65), p75: q(0.75), p85: q(0.85), p95: q(0.95) },
    latProf,
    bio: Object.fromEntries(['ocean','seaIce','desert','grassland','forest','rainforest','taiga','tundra','mountain','snow','ice','river'].map((k) => [k, bio[k] || 0])),
  };
})()`;

const setCfg = (obj) => `(() => { const C = window.__PLANET__.CONFIG; ${Object.entries(obj).map(([k, v]) => `C.${k}=${v};`).join('')} return 1; })()`;

async function run(label, cfg) {
  await evaluate(setCfg(cfg));
  const stats = await evaluate('window.__PLANET__.refresh()');
  const a = await evaluate(ANALYZE);
  const b = a.bio, landN = a.land;
  const pctLand = (k) => +(b[k] / landN * 100).toFixed(1);
  console.log(`\n=== ${label} ===`);
  console.log(`  cfg: ${JSON.stringify(cfg)}`);
  console.log(`  零湿度占陆地 ${a.zeroPctOfLand}% | 参与湿度分类的陆地 ${a.clsCount} (${a.clsPctOfLand}% 陆地)`);
  console.log(`  沙漠 ${b.desert} (${pctLand('desert')}% 陆地) 草原 ${b.grassland} (${pctLand('grassland')}%) 森林 ${b.forest} (${pctLand('forest')}%) 雨林 ${b.rainforest} (${pctLand('rainforest')}%)`);
  console.log(`  针叶林 ${b.taiga} 苔原 ${b.tundra} 山脉 ${b.mountain} 雪峰 ${b.snow} 冰原 ${b.ice} 河流 ${b.river}`);
  console.log(`  可分类陆地湿度分位: ${JSON.stringify(a.q)}`);
  const maxJump = (() => { let mx = 0; for (let i = 1; i < a.latProf.length; i++) mx = Math.max(mx, Math.abs(a.latProf[i].mean - a.latProf[i - 1].mean)); return +mx.toFixed(3); })();
  console.log(`  纬向平均湿度最大跳变 ${maxJump} | 各纬度桶(平均/std/零%) ${a.latProf.map((r) => `${r.mean}/${r.std}/${r.zeroPct}`).join('  ')}`);
  return { label, cfg, ...a, maxJump };
}

const results = [];
// 基线（当前 CONFIG 值）
results.push(await run('基线（subtropicDrying 0.55 / moistureNoise 0.70）', {}));

// 扫副热带下沉强度
for (const d of [0.35, 0.45, 0.55, 0.70]) {
  results.push(await run(`下沉强度 subtropicDrying=${d}`, { subtropicDrying: d }));
}
// 扫湿度扰动强度（固定下沉 0.45）
for (const m of [0.5, 0.7, 0.9, 1.1]) {
  results.push(await run(`扰动 moistureNoise=${m}（下沉 0.45）`, { subtropicDrying: 0.45, moistureNoise: m }));
}

const OUTDIR = path.join(ROOT, 'tools', 'out');
fs.mkdirSync(OUTDIR, { recursive: true });
fs.writeFileSync(path.join(OUTDIR, 'lab-climate.json'), JSON.stringify(results, null, 2), 'utf8');
ws.close(); child.kill(); await sleep(400);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { }
process.exit(0);
