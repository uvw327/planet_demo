# tools — 验证与调参脚本

这些是"评审驱动"开发流程用到的脚本：所有结论都必须能在实机（headless Chromium）里复现，
不靠肉眼判断。冻结阶段 A 时从临时目录归档进仓库，保证冻结点自洽。

## 环境要求

- Node.js 18+（用到内置 `fetch` 与 `WebSocket`）
- headless Chromium。默认路径写死在脚本里（Playwright 的 `chromium-1243`），
  换机器时用环境变量覆盖：

```powershell
$env:CHROME_PATH = 'C:\path\to\chrome.exe'
```

- 路径与页面都可以用 `PLANET_PAGE` 覆盖（默认按脚本位置推导到仓库根目录）。
- WebGL 走 SwiftShader 软件渲染，因此**截图较慢**（每张约 1–2 秒），请耐心等。

## 脚本清单

| 脚本 | 用途 | 用法 |
| --- | --- | --- |
| `shot-v1.mjs` | 复现 **v1 基线**的截图与全部统计（`docs/v1-shots/` 的来源，默认页面是 `archive/v1-biome-globe.html`） | `node tools/shot-v1.mjs v1` |
| `verify-render.mjs` | **渲染架构验收**：hook WebGL 数真实 draw call、量帧间隔、拾取往返、高亮像素级比对、矿石层、截图（`docs/render-shots/` 的来源）。同一脚本可跑 v1 做 A/B | `node tools/verify-render.mjs merged`<br>`$env:PLANET_PAGE='…\archive\v1-biome-globe.html'; node tools/verify-render.mjs v1` |
| `verify-stage-a.mjs` | **阶段 A 验收**：实机取数 + 多视角截图（`docs/stage-a-shots/` 的来源。⚠️ 这批截图是**旧地形**（陆地 62.87%）上的，勿覆盖） | `node tools/verify-stage-a.mjs` |
| `verify-terrain.mjs` | **地形地基 + H1 + 阶段 D 验收**：30 条断言（M1–M5 / 陆块结构 / 阶段 A 红线 / 渲染回归 / H1 覆盖层守卫 / 阶段 D 造山带与雪线）+ **v1 口径对照** + 4 视角截图 + 1 张 UI 截图（`docs/terrain-shots/` 的来源） | `node tools/verify-terrain.mjs` |
| `lab-terrain.mjs` | **地形调参实验室**：通用多轴扫描（`landFraction / continentScale / continentOctaves / detailOctaves / detailScale / continentWeight / elevationSpread`），页面内跑，不重建几何体 | `node tools/lab-terrain.mjs`<br>`node tools/lab-terrain.mjs --lf=0.38 --cs=1.0,1.2 --oct=2 --doct=2,3,4` |
| `shot-terrain.mjs` | **候选参数对比截图**：同一页面内切参数，每组截 4 个视角（`docs/terrain-shots/candidates/` 的来源） | `node tools/shot-terrain.mjs` |
| `lab-orogeny.mjs` | **造山带调参实验室**（阶段 D）：扫 `bands / width / mtn / gain / minLen / maxLen / peak* / tempSnow / elevationSpread`，输出山脉占比（M6）、**带形长宽比**（最小外接矩形，面积加权 + 最大分量）、长条覆盖面积占比、赤道雪峰数、红线回归，并自动跑一遍 **v1 口径对照** | `node tools/lab-orogeny.mjs`<br>`node tools/lab-orogeny.mjs --bands=4,5,6 --width=5,6 --mtn=0.35` |
| `shot-orogeny.mjs` | **阶段 D 截图**：全球 6 视角 + 「只显示山脉/雪峰」4 视角 + 2 个聚焦近景（`docs/orogeny-shots/` 的来源）。内置"背景色格数"探针，防止群系筛选没关掉就截图 | `node tools/shot-orogeny.mjs` |
| `lab-climate.mjs` | **调参实验室**：加载一次页面，在页面内扫 `CONFIG` 组合，输出对比表 | `node tools/lab-climate.mjs` |
| `table-check.mjs` | markdown 表格列数自检（改完文档跑一遍） | `node tools/table-check.mjs docs/v1-biome-globe-review.md` |

## ⚠️ 两个已经踩过的坑（新脚本请照抄防护）

