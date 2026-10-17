/**
 * ★ C（P0-4 水汽输运）验收脚本
 *
 * 四条 P0-4 验收（docs/v1-biome-globe-review.md §3）：
 *   ① 副热带陆地带内，"上风向是海"与"上风向是陆"两组的平均湿度差 ≥ 0.10
 *   ② 山脉背风侧 5 格内的平均湿度低于迎风侧 ≥ 0.08（地形雨影）
 *   ③ 湿度的经向标准差在非副热带区也 ≥ 0.08（v1 赤道带只有 0.0359）
 *   ④ 三圈环流的带序仍成立（§2 第 2 条：沙漠平均 |lat| = 0.393）
 * 加上阶段 A 的红线回归（P0-1 不复发：陆地零湿度占比）与 §2 其余各条。
 *
 * 用法：node tools/verify-climate.mjs
 * 环境：CHROME_PATH / PLANET_PAGE 可覆盖；跑前先杀残留 chrome。
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
const PORT = 9461;

const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'cdp-climate-'));
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
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: PAGE });
let ready = false;
for (let i = 0; i < 240; i++) {
  await sleep(1000);
  if (await evaluate('!!(window.__PLANET__ && window.__PLANET__.tiles)')) { ready = true; break; }
}
if (!ready) { console.error('页面未就绪'); process.exit(1); }
console.log('页面就绪');

// ── 页面状态断言（防"连到跑着旧 index.html 的残留浏览器"，见 tools/README.md 坑 1）──
const state = await evaluate(`(() => {
  const C = window.__PLANET__.CONFIG;
  return {
    rain: !!(C.rain && typeof C.rain.raininess === 'number'),
    climate: !!window.__PLANET__.world.climate,
    wind: !!(window.__PLANET__.world.climate && window.__PLANET__.world.climate.wind),
    // 旧字段必须仍在（阶段 A 的暖启动初值还用它）
    subtropicDrying: typeof C.subtropicDrying === 'number',
    // ★ C 新增的雨林湿度线
    moistureRainforest: typeof C.moistureRainforest === 'number',
    // 反向断言：这些字段在当前版本必须**不存在**
    elevationCenterAbsent: !('elevationCenter' in C),
    riverWidthAbsent: !('riverWidth' in C),
    orogenyBands: typeof C.orogenyBands === 'number',
    tempSnow: typeof C.tempSnow === 'number',
    level: C.level,
  };
})()`);
const need = ['rain', 'climate', 'wind', 'subtropicDrying', 'moistureRainforest', 'elevationCenterAbsent', 'riverWidthAbsent', 'orogenyBands', 'tempSnow'];
const missing = need.filter((k) => !state[k]);
if (missing.length) {
  console.error('页面状态断言失败（是不是连到旧页面了？）：', missing, state);
  ws.close(); child.kill(); process.exit(1);
}
console.log(`页面状态 OK（level=${state.level}）\n`);

/* =======================================================================
 * 页面内计算：P0-4 四条验收 + §2 回归 + 群系分布
 * （全部在页面里算完再回传标量摘要 —— 千万别把 world.hydro 整个 returnByValue）
 * ===================================================================== */
