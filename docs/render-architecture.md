# 渲染架构重构：从 10242 个 Mesh 到 1 个 Mesh

> 目标：干掉手机端的卡顿。根因是 draw call 爆炸，不是面数。
> 本文档记录改造方案、`triToTile` 映射的建立方式、全部取舍理由，以及同环境 A/B 实测数据。
>
> **当前状态（2026-10-16 更新）**：`CONFIG.level` 已由用户从 **5 上调到 6**
> （图块 10242 → **40962**，三角形 61440 → **245760**），手机真机实测流畅。
> 本文档 §2.1 的 A/B 表是 **level 5 当时**的记录（保留原样），§2.2 给出两个 level 的对照。

---

## 0. 一句话结论

**每帧 draw call 从 10243 降到 2。** 星球主体是 1 个 `Mesh`，群系用顶点色表达，
拾取走 `faceIndex → triToTile`，高亮/选中只改顶点色的一个小区间（72~84 字节）且**不新建任何 Mesh**，
矿石走 `InstancedMesh`。所有验收项都有实机数据，见 §1。

---

## 1. 验收对照

| 验收项 | 要求 | 实测 | 结论 |
| --- | --- | --- | --- |
| 星球主体 Mesh 数 | 1（含高亮 ≤ 3） | `meshCount = 1`（默认态；放矿后才出现第 2 个 InstancedMesh） | ✅ |
| 运行时 draw call | ≤ 5 | 默认 **2**（星球 1 + 星空 Points 1）；放矿 + 选中后 **4** | ✅ |
| 手机 60fps / 30fps 无卡顿 | — | draw call 瓶颈已消除（§2.3）；**真机已确认**：用户在手机端实测 level **6**（245760 三角形，是本次重构时 level 5 的 **4 倍**）**流畅** | ✅ |
| 点击六边形正确选中 | faceIndex → tileIndex 准确 | 拾取往返 **92/92 = 100%**；真实指针链路点击 → 选中同一图块 | ✅ |
| 悬停/选中不产生新 Mesh | 除 1 个可复用高亮 | `meshCountBefore = meshCountAfter = 1`；描边是 1 个全局复用的 `LineLoop` | ✅ |
| 各群系颜色正确（顶点色） | 通过顶点色 | 每格内部颜色完全一致（`perTileSolidColor = true`）、无跨格共享顶点 | ✅ |
| 保持 Level 5 面数、球体平滑 | 不减少面数 | 10242 图块 / 61440 三角形不变；法线为球面解析法线（单位长度校验通过）。**后来还上调到 level 6**（40962 图块 / 245760 三角形），面数只增不减 | ✅ |
| 新增矿石不显著增加 draw call | 用 InstancedMesh | 512 容量 1 个 `InstancedMesh`，无论多少矿 **只 +1** | ✅ |
| **禁止**减少面数 | — | 未动 | ✅ |
| **禁止**保留每面一个 Mesh | — | 已全部删除 | ✅ |
| **禁止**按群系拆材质 | — | 只有 1 份材质，靠顶点色区分 | ✅ |

---

## 2. 实测数据

### 2.1 同环境 A/B（headless Chromium + SwiftShader，同一台机、同一脚本）

`tools/verify-render.mjs` 直接 hook WebGL 的 `drawElements/drawArrays/drawElementsInstanced/drawArraysInstanced`
统计**真实** draw call（不是靠代码推断）：

| | v1 基线（`archive/v1-biome-globe.html`） | 重构后（`index.html`） | 变化 |
| --- | --- | --- | --- |
| draw call / 帧（p50） | **10243** | **2** | ↓ 5121× |
| draw call / 帧（max） | 10243 | 2 | — |
| 帧间隔 p50 | 116.7 ms（8.6 fps） | 50.0 ms（20 fps） | ↓ 2.34× |
| 帧间隔 max | 399.9 ms | 200.2 ms | — |
| 三角形 / 帧 | 61440（但被拆成 10242 次提交） | 61440（1 次提交） | — |

10243 = 10242 个图块 Mesh + 1 个星空 `Points`，与"draw call 数 = Mesh 数"的推断完全吻合。

### 2.2 几何与内存

> 下表同时给出 **level 5**（重构当时的值）与 **level 6**（当前值）。
> 所有量都随 `level` 增长，`level → level+1` 大致 **×4**（每个三角形细分成 4 个）。
> 唯一**不随 level 变化**的是 draw call —— 这正是这次重构的要点。