1. **残留的 Chrome 会静默污染结果**。`child.kill()` 在 Windows 上只杀启动器、不杀子进程，
   残留的浏览器会继续占着调试端口并**响应**请求 —— 新脚本可能连到"内存里跑着旧 `index.html`"
   的那个浏览器上，量出一堆假数据（表现非常迷惑：数字自洽但完全不对）。
   现在 `lab-terrain.mjs` / `shot-terrain.mjs` / `verify-terrain.mjs` / `lab-orogeny.mjs` /
   `shot-orogeny.mjs` 都会：
   ① 先扫一段随机端口，只挑**没有任何浏览器在监听**的那个；② 连上后**断言页面状态**
   （`CONFIG.landFraction` 存在、`elevationCenter` 不存在、`riverWidth` 必须不存在、
   `orogenyBands` / `tempSnow` / `orogenyLandZ` 必须存在、`refresh()` 走 `recomputeTerrain()`），
   不对就直接报错退出。改脚本前先 `Get-Process chrome | Stop-Process -Force`。
2. **`tool/out/*.json` 不入库**（`.gitignore`），但文档里的每个数字都要能从它复现。
3. **群系筛选截图后必须 `setVisibleBiomes(null)` 恢复**，否则后续截图全废
   （`shot-orogeny.mjs` 因此内置了"背景色格数"探针，>3000 就打警告）。
   另外，`setVisibleBiomes()` 与随后的 `setHovered()` 之间如果没有渲染帧，
   旧代码会**丢掉整段颜色上传**（只传被悬停的那一格）→ 画面里星球会"消失"。
   这个 bug 已在阶段 D 修掉（`fullRepaintPending` 标记），但新脚本仍建议
   "改完颜色 → 等一帧 → 再截图"。

## 关键前提：`window.__PLANET__`

`index.html` 的 `init()` 末尾挂了一个出口，分三类：

```js
window.__PLANET__ = {
  /* 业务数据层（纯 JS，渲染层不感知） */
  tiles, world,                       // world = { ore, oreAmount, owner, hydro }
  /* 渲染层句柄 */
  scene, camera, renderer, controls, planetGroup, gfx,
  buildTimings,                       // 生成耗时（纯算法）：{ level, tiles, triangles, terrainMs, geometryMs, totalMs }
  /* 渲染 → 业务的映射表 */
  triToTile, tileVertStart, tileVertCount,
  /* 拾取与选中 */
  pickTile, select, setHovered, getSelected, getHovered,
  /* 矿石（演示"加资源不增加 draw call"） */
  setOre, clearOres,
  /* 覆盖层（★ H1 起与「气候群系」分层，见 docs/river-system-design.md §3.2） */
  hydro,                              // () => world.hydro，H1 为 null，H2 起有水文数据
  setVisibleOverlays, overlays,       // (['river']) / (['ore']) / (null = 全部恢复)
  /* 顶点色 */
  repaintTile, repaintAll, setVisibleBiomes,
  /* 调参 */
  refresh,                            // 重跑整条地形链「海拔 → 气候 → 群系 → 顶点色」，返回新的群系计数
  stats,                              // draw call / 三角形 / 几何体数 / Mesh 数
};
```

因为地形 / 气候 / 分类都是纯函数（只依赖 `CONFIG` 与图块数据），所以改完 `CONFIG` 直接调
`__PLANET__.refresh()` 就能看到新结果，**不必重建几何体、也不必重载页面**。
调参时每次重载约 1 分钟，这个出口能省掉绝大部分等待。对正常浏览无任何影响。

⚠️ **`CONFIG.level` 现在是 6**（图块 **40962** / 三角形 **245760**，间距约 1.0°）。
脚本里**别写死图块数 / 三角形数 / 边数**：level → level+1 这些量都 ×4。
当前值：图块 40962、三角形 245760、邻接边 122880、顶点 286722、生成耗时约 175 ms。
想读真数用 `__PLANET__.buildTimings`（见上表），或看控制台启动日志。
"比例型"指标（陆地占比、山脉占比…）与 level 无关；"计数型"指标（赤道雪峰格数…）会 ×4。