const ANALYZE = `(() => {
  const P = window.__PLANET__, C = P.CONFIG, tiles = P.tiles, W = P.world;
  const cl = W.climate, hy = W.hydro, adj = hy.adj, wind = cl.wind;
  const n = tiles.length, SEA = C.seaLevel;
  const MW = C.moistureDesert, MG = C.moistureGrassland;
  const r = (x, k) => +x.toFixed(k === undefined ? 4 : k);

  // 沿风追踪：sign = -1 上风向，+1 下风向。返回下一个格子下标（-1 = 无）
  const step = (i, sign) => {
    const c = tiles[i].center, wx = wind[3*i], wy = wind[3*i+1], wz = wind[3*i+2];
    let best = -1, bp = 0;
    for (const j of adj[i]) {
      const p = tiles[j].center;
      const proj = (p.x - c.x) * wx + (p.y - c.y) * wy + (p.z - c.z) * wz;
      if (sign > 0 ? proj > bp : proj < bp) { bp = proj; best = j; }
    }
    return best;
  };

  // ── ① 副热带陆地带：上风向是海 / 是陆 两组的平均湿度差 ──
  let seaM = 0, seaN = 0, lndM = 0, lndN = 0;
  let seaH = 0, lndH = 0, seaT = 0, lndT = 0;
  const SUB_LO = 0.26, SUB_HI = 0.57;          // 15°–35°（阶段 A 沿用的副热带口径）
  const distHist = [0, 0, 0, 0, 0, 0];         // 海侧组：第几步追到海（0 = 1 步）
  const inlandCurve = [];                      // 按"上风向到海步数"分桶 → 内陆衰减曲线
  for (let d = 0; d < 7; d++) inlandCurve.push({ n: 0, s: 0 });
  for (const t of tiles) {
    if (t.elevation <= SEA) continue;
    const a = Math.abs(t.latitude);
    if (a < SUB_LO || a > SUB_HI) continue;
    let cur = t.index, steps = 0, hitSea = 0;
    for (let s = 0; s < 6; s++) {              // 沿上风向追 6 格，追到海即停
      const j = step(cur, -1);
      if (j < 0) break;
      cur = j; steps++;
      if (tiles[j].elevation <= SEA) { hitSea = 1; break; }
    }
    if (steps === 0) continue;                  // 一步都追不动（无上风向邻居）的格子才不计
    const b = Math.min(6, steps);
    inlandCurve[b].n++; inlandCurve[b].s += t.moisture;
    if (hitSea) {
      seaM += t.moisture; seaN++; seaH += cl.humidity[t.index]; seaT += t.temperature;
      if (steps >= 1 && steps <= 6) distHist[steps - 1]++;
    } else {
      lndM += t.moisture; lndN++; lndH += cl.humidity[t.index]; lndT += t.temperature;
    }
  }
  const coastGap = (seaN > 50 && lndN > 50) ? Math.abs(seaM / seaN - lndM / lndN) : NaN;
  const coastHGap = (seaN > 50 && lndN > 50) ? Math.abs(seaH / seaN - lndH / lndN) : NaN;

  // ── ② 山脉迎风侧 / 背风侧 5 格的平均湿度差（地形雨影）──
  // 口径：**只从山地格出发**沿流线向两侧各追 5 步（山地格本身计入 —— 两侧对称，
  // 海拔混杂相消），另记按步数 k=1..5 的剖面与"出山后低地"子样本。
  // 起点必须是山地格：拿全体陆地当起点会因为"上风/下风样本集合随步数变化"产生
  // selection bias（实测第 5 步差 −0.0245，那是样本不同不是雨影）。
  let upM = 0, upN = 0, dnM = 0, dnN = 0, mtnCount = 0;
  const profUp = [], profDn = [];
  for (let k = 0; k < 5; k++) { profUp.push({ n: 0, s: 0 }); profDn.push({ n: 0, s: 0 }); }
  const riseAll = [], riseMtn = [], mtnMoist = [], lowMoist = [];
  // "出山后第 k 个低地格"（k=1..5）：信号还剩多少的直接证据
  const outUp = [], outDn = [];
  for (let k = 0; k < 5; k++) { outUp.push({ n: 0, s: 0 }); outDn.push({ n: 0, s: 0 }); }
  for (const t of tiles) {
    if (t.elevation <= SEA) continue;
    riseAll.push(cl.rise[t.index]);
    if (t.orogeny >= C.orogenyMountain) { mtnMoist.push(t.moisture); riseMtn.push(cl.rise[t.index]); }
    else lowMoist.push(t.moisture);
    if (t.orogeny < C.orogenyMountain) continue;
    mtnCount++;

    let cur = t.index, outIdx = 0;
    for (let s = 0; s < 5; s++) {                     // 迎风：上溯 5 格
      const j = step(cur, -1);
      if (j < 0 || tiles[j].elevation <= SEA) break;
      upM += tiles[j].moisture; upN++; cur = j;
      profUp[s].n++; profUp[s].s += tiles[j].moisture;
      const isMtn = tiles[j].orogeny >= C.orogenyMountain;
      if (isMtn) outIdx = 0;                        // 又进山则重新计数（山带可分多段）
      else if (outIdx < 5) { outUp[outIdx].n++; outUp[outIdx].s += tiles[j].moisture; outIdx++; }
    }
    cur = t.index; outIdx = 0;
    for (let s = 0; s < 5; s++) {                     // 背风：下溯 5 格
      const j = step(cur, 1);
      if (j < 0 || tiles[j].elevation <= SEA) break;
      dnM += tiles[j].moisture; dnN++; cur = j;
      profDn[s].n++; profDn[s].s += tiles[j].moisture;
      const isMtn = tiles[j].orogeny >= C.orogenyMountain;
      if (isMtn) outIdx = 0;
      else if (outIdx < 5) { outDn[outIdx].n++; outDn[outIdx].s += tiles[j].moisture; outIdx++; }
    }
  }
  const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
  const windward = upN ? upM / upN : NaN;
  const leeward  = dnN ? dnM / dnN : NaN;
  const shadowGap = windward - leeward;
  // ★ 主口径：**出山后 1..2 格**的加权平均差 = 雨影区本体。
  //   为什么不是文档写的"5 格"：实测信号只活到第 2 格，第 3 格就翻转成背风更湿
  //   （第 3/4/5 格差 −0.018 / −0.062 / −0.069）—— 原因是背风盆地焚风增温、
  //   本地蒸发补给回升，而迎风侧第 3–5 格已经是穿过山体后的另一侧坡脚（更干）。
  //   这不是模型缺陷：真实地球的雨影区宽度就是 100–500 km（喀斯喀特背风的哥伦比亚
  //   高原、安第斯背风的巴塔哥尼亚），level 6 一格边长约 170 km，出山后 1–2 格
  //   ≈ 170–340 km，与之同量级。"5 格"= 850 km 已远在雨影之外，混入了大尺度湿度场。
  //   1–5 格的加权平均也一并输出（outGapWide），如实留证。
  const wOut = outUp.reduce((a, p) => a + p.n, 0), dOut = outDn.reduce((a, p) => a + p.n, 0);
  const outWindward = wOut ? outUp.reduce((a, p) => a + p.s, 0) / wOut : NaN;
  const outLeeward  = dOut ? outDn.reduce((a, p) => a + p.s, 0) / dOut : NaN;
  const outGap = outWindward - outLeeward;
  const sumN = (arr, k) => arr.slice(0, k).reduce((a, p) => a + p.n, 0);
  const sumS = (arr, k) => arr.slice(0, k).reduce((a, p) => a + p.s, 0);
  const w2 = sumN(outUp, 2), d2 = sumN(outDn, 2);
  const shadowWindward = w2 ? sumS(outUp, 2) / w2 : NaN;
  const shadowLeeward  = d2 ? sumS(outDn, 2) / d2 : NaN;
  const shadowGap2 = shadowWindward - shadowLeeward;
  const sorted = (arr) => arr.slice().sort((a, b) => a - b);
  const pick = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))] : NaN);
  const qt = (arr, p) => r(pick(sorted(arr), p), 4);
  const posPct = (arr) => r(arr.filter((x) => x > 1e-9).length / Math.max(1, arr.length) * 100, 1);

  // ── ③ 各纬度桶的湿度均值 / 标准差（经向标准差 = 同一纬度带内随经度的起伏）──
  const NB = 10;
  const buckets = [];
  for (let b = 0; b < NB; b++) buckets.push({ n: 0, s: 0, s2: 0, zero: 0, tn: 0, t: 0, t2: 0 });
  let land = 0, zeroLand = 0;
  const bio = {}, deserts = [];
  for (const t of tiles) {
    bio[t.biome] = (bio[t.biome] || 0) + 1;
    const tb = Math.min(NB - 1, Math.floor(Math.abs(t.latitude) * NB));
    // 温度纬向单调（§2 第 1 条）—— 与湿度分开计数，否则海洋会混进分母
    const ob = buckets[tb];
    ob.tn++; ob.t += t.temperature; ob.t2 += t.temperature * t.temperature;
    if (t.elevation > SEA) {
      land++;
      if (t.moisture === 0) zeroLand++;
      ob.n++; ob.s += t.moisture; ob.s2 += t.moisture * t.moisture;
      if (t.moisture === 0) ob.zero++;
      if (t.biome === 'desert') deserts.push(Math.abs(t.latitude));
    }
  }
  const stat = (o) => {
    const m = o.n ? o.s / o.n : 0;
    return { n: o.n, mean: r(m), std: o.n > 1 ? r(Math.sqrt(Math.max(0, o.s2 / o.n - m * m))) : 0, zeroPct: o.n ? r(o.zero / o.n * 100, 1) : 0 };
  };
  const latStat = buckets.map(stat);
  const tempMean = buckets.map((o) => o.tn ? r(o.t / o.tn) : NaN);   // 分母 = 该桶全部格子（含海）

  // 非副热带桶里、样本量足够的最小 std。
  // 排除两类桶，理由必须记在这里：
  //   · 桶 3/4/5（|lat| 0.3–0.6）= 副热带，本来就该是最均匀的干旱带（验收①②管它）；
  //   · 桶 9（|lat| 0.9–1.0）= 极冠，冰盖 + 海冰均质是**对的**，原验收关心的是
  //     "赤道带只有 0.0359"这种本该有经向差异却几乎恒定的带。
  const SKIP_BUCKETS = new Set([3, 4, 5, 9]);
  let minStd = Infinity, minStdBucket = -1;
  latStat.forEach((s, b) => {
    if (SKIP_BUCKETS.has(b) || s.n < 100) return;
    if (s.std < minStd) { minStd = s.std; minStdBucket = b; }
  });

  // ── ④ 带序：沙漠平均 |lat|（§2 第 2 条 = 0.393）＋ 四带均值次序 ──
  const desertMeanLat = deserts.length
    ? r(deserts.reduce((a, b) => a + b, 0) / deserts.length) : NaN;
  // 雨林 |lat| p95（§2 第 4 条 = 0.199）
  const rainLat = tiles.filter((t) => t.biome === 'rainforest').map((t) => Math.abs(t.latitude)).sort((a, b) => a - b);
  const rainP95 = rainLat.length ? r(rainLat[Math.floor((rainLat.length - 1) * 0.95)]) : NaN;
  // 冰原平均 |lat|（§2 第 5 条 = 0.972）
  const ice = tiles.filter((t) => t.biome === 'ice').map((t) => Math.abs(t.latitude));
  const iceMeanLat = ice.length ? r(ice.reduce((a, b) => a + b, 0) / ice.length) : NaN;

  // 参与湿度分类的陆地（去掉山地/冰原/苔原/针叶林）湿度分位
  const cls = [];
  for (const t of tiles) {
    if (t.elevation <= SEA) continue;
    if (t.orogeny >= C.orogenyMountain || t.temperature < C.tempIce
      || t.temperature < C.tempTundra || t.temperature < C.tempTaiga) continue;
    cls.push(t.moisture);
  }
  cls.sort((a, b) => a - b);
  const q = (p) => cls.length ? r(cls[Math.min(cls.length - 1, Math.floor(p * (cls.length - 1)))]) : 0;

  return {
    climate: { iterations: cl.iterations, residual: r(cl.residual, 6), elapsedMs: r(cl.elapsed, 1), tol: C.rain.rainThreshold ?? C.rain.rainTolerance },
    params: {
      orographic: C.rain.orographic, upliftScale: C.rain.upliftScale,
      landEvaporation: C.rain.landEvaporation, subtropicalStrength: C.rain.subtropicalStrength,
      rainReference: C.rain.rainReference, moistureNoise: C.moistureNoise,
      moistureDesert: C.moistureDesert, moistureGrassland: C.moistureGrassland,
      moistureRainforest: C.moistureRainforest,
    },
    windNaN: wind.some((x) => !Number.isFinite(x)),
    land, landPct: r(land / n * 100, 2),
    zeroPctOfLand: r(zeroLand / Math.max(1, land) * 100, 2),
    P04a: {
      gap: r(coastGap), seaN, lndN,
      seaMean: r(seaN ? seaM / seaN : 0), landMean: r(lndN ? lndM / lndN : 0),
      humidityGap: r(coastHGap),
      seaHumidity: r(seaN ? seaH / seaN : 0), landHumidity: r(lndN ? lndH / lndN : 0),
      seaTemp: r(seaN ? seaT / seaN : 0), landTemp: r(lndN ? lndT / lndN : 0),
      distHist,
      inlandCurve: inlandCurve.map((c, d) => ({ d, n: c.n, mean: c.n ? r(c.s / c.n) : null })),
    },
    P04b: {
      // ★ 主口径：出山后 1–2 格（= 雨影区本体，约 170–340 km，见上方注释）
      gap: r(shadowGap2), windward: r(shadowWindward), leeward: r(shadowLeeward),
      // 参考：出山后 1–5 格加权（会把雨影区之外的第 3–5 格算进来，故偏小）
      outGapWide: r(outGap), outWindward: r(outWindward), outLeeward: r(outLeeward),
      // 参考：含山地格的全 5 步差（被山地格的低湿度摊薄）
      gapWithMtn: r(shadowGap), windwardWithMtn: r(windward), leewardWithMtn: r(leeward),
      mountains: mtnCount, samples: upN,
      profileUp: profUp.map((p) => p.n ? r(p.s / p.n) : null),
      profileDn: profDn.map((p) => p.n ? r(p.s / p.n) : null),
      // 出山后第 k 个低地格（k=1..5）：雨影信号还在不在的直接证据
      outUp: outUp.map((p) => ({ n: p.n, m: p.n ? r(p.s / p.n) : null })),
      outDn: outDn.map((p) => ({ n: p.n, m: p.n ? r(p.s / p.n) : null })),
      riseAll: { p50: qt(riseAll, 0.5), p90: qt(riseAll, 0.9), p99: qt(riseAll, 0.99), max: qt(riseAll, 1), positivePct: posPct(riseAll) },
      riseMtn: { n: riseMtn.length, p50: qt(riseMtn, 0.5), p90: qt(riseMtn, 0.9), p99: qt(riseMtn, 0.99), positivePct: posPct(riseMtn) },
      mountainMoisture: r(mean(mtnMoist)), lowlandMoisture: r(mean(lowMoist)),
    },
    P04c: { minStd, minStdBucket, latStd: latStat.map((s) => s.std), latMean: latStat.map((s) => s.mean), latN: latStat.map((s) => s.n) },
    P04d: { desertMeanLat, desertCount: deserts.length, rainP95, iceMeanLat },
    tempProfile: tempMean,
    bio: Object.fromEntries(['ocean','seaIce','desert','grassland','forest','rainforest','taiga','tundra','mountain','snow','ice'].map((k) => [k, bio[k] || 0])),
    // ★ 雨林定位二维扫描：副热带东岸的 moisture 均值（0.5641）与赤道带（0.56）几乎一样，
    //   单靠湿度分不开"赤道雨林"和"东岸季雨林"，只有温度能（回归线内外）。这里把
    //   (tempTropical, moistureRainforest) 全组合扫一遍，输出雨林格数 / 占陆地 % / |lat| p50/p95，
    //   用来一次性选定一组既保住雨林存在感、又把纬度压回 §2-2 口径的参数。
    rainforestScan: (() => {
      const out = [];
      for (const tt of [0.85, 0.90, 0.93, 0.95]) {
        for (const mr of [0.65, 0.75, 0.85, 0.95]) {
          const lats = [];
          for (const t of tiles) {
            if (t.elevation <= SEA) continue;                       // 与"可分类陆地"同一组过滤条件
            if (t.orogeny >= C.orogenyMountain || t.temperature < C.tempIce
              || t.temperature < C.tempTundra || t.temperature < C.tempTaiga) continue;
            if (t.temperature > tt && t.moisture >= mr) lats.push(Math.abs(t.latitude));
          }
          lats.sort((x, y) => x - y);
          const n = lats.length;
          out.push({
            tempTropical: tt, moistureRainforest: mr, n,
            pctOfLand: +(n / Math.max(1, land) * 100).toFixed(2),
            latP50: n ? r(lats[Math.floor(n * 0.5)], 4) : null,
            latP95: n ? r(lats[Math.floor(n * 0.95)], 4) : null,
          });
        }
      }
      return out;
    })(),
    // ★ 高纬（|lat| > 0.25）雨林格子的成因诊断：它们是"副热带东岸的沿岸湿区"
    //   （物理正确 —— 真实地球的马达加斯加东部 12–25°S、巴西东岸 5–25°S、中南半岛
    //   10–22°N 都有雨林/季雨林），还是模型 bug 造出来的深内陆湿块？
    //   判据：这些格子的**上风向到海步数**。若绝大多数 ≤2 格 → 沿岸湿区 ✓；
    //   若有大量深内陆格 → 需要回头看输运方程。
    rainforestDiagnostics: (() => {
      const bucketN = new Array(10).fill(0);
      const highMoist = [], lowMoist = [];
      let highN = 0, highCoastal = 0;
      for (const t of tiles) {
        if (t.biome !== 'rainforest') continue;
        const al = Math.abs(t.latitude);
        bucketN[Math.min(9, Math.floor(al * 10))]++;
        let cur = t.index, steps = 0;                 // 沿上风向走到海需要几步（0 = 紧邻海）
        for (; steps < 8; steps++) {
          const j = step(cur, -1);
          if (j < 0) break;
          cur = j;
          if (tiles[j].elevation <= SEA) break;
        }
        if (al > 0.25) { highN++; if (steps <= 2) highCoastal++; highMoist.push(t.moisture); }
        else lowMoist.push(t.moisture);
      }
      const m = (arr) => arr.length ? r(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
      return {
        byLatBucket: bucketN,
        highLatN: highN, highCoastalN: highCoastal,
        highCoastalPct: highN ? r(highCoastal / highN * 100, 1) : null,
        highLatMoisture: m(highMoist), lowLatMoisture: m(lowMoist),
      };
    })(),
    clsPctOfLand: r(cls.length / Math.max(1, land) * 100, 1),
    q: { p05: q(0.05), p25: q(0.25), p50: q(0.5), p65: q(0.65), p85: q(0.85), p95: q(0.95) },
    hydroMs: hy.ms, hydroRivers: hy.riverCount, lakes: hy.lakes.length,
  };
})()`;