| 项目 | level 5（重构当时） | level 6（当前） |
| --- | --- | --- |
| 图块 | 10242（12 五边形 + 10230 六边形） | **40962**（12 五边形 + 40950 六边形） |
| 三角形 | 61440 | **245760** |
| 顶点（图块内共享扇心） | **71682** | **286722** |
| 顶点（完全不共享） | 184320（共享扇心省下 61.1%） | 737280（省下 61.1%） |
| 索引 | 184320 个，**必须 `Uint32Array`**（顶点数 71682 > 65535） | 737280 个，`Uint32Array` |
| 缓冲总占用 | position / normal / color 各 840 KB + index 720 KB ≈ **3.2 MB** | 各 ≈ 3.4 MB + index ≈ 2.9 MB ≈ **13 MB** |
| 材质数 | 1 | 1 |
| draw call / 帧 | 2 | **2**（不变） |
| 图块间距 | ≈ 2.0° | ≈ **1.0°** |

> 顶点数 > 65535 只能走 `Uint32` 索引。WebGL2 原生支持，不需要 `OES_element_index_uint` 扩展，
> 所以这里没有兼容性风险；但如果哪天要退回 WebGL1，这一条必须先处理。

### 2.3 关于「手机 60fps」这条验收

**已由用户真机确认（level 6）。** 证据分层：

1. **draw call 这个瓶颈已经实打实地消除了**（10243 → 2，见 §2.1）。这是"每帧 2 万次 draw call
   把手机 CPU 拖死"的直接根因，也是本次改造的全部目标。
2. **剩下的是填充率与顶点量**：level 5 是 61440 个三角形、3.2 MB 缓冲；**用户把 level 上调到 6
   （245760 三角形、约 13 MB 缓冲，是重构当时的 4 倍）之后，手机端实测依然流畅** ——
   这比重构当时需要证明的更强。另已按验收要求做了 `setPixelRatio(Math.min(dpr, 2))`、
   关闭阴影与后处理、`stencil: false`、材质 `FrontSide`（背面剔除，既省填充率也让射线少测一半三角形）。

上表里的帧时间来自 **SwiftShader 软件光栅化器**，它按 CPU 逐像素算，跟手机 GPU 完全不可比，
所以只能用来做"前后对比"，不能当作手机帧率 —— 手机端的结论以上面第 2 条（用户实测）为准。
**注意**：`docs/terrain-shots/terrain-stats.json` 里的 `render.triangles` 现在是 level 6 的
**245760**，与 §2.1 表里的 61440（level 5 的 A/B 记录）不是同一个 level，别混用。

### 2.4 level 6 再验证（2026-10-16，`node tools/verify-render.mjs l6`）

用户把 `CONFIG.level` 从 5 上调到 6 之后，用**同一个 WebGL hook**（不是靠代码推断）
重新量了一轮。tag 用 `l6`，所以截图前缀是 `render-l6-*`，**不会覆盖** merged 那一轮的归档图。

| 验收项 | level 5（§2.1） | **level 6** | 结论 |
| --- | --- | --- | --- |
| draw call / 帧（p50，WebGL hook） | 2 | **2** | ✅ 与图块数无关，这条没变 |
| 渲染三角形 | 61440 | **245760** | — |
| Mesh 数 | 1 | **1** | ✅ |
| 图块数 | 10242 | **40962** | — |
| 顶点数 | 71682 | **286722** | — |
| 索引类型 | `Uint32Array` | **`Uint32Array`** | ✅ |
| 几何一致性（`badTriangles`） | 0 | **0** | ✅ |
| 每格纯色 / 无勾缝 / 法线单位长 | 全 true | **全 true** | ✅ |
| 拾取往返 | 92/92 | **369/369 = 100%** | ✅ 抽样量加大到 4 倍仍零误差 |
| 高亮/选中不新建 Mesh | 是 | **是**（`noNewMesh`、`lineLoopCount 1`、`usesPartialUpload`） | ✅ |
| 放矿 draw call | 2 → 4 | **2 → 4**（1 个 InstancedMesh） | ✅ 只 +1 |
| 真实指针点击链路 | 通过 | **通过**（`afterClick === pickTile`、二次点击保持、点空白取消） | ✅ |
| 帧间隔 p50（SwiftShader 软件光栅） | 50.0 ms | **83.3 ms** | 软件渲染变慢是预期的（三角形 ×4）；手机 GPU 结论见 §2.3 |

