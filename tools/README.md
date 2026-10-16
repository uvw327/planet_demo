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
| `verify-terrain.mjs` | **地形地基验收**：17 条断言（M1–M5 / 陆块结构 / 阶段 A 红线 / 渲染回归）+ 4 视角截图（`docs/terrain-shots/` 的来源） | `node tools/verify-terrain.mjs` |
| `lab-terrain.mjs` | **地形调参实验室**：通用多轴扫描（`landFraction / continentScale / continentOctaves / detailOctaves / detailScale / continentWeight / elevationSpread`），页面内跑，不重建几何体 | `node tools/lab-terrain.mjs`<br>`node tools/lab-terrain.mjs --lf=0.38 --cs=1.0,1.2 --oct=2 --doct=2,3,4` |
| `shot-terrain.mjs` | **候选参数对比截图**：同一页面内切参数，每组截 4 个视角（`docs/terrain-shots/candidates/` 的来源） | `node tools/shot-terrain.mjs` |
| `lab-climate.mjs` | **调参实验室**：加载一次页面，在页面内扫 `CONFIG` 组合，输出对比表 | `node tools/lab-climate.mjs` |
| `table-check.mjs` | markdown 表格列数自检（改完文档跑一遍） | `node tools/table-check.mjs docs/v1-biome-globe-review.md` |

## ⚠️ 两个已经踩过的坑（新脚本请照抄防护）

1. **残留的 Chrome 会静默污染结果**。`child.kill()` 在 Windows 上只杀启动器、不杀子进程，
   残留的浏览器会继续占着调试端口并**响应**请求 —— 新脚本可能连到"内存里跑着旧 `index.html`"
   的那个浏览器上，量出一堆假数据（表现非常迷惑：数字自洽但完全不对）。
   现在 `lab-terrain.mjs` / `shot-terrain.mjs` / `verify-terrain.mjs` 都会：
   ① 先扫一段随机端口，只挑**没有任何浏览器在监听**的那个；② 连上后**断言页面状态**
   （`CONFIG.landFraction` 存在、`elevationCenter` 不存在、`refresh()` 走 `recomputeTerrain()`），
   不对就直接报错退出。改脚本前先 `Get-Process chrome | Stop-Process -Force`。
2. **`tool/out/*.json` 不入库**（`.gitignore`），但文档里的每个数字都要能从它复现。

## 关键前提：`window.__PLANET__`

`index.html` 的 `init()` 末尾挂了一个出口，分三类：

```js
window.__PLANET__ = {
  /* 业务数据层（纯 JS，渲染层不感知） */
  tiles, world,                       // world = { ore, oreAmount, owner }
  /* 渲染层句柄 */
  scene, camera, renderer, controls, planetGroup, gfx,
  /* 渲染 → 业务的映射表 */
  triToTile, tileVertStart, tileVertCount,
  /* 拾取与选中 */
  pickTile, select, setHovered, getSelected, getHovered,
  /* 矿石（演示"加资源不增加 draw call"） */
  setOre, clearOres,
  /* 顶点色 */
  repaintTile, repaintAll, setVisibleBiomes,
  /* 调参 */
  refresh,                            // 重跑整条地形链「海拔 → 河流 → 气候 → 群系 → 顶点色」，返回新的群系计数
  stats,                              // draw call / 三角形 / 几何体数 / Mesh 数
};
```

因为地形 / 河流 / 气候 / 分类都是纯函数（只依赖 `CONFIG` 与图块数据），所以改完 `CONFIG` 直接调
`__PLANET__.refresh()` 就能看到新结果，**不必重建几何体、也不必重载页面**。
调参时每次重载约 1 分钟，这个出口能省掉绝大部分等待。对正常浏览无任何影响。

⚠️ **`refresh()` 现在包含海拔**（地形地基之后）。改前它只重跑"河流 → 气候 → 群系"，
所以"改 `landFraction` 再 `refresh()`"根本不会生效。现在它调 `recomputeTerrain()`，
与 `init()` **共用同一份实现**。之所以能这么放心地重算海拔，是因为默认
`enableHeightOffset === false` 时**海拔不参与顶点坐标**（球面恒为半径 1），
所以换地形参数不需要重建几何体 —— 这正是 `lab-terrain.mjs` 能在一次加载里扫几十组的原因。

⚠️ 重构后整颗星球只有 **1 个 Mesh**，所以**不能再逐格切 `visible`**（旧的 `t.mesh.visible = …`
写法会直接报错）。要做"只留某几个群系"的对比截图，改用
`__PLANET__.setVisibleBiomes(['desert','grassland'])`（传 `null` 恢复全部）——
它靠改顶点色实现，draw call 仍是 1。

`archive/v1-biome-globe.html`（v1 基线快照）**没有**这个出口，所以 `shot-v1.mjs` 只能用
`Array.prototype.push` 钩子从 `Mesh.userData.tile` 反向取图块，并靠对象去重
（`tileMeshes.push` 与 `planetGroup.add` 会各 push 一次同一个 mesh）。

## 输出位置

- `shot-v1.mjs` → `docs/v1-shots/`
- `verify-render.mjs` → `docs/render-shots/`（v1 模式写 `docs/render-shots/v1-baseline-*.png`，
  **不要**写进 `docs/v1-shots/`，那是 v1 归档证据）
- `verify-stage-a.mjs` → `docs/stage-a-shots/`（旧地形上的历史证据，勿覆盖）
- `verify-terrain.mjs` → `docs/terrain-shots/`（`terrain-*.png` + `terrain-stats.json`）
- `shot-terrain.mjs` → `docs/terrain-shots/candidates/`
- `verify-render.mjs` / `lab-climate.mjs` / `lab-terrain.mjs` / `shot-terrain.mjs` → `tools/out/*.json`（`tools/out/` 不入库）