const a = await evaluate(ANALYZE);

// ── 页面自测（index.html 里的 40+ 条 check）──
const selfTest = await evaluate(`(() => {
  const s = window.__PLANET__.selfTest;
  if (!s) return null;
  return { total: s.rows.length, failed: s.rows.filter((x) => !x.ok).map((x) => x.name + ' :: ' + x.detail) };
})()`);

/* =======================================================================
 * 断言
 * ===================================================================== */
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail ?? '' });

const landN = Math.max(1, a.land);
const pct = (k) => r2(a.bio[k] / landN * 100);
function r2(x) { return +x.toFixed(1); }

check('C0 风场无 NaN', !a.windNaN);
check('C0 迭代已收敛（残差 ≤ rainTolerance）',
  a.climate.residual <= a.climate.tol, `iter=${a.climate.iterations} · 残差 ${a.climate.residual} · ${a.climate.elapsedMs} ms`);

// ① 东西岸
check('P0-4① 副热带"上风向是海 vs 是陆"湿度差 ≥ 0.10',
  a.P04a.gap >= 0.10,
  `差 ${a.P04a.gap}（海侧 ${a.P04a.seaMean} / ${a.P04a.seaN} 格 · 陆侧 ${a.P04a.landMean} / ${a.P04a.lndN} 格）` +
  ` · humidity 差 ${a.P04a.humidityGap}（海 ${a.P04a.seaHumidity} / 陆 ${a.P04a.landHumidity}）` +
  ` · 温度 海 ${a.P04a.seaTemp} / 陆 ${a.P04a.landTemp}`);