> **★ H3 起（2026-10-17）：上表有两行换了新值。** 河网是**独立覆盖层**
> （独立几何体 + 独立材质，见 `docs/river-system-design.md` §5），所以星球场景从
> draw call 2 / Mesh 1 变成 **draw call 3 / Mesh 2**（星空 + 星球 + 河网），
> 渲染三角形 245760 → **264278**（河网 18518）。两条红线**都没破**：
> draw call 3 ≤ 20；"星球主体合并成 1 个 Mesh"仍然成立 —— 河网是**覆盖层**，
> 不是星球主体的一部分（口径改为"`meshCount − 覆盖层数 === 1`"）。
> 放矿 draw call 现在是 **3 → 5**（河网 +1、矿石 `InstancedMesh` +1）。
> `render-l6-*.png` 这批图已按 H3 重新生成（画面里能看见河了）。

> **★ H4 起（2026-10-17）：一行都没变，而且这次是"设计对了"的证据。**
> 湖泊 / 内流盆地 / 盐湖是**面**，所以走**顶点色**（`docs/river-system-design.md` §3.2），
> **不加层**：draw call 仍是 **3**、Mesh 仍是 **2**、`perTileSolidColor` 仍为真。
> 唯一变的是渲染三角形 264278 → **260912** —— 河网几何体小了
> （湖面格不画河线，M38：18518 → 15152 三角形）。
> 想自己验"湖面真的走顶点色"：`setVisibleBiomes(['__lake__'])` 能把它刷掉，
> 而河网（独立几何体）刷不掉 —— 见 `docs/river-shots/lake-only-a000.png`。

> **★ H4.5 起（2026-10-17）：同样一行都没变。** H4.5 是**纯数据层**改动
> （内流盆地格的 MFD 出边清零 → 重算 `accum` / `down` / 河网提取），渲染层只是跟着
> `rebuildRivers()` 重跑一次 —— 还是 1 个覆盖层 Mesh，draw call **3**、Mesh **2**。
> 渲染三角形 260912 → **260084**（河网 15152 → **14324**：少掉的 828 个就是不再画的
> 幽灵出湖河）。开关对照图 `docs/river-shots/sink-off.png` → `sink-on.png`。

> 顺带记录一个数据：`naiveFloorDiv6WrongTriangles = 245745 / 245760 = 99.994%` ——
> 用 `Math.floor(faceIndex / 6)` 反推图块在 level 6 下**几乎全错**（12 个五边形只有 5 个三角形，
> 会把这之后的偏移全部错位）。这正是必须显式维护 `triToTile` 的原因。

**证据**：`docs/render-shots/render-l6-{ui-hover,selected-center,close-selected,desert-grassland,ore-markers}.png`；
明细 `tools/out/l6-render.json`（不入库）。

---

## 3. 架构分层

```
业务数据层（纯 JS，渲染层不感知）
  tiles[]       每格：center / elevation / orogeny / latitude / temperature / moisture / biome / vertices
  world{}       ore（矿种）/ oreAmount（储量）/ owner（归属）/ hydro（水文，H2 起）
       │
       │  唯一的桥：三张索引表
       ▼
映射层
  triToTile[T]          三角形序号 → 图块序号      （拾取；T = 三角形数，level 6 是 245760）
  tileVertStart/Count   图块 → 顶点区间            （改色/高亮/描边）
  tileIndexStart        图块 → 索引区间            （调试）
       │
       ▼
渲染层
  gfx.mesh      1 个 Mesh（合并几何体 + 1 份顶点色材质）
  gfx.outline   1 个复用的 LineLoop（选中描边，首次选中时才创建）
  gfx.oreLayer  1 个 InstancedMesh（首次放矿时才创建）
```

将来加矿石、出生地、势力归属，**只动业务数据层**；渲染层只按"有了就画"的规则读它。
`world.ore` 等数组与 `tiles` 都是普通 JS 数组/定型数组，序列化存档不依赖任何 three 对象。

---

## 4. 重点：`triToTile` 是怎么建立的

### 4.1 建立过程（`buildPlanetGeometry()`）

按图块顺序**逐格写入**，写的过程中顺手把映射记下来：

