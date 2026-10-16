/**
 * 渲染架构验收脚本
 *
 *   ① 直接 hook WebGL 的 drawElements/drawArrays，逐帧统计真实 draw call
 *   ② 量 rAF 帧间隔（p50 / p95 / max）
 *   ③ 拾取往返测试：把图块中心投影到屏幕 → pickTile() → 必须回到同一个图块
 *   ④ 顶点色高亮 / 选中 / 矿石层的正确性断言
 *   ⑤ 截图存档
 *
 * 同一个脚本可以跑两个页面做 A/B：
 *   node tools/verify-render.mjs                       → index.html（合并后）
 *   PLANET_PAGE=<v1 的绝对路径> node tools/verify-render.mjs v1  → v1 基线
 *
 * v1 没有 window.__PLANET__，所以只有 ① ② ⑤ 会执行。
 * 用法：node tools/verify-render.mjs [tag]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toUrl = (p) => 'file:///' + p.replace(/\\/g, '/');
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/matt/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const TAG = process.argv[2] || 'merged';
const PAGE = toUrl(process.env.PLANET_PAGE || path.join(ROOT, 'index.html'));
const PORT = process.env.CDP_PORT || 9421;
// 两种模式都写进 docs/render-shots/，用文件名前缀区分。
// 注意不要写进 docs/v1-shots/ —— 那是 v1 基线的归档证据，不能被后来者覆盖。
// TAG 除了 v1 / merged 之外还可以是别的（例如 l6 = level 6 再基线），
// 这时前缀变成 `render-<TAG>`，**不会**覆盖 merged 那一轮的归档图。
const OUT = path.join(ROOT, 'docs', 'render-shots');
const FILE_PREFIX = TAG === 'v1' ? 'v1-baseline' : (TAG === 'merged' ? 'render' : `render-${TAG}`);

const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'cdp-render-'));
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
const tgt = await waitJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, 20, 'PUT');
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');

// ── 注入：单调累加的 draw call 计数器 + 两个测量助手（在任何页面脚本之前）──
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  let total = 0;
  window.__dcTotal = 0;
  for (const proto of [window.WebGLRenderingContext && WebGLRenderingContext.prototype,
                       window.WebGL2RenderingContext && WebGL2RenderingContext.prototype]) {
    if (!proto) continue;
    for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const orig = proto[name];
      if (!orig) continue;
      proto[name] = function (...a) { window.__dcTotal++; total++; return orig.apply(this, a); };
    }
  }
  // 逐帧采样：帧间增量 = 这一帧真实发生的 draw call 次数。
  // 不能在每个 rAF 回调里清零计数器 —— 一帧内可能有多个回调（页面自己的 animate
  // 加上测量脚本的回调），互相清零会把计数抹掉。
  window.__measureFrames = (frames) => new Promise((res) => {
    const ts = [], dc = [];
    let n = 0, last = window.__dcTotal;
    const tick = (t) => {
      ts.push(t);
      const cur = window.__dcTotal;
      dc.push(cur - last);
      last = cur;
      if (++n < frames) requestAnimationFrame(tick);
      else res({ ts, dc });
    };
    requestAnimationFrame(tick);
  });
})();` });

await send('Page.navigate', { url: PAGE });
let hasApi = false;
for (let i = 0; i < 200; i++) {
  await sleep(1000);
  hasApi = await evaluate('!!(window.__PLANET__ && window.__PLANET__.planetMesh)');
  if (hasApi) break;
  if (await evaluate('!!window.__planetReady')) break;
}
if (!hasApi && !(await evaluate('!!window.__planetReady'))) throw new Error('页面未就绪');
await sleep(3000);
console.log(`页面就绪｜模式 = ${hasApi ? '合并后（有 __PLANET__）' : 'v1 基线（无 __PLANET__）'}`);

fs.mkdirSync(OUT, { recursive: true });

// ── 帧率与 draw call ──
const perf = await evaluate(`(async () => {
  const { ts, dc } = await window.__measureFrames(181);
  const dts = [];
  for (let i = 1; i < ts.length; i++) dts.push(ts[i] - ts[i - 1]);
  dts.sort((a, b) => a - b);
  const q = (p) => +dts[Math.min(dts.length - 1, Math.floor(p * dts.length))].toFixed(2);
  const d = dc.slice(5).sort((a, b) => a - b);           // 丢掉开头几帧的初始化
  const dq = (p) => (d.length ? d[Math.min(d.length - 1, Math.floor(p * d.length))] : -1);
  return {
    frames: dts.length,
    frameMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +dts[dts.length - 1].toFixed(2) },
    fpsFromP50: +(1000 / q(0.5)).toFixed(1),
    drawCalls: { p50: dq(0.5), p95: dq(0.95), max: d[d.length - 1] ?? -1, samples: d.slice(0, 10) },
  };
})()`);
console.log('性能：', JSON.stringify(perf));

const report = { tag: TAG, page: PAGE, perf, hasApi };

if (hasApi) {
  // ── 功能断言 ──
  report.stats = await evaluate('window.__PLANET__.stats()');
  console.log('渲染统计：', JSON.stringify(report.stats));

  report.consistency = await evaluate(`(() => {
    const P = window.__PLANET__;
    const g = P.gfx;
    const geo = g.mesh.geometry;
    const idx = geo.index.array;
    const triCount = idx.length / 3;

    // ① 顶点数 / 索引数 / 映射表长度
    const sizes = {
      vertices: geo.attributes.position.count,
      triangles: triCount,
      triToTile: g.triToTile.length,
      colorLen: geo.attributes.color.array.length,
      normalLen: geo.attributes.normal ? geo.attributes.normal.array.length : 0,
      indexType: idx.constructor.name,
    };

    // ② 逐三角形：三个顶点必须落在 triToTile[t] 自己的顶点区间内
    let bad = 0, firstBad = -1;
    for (let t = 0; t < triCount; t++) {
      const ti = g.triToTile[t];
      const lo = g.tileVertStart[ti], hi = lo + g.tileVertCount[ti];
      const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
      if (a < lo || a >= hi || b < lo || b >= hi || c < lo || c >= hi) { bad++; if (firstBad < 0) firstBad = t; }
    }

    // ③ 单材质 / 单几何体
    let meshCount = 0, lineCount = 0, pointsCount = 0, instanced = 0;
    P.scene.traverse((o) => {
      if (o.isInstancedMesh) instanced++;
      else if (o.isMesh) meshCount++;
      if (o.isLine || o.isLineLoop || o.isLineSegments) lineCount++;
      if (o.isPoints) pointsCount++;
    });

    // ④ 一个图块内部的所有顶点颜色必须完全一致（每格纯色，不是渐变色）
    const col = geo.attributes.color.array;
    let colorOK = true;
    for (const tile of P.tiles) {
      const s = g.tileVertStart[tile.index] * 3, n = g.tileVertCount[tile.index] * 3;
      for (let k = s + 3; k < s + n; k++) if (col[k] !== col[s + (k - s) % 3]) { colorOK = false; break; }
      if (!colorOK) break;
    }

    // ⑤ 无缝隙：合并后的环顶点坐标必须与 buildDual 给出的对偶顶点坐标相同
    //    （Float32Array 会把 float64 舍入到 float32，所以要用 fround 比）
    const pos = geo.attributes.position.array;
    let seamOK = true, seamBad = -1;
    for (const tile of P.tiles) {
      const ring = g.tileVertStart[tile.index] + 1;
      for (let i = 0; i < tile.vertices.length; i++) {
        const v = tile.vertices[i], p = (ring + i) * 3;
        if (pos[p] !== Math.fround(v.x) || pos[p + 1] !== Math.fround(v.y) || pos[p + 2] !== Math.fround(v.z)) {
          seamOK = false; seamBad = tile.index; break;
        }
      }
      if (!seamOK) break;
    }

    // ⑥ 扇心必须落在球面上（半径 avgR），不能塌进球体
    let centerOK = true;
    for (const tile of P.tiles) {
      const p = g.tileVertStart[tile.index] * 3;
      const r = Math.hypot(pos[p], pos[p + 1], pos[p + 2]);
      if (Math.abs(r - tile.avgRadius) > 1e-6) { centerOK = false; break; }
    }

    // ⑦ 法线必须是单位长度（球面解析法线）
    const nor = geo.attributes.normal.array;
    let normalOK = true;
    for (let k = 0; k < nor.length; k += 3) {
      const len = Math.hypot(nor[k], nor[k + 1], nor[k + 2]);
      if (Math.abs(len - 1) > 1e-4) { normalOK = false; break; }
    }

    // ⑧ 反例：如果偷懒用 Math.floor(faceIndex / 6) 会有多少三角形落错图块
    let naiveWrong = 0;
    for (let t = 0; t < triCount; t++) if (Math.floor(t / 6) !== g.triToTile[t]) naiveWrong++;
    const firstTwelveArePentagons = P.tiles.slice(0, 12).every((t) => t.vertexIndices.length === 5);

    return { sizes, badTriangles: bad, firstBadTriangle: firstBad,
             meshCount, instancedCount: instanced, lineCount, pointsCount,
             perTileSolidColor: colorOK,
             seamFree: seamOK, seamBadTile: seamBad,
             fanCenterOnSphere: centerOK,
             normalsUnitLength: normalOK,
             naiveFloorDiv6WrongTriangles: naiveWrong,
             firstTwelveTilesArePentagons: firstTwelveArePentagons };
  })()`);
  console.log('几何一致性：', JSON.stringify(report.consistency));

  // ── 拾取往返测试 ──
  report.picking = await evaluate(`(() => {
    const P = window.__PLANET__;
    const cam = P.camera;
    const el = P.renderer.domElement;
    const rect = el.getBoundingClientRect();
    P.planetGroup.updateMatrixWorld(true);
    cam.updateMatrixWorld();

    const Vec3 = P.tiles[0].center.constructor;   // THREE.Vector3
    let tested = 0, hit = 0, matched = 0;
    const mismatches = [];

    for (let i = 0; i < P.tiles.length; i += 17) {      // 均匀抽样
      const tile = P.tiles[i];

      // 中心方向 → 世界坐标（planetGroup 只有旋转，用 matrixWorld 变换一次）
      const m = P.planetGroup.matrixWorld.elements;
      const w = tile.center;
      const wx = m[0] * w.x + m[4] * w.y + m[8] * w.z + m[12];
      const wy = m[1] * w.x + m[5] * w.y + m[9] * w.z + m[13];
      const wz = m[2] * w.x + m[6] * w.y + m[10] * w.z + m[14];

      // 只测朝向相机的图块，否则会被背面挡住（这正是 FrontSide 剔除的意义）
      const dx = cam.position.x - wx, dy = cam.position.y - wy, dz = cam.position.z - wz;
      const dl = Math.hypot(dx, dy, dz) || 1;
      if ((dx * wx + dy * wy + dz * wz) / dl < 0.45) continue;

      // 世界坐标 → NDC → 屏幕像素
      const v = new Vec3(wx, wy, wz).project(cam);
      if (v.x < -0.92 || v.x > 0.92 || v.y < -0.92 || v.y > 0.92) continue;
      const sx = (v.x * 0.5 + 0.5) * rect.width;
      const sy = (-v.y * 0.5 + 0.5) * rect.height;

      tested++;
      const got = P.pickTile(sx, sy);
      if (got >= 0) hit++;
      if (got === tile.index) matched++;
      else if (mismatches.length < 8) mismatches.push({ want: tile.index, got, sx: +sx.toFixed(1), sy: +sy.toFixed(1) });
    }
    return { tested, hit, matched, accuracy: tested ? +(matched / tested * 100).toFixed(2) : 0, mismatches };
  })()`);
  console.log('拾取往返：', JSON.stringify(report.picking));

  // ── 拾取稳定性：同一个屏幕点在相机不动的情况下必须每次都得到同一个图块 ──
  const probe = async (label) => {
    const r = await evaluate(`(() => {
      const P = window.__PLANET__;
      const rect = P.renderer.domElement.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const c = P.camera.position;
      return {
        tile: P.pickTile(cx, cy),
        cam: [+c.x.toFixed(6), +c.y.toFixed(6), +c.z.toFixed(6)],
        rot: [+P.planetGroup.rotation.x.toFixed(6), +P.planetGroup.rotation.y.toFixed(6)],
      };
    })()`);
    return { label, ...r };
  };
  report.pickStability = [];
  report.pickStability.push(await probe('立即'));
  await sleep(1500);
  report.pickStability.push(await probe('1.5 秒后'));
  await evaluate('window.__measureFrames(61)');
  report.pickStability.push(await probe('再跑 60 帧'));
  console.log('拾取稳定性：', JSON.stringify(report.pickStability));

  // ── 高亮 / 选中：只改顶点色，不新建 Mesh ──
  report.highlight = await evaluate(`(() => {
    const P = window.__PLANET__;
    const g = P.gfx;
    const col = g.mesh.geometry.attributes.color.array;
    const readTile = (ti) => {
      const s = g.tileVertStart[ti] * 3;
      return [col[s], col[s + 1], col[s + 2]];
    };
    const meshBefore = [];
    P.scene.traverse((o) => { if (o.isMesh) meshBefore.push(o.uuid); });

    const ti = P.pickTile(window.innerWidth / 2, window.innerHeight / 2);
    const base = readTile(ti > 0 ? ti : 0);
    const before = readTile(ti > 0 ? ti : 0);

    P.select(ti);
    const afterSel = readTile(ti);
    const selColor = new (P.tiles[0].baseColor.constructor)(0x8fe3ff);
    const sameAsBase = afterSel[0] === before[0] && afterSel[1] === before[1] && afterSel[2] === before[2];

    const meshAfter = [];
    P.scene.traverse((o) => { if (o.isMesh) meshAfter.push(o.uuid); });

    // 描边对象是否复用（只有一个）
    let lines = 0;
    P.scene.traverse((o) => { if (o.isLineLoop) lines++; });

    return {
      pickedTile: ti,
      selectedIndex: P.getSelected(),
      vertexColorChanged: !sameAsBase,
      baseColor: base.map((v) => +v.toFixed(4)),
      colorAfterSelect: afterSel.map((v) => +v.toFixed(4)),
      selectionTargetLinear: [selColor.r, selColor.g, selColor.b].map((v) => +v.toFixed(4)),
      meshCountBefore: meshBefore.length,
      meshCountAfter: meshAfter.length,
      noNewMesh: meshBefore.length === meshAfter.length,
      lineLoopCount: lines,
      usesPartialUpload: typeof g.colorAttr.addUpdateRange === 'function',
    };
  })()`);
  console.log('高亮/选中：', JSON.stringify(report.highlight));

  // ── 矿石层：draw call 只 +1 ──
  report.ore = await evaluate(`(() => {
    const P = window.__PLANET__;
    const callsBefore = P.renderer.info.render.calls;
    const before = P.stats();
    // 在若干格上放矿
    const picked = [];
    for (let i = 0; i < P.tiles.length && picked.length < 40; i += 211) {
      const ti = i;
      P.setOre(ti, (picked.length % 3) + 1, 500);
      picked.push(ti);
    }
    let meshCount = 0, instanced = 0;
    P.scene.traverse((o) => { if (o.isInstancedMesh) instanced++; else if (o.isMesh) meshCount++; });
    return {
      orePlaced: picked.length,
      instancedMeshes: instanced,
      regularMeshes: meshCount,
      oreLayerCount: P.gfx.oreLayer ? P.gfx.oreLayer.count : -1,
      geometryCount: P.renderer.info.memory.geometries,
      callsBeforeRender: callsBefore,
      statsBefore: before,
    };
  })()`);
  console.log('矿石层：', JSON.stringify(report.ore));

  // 放矿之后重新量一次 draw call（等渲染几帧）
  await sleep(2500);
  report.perfWithOre = await evaluate(`(async () => {
    const { dc } = await window.__measureFrames(61);
    const d = dc.slice(3).sort((a, b) => a - b);
    return { drawCallsP50: d.length ? d[Math.floor(d.length / 2)] : -1, drawCallsMax: d[d.length - 1] ?? -1 };
  })()`);
  console.log('放矿后 draw call：', JSON.stringify(report.perfWithOre));

  // ── 截图 ──
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${FILE_PREFIX}-${name}.png`), Buffer.from(s.data, 'base64'));
  };
  const setRot = async (xDeg, yDeg) => {
    await evaluate(`(() => { const g = window.__PLANET__.planetGroup; g.rotation.x = ${xDeg}*Math.PI/180; g.rotation.y = ${yDeg}*Math.PI/180; g.updateMatrixWorld(true); return 1; })()`);
    await sleep(1400);
  };

  await setRot(0, 0);
  // 一律用 canvas 的实际矩形中心，不要假设 window.innerHeight 等于窗口高度
  const center = await evaluate(`(() => {
    const r = window.__PLANET__.renderer.domElement.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height, iw: window.innerWidth, ih: window.innerHeight };
  })()`);
  report.viewport = center;
  console.log('视口：', JSON.stringify(center));

  // 先清掉之前测试放的矿，保证干净截图（矿石单独出一张）
  await evaluate('window.__PLANET__.clearOres()');
  await evaluate('window.__PLANET__.select(-1)');
  await sleep(900);

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y, button: 'none' });
  await sleep(1200);
  await shot('ui-hover');

  // 真实指针点击路径：按下 + 抬起 → 应当选中「该点下方的图块」。
  // 特意偏离中心，这样选中项一定会变化，才能验证指针链路真的生效。
  const clickX = Math.round(center.x + center.w * 0.18);
  const clickY = Math.round(center.y - center.h * 0.14);
  const beforeClick = await evaluate('window.__PLANET__.getSelected()');
  const expected = await evaluate(`window.__PLANET__.pickTile(${clickX}, ${clickY})`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickX, y: clickY, button: 'none' });
  await sleep(400);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(900);
  const afterClick = await evaluate('window.__PLANET__.getSelected()');
  report.realClickPath = {
    clickPoint: [clickX, clickY],
    expectedTileFromPickTile: expected,
    beforeClick,
    afterClick,
    selectionChanged: afterClick !== beforeClick,
    matchesPickTile: afterClick === expected,
    works: afterClick >= 0 && afterClick === expected && afterClick !== beforeClick,
  };
  console.log('真实点击路径：', JSON.stringify(report.realClickPath));

  // 再点一次同一位置 → 保持选中（不误取消；取消要点击空白处）
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(700);
  const afterSecond = await evaluate('window.__PLANET__.getSelected()');
  report.clickAgain = { selectedAfterSecondClick: afterSecond, staysSelected: afterSecond === expected };
  console.log('再次点击同一格（应保持选中）：', JSON.stringify(report.clickAgain));

  // 点空白处（球体外）→ 取消选中
  const emptyX = 30, emptyY = center.h - 20;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: emptyX, y: emptyY, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: emptyX, y: emptyY, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(700);
  report.clickEmpty = { selectedAfterClickOnEmpty: await evaluate('window.__PLANET__.getSelected()') };
  console.log('点击空白处（应取消选中）：', JSON.stringify(report.clickEmpty));

  // ── 像素级证明：选中前后，被选中图块附近的像素必须真的变了 ──
  // 只改顶点色 + 局部上传是否真的生效、描边是否真的画出来了，只有像素说了算。
  const proof = await evaluate(`(() => {
    const P = window.__PLANET__;
    P.setHovered(-1);          // 排除悬停干扰，让两次截图的唯一差别就是"选中"
    P.select(-1);
    const rect = P.renderer.domElement.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    return { cx: Math.round(cx), cy: Math.round(cy), tile: P.pickTile(cx, cy) };
  })()`);
  const clip = { x: proof.cx - 40, y: proof.cy - 40, width: 80, height: 80, scale: 1 };
  await sleep(1500);
  const shotBefore = (await send('Page.captureScreenshot', { format: 'png', clip })).data;
  await evaluate(`window.__PLANET__.select(${proof.tile})`);
  await sleep(1500);
  const shotAfter = (await send('Page.captureScreenshot', { format: 'png', clip })).data;

  report.pixelProof = await evaluate(`(async () => {
    const load = (b64) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = 'data:image/png;base64,' + b64;
    });
    const a = await load(${JSON.stringify(shotBefore)});
    const b = await load(${JSON.stringify(shotAfter)});
    const cv = document.createElement('canvas');
    cv.width = a.width; cv.height = a.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(a, 0, 0);
    const da = ctx.getImageData(0, 0, cv.width, cv.height).data;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(b, 0, 0);
    const db = ctx.getImageData(0, 0, cv.width, cv.height).data;

    let changed = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        const i = (y * cv.width + x) * 4;
        const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
        if (d > 12) {
          changed++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    const px = (d, x, y) => { const i = (y * cv.width + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
    const cx = Math.round((cv.width - 1) / 2), cy = Math.round((cv.height - 1) / 2);
    return {
      crop: [cv.width, cv.height],
      changedPixels: changed,
      changedRatio: +(changed / (cv.width * cv.height)).toFixed(4),
      // 变化区域的包围盒，坐标相对裁剪框中心（中心即被选中图块的中心）
      changedBBoxRelCenter: [minX - cx, minY - cy, maxX - cx, maxY - cy],
      centerPixelBefore: px(da, cx, cy),
      centerPixelAfter: px(db, cx, cy),
    };
  })()`);
  report.pixelProof.tile = proof.tile;
  console.log('像素级证明：', JSON.stringify(report.pixelProof));
  fs.writeFileSync(path.join(OUT, 'pixel-diff-before.png'), Buffer.from(shotBefore, 'base64'));
  fs.writeFileSync(path.join(OUT, 'pixel-diff-after.png'), Buffer.from(shotAfter, 'base64'));

  // ── 截图：选中正对相机的图块，这样描边与高亮一定在画面正中 ──
  const centerTile = await evaluate(`window.__PLANET__.pickTile(${center.x}, ${center.y})`);
  await evaluate(`window.__PLANET__.select(${centerTile})`);
  await evaluate(`window.__PLANET__.setHovered(${centerTile})`);
  await sleep(900);
  report.screenshotState = {
    centerTile,
    selected: await evaluate('window.__PLANET__.getSelected()'),
    biome: await evaluate(`window.__PLANET__.tiles[${centerTile}].biome`),
  };
  console.log('截图状态：', JSON.stringify(report.screenshotState));
  await shot('selected-center');

  // 近景：检查 FrontSide 有没有露洞、六边形是否仍是纯色、白色描边是否清晰
  // 缩放是沿视线推近，画面中心始终对着同一块图块，所以选中格会留在正中
  for (let i = 0; i < 3; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY: -400 });
    await sleep(500);
  }
  await sleep(1800);
  await shot('close-selected');

  // 只留沙漠 + 草原（验证顶点色筛选，draw call 仍为 1）
  await evaluate(`window.__PLANET__.setVisibleBiomes(['desert','grassland'])`);
  await sleep(900);
  report.filteredStats = await evaluate('window.__PLANET__.stats()');
  await shot('desert-grassland');
  await evaluate(`window.__PLANET__.setVisibleBiomes(null)`);
  await sleep(900);

  // 矿石层：放一批矿，draw call 只 +1
  await evaluate(`(() => {
    const P = window.__PLANET__;
    let k = 0;
    for (let i = 0; i < P.tiles.length; i += 173) { P.setOre(i, (k++ % 3) + 1, 500); }
    return k;
  })()`);
  await sleep(1500);
  await shot('ore-markers');
  report.oreShotStats = await evaluate('window.__PLANET__.stats()');
  console.log('矿石截图后统计：', JSON.stringify(report.oreShotStats));
  await evaluate('window.__PLANET__.clearOres()');
  await sleep(600);
} else {
  // v1 基线：只做统计与截图
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `v1-${name}.png`), Buffer.from(s.data, 'base64'));
  };
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: -520 });
  await sleep(400);
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: -520 });
  await sleep(1800);
  await shot('close');
}

const jsonPath = path.join(ROOT, 'tools', 'out', `${TAG}-render.json`);
fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
console.log(`已写出 ${jsonPath}`);

ws.close(); child.kill(); await sleep(500);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { }
process.exit(0);