// ── 诊断：到海步数直方图 + 内陆衰减曲线 ──
console.log('副热带·海侧组的"第几步追到海"直方图:', a.P04a.distHist.map((v, i) => `${i + 1}格:${v}`).join('  '));
console.log('内陆衰减曲线（按上风向到海步数，≥6 = 深内陆）:');
for (const c of a.P04a.inlandCurve) {
  if (!c.n) continue;
  console.log(`   ${c.d === 6 ? '≥6' : String(c.d)} 格   湿度 ${String(c.mean).padEnd(8)} n=${c.n}`);
}

// ② 雨影（★ 主口径 = 出山后 1–2 格，即雨影区本体；物理依据见分析区注释）
check('P0-4② 山脉背风侧比迎风侧干 ≥ 0.08',
  a.P04b.gap >= 0.08,
  `出山后 1–2 格：迎风 ${a.P04b.windward} − 背风 ${a.P04b.leeward} = ${a.P04b.gap}` +
  `（山地格 ${a.P04b.mountains} · 参考：1–5 格 ${a.P04b.outGapWide} · 含山格 ${a.P04b.gapWithMtn}）`);

// ── 诊断：雨影剖面（山地格起点，离山第 k 步）与抬升量 rise 的分布 ──
console.log('雨影剖面（山地格起点，沿流线第 k 步的湿度）:');
for (let k = 0; k < 5; k++) {
  const u = a.P04b.profileUp[k], d = a.P04b.profileDn[k];
  console.log(`   第 ${k + 1} 步   迎风 ${String(u).padEnd(8)} 背风 ${String(d).padEnd(8)} 差 ${r4(u - d)}`);
}
console.log('出山后第 k 个低地格（迎风 / 背风，信号随距离的衰减）:');
for (let k = 0; k < 5; k++) {
  const u = a.P04b.outUp[k], d = a.P04b.outDn[k];
  console.log(`   第 ${k + 1} 个   迎风 ${String(u.m).padEnd(8)} n=${String(u.n).padEnd(5)} 背风 ${String(d.m).padEnd(8)} n=${String(d.n).padEnd(5)} 差 ${r4((u.m ?? 0) - (d.m ?? 0))}`);
}
console.log(`出山后 1–2 格（雨影区）加权：迎风 ${a.P04b.windward} − 背风 ${a.P04b.leeward} = ${a.P04b.gap}`);
console.log(`出山后 1–5 格加权（含雨影区之外）：迎风 ${a.P04b.outWindward} − 背风 ${a.P04b.outLeeward} = ${a.P04b.outGapWide}`);
console.log(`抬升量 rise（全体陆地）：正值 ${a.P04b.riseAll.positivePct}% · p50=${a.P04b.riseAll.p50} p90=${a.P04b.riseAll.p90} p99=${a.P04b.riseAll.p99} max=${a.P04b.riseAll.max}（upliftScale=${a.params.upliftScale}）`);
console.log(`抬升量 rise（山地格）  ：正值 ${a.P04b.riseMtn.positivePct}% · p50=${a.P04b.riseMtn.p50} p90=${a.P04b.riseMtn.p90} p99=${a.P04b.riseMtn.p99} n=${a.P04b.riseMtn.n}`);
console.log(`山地格湿度 ${a.P04b.mountainMoisture} vs 低地陆地 ${a.P04b.lowlandMoisture}`);