```js
let vo = 0, io = 0, to = 0;
for (let ti = 0; ti < nTiles; ti++) {
  const tile = tiles[ti], verts = tile.vertices, n = verts.length;

  tileVertStart[ti] = vo;          // 这一格的顶点从哪开始
  tileVertCount[ti] = n + 1;       // 扇心 + n 个环顶点
  tileIndexStart[ti] = io;

  // …写入扇心 + n 个环顶点…

  for (let i = 0; i < n; i++) {
    indices[io++] = base;                       // 扇心
    indices[io++] = base + 1 + i;               // 环顶点 i
    indices[io++] = base + 1 + ((i + 1) % n);   // 环顶点 i+1
    triToTile[to++] = ti;                       // ★ 三角形序号 → 图块序号
  }
  vo += n + 1;
}
```

关键就一行：`triToTile[to++] = ti`。因为索引是严格按"图块 0 的 n 个三角形 → 图块 1 的 n 个三角形 → …"
的顺序写入的，所以 `triToTile` 天然是一串**升序游程**，长度等于三角形总数（level 6 = 245760）。

### 4.2 拾取时怎么用

```js
raycaster.setFromCamera(pointerNDC, camera);
const hits = raycaster.intersectObject(gfx.mesh, false);
const faceIndex = hits[0].faceIndex;      // three 给的三角形序号
const tileIndex = gfx.triToTile[faceIndex];
```

three r160 里，索引化几何体的 `faceIndex` 定义是
`intersection.faceIndex = Math.floor(i / 3)`（`i` 是索引缓冲里的偏移，注释原文为
"triangle number in indexed buffer semantics"），也就是**索引缓冲里的三角形序号**，
正好和 `triToTile` 的写入顺序一一对应。

### 4.3 为什么不能偷懒写 `Math.floor(faceIndex / 6)`

因为 **12 个五边形每个只有 5 个三角形，六边形有 6 个**，三角形序号到图块序号不是等距的。

本星球上，`buildDual()` 按原网格顶点下标顺序生成对偶多边形，而 `buildIcosahedron()` 先把 12 个
原始顶点放在下标 0~11，细分产生的新顶点追加在后面 —— 所以**图块 0~11 正好就是那 12 个五边形**
（`firstTwelveTilesArePentagons: true`，实测确认）。

于是 `faceIndex = 5` 时，`Math.floor(5 / 6) = 0`，但它其实已经是图块 1 的第一个三角形了。
之后每经过一个五边形，整体偏移再 +1。

实测这个"偷懒写法"错得有多离谱：

| 指标 | 数值 |
| --- | --- |
| `Math.floor(faceIndex / 6)` 落错图块的三角形 | level 5：**61425 / 61440 = 99.98%**｜level 6：**245745 / 245760 = 99.994%** |
| 落对的三角形 | 15 |

也就是说：**除了最开头几个三角形，整个星球的拾取都会错**，而且错得"看起来挺正常"
（选中的是邻近图块），是最难查的那类 bug。所以 `triToTile` 这张表不是"更严谨的写法"，
而是唯一正确的做法。

### 4.4 代价

一张 `Uint32Array(T)`（T = 三角形数；level 6 是 245760 → 约 **960 KB**），一次构建，之后每帧只读。

---

## 5. 顶点布局：为什么共享扇心、但不跨图块共享

每个图块用「1 个扇心 + n 个环顶点、n 个三角形」的**索引化扇形**：

- 六边形：7 个顶点 + 18 个索引（不共享要 18 个顶点）
- 五边形：6 个顶点 + 15 个索引

**为什么只在图块内部共享**：跨图块共享顶点意味着相邻图块共用同一个顶点，而一个顶点只能有
一个颜色，相邻群系之间就必然出现"顶点色插值渐变"——这会毁掉本星球"每一格一个纯色"的设计语言。
只在图块内部共享扇心，是保持每格纯色的前提下能拿到的最优解（省 61% 顶点）。

**合并后的几何体仍然无缝隙**：环顶点的坐标是从 `renderPos` 同一批 `Vector3` 实例逐位复制过来的，
所以相邻图块的公共边坐标完全相同。这条有专门的校验（`seamFree: true`，逐顶点与 `Float32Array`
舍入后的源坐标比对）。

**法线**：直接取 `position.normalize()`，也就是球面的解析法线，比 `computeVertexNormals()`
的逐面平均更平滑（后者会在球面上带出网格状的细微起伏）。当前材质是 `MeshBasicMaterial`
（完全不受光照），法线并不参与着色；保留它是为了将来换成光照材质时球面依然平滑、不出棱角。

