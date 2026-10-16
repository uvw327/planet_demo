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
| `verify-stage-a.mjs` | **阶段 A 验收**：实机取数 + 多视角截图（`docs/stage-a-shots/` 的来源） | `node tools/verify-stage-a.mjs` |
| `lab-climate.mjs` | **调参实验室**：加载一次页面，在页面内扫 `CONFIG` 组合，输出对比表 | `node tools/lab-climate.mjs` |
| `table-check.mjs` | markdown 表格列数自检（改完文档跑一遍） | `node tools/table-check.mjs docs/v1-biome-globe-review.md` |

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
  refresh,                            // 重跑「河流 → 气候 → 群系 → 顶点色」，返回新的群系计数
  stats,                              // draw call / 三角形 / 几何体数 / Mesh 数
};
```

因为河流 / 气候 / 分类都是纯函数（只依赖 `CONFIG` 与图块数据），所以改完 `CONFIG` 直接调
`__PLANET__.refresh()` 就能看到新结果，**不必重建几何体、也不必重载页面**。
调参时每次重载约 1 分钟，这个出口能省掉绝大部分等待。对正常浏览无任何影响。

⚠️ 重构后整颗星球只有 **1 个 Mesh**，所以**不能再逐格切 `visible`**（旧的 `t.mesh.visible = …`
写法会直接报错）。要做"只留某几个群系"的对比截图，改用
`__PLANET__.setVisibleBiomes(['desert','grassland'])`（传 `null` 恢复全部）——
它靠改顶点色实现，draw call 仍是 1。

`archive/v1-biome-globe.html`（v1 基线快照）**没有**这个出口，所以 `shot-v1.mjs` 只能用
`Array.prototype.push` 钩子从 `Mesh.userData.tile` 反向取图块，并靠对象去重
（`tileMeshes.push` 与 `planetGroup.add` 会各 push 一次同一个 mesh）。

## 输出位置

- `shot-v1.mjs` → `docs/v1-shots/`
- `verify-render.mjs` → `docs/render-shots/`（v1 模式写 `docs/v1-shots/`）
- `verify-stage-a.mjs` → `docs/stage-a-shots/`
- `verify-render.mjs` / `lab-climate.mjs` → `tools/out/*.json`（`tools/out/` 不入库）