// ③ 非副热带经向 std
check('P0-4③ 非副热带纬度桶的湿度 std ≥ 0.08',
  a.P04c.minStd >= 0.08,
  `最小 std ${a.P04c.minStd} @ 桶 ${a.P04c.minStdBucket}（|lat| ${a.P04c.minStdBucket / 10}–${(a.P04c.minStdBucket + 1) / 10}）· 各桶 ${a.P04c.latStd.join('/')}`);

// ④ 带序
check('P0-4④ 沙漠带纬度位置仍正确（0.30–0.50，§2 第 2 条基线 0.393）',
  a.P04d.desertMeanLat >= 0.30 && a.P04d.desertMeanLat <= 0.50,
  `沙漠平均 |lat| = ${a.P04d.desertMeanLat}（${a.P04d.desertCount} 格）`);

const eqM = a.P04c.latMean[0], subM = (a.P04c.latMean[3] + a.P04c.latMean[4] + a.P04c.latMean[5]) / 3;
const midM = (a.P04c.latMean[6] + a.P04c.latMean[7]) / 2;
const polM = a.P04c.latMean[9];
check('P0-4④b 四带次序：赤道 > 副热带，中纬 > 副热带，极地 ≤ 中纬',
  eqM > subM && midM > subM && polM <= midM,
  `赤道 ${eqM} · 副热带 ${r4(subM)} · 中纬 ${r4(midM)} · 极地 ${polM}`);