⚠️ **`refresh()` 现在包含海拔**（地形地基之后）。改前它只重跑"气候 → 群系"，
所以"改 `landFraction` 再 `refresh()`"根本不会生效。现在它调 `recomputeTerrain()`，
与 `init()` **共用同一份实现**。之所以能这么放心地重算海拔，是因为默认
`enableHeightOffset === false` 时**海拔不参与顶点坐标**（球面恒为半径 1），
所以换地形参数不需要重建几何体 —— 这正是 `lab-terrain.mjs` 能在一次加载里扫几十组的原因。
（例外：H3 的河网是**独立几何体**，改水文参数必须重建它，见设计书 §10.3。）

⚠️ 重构后整颗星球只有 **1 个 Mesh**，所以**不能再逐格切 `visible`**（旧的 `t.mesh.visible = …`
写法会直接报错）。要做"只留某几个群系"的对比截图，改用
`__PLANET__.setVisibleBiomes(['desert','grassland'])`（传 `null` 恢复全部）——
它靠改顶点色实现，draw call 仍是 1。

⚠️ **`river` 已不是一个群系**（H1 起改为「覆盖层」）。`BIOME.RIVER` / `CONFIG.riverWidth` /
`tile.river` 都已删除；按群系筛河流的写法会静默筛掉一切。水文要看 `__PLANET__.hydro()`。

⚠️ **OrbitControls 的滚轮缩放是累积的**。一次会话里连拍多个"远 → 近"镜头时，
必须在每组镜头开始前把相机距离复位（`camera.position.setLength(初始距离)` +
`controls.update()`），否则第二组的"-far"截图其实是"-near"视角。
`shot-orogeny.mjs` 的 `resetZoom()` 就是干这个的（阶段 D 修过一次）。

⚠️ 阶段 D 起 `tile` 多了 **`orogeny`** 字段（造山带强度 ∈ [0,1]），且**山地判据不再是海拔阈值**：
`orogeny >= CONFIG.orogenyMountain`。雪峰由**温度**判定（`temperature < CONFIG.tempSnow`）。
`CONFIG.SNOW_LEVEL` / `MOUNTAIN_LEVEL` 已删除 —— 用旧口径量山地会得到完全不同的数。

⚠️ **别用 `Select-Object -First N` 去截这些脚本的输出。** PowerShell 会在第 N 行之后
停止读取管道，但**不会立刻杀掉 node**：它会带着自己的 headless Chrome 继续在后台跑完，
与下一条命令的实例**并发写同一批 PNG/JSON**，于是截图被后写的一方覆盖成半成品
（曾经出现 `terrain-090.png` 只剩 3.8 KB 的全黑图）。要么让输出完整打印，
要么重定向到文件（`node tools/x.mjs *> $env:TEMP\x.log`）。
`verify-terrain.mjs` 已加**体积哨兵**：PNG < 12 KB 会打印 `⚠ … 星球可能不在画面里`。

`archive/v1-biome-globe.html`（v1 基线快照）**没有**这个出口，所以 `shot-v1.mjs` 只能用
`Array.prototype.push` 钩子从 `Mesh.userData.tile` 反向取图块，并靠对象去重
（`tileMeshes.push` 与 `planetGroup.add` 会各 push 一次同一个 mesh）。

## 输出位置

- `shot-v1.mjs` → `docs/v1-shots/`
- `verify-render.mjs` → `docs/render-shots/`（v1 模式写 `docs/render-shots/v1-baseline-*.png`，
  **不要**写进 `docs/v1-shots/`，那是 v1 归档证据；tag 非 `v1`/`merged` 时前缀是
  `render-<tag>`，例如 `node tools/verify-render.mjs l6` → `render-l6-*.png`，**不覆盖**归档轮）
- `verify-stage-a.mjs` → `docs/stage-a-shots/`（旧地形上的历史证据，勿覆盖）
- `verify-terrain.mjs` → `docs/terrain-shots/`（`terrain-*.png` + `terrain-stats.json`）
- `shot-terrain.mjs` → `docs/terrain-shots/candidates/`
- `shot-orogeny.mjs` → `docs/orogeny-shots/`（全球 6 + 山地隔离 4 + 聚焦 6）
- `verify-render.mjs` / `lab-climate.mjs` / `lab-terrain.mjs` / `shot-terrain.mjs` / `lab-orogeny.mjs` / `shot-orogeny.mjs` → `tools/out/*.json`（`tools/out/` 不入库）