**背面剔除**：环序由 `buildDual()` 保证从球外看是逆时针，所以材质用 `FrontSide`。
v1 用的是 `DoubleSide`（防御性），这里必须换成 `FrontSide` —— 既省一半填充率，
又让 `Raycaster` 按 `material.side` 跳过背面三角形，拾取快一倍。近景截图已确认无空洞。

---

## 6. 高亮 / 选中 / 描边：不新建 Mesh

### 6.1 高亮 = 改顶点色，而且只上传动过的那一段

```js
function repaintTile(ti) {
  computeTileColor(ti, scratchColor);              // 群系本色 + 悬停/选中提亮
  const start = gfx.tileVertStart[ti];
  const count = gfx.tileVertCount[ti];             // 6 或 7 个顶点
  for (let i = start; i < start + count; i++) { /* 写 3 个 float */ }
  attr.addUpdateRange(start * 3, count * 3);       // ★ 只标记这一小段为脏
  attr.needsUpdate = true;
}
```

一次高亮改 **18~21 个 float（72~84 字节）**，而不是重传整个 0.86 MB 的颜色缓冲。
这是"高亮不新建 Mesh"能近乎零成本的关键。

`addUpdateRange()` 是 three r159+ 的 API（本项目锁 0.160.0），
`WebGLAttributes.update()` 里会对每个区间做一次 `gl.bufferSubData` 区间上传，然后
`clearUpdateRanges()`。已在源码层确认过，并且代码里做了 `typeof` 兜底：
老版本 three 会退化成整体上传，**结果依然正确**，只是慢一点。

### 6.2 描边 = 整颗星球只有 1 个可复用的 LineLoop

切选中项时只改它的顶点坐标（6 个环顶点沿半径外扩 1.004，避开 z-fighting），
不新建对象；没有选中项时 `visible = false`，连那次 draw call 都不花。
将来放"矿石/出生地标记"是同一套路。

描边刻意用**白色**而非选中色：选中色已经把格子内部染成青蓝，同色描边等于没有描边。

### 6.3 像素级证明（不是"我觉得能看见"）

在正对相机的图块位置裁 80×80 截两张图（选中前 / 选中后），逐像素比对：

| 指标 | 数值 |
| --- | --- |
| 变化的像素 | **182**（占裁剪框 2.84%） |
| 变化区域包围盒（相对图块中心） | `x ∈ [-8, 7]`、`y ∈ [-9, 4]` → 正好一个约 16 px 的六边形 |
| 中心像素 选中前 → 选中后 | `[122,122,122]`（山脉灰）→ `[134,189,209]`（青蓝） |
| 选中前后 Mesh 数 | 1 → 1（不变） |

结论：局部上传真的生效了、描边和提亮都真的画出来了、而且**只影响被选中的那一格**。

---

## 7. 交互（含触屏）

- **悬停**：仅鼠标（`pointerType === 'mouse'`）。触屏没有"悬停"概念，整条悬停拾取链路
  在触屏上被直接短路——这省掉了触屏上最贵的一笔开销。
- **点选**：按下 → 抬起之间位移 ≤ 8 px 且时长 ≤ 700 ms 才算"点选"，否则视为拖动旋转
  （`OrbitControls` 在监听同一批事件，必须区分）。
- **取消选中**：点击球体外的空白处。点同一格保持选中（避免误取消）。
- 拾取请求合并到动画循环里执行（`needsPick` 标志），避免 `pointermove` 事件风暴。
- 顺手修了一个真实 bug：`#hint`（左下角操作提示）没有 `pointer-events: none`，
  会挡住画布，导致左下角那一条区域点不中图块。

---

## 8. 矿石层：验证"加资源不增加 draw call"

`setOre(tileIndex, typeId, amount)` 只写业务数组，渲染侧同步到**一个** `InstancedMesh`：

- 容量 512，共用 1 份几何体 + 1 份材质；矿种用 `instanceColor` 区分颜色
  （所以"多矿种"也不会变成多材质、多 draw call）。
- 没矿时 `visible = false`、`count = 0`，连那 1 次 draw call 都不花。
- **懒创建**：`setOre()` 第一次被调用时才 `new InstancedMesh`，所以默认态场景里
  星球主体就是 1 个 Mesh，不会因为"演示用"多出一个对象。

实测：放 40 份矿后 draw call 4 = 星球 1 + 星空 1 + 描边 1 + 矿石 1。

---