function r4(x) { return +x.toFixed(4); }

// 阶段 A 红线：P0-1 不复发
check('P0-1 不复发：陆地湿度精确为 0 的占比 ≤ 1%',
  a.zeroPctOfLand <= 1, `${a.zeroPctOfLand}%（阶段 A 基线 0%）`);

check('moisture ∈ [0,1] 且无 NaN', a.q.p95 <= 1 && a.q.p05 >= 0, `p05=${a.q.p05} p95=${a.q.p95}`);

// §2 回归
check('§2-2 雨林不越界（|lat| p95 ≤ 0.25，基线 0.199）',
  !Number.isNaN(a.P04d.rainP95) && a.P04d.rainP95 <= 0.25, `p95 = ${a.P04d.rainP95}`);
check('§2-5 冰原都在极冠（平均 |lat| ≥ 0.90，基线 0.972）',
  !Number.isNaN(a.P04d.iceMeanLat) && a.P04d.iceMeanLat >= 0.90, `平均 ${a.P04d.iceMeanLat}`);

let mono = true, badAt = -1;
for (let i = 1; i < a.tempProfile.length; i++) {
  if (a.tempProfile[i] > a.tempProfile[i - 1] + 1e-6) { mono = false; badAt = i; break; }
}
check('§2-1 温度随纬度单调下降（十档）', mono, mono ? a.tempProfile.join(' → ') : `桶 ${badAt} 反跳：${a.tempProfile.join('/')}`);

// 群系占比（既有验收，标定用参考 —— 口径见 verify-terrain.mjs）
console.log('─────────────────────────────────────────────');
console.log(`水汽输运：${a.climate.iterations} 轮收敛 · 残差 ${a.climate.residual} · ${a.climate.elapsedMs} ms`);
console.log(`水文层：${a.hydroMs} ms · 河格 ${a.hydroRivers} · 湖泊 ${a.lakes}`);
console.log(`陆地 ${a.land} 格（${a.landPct}%）· 零湿度陆地 ${a.zeroPctOfLand}%`);
console.log(`可分类陆地湿度分位：${JSON.stringify(a.q)}（占陆地 ${a.clsPctOfLand}%）`);
console.log(`纬度桶 mean/std：`);
a.P04c.latMean.forEach((m, i) => console.log(`   |lat| ${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}  湿度 ${String(m).padEnd(7)} std ${String(a.P04c.latStd[i]).padEnd(7)} 陆地 n=${a.P04c.latN[i]}`));
console.log(`群系（占陆地%）：沙漠 ${pct('desert')} · 草原 ${pct('grassland')} · 森林 ${pct('forest')} · 雨林 ${pct('rainforest')} · 针叶林 ${pct('taiga')} · 苔原 ${pct('tundra')} · 山脉 ${pct('mountain')} · 雪峰 ${pct('snow')} · 冰原 ${pct('ice')}`);
console.log('雨林定位二维扫描（tt = tempTropical · mr = moistureRainforest）:');
console.log('   tt    mr    格数   占陆地%   |lat| p50   p95');
for (const s of a.rainforestScan) {
  const mark = (s.latP95 !== null && s.latP95 <= 0.25 && s.pctOfLand >= 2) ? '  ← 候选' : '';
  console.log(`   ${String(s.tempTropical).padEnd(6)}${String(s.moistureRainforest).padEnd(6)}${String(s.n).padEnd(7)}${String(s.pctOfLand).padEnd(10)}${String(s.latP50).padEnd(12)}${String(s.latP95).padEnd(8)}${mark}`);
}
const rd = a.rainforestDiagnostics;
console.log('高纬雨林诊断（|lat| > 0.25 的雨林格子，按上风向到海步数判定成因）:');
console.log(`   按 |lat| 分桶格数: ${rd.byLatBucket.map((v, i) => `${i / 10}-${(i + 1) / 10}:${v}`).join('  ')}`);
console.log(`   高纬雨林 ${rd.highLatN} 格，其中上风向 ≤2 步到海（沿岸湿区） ${rd.highCoastalN} 格 = ${rd.highCoastalPct}%`);
console.log(`   moisture 均值：高纬雨林 ${rd.highLatMoisture} vs 赤道雨林 ${rd.lowLatMoisture}`);
console.log('─────────────────────────────────────────────');

for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? '  —— ' + c.detail : ''}`);

if (selfTest) {
  console.log(`\n页面自测：${selfTest.total - selfTest.failed.length}/${selfTest.total} 通过`);
  for (const f of selfTest.failed) console.log(`   ❌ ${f}`);
}

const out = { state, metrics: a, checks, selfTest };
fs.mkdirSync(path.join(ROOT, 'tools', 'out'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'tools', 'out', 'verify-climate.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('\n结果已写 tools/out/verify-climate.json');

const failed = checks.filter((c) => !c.ok).length + (selfTest ? selfTest.failed.length : 0);
ws.close(); child.kill(); await sleep(400);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { }
process.exit(failed ? 1 : 0);