## 9. 取舍清单（以及为什么）

| # | 取舍 | 选择 | 理由 |
| --- | --- | --- | --- |
| 1 | 是否用 `BufferGeometryUtils.mergeGeometries` | **不用，直接写定型数组** | `mergeGeometries` 要求先造出 10242 个 `BufferGeometry` 再合并——1 万多个临时对象 + 一次大拷贝，初始化的内存峰值和 GC 抖动都很难看。这里一个循环直接把坐标写进 `Float32Array`，顺带就拿到了 `triToTile` 和每格顶点区间。**产物与 `mergeGeometries` 等价**（1 个 Mesh、1 份材质、无分组），想换回去只需改 `buildPlanetGeometry()` 一个函数。 |
| 2 | 是否合并后共享顶点 | **只在图块内共享扇心** | 跨图块共享会引入顶点色插值渐变，破坏"每格纯色"的设计语言（这是之前走过弯路的地方）。见 §5。 |
| 3 | 是否保留 `normals` 属性 | **保留**（840 KB） | 当前材质不受光照，法线不参与着色，所以它现在**不产生任何视觉收益**——纯粹是为将来换光照材质预留，换来的是"球面平滑不出棱角"。如果你要极致省内存，删掉 `geometry.setAttribute('normal', …)` 一行即可。 |
| 4 | 材质 `side` | `FrontSide`（v1 是 `DoubleSide`） | 环序自洽，背面永远被自身遮住；省一半填充率 + 拾取少测一半三角形。已用近景截图确认无空洞。 |
| 5 | 高亮方式 | 改顶点色 + 区间上传 | 验收要求"悬停/选中不产生新 Mesh"，这是唯一能做到 0 新增对象的方案。 |
| 6 | 描边 | 1 个复用 `LineLoop` | 1 次 draw call，且 `linewidth` 在多数平台无效，所以只求"有一圈清晰的边"，不求粗细。若想要更粗/发光的选中环，把同一个复用槽换成一圈四边形带即可（仍是 1 次 draw call）。 |
| 7 | 是否上 BVH 加速拾取 | **不上** | 只有 1 个 Mesh，三角形数随 level 变（level 5 是 61440、level 6 是 245760），`Raycaster` 先做包围球剔除、再按 `FrontSide` 剔一半。实测 level 5 抽样 92 次、level 6 抽样 **369 次**拾取，均零误差、零卡顿。加 `three-mesh-bvh` 是引入依赖换一个目前不需要的性能。 |
| 8 | 群系筛选（调试用） | 改顶点色刷背景色 | 只有 1 个 Mesh，没法逐格 `visible`。`setVisibleBiomes()` 用顶点色实现，draw call 仍是 1。 |

---

## 10. 复现方式

```powershell
# 重构后（合并版）：性能统计 + 功能断言 + 截图
node tools/verify-render.mjs merged

# v1 基线（无 __PLANET__，只跑 draw call / 帧率 / 截图）
$env:PLANET_PAGE = 'D:\workspace\dev\planet_demo\archive\v1-biome-globe.html'
node tools/verify-render.mjs v1
```

输出：

- `docs/render-shots/` —— `selected-center`、`close-selected`、`desert-grassland`、`ore-markers` 等截图
  以及 `pixel-diff-before/after.png`（像素级证明的原始裁剪图）
- `tools/out/merged-render.json` / `tools/out/v1-render.json` —— 全部原始数据（本文档所有数字的来源）
- `docs/stage-a-shots/` —— 阶段 A 的截图与统计（重建后仍然可复现，见 `tools/verify-stage-a.mjs`）

---

## 11. 遗留与下一步

1. **真机帧率未验**。draw call 瓶颈已消除，但手机 60fps 这条要在真机上确认（见 §2.3）。
2. **拾取是暴力求交**。当前够用；若将来图块密度提到 level 6（40962 格 / 245760 三角形），
   建议此时再上 BVH。
3. **`enableHeightOffset` 仍是 `false`**。开启后顶点半径不再相等，届时：
   `seamFree` 校验要改成按共享顶点引用比对；描边的 1.004 外扩也要改成沿法线外推。
   已在代码注释里标注。
4. 渲染架构与自然模型（阶段 B/C/D）互不干扰：本文档只改渲染层与交互层，
   **群系分布、气候、河流一行未动**，阶段 A 的全部结论（`docs/v1-biome-globe-review.md` §3 P0-1）
   依然成立。
