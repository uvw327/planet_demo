# 球面地形生成与手绘渲染改造规划（HTML 原型版）

> 版本：v3.1（**M3 交互与导出**：hover / 选中轮廓、拾取信息面板、导出 JSON、性能剖面）
> 目标产物：单个可直接在浏览器打开的 `index.html`（Three.js）
> 参考实现：Red Blob Games `mapgen4`（`D:\workspace\ref\mapgen4`）
> 上位文档：`docs/goldberg-planet-plan.md`（v1.5，本版在此基础上做算法与渲染的实质性改造）
> 进度：M1 地形因果链 ✅ · M2 手绘风格渲染 ✅ · **M2.5 大陆尺度重做 ✅** · M3 交互与导出 ✅
>
> **v3.1 一句话**：把「只能看」的原型变成「能摸」的原型 —— 鼠标悬停 / 点击拾取任意一格，
> 用**独立 `LineLoop`** 描出该格的 dual 六（五）边形轮廓（**不改几何体**，`planetMesh`
> 永远 1 个 draw call），HUD 显示海拔 / 温度 / 降雨 / 流量 / **汇水面积** / 群系 / 湖 / 内流 /
> 大陆掩码 / 下游格；一键导出 `CONFIG + 统计 + 群系分布 + 分位` 的 JSON 供 Godot 端做数值对照。
>
> **v3.0 一句话**：M2 的地形在 level 5 下是「迷宫型」群岛（孤立划 18.3%、最长河链 6 格），
> 看不出「大陆」也没有「长河」。M2.5 引入**大陆掩码**（低频包络只当掩码、**不加进海拔**，
> 在 z-score **之后**才偏移），把世界改造成 **1 块超级大陆 + 大西洋式大洋 + 内陆海**，
> 河网变成真正的**树状长河**（最长链 16、河段 873、孤立划 8.1%）。
> 河流缎带同时从「一段一个直 quad」升级为**二次 Bezier 平滑带**（消除闪电折角）。
> ⚠️ 本次改动**推翻了 M2 的一个核心做法**，教训写在 §2.3.1 与 §2.6.1，务必先读。

---

## 0. 一页速览

| 项 | 结论 | 状态 |
|---|---|---|
| 网格 | 继续用 Goldberg 球（icosphere 细分），默认 `level = 5`（10242 region / 30722 地形顶点 + 墨线 + 河流 / **3 draw call**；悬停时 +1 个轮廓对象） | ✅ M3 |
| 算法 | 照搬 mapgen4 的「因果链」：海拔 → 山脉 → 温度 → 风 → 降雨 → 下坡 → 湖泊 → 流量 → 生物群系。一步不改语义，只做球面化（额外产出 `area` = 上游汇水面积） | ✅ M2 |
| **大陆** | ★ **M2.5 新增**：低频包络 FBM 只当 **`T.continent` 掩码**（**不加进海拔**），在 z-score **之后**用 `dz = −oceanDepth·(1−C)` 压低大洋。这样大陆内部保留原始分形起伏 → 排水是**树状**而不是「从海岸向内的平行直棍」 | ✅ M2.5 |
| 渲染 | **方案 A**（顶点色 + CPU 烘焙光照）+ **三个几何层**：地形 / 墨线（海岸 + 湖岸合并）/ 河流缎带，明确不用片元着色器 | ✅ M2 |
| 光照 | 逐顶点 **map 式 hillshade**（固定罗盘方位 + 45° 天顶角，用切平面梯度计算），**不含晨昏线**，与几何起伏完全解耦 | ✅ M2 |
| 唯一接口 | `paletteAt(elev, temp, moist) → [r,g,b]`，算法层与渲染层之间只此一条缝 | ✅ M1 |
| 气候 | **陆面蒸发**（`landEvaporation` / `landSaturation`）+ **中纬风暴带**（`stormTrack`）两项；后者是「赤道湿 / 副热带干 / 中纬次湿 / 极地干」四带成立的必要条件 | ✅ M2.5 |
| 湖泊 | mapgen4 全仓 grep `lake` **零命中**；改用 **priority-flood 填平量** `filled − elevation` 作为湖深，并额外产出 `isEndorheic`（内流盆地）字段。★ `lakeMinDepth` 是湖/河质量第一旋钮 | ✅ M2.5（132 格 = 1.29% 全格 / 1.90% 陆地） |
| 河网 | 两级门槛 **`area ≥ 5 & flow ≥ 0.10`**（拓扑 + 水量）。★ M2.5 把缎带改成**二次 Bezier 平滑中心线**（K=3 子段），消除六边形网格的 120° 硬折角（「闪电感」） | ✅ M2.5（873 段 / 孤立划 8.1% / 最长链 16） |
| 求解器 | 降雨迭代默认 **Gauss-Seidel + 纬向气候学暖启动**（实测 12 次收敛）；Jacobi 与单向风保留为调试选项 | ✅ M1 |
| **交互** | ★ **M3 新增**：hover / 点击拾取任意格 → **独立 `LineLoop`** 描 dual 轮廓（抬高 `hoverLift = 0.014`），**不改几何体**；HUD 显示 11 项逐格数据；Esc 取消选中 | ✅ M3 |
| **导出** | ★ **M3 新增**：一键导出 JSON（`meta + config + stats + biomeCounts + quantiles + timingMs`），**不含任何 THREE 对象**，Godot 端可直接对照断言 | ✅ M3 |
| 分层 | L0 core / L1 mesh / L2 terrain / L3 draw / L4 app，**L0–L3 零 Three.js 依赖、可逐函数翻译成 GDScript** | ✅ M2 |
| 性能 | level 5 全因果链 **~90 ms**（浏览器内首次生成 ~570–660 ms）。用户要的 1–2 s 门槛余量 10 倍以上 | ✅ M2.5 实测 |
| 里程碑 | M1 因果链灰阶验证 → M2 手绘渲染 → **M2.5 大陆尺度重做** → **M3 交互与导出** | M1 / M2 / M2.5 / M3 全部完成 |

**当前交付物**：`D:\workspace\dev\planet_demo\index.html`（单文件 **121 KB**，浏览器直接打开）。
含 `CONFIG` + L0–L4 + **20 个原生滑杆 / 1 数字框 / 2 下拉 / 1 导出按钮 / 6 视图按钮** 面板 + HUD，
**无构建步骤**。纯算法层可整体抽出做 headless 验证（`m1-test.mjs`，**93 项断言**，level 4/5 均通过）。

**归档（每里程碑一份，可回退对照）**：

| 文件 | 里程碑 | 大小 |
|---|---|---|
| `archive/v1-biome-globe.html` | v1 旧版（解析气候 + 每图块一个纯色 mesh） | 39 KB |
| `archive/v2-m2-handdrawn.html` | M2 手绘渲染（迷宫型群岛） | 97 KB |
| `archive/v3-m3-interactive.html` | **M3 交互与导出（当前）** | **119 KB** |

**当前默认世界（level 5 · seed 1337）**：陆地 67.8%（6944 格）· 单块超级大陆（最大块 99.8%）
· 大洋 32.2% · 湖泊 132 格 · 内流盆地 118 格 · 河段 873 · 孤立划 8.1% · 最长河链 16 格
· 到海平均 4.6 格 · 干旱陆地 22.7%。

> ⚠️ **v3.0 推翻了 M2 的两条做法，先看这两条再读后面**：
> 1. **不能把包络加进海拔**（§2.3.1）——会造出「光滑穹顶大陆」，内部起伏被包络淹没，
>    排水退化成从海岸向内的平行直棍。
> 2. **不能抬大陆**（§2.4.1）——`landRelief` 与 `lapseRate` 会把全球降温，
>    表现为「干旱陆地暴跌」，那是**变冷**不是变湿。改为**只压低大洋**。

---

## 1. 参考实现（mapgen4）关键结论

这一节是上一轮通读 `mapgen4` 源码后的结论沉淀，后面的改造全部建立在它之上。

### 1.1 数据与拓扑

- `mapgen4` 是**半边网格**，核心对象 `mesh` 来自 `dual-mesh/index.ts`。
- **`r`（region）= 网格顶点**，**`t`（triangle）= 网格面**。即：`r` 是「地块」，`t` 是「地块之间的接缝」。
- 关键访问器：`r_begin_s(s)`（半边 s 的起点 region）、`s_opposite_s(s)`（对侧半边）、`t_inner_s(s)`（半边所在三角形）、`r_around_t(t, i)`、`is_boundary_r(r)`、`length_s(s)`。
- **球面 icosphere 的对偶结构与 mapgen4 同构**：region 度数恒为 5 或 6（正方体映射的 icosphere 恰有 12 个五边形），`t` 是三角形。所以 mapgen4 里对 `r`/`t` 做的一切，在 Goldberg 球上都能原样跑。

### 1.2 因果链（`map.ts`）

```
assignTriangleElevation / assignRegionElevation   ← 噪声 + 大陆掩码 + 山脉脊线增强
        ↓
calculateMountainDistance                         ← Poisson-disk 峰点 + BFS 距离场
        ↓
assignRainfall                                    ← 沿风向排序 + 一遍扫描 + 雨影
        ↓
assignDownslope / assignRivers                    ← 下坡方向
        ↓
assignMoisture / assignFlow                       ← 反向遍历 t_order 累积流量
```

- **`calculateMountainDistance`**：`generate-points.ts` 的 `choosePoints()` 用 Poisson-disk 撒峰点（间距 `mountainSpacing`），再对每个地块算 BFS 距离场，`mountain` = 距离归一化后的值。
- **山脉脊线增强**（`painting.ts`）：`Math.max(e, Math.min(e*3, mountain))`，把山脉从噪声背景里「提」出来。
- **`mountain_folds` 降谷**（`geometry.ts` / 参数）：`elev = (1 - folds*sqrt(max(0,e)))*e`，让山体两侧凹陷，视觉上形成山脊。
- **`assignRainfall`**：`wind_sort_r[r] = x*cos(windAngle) + y*sin(windAngle)` 做**全局排序**，构成 DAG，**一遍扫描即收敛**（`humidity[r] = clamp(humidity[r] + raininess*(humidity[prev] - humidity[r]), 0, 1)` 之类）。
- **`assignFlow`**：**必须反向遍历 `t_order`（叶 → 根）**。实测：写成正序遍历，`maxFlow = 0.000`；反向遍历正确值为 15.07（球面 level 5）。
- **`MIN_FLOW = exp(2.7) ≈ 14.9`**（`map.ts` 里 `riverThreshold` 的默认基准）是针对它那张 25k 格、单一大陆的平面图调的。**球面上不适用**，实测球面 `maxFlow` 只有 15.07，阈值须降到 `2.0`（实测对应 ~2.7% 陆地成河）。

### 1.3 风与雨在球面上的根本差别

mapgen4 的风是**全局单一风向角**，标量投影后天然是一个**无环的偏序**，所以一遍扫描就收敛。

**球面上做不到**：纬向风带（三圈环流）是旋度非零的环流场，**无法构造 DAG**，因此必须迭代松弛。实测：纯 mapgen4 的「均匀风 + 地形雨影」在球面上按纬度统计降雨几乎全平（0.68–0.89），**沙漠带根本造不出来**。

结论（实测数据见 §12）：

- 风必须按**纬度分带**（信风 / 西风 / 极地东风）。
- 更关键的是：**海洋蒸发潜力必须 ∝ 温度**，且要显式加入**副热带下沉脱湿**。加上这两项后，降雨才有 **62.2%** 的方差能被纬度解释（剩下 37.8% 是地形/海陆贡献的，即雨影与内陆干旱），并造出「赤道 0.248 → 副热带 0.043 → 中纬 0.062 → 高纬 0.102」这条链。

### 1.4 渲染（`render.ts` / `geometry.ts` / `colormap.ts`）

mapgen4 的手绘感**不是**来自噪声纹理，全部来自这 5 件事：

1. **不规则网格 + 四边形折叠**：`setMapGeometry` 对每个 quad（两个相对半边）在两条对角线之间二选一——「水边 或 有河流经过」时折向山谷，否则折向山脊。
2. **`mountain_folds` 降谷**（见 1.2）。
3. **高度场漫反射**：`light = ambient + max(0, dot(L, N))`，`L` 是固定方向光。
4. **深度不连续描边**：`frag_final` 用深度差做乘法压暗，形成墨线。
5. **最终半像素 blit**：轻微模糊，柔化锯齿。

源码里 `// TODO: add noise texture based on biome` 明确证实**纸纹/噪点当年没做**。**mapgen4 没有湖泊，没有生物群系枚举，没有等高线，没有脊线**。

**生物群系**完全由 `colormap.ts` 的 64×64 二维查表决定：

- 采样坐标 `vec2(z, v_em.y)` = **`z` 是海拔、`y` 是降雨**。**完全没有温度这一维。**
- 深海：`rgb = (48 + 48e, 64 + 64e, 127 + 127e)`（按深度渐变）。
- 陆地：`m = m*(1-e)`，`(r,g,b) = (210-100m, 185-45m, 139-45m)`，再 `color = 255*e + color*(1-e)` 淡出到白（高海拔 → 白）。
- 海岸 3 条亮蓝浅水带位于 `x = width/2 - 1, 2, 3`，即 `(48,120,160) / (48,100,150) / (48,80,140)`。

> 我们要做的两处**有意偏离**：① `mapgen4` 无温度 → 扩展成三轴 palette；② `mapgen4` 无湖泊 → 用 priority-flood 填平量补上。

### 1.5 球面不需要的 hack

`mapgen4.ts` 里 `projection[9] = 1` 的 **oblique projection** 是它那张平面图的透视技巧，**球面上既不需要也不可移植**，直接丢弃。

---

## 2. 算法改造：从「分类」到「因果链」

现状（v1）是**分类模型**：给定纬度算温度、算湿度、查表得生物群系——各地块彼此独立，没有因果关系，所以看不到雨影、看不到河流汇流、看不到「山决定河、河决定谷」。

本次改为**因果链模型**：每一步的输入是上一步的输出，最终所有视觉特征都是因果产物。

### 2.1 因果链总览

```
                        ┌─────────────────────────────┐
                        │ 0. 网格：icosphere → dual   │  L1
                        │    r = 地块（5/6 度）        │
                        │    t = 接缝三角形            │
                        │    neighbors[] 邻接表        │
                        └──────────────┬──────────────┘
                                       │
         ┌─────────────────────────────▼─────────────────────────────┐
         │ 1. 海拔 assignElevation                                    │  L2
         │    基础 FBM 噪声 e0                                        │
         │  + 大陆掩码（低频包络，★ 不加进海拔，M2.5 §2.3.1）         │
         │  + 山脉脊线增强 max(e, min(e*3, mountain))                 │
         │  → 全局 z-score → 掩码偏移 dz → elevation ∈ [−1,1]         │
         └──────────────┬────────────────────────────────────────────┘
                        │
   ┌────────────────────▼────────────────────┐
   │ 2. 山脉放置 placeMountainPeaks           │  L2
   │    Poisson-disk 撒峰点（球面距离）        │
   │  + mountainDistanceField（球面 BFS）      │
   │  → mountainDist[i], mountain[i] ∈ [0,1]  │
   └────────────────────┬────────────────────┘
                        │
   ┌────────────────────▼────────────────────┐
   │ 3. 温度 assignTemperature                │  L2
   │    T = √(1-y²) − landRelief · lapseRate  │
   │    （y = 单位向量的 y 分量 = sin 纬度）    │
   └────────────────────┬────────────────────┘
                        │
   ┌────────────────────▼────────────────────┐
   │ 4. 风场 assignWind                       │  L2
   │    zonal：按纬度取三圈环流方向            │
   │    uniform：全局单向（调试）              │
   │  → wind[i] = [x,y,z] 单位切向向量         │
   └────────────────────┬────────────────────┘
                        │
   ┌────────────────────▼────────────────────┐
   │ 5. 降雨 solveRainfall（迭代松弛）         │  L2
   │    humidity[target] =                       │
   │      clamp(rainfall[src] − landRelief·shadow) │
   │    源汇：海洋蒸发 ∝ 温度 − 副热带下沉       │
   │    暖启动：先跑一遍纬向气候学解            │
   │    求解器：Gauss-Seidel（默认）/ Jacobi    │
   │  → rainfall[i], moisture[i] ∈ [0,1]      │
   └────────────────────┬────────────────────┘
                        │
   ┌────────────────────▼────────────────────┐
   │ 6. 下坡 priorityFlood                    │  L2
   │    种子 = 海洋格（elevation ≤ seaLevel）   │
   │    最小堆按 elevation 扩展                 │
   │  → downslope[i]（流向哪个邻居）            │
   │  → filled[i]（填平后高程）                 │
   │  → floodOrder[]（叶→根）                   │
   └────────────────────┬────────────────────┘
                        │
   ┌────────────────────▼────────────────────┐
   │ 7. 湖泊 detectLakes                      │  L2
   │    lakeDepth = filled − elevation         │
   │    > lakeMinDepth → 湖                     │
   │    waterLevel = filled                    │
   │    isEndorheic = 流域平均降雨 < 阈值        │
   └────────────────────┬────────────────────┘
                        │
   ┌────────────────────▼────────────────────┐
   │ 8. 流量 accumulateFlow                   │  L2
   │    反向遍历 floodOrder（叶→根）            │
   │    flow[downslope[i]] += flow[i]          │
   │    ★ 正序遍历会得到错误结果（实测 0.6 vs 4.07）│
   └────────────────────┬────────────────────┘
                        │
   ┌────────────────────▼────────────────────┐
   │ 9. 生物群系 classifyBiome                │  L2
   │    海洋/海冰 > 雪峰 > 山脉 > 冰原 > 湖泊    │
   │    > 河流 > 温度带 > 湿度带                │
   └────────────────────┬────────────────────┘
                        │
   ┌────────────────────▼────────────────────┐
   │ 10. 渲染 paletteAt(elev, temp, moist)     │  L3 ★唯一接口
   └─────────────────────────────────────────┘
```

### 2.2 网格与邻接表（L1）

**保持 Goldberg 球，不换不规则 Delaunay。** 理由：

1. 与 mapgen4 的 `r`/`t` 对偶结构**同构**——mapgen4 的写法可以逐行照搬。
2. 度数有界（5 或 6），邻接表可以用 `Int32Array` 定长或短变长存储，**GDScript 里也好写**。
3. 六边形网格上 quad 折叠（§3.3）同样成立。
4. 球面 Delaunay/Voronoi 的移植成本高，而在 Godot 里没有任何额外收益。
5. 顺带把 draw call 从现在的 **10242 个降到 1 个**。

`buildDual` 的产物：

| 字段 | 含义 |
|---|---|
| `triCenters[t]` | 每个原三角形 = 一个 dual 顶点（region 的中心） |
| `regionTris[r]` | 绕 region `r` 一圈的三角形索引（5 或 6 个，环序） |
| `triAcross[3t+i]` | 半边 `(a→b)` 的对侧三角形索引（`-1` 表示边界） |
| `dirEdge[A*nR+B]` | 模块级哈希，有向边 → 所属三角形，用于求对侧 |

**邻接表** `buildNeighbors`：对每个 `r`，收集 `regionTris[r]` 里所有三角形的全部顶点再减去 `r` 自身。度数实测恒为 5 或 6，`Σdeg = 2E` 精确成立（§12）。

> ⚠️ 邻接表用 `Set` 去重，**插入顺序依赖 `regionTris[r]` 的环序**，而环序是确定性的，所以同种子结果完全一致。但仍要补一条显式排序（按邻居索引升序）来杜绝任何引擎差异。

### 2.3 海拔与山脉（L2 · 步 1–2）

海拔被拆成**两个独立函数**，因为中间要插一步「山脉距离场」：

- `assignElevation(T, cfg, rng)` —— 步 1：只算基础地形
- `placeMountainPeaks` + `mountainDistanceField` —— 步 2：撒峰点 + 距离场 → `T.mountain`
- `applyMountainRidge(T, cfg)` —— 步 3：脊线抬升 + z-score 标准化

**① `assignElevation`（步 1）—— 地貌 + 大陆掩码：**

```
e  = 0.5 + 0.9 · FBM_base(center · noiseScale)             ← 丘陵（分形，保留全部起伏）
e += detailAmp · FBM_detail(center · detailScale)          ← 细节粗糙度（制造封闭洼地 → 湖泊）
elevationRaw = e

env = FBM_cont(center · continentScale)                    ← ★ 低频包络，**只写进 T.continent，不进海拔**
mz  = smoothstep(bias−band, bias+band, (env − mean(env)) / sd(env))   ← 用「标准差单位」过阈值
C   = 1 − continentAmp · (1 − mz)                          ← 掩码 ∈ [0,1]；amp=0 → C≡1（关闭）
```

**② `applyMountainRidge`（步 3）—— 脊线抬升 → z-score → 掩码偏移：**

```
ridgeN = 1 − |FBM_ridge(center · ridgeScale)|               ← ridged multifractal
lift   = (mountainSharpness/10) · mountain^1.4 · (ridgeAmp · ridgeN² + 0.10)
a      = elevationRaw + lift
z      = (a − mean(a)) / sd(a)                              ← 全局 z-score
dz     = continentLandLift·C − oceanDepth·(1 − C)           ← ★ 掩码只在 z-score **之后**出手
elev   = clamp(elevationCenter + z · elevationSpread + dz, −1, 1)
```

- 沿用 v1 验证过的 **z-score 标准化**（`elevationCenter = 0.40` / `elevationSpread = 0.19`），
  让「陆地占比」与 `mountainSharpness` **解耦**：拖 `mountainSharpness` 只改山的相对高度，不改海陆比例。
- `mountainSharpness` 默认 **9.8**，内部 `/10` 归一成 `0.98`。面板范围 6–14。
- ★ **海拔下界是 −1 而不是 0**：掩码把大洋压到海平面以下，若仍 `clamp(e, 0, 1)`，
  则 `seaLevel < 0` 时**全球都会变成陆地**（掩码的海洋被 clamp 吃掉）。这是一个真实踩到的 bug。

#### 2.3.1 ★★ 大陆掩码：为什么「包络不能加进海拔」（v3.0 核心教训）

**第一版做法（已否决）**：`elevationRaw += continentAmp · env`，即把低频包络**加进**海拔。
z-score 之后，大陆确实成块了（陆地 66.9% / 最大块 99.3%），但**排水彻底废了**：

- 包络幅度 2.2 : 基础地形幅度 0.9 ≈ **2.4 : 1**，大陆内部变成一座**光滑穹顶**，
  局部起伏被包络淹没（梯度方向由包络主导）。
- 于是 `downslope` 全部指向「离海岸最近的方向」→ 河流变成**从海岸向内的平行直棍**，
  没有分叉、没有支流（`shots/fin-close-a0.png`、`shots/fin-river-only.png` 实测）。
- 这正是 mapgen4 里 `elevation.island = 0.5` 那种「岛屿衰减」在**大尺度**上的翻版：
  岛屿衰减把地形压成碗，而碗里只能有放射状排水。

**v3.0 做法 = 大陆掩码（continent mask）**：包络**不加进海拔**，只当掩码；
z-score **之后**才用 `dz` 偏移。两者在数学上的差别只有「谁先谁后」，但效果相反：

| | 包络加进海拔（旧） | z-score 后掩码（新） |
|---|---|---|
| 大陆内部起伏 | 被包络淹没（2.4:1） | **保留原始分形**（梯度仍由 base FBM 主导） |
| 排水形态 | 从海岸向内的**平行直棍** | **树状分叉**（有干流、有支流、有汇流） |
| 最长河链 | 6 格 | **16 格** |
| 孤立划占比 | 18.3%（M2 迷宫型） | **8.1%** |

**掩码阈值用「标准差单位」表达**（`bias` / `band` 是 σ 而不是绝对幅度）：
先求包络全局 `mean / sd`，再 `mz = smoothstep(bias−band, bias+band, (env−mean)/sd)`。
好处是 `continentBias` / `continentBand` 的含义**与噪声幅度无关** → 可复现、可移植到 Godot。

**`continentAmp` 语义 = 0–1 的强度混合**：`C = 1 − amp·(1 − mz)`。
- `amp = 0` → `C ≡ 1` → `dz = 0` → **完全回到 M2 的迷宫型世界**（这是 A/B 对照用的「关闭」档）。
- `amp = 1` → 满强度。
- 早期 bug：`amp = 0` 时仍加了 `continentLandLift`，已修（`dz` 与 `C` 同时受 `amp` 管辖）。

#### 2.3.2 ★ 为什么海岸线不会「又变成迷宫」

掩码的**过渡带**（`band` 宽度）本身会形成一个「陆地占比 ≈ 50%」的环带 ——
如果海岸线由「z-score 阈值」决定，这个环带就会再次退化成**临界渗透迷宫**（M2 的毛病）。

解法是**把 `oceanDepth` 调大**，让海岸线由**掩码等值线**主导而不是 z 阈值主导：

```
陆地 ⟺ z > (seaLevel − center + oceanDepth·(1−C)) / spread
```

`oceanDepth = 0.80` 时，过渡带中段（`C ≈ 0.5`）需要 `z` 极高才可能是陆地
→ 过渡带几乎全是大洋陆架 → **海岸线 = 掩码等值线 + 少量 z 抖动**，既有分形感又不断成群岛。
实测：`oceanDepth` 0.35 → 0.80 → 1.30 时，块数 5 → 8 → 1（陆地占比恒定在 ~76%），
地理指标几乎不变，但 **`oceanDepth` 太大会把整个大洋压成均匀「深海」**（丢掉大陆架层次）。
默认取 **0.80**：地理质量与水深层次兼顾。

> `continentLandLift` 默认 **0.0**（永远不用），原因见 §2.4.1。

> ⚠️ **为什么必须单独加 `detailScale` / `detailAmp` 这一层**（§8.4 案例三）：
> 早期公式是 `e = 0.58·(FBM·0.72+0.5) + 0.42·(1−|FBM|)`。
> 在 `FBM > 0` 的区间里两项斜率几乎抵消（`0.4176·b − 0.42·|b| ≈ −0.0024·b`），
> 结果是**大片近乎水平的平台**。平台上 `filled[j] = max(elev[j], filled[c])`
> 退化成 `filled = elevation` → **99% 的陆地填平量精确为 0 → 全图只有 2 个湖**。
> 现在基础地形改成纯平滑 FBM（不再有 `1−|FBM|` 的退化），
> 粗糙度由**独立的细节层**提供，脊线只在 `mountain` 权重高的地方叠加。

**山脉放置**（`placeMountainPeaks` + `mountainDistanceField`）：照搬 mapgen4 的 `generate-points.ts#choosePoints`。

- Poisson-disk 在**球面上**撒点：拒绝判据用**球面距离** `acos(dot(a,b))`，最小间距 `mountainSpacing = 0.280`；`mountainDensity` 是候选点保留概率（默认 1.0 = 全保留，密度只由间距决定）。
- 每个峰点带一个强度 `peak[i]`（由噪声决定），距离场按强度做**加权 BFS**。
- `mountain[r] = 1 − clamp(dist[r] / mountainWidth, 0, 1)`，再乘 `peak`；
  实测 level 5 撒出 **109 个峰点**，`mountain` 覆盖 65.5% 的格子（max 0.858）。
- **本期不做 `painting.ts` 那种可涂画约束**（用户已确认）。BFS 用**最小堆**（按累积代价），保证山峰是「最近的最强峰」。`MinHeap` 是 L0 提供的通用结构（priority-flood 也复用它）。

### 2.4 温度（补充 1）

```
y          = center[i].y                       // 单位向量 → y = sin(纬度)
latFactor  = sqrt(max(0, 1 − y*y))             // = cos(纬度)
landRelief = clamp((elevation − seaLevel) / (1 − seaLevel), 0, 1)
temperature = clamp(latFactor − landRelief * lapseRate + tempJitter * noise, 0, 1)
```

- `lapseRate` 默认 **0.6**（用户指定），走 `CONFIG.terrain.lapseRate`。
- 关键点：用 **`landRelief`（陆地相对高度）** 而不是绝对海拔。海平面下的格子的温度只由纬度决定，否则深海会被算成极寒，海冰带会长得很怪。
- `tempJitter` 默认 0.05，很小，只为打散等温线的规整感；同一噪声种子下确定。

效果：**沙漠不会跑到极地**（极地 `latFactor` 已经≈0，再叠 `lapseRate` 只会更冷）；**雪峰会出现在赤道高山上**（赤道 `latFactor = 1`，海拔给足就能扣到冰点以下）。两条都符合现实直觉。

#### 2.4.1 ★ `landRelief` 与 `seaLevel` 强耦合（v3.0 教训之二）

`landRelief = (elevation − seaLevel) / (1 − seaLevel)` 这条式子让 `seaLevel` 同时进入**五处**语义：

| 位置 | 用途 |
|---|---|
| `assignTemperature` | 直减率的相对高度基准 |
| `solveRainfall` | `oneMS = 1/(1−s)`，降雨的「陆地容量」归一 |
| `waterColorAt` / `classifyBiome` | `deepWaterDepth` 判深海、雨影判据 |
| `paletteAt` | 陆地色阶 `(e−s)/(1−s)` |
| `vertexRadius` | `k = reliefScale/(1−s)`，贴花层抬升比例 |

**教训：不要抬大陆（`continentLandLift > 0`）**。早期想用「抬大陆」把大陆做出来，
参数 `lift = 0.45` 时实测：`landRelief` 整体变大 → 直减率把**全球降温**
→ 赤道温度只剩 ~0.55 → 「干旱陆地」从 ~12% 掉到 5%。

看起来像「变湿了」，其实是**变冷了**（副热带温度跌破 `tempTropical`，沙漠带被判定成稀树草原）。
所以 v3.0 默认 **`continentLandLift = 0.0`**，改为**只把大洋压低**（`oceanDepth`）
并用**很低的 `seaLevel`**（默认 0.20）当「陆地占比主旋钮」。

> **如果将来坚持要抬大陆**，备选解法是新增 `T.elevationBase`（**不带掩码**的 z-score 值）
> 专供 `assignTemperature` 算 `landRelief`，把直减率与掩码解耦。**尚未实现**。

另：`seaLevel` 从 M2 的 0.40 降到 0.20 后，`1 − seaLevel` 从 0.60 变成 0.80，
上面五处的数值都会跟着变——**降 `seaLevel` 之后必须重新目视检查配色与雪线**（本轮已做）。

### 2.5 风场（L2 · 步 4）

`CONFIG.terrain.windMode = 'zonal' | 'uniform'`，**默认 `zonal`**。

**`zonal`（默认）——三圈环流：**

| 纬度带 | 风向 | 说明 |
|---|---|---|
| 0°–30° | 东风（自东向西） | 信风带 |
| 30°–60° | 西风（自西向东） | 盛行西风 |
| 60°–90° | 东风（自东向西） | 极地东风 |

实现：按 `y` 分量查带，取该带的**经度方向切向量**再加一点经向分量，最后**投影到该点的切平面并归一化**：

```js
// [Godot-ready] 纯算法
function assignWind(T, cfg) {
  for (let i = 0; i < T.n; i++) {
    const n = T.center[i];                      // 单位球面法线
    const lat = Math.asin(clamp(n[1], -1, 1));  // 弧度
    let dir;
    if (cfg.windMode === 'uniform') {
      dir = cfg.windUniformDir;                 // 全局单向（调试用）
    } else {
      const band = zonalBandFactor(lat);        // ∈ [-1,1]，正 = 向东
      const east = v3Norm(v3Cross(UP, n));      // 该点的东向
      const north = v3Norm(v3Cross(n, east));   // 该点的北向
      // 额外掺一点经向分量（Hadley 环流的经向漂移），让雨影更有机感
      dir = v3Norm(v3Add(v3Mul(east, band), v3Mul(north, cfg.windMeridional * meridionalSign(lat))));
    }
    // 投影到切平面并归一化 —— 风必须贴着球面吹
    T.wind[i] = v3Norm(v3Sub(dir, v3Mul(n, v3Dot(dir, n))));
  }
}
```

- `windMeridional` 默认 0.25（信风带略微向赤道偏、西风带略微向极偏）。
- `uniform` 模式保留为**调试选项**（用户要求），用于对照「单向风确实造不出沙漠带」。

### 2.6 降雨（L2 · 步 5）

球面上**不能一遍扫描收敛**（§1.3），必须迭代。

**实现照搬 mapgen4 `assignRainfall` 的骨架**（`humidity` 是迭代状态、`rainfall` 是输出），
只做两处球面化改造。下面是**实际落地**的代码结构（`index.html`
`solveRainfall`，与文档早期草稿的差别见本节末尾）：

```js
// [Godot-ready] 纯算法，可直接翻译成 GDScript
function solveRainfall(T, cfg) {
  const cl = cfg.climate;
  const gs = cl.rainSolver === 'gaussSeidel';
  const oneMS = 1 / (1 - cfg.seaLevel);

  // ── 暖启动：先用纬向气候学解铺一遍 ──
  for (let i = 0; i < T.n; i++) T.humidity[i] = climatologyRain(T, i, cfg);
  const prev = new Float64Array(T.n);

  let iter = 0, residual = Infinity;
  while (iter < cl.rainMaxIter && residual > cl.rainTolerance) {
    if (!gs) prev.set(T.humidity);                 // Jacobi：读上一轮
    residual = 0;
    for (let i = 0; i < T.n; i++) {
      const src = gs ? T.humidity : prev;
      const nb = T.neighbors[i];

      // ① 平流：沿风的上游邻居按投影加权平均
      let sum = 0, wsum = 0;
      for (let k = 0; k < nb.length; k++) {
        const j = nb[k];
        const proj = (cj[0]-ci[0])*wx + (cj[1]-ci[1])*wy + (cj[2]-ci[2])*wz;
        if (proj >= 0) continue;                   // 只看上游
        const w = -proj; sum += src[j]*w; wsum += w;
      }
      let humidity = wsum > 1e-9 ? sum / wsum : src[i];

      // ② 平流水汽本身降下的雨（mapgen4: rainfall += raininess * humidity）
      let rainfall = cl.raininess * humidity * cl.convectiveRain;

      // ②b ★ 中纬风暴带（极锋辐合带）—— v3.0 新增，见 §2.6.1
      const dStorm = (latDeg - cl.stormTrackLat) / cl.stormTrackWidth;
      rainfall += cl.raininess * cl.stormTrack * Math.exp(-dStorm*dStorm) * humidity * cl.convectiveRain;

      // ③ 海洋蒸发：向「温度决定的饱和湿度」松弛（暖海蒸发快、冷海几乎不蒸发）
      const e = T.elevation[i];
      if (e <= cfg.seaLevel) {
        const warm = Math.pow(T.temperature[i], cl.evaporationExponent);
        const sat  = cl.saturationFloor + (1 - cl.saturationFloor) * warm;
        humidity += (sat - humidity) * cl.oceanEvaporation;
      } else if (cl.landEvaporation > 0) {
        // ③b ★ 陆面蒸发 —— v3.0 新增：植被 / 土壤 / 内陆水体也供水汽
        const warm = Math.pow(T.temperature[i], cl.evaporationExponent);
        const satLand = cl.landSaturation * warm;   // 暖地蒸发强、寒地弱（极地依旧干）
        humidity += (satLand - humidity) * cl.landEvaporation;
      }

      // ④ 副热带下沉脱湿：直接降低湿度，干燥随下风向传播（沙漠靠这一步）
      const latDeg = Math.abs(Math.asin(clamp(ci[1], -1, 1)) * 180 / Math.PI);
      const dd = (latDeg - cl.subtropicalLat) / cl.subtropicalWidth;
      humidity *= (1 - Math.exp(-dd*dd) * cl.subtropicalStrength);

      // ⑤ 地形雨影：容量 = 1 − 陆地相对高度，超出容量的部分降下来（mapgen4 原判据）
      const relief   = e > cfg.seaLevel ? (e - cfg.seaLevel) * oneMS : 0;
      const capacity = clamp(1 - relief, 0.05, 1);
      if (humidity > capacity) {
        const drop = cl.rainShadow * (humidity - capacity);
        rainfall += cl.raininess * drop;
        humidity -= drop;
      }
      humidity = clamp(humidity, 0, 1);

      residual = Math.max(residual, Math.abs(humidity - T.humidity[i]));
      T.humidity[i] = humidity;                    // ← Gauss-Seidel：原地写回
      T.rainfall[i] = rainfall;
    }
    iter++;
  }
  normalizeMoisture(T, cfg);
  return { iterations: iter, residual, maxRainfall, maxHumidity };
}
```

**球面化改造：**

1. **「平面图的边界海洋」→「海洋向饱和湿度松弛」。**
   mapgen4 在平面的四条边界上强制赋值海洋湿度；球面没有边界，改成
   `humidity += (sat − humidity) · oceanEvaporation`，其中
   `sat = saturationFloor + (1 − saturationFloor) · T^evaporationExponent`。
   **`sat` 随温度变**是必须的：极地海洋温度低 → 饱和湿度低 → 极地也不会下雨。
2. **新增「副热带下沉脱湿」。** 这是**沙漠带唯一造得出来的路径**。
   mapgen4 平面图靠「离海远」造内陆干旱，球面上陆地可能四面环海，
   没有这一项就永远出不了沙漠（§12.3 有实测证据）。
3. **★ v3.0 新增「陆面蒸发」（③b）与「中纬风暴带」（②b）**，理由见 §2.6.1。

#### 2.6.1 ★★ 为什么必须有「中纬风暴带」（v3.0 教训之三）

M2 的降雨只有**海洋蒸发**一个湿度源，而 `sat ∝ T^evaporationExponent`（指数 2.0），
`T ≈ cos(纬度)`。于是**湿度随纬度单调下降**：副热带永远比中纬湿，
三圈环流里「赤道湿 / 副热带干 / **中纬次湿** / 极地干」的第三环**根本不存在**。

实测（M2 参数，只统计陆地）：`0°=0.182  ±30°=0.076  ±45°=0.056  ±65°=0.019`
—— ±45° 比 ±30° 还干，`m1-test` 的「中纬次湿」断言直接失败。

**物理上缺的是什么**：极锋辐合带（≈50°）里，西风带把海洋水汽送上中纬陆地并被锋面抬升。
这是一个**降水**项（不是蒸发项），所以直接加在 `rainfall` 上：

```
rainfall += raininess · stormTrack · exp(−((|lat| − stormTrackLat)/stormTrackWidth)²) · humidity · convectiveRain
```

默认 `stormTrack = 0.70`、`stormTrackLat = 48`、`stormTrackWidth = 12`。
加入后实测：`0°=0.177  ±30°=0.061  ±45°=0.079  ±65°=0.022` —— **四带成立**，三条断言全过
（注意 `stormTrackWidth` 不能太大：太宽会把雨带到副热带，把「副热带最干」也一起救活）。

#### 2.6.2 ★ 陆面蒸发：量级与副作用

M2 把 `landEvaporation` 删掉了（当时结论：「加常量蒸散会污染雨影信号」）。
v3.0 **把它加回来**，因为开大陆掩码后陆地占比从 47% 涨到 68%，
地球上**几乎没有海洋**的超级大陆内部会干到不可用（实测干旱陆地 30%+）。

```
humidity += (landSaturation · T^evaporationExponent − humidity) · landEvaporation
```

- `landEvaporation` 默认 **0.55**（面板可调），`landSaturation` 默认 **0.55**。
- 它**乘 `T^exp`**，所以极地依旧干（不会把苔原变雨林），也**天然有界**，不需要额外 clamp。
- 副作用：**开大陆 → 土地更多 → 蒸发源更多 → 世界整体变湿**。
  实测（`lift0.45` 的那一版）：`landEvap 0.35/0.20/0.10` 对应干旱陆地 11.8%/14.1%/16.3%
  （M2 基线是 39.8%）。所以 `moistDry` / `moistWet` 必须**按新 moisture 分位重标定**（已做，见 §7.6）。
- **迭代次数反而变少**：M2 是 40 次收敛，v3.0 是 **12 次**（陆面蒸发缩短了水汽的传播距离）。

**雨影为什么不需要显式「迎风判定」：**
早期草稿写了一个 `orographicSink()`，用「上游相对本格的高差」判断上坡。
实现时发现 **mapgen4 原有的判据已经涵盖了它**：
`capacity = 1 − landRelief`，湿度超过容量就把超出部分降下来 ——
迎风面海拔高 → 容量小 → 立刻降水（湿）；背风面海拔低 → 容量大 → 湿度保持甚至累积。
所以 `orographic` 这个参数**删掉了**，`upwindRelief` 也删掉了。
（`upwindSlope` 的实测证据见 §12.3：纬度只解释 62.2% 的降雨方差，
剩下 37.8% 就是地形/海陆贡献的，说明雨影确实出现了。）

**暖启动 + Gauss-Seidel**：先跑一遍 `climatologyRain`（解析的纬向气候学解）作为初值，
再原地更新（`gaussSeidel`）或读上一轮（`jacobi`，仅作调试对照）。
实测 level 4 / level 5 都是 **12 次**收敛、残差 ~6e-5（`rainTolerance = 1e-4`）。
（M2 无陆面蒸发时是 40 次；陆面蒸发缩短了水汽传播距离。）
`rainSolver` 是面板可切换的下拉框。

**归一化**：`moisture[i] = clamp(rainfall[i] / CONFIG.climate.rainReference, 0, 1)`，
`rainReference` 默认 **0.40**。**用固定参考值而不是运行时最大值**，
这样 `raininess` 滑杆才会真正改变生物群系分布（否则会被归一化掉）。

> **与本文档早期草稿的差异**（草稿里的 `evaporativeSource` / `orographicSink` 两个
> 辅助函数在实现中**不存在**）：
>
> | 草稿 | 实际实现 | 原因 |
> |---|---|---|
> | `landEvaporation`（陆地蒸散常量） | **M2 删除 → v3.0 加回（③b）** | M2 时陆地占比只有 47%，加蒸散确实会污染雨影；v3.0 陆地 68% 且是超级大陆，没有陆面蒸发内陆会干到不可用 |
> | `oceanEvaporation` 作为 multiplicative 源 | 改为**向 `sat` 松弛**的速率 | 松弛形式天然有界 `∈[0,1]`，不需要额外 clamp |
> | `orographic` | **删除** | mapgen4 的「容量 = 1 − landRelief」已经涵盖雨影 |
> | — | **新增** `convectiveRain` | 平流水汽的直接降水系数（mapgen4 的 `raininess * humidity` 项） |
> | — | **新增** `saturationFloor` | 冷海最低饱和湿度，否则极地海洋会把水汽送进极地内陆 |
> | — | **新增** `rainShadow` | 容量溢出的提取率，对应 mapgen4 的 `rain_shadow` |
> | `rainReference = 0.55` | **0.40** | 实测降雨量级比草稿预估低，0.55 会让 69% 的陆地判成干旱 |

### 2.7 下坡与 priority-flood（L2 · 步 6）

mapgen4 的 `assignDownslope` 是平面上的「指向最低邻居」，会**在洼地里死循环**。球面上更严重（有真实的封闭洼地）。改用 **priority-flood**（Barnes 2014）：

```js
// [Godot-ready] 纯算法
function priorityFlood(T, cfg) {
  const heap = new MinHeap();
  for (let i = 0; i < T.n; i++) {
    T.filled[i] = Infinity;
    T.downslope[i] = -1;
    if (T.elevation[i] <= cfg.seaLevel) {          // 种子：海洋
      T.filled[i] = T.elevation[i];
      T.downslope[i] = -1;
      heap.push(i, T.elevation[i]);
    }
  }
  while (heap.size > 0) {
    const c = heap.pop();
    for (const nb of T.neighbors[c]) {
      if (T.filled[nb] !== Infinity) continue;
      const f = Math.max(T.elevation[nb], T.filled[c]);   // ← 填平
      T.filled[nb] = f;
      T.downslope[nb] = c;                                 // ← 指向把水放出去的那个邻居
      heap.push(nb, f);
    }
  }
  // 未被触达的格子（理论上不存在，因为海洋连通）→ 兜底指向最低邻居
  T.floodOrder = ... // 按 filled 升序 = 堆的出场顺序，天然是「叶 → 根」
}
```

- **`filled - elevation` 就是「本格能被填多深」**，也就是**湖深**。
- **`floodOrder`** 是堆的出场顺序，天然按 `filled` 升序，**正是 `accumulateFlow` 需要的「叶 → 根」顺序**。这一点比 mapgen4 的 `t_order` 更干净。
- 种子用 `elevation ≤ seaLevel`（而不是「深海」），保证所有海岸线都能出海。
- 全是陆地的球会有格子触达不到（无海洋种子）。兜底：把所有剩余格子当作「内流盆地根」，各自入堆。文档里标为 `CONFIG.terrain.allowNoOcean`。

### 2.8 湖泊与内流盆地（L2 · 步 7）

用户已确认用 priority-flood 填平量检测，并且要写清「填平量 = 湖深」：

```js
// [Godot-ready] 纯算法
function detectLakes(T, cfg) {
  for (let i = 0; i < T.n; i++) {
    const land = T.elevation[i] > cfg.seaLevel;
    const depth = T.filled[i] - T.elevation[i];   // ← 填平量 = 湖深
    T.lakeDepth[i] = land ? depth : 0;
    T.isLake[i]    = land && depth > cfg.lakeMinDepth;
    T.waterLevel[i] = T.filled[i];                // ← 湖面画在 filled 上
  }
  // 内流盆地（可选，字段先留出来）
  for (const basin of findBasins(T, cfg)) {
    const meanRain = basinRainMean(T, basin);
    for (const i of basin) T.isEndorheic[i] = meanRain < cfg.hydro.endorheicRain;  // 默认 0.10 ≈ p63
  }
}
```

**三层几何语义**（用户要求写清）：

| 层 | 数据 | 渲染位置 |
|---|---|---|
| 地形（湖底） | `elevation[i]` | 球面半径 `1 + relief · landRelief` |
| 水面 | `filled[i]` | 球面半径 `1 + relief · (filled − seaLevel)/(1−seaLevel)` |
| 中间那一层 | `lakeDepth = filled − elevation` | 就是水体本身 |

**`isEndorheic` 判据（已实现）**：湖泊所在流域的平均降雨低于 `CONFIG.hydro.endorheicRain`（默认 **0.10**，≈ 降雨分位 p63）。物理动机是「补给量 < 蒸发量 → 水体不外流」，结果就是咸水湖（里海、大盐湖）。用户说这项可选，**字段先留出来，渲染时若为真用更深的蓝绿色**。本期实现这个简单代理判据，并在 HUD 里可见。**实测 level 5：132 个湖格里 118 格被判为内流，分属 22 个流域。**

> 注意：priority-flood 保证每个格子的 `downslope` 链最终都到海洋，所以**严格意义上的「无出口」不会出现**。这里的 `isEndorheic` 是**气候代理判据**，不是拓扑判据——文档里必须写清楚，避免后来人误解。

#### 2.8.1 ★★ `lakeMinDepth` 是湖/河质量的**第一主旋钮**（v3.0 教训之四）

开大陆掩码之后，基础 FBM 的局部极小值**全部从「算海洋」变成了「算内陆湖」**——
M2 里那些本来就低于海平面的洼地，现在都露在大陆内部。后果是**三件事同时发生**：

1. 湖泊数暴涨（实测 1224 个湖格）；
2. 河道「碎」掉：`flow` 在湖里被清零，河流被切成很多短段 → 孤立划占比升到 16.5%；
3. **到海距离被拉回**（2.4–4.3）——陆地被湖泡成「海绵」，怎么也长不出长河。

单格湖还有一个纯粹的**视觉**后果：**湖岸等值线在六边形网格上就是一圈正六边形**，
画出来像「六角螺帽」（§3.5 用 `lakeShoreMinCells` 解决）。

所以调参顺序必须是：**先定 `seaLevel` / `oceanDepth` / `continentBias` 把大陆做出来，
再用 `lakeMinDepth` 把「海绵」挤干**。实测（`lift0.45 dep0.45 bias−0.6 band0.3`）：

| `lakeMinDepth` | 湖格数 | 单格湖 | 孤立划 | 最长河链 | 到海均 |
|---|---|---|---|---|---|
| 0.006 | 1224 | 57 | 16.5% | 38 | 3.65 |
| 0.015 | 1052 | — | 14.8% | 38 | 4.06 |
| 0.025 | 904 | — | 13.8% | 38 | 4.69 |
| 0.045 | 665 | — | 9.8% | **49** | 5.85 |
| 0.080 | 379 | 9 | **6.0%** | **49** | **7.31** |

**默认取 `0.050`**（在「保留真实湖泊」与「挤干海绵」之间）。
物理含义：`lakeMinDepth` 是**海拔单位**下的湖深，而陆地海拔跨度是 `[seaLevel, 1]`；
`0.05` ≈ 陆地相对高度的 6%。

### 2.9 流量累积与上游汇水面积（L2 · 步 8）

```js
// [Godot-ready] 纯算法
function accumulateFlow(T, cfg) {
  T.flow.fill(0);
  for (let i = 0; i < T.n; i++) {
    // 产流 = gain · moisture²（照抄 mapgen4）
    T.flow[i] = (T.elevation[i] > cfg.seaLevel && !T.isLake[i]) ? cfg.hydro.flowGain * T.moisture[i] ** 2 : 0;
    // ★ 汇水面积：每块陆地 1 格，海洋与湖面 0
    T.area[i]  = (T.elevation[i] > cfg.seaLevel && !T.isLake[i]) ? 1 : 0;
  }
  // ★ 反向遍历（叶 → 根）
  for (let k = T.floodCount - 1; k >= 0; k--) {
    const i = T.floodOrder[k], d = T.downslope[i];
    if (d >= 0) { T.flow[d] += T.flow[i]; T.area[d] += T.area[i]; }
  }
  // …再统计 maxFlow / maxArea / isRiver
}
```

**这一条是硬性要求，实测过**：写成正序遍历，`maxFlow` 直接掉到 **0.000**；反向遍历才是正确的 **15.074**。

**两个量各管一件事**（这是 M2 阶段最重要的一个设计决定）：

| 量 | 含义 | 受什么影响 | 用途 |
|---|---|---|---|
| `flow` | 流量（湿度加权累积） | 湿度 + 累积 | **河宽渐变**（上游细下游粗）、`isRiver` 判定 |
| `area` | 上游汇水面积（格数） | **只受地形拓扑影响** | ★ **「这里是不是一条真正的河道」** 的判据 |

**为什么要单独加 `area`**：`flow[i] = flowGain·moisture[i]²` 里有一大块是**本地产流**，
湿润区的单个格子靠自己产流就能越过阈值 → 满屏互不相连的短划（渲染出来就是「梳齿/鱼骨」，见 §3.6）。
`area` 只依赖 `downslope` 拓扑，是 GIS 里的标准做法（contributing area threshold），
用它筛河道能把「海岸峭壁上一格一格各自入海」的假河道全部剔除，而**不动 `flow`、不动 `isRiver`、不动生物群系分类**。

实测（level 5 / seed 1337）：`area` 分位 `p50 = 1`、`p90 = 5`、`p95 = 10`、`p99 = 41`、`max = 92`（陆地格）。
也就是说**半数陆地格没有任何上游来水**——球面的河网本来就很短，这一点必须靠渲染层的门槛设计去适配，而不是硬套 mapgen4 的参数。

**河流阈值**：`flow[i] >= CONFIG.hydro.riverThreshold` 且 `elevation[i] > seaLevel` 且 `!isLake[i]`。默认 **2.0**（面板可调）。
这个阈值只决定**生物群系分类里的 `RIVER`**；渲染层是否画缎带用的是 `area` + `flow` 两级门槛（§3.6）。

> mapgen4 的 `MIN_FLOW = exp(2.7) ≈ 14.9` **不能用**——它针对 25k 格 + 单一大陆的平面图。球面 level 5 的 `maxFlow` 只有 15.074，阈值必须降到 2.0 量级（实测 2.0 → **2.68%** 陆地格成河）。完整阈值表见 §12.4。
>
> **产流公式照抄 mapgen4**：`flow[i] = flowGain · moisture[i]²`。
> 沙漠 `moisture ≈ 0` → 产流 ≈ 0 → **沙漠里天然长不出河**。
> 若改成「每格常数产流」，100% 的陆地都会变成河。

### 2.10 生物群系（L2 · 步 9）

mapgen4 的 biome 完全由 (海拔, 降雨) 二维表决定（§1.4）。我们扩成**三轴**：

```js
// [Godot-ready] 纯算法
function classifyBiome(T, i, cfg) {
  const e = T.elevation[i], t = T.temperature[i], m = T.moisture[i];
  if (e <= cfg.seaLevel) {
    if (t < cfg.tempSeaice) return BIOME.SEA_ICE;      // 海冰
    return (e < cfg.seaLevel - cfg.deepWaterDepth) ? BIOME.DEEP_OCEAN : BIOME.OCEAN;
  }
  if (t < cfg.tempSnow)      return BIOME.SNOW;         // 雪峰（赤道高山也进这里）
  if (T.mountain[i] > cfg.mountainBiomeThreshold) return BIOME.MOUNTAIN;
  if (t < cfg.tempIce)       return BIOME.ICE;          // 冰原
  if (T.isLake[i])           return T.isEndorheic[i] ? BIOME.SALT_LAKE : BIOME.LAKE;
  if (T.isRiver[i])          return BIOME.RIVER;
  // 温度带 × 湿度带（Whittaker）
  // ★ 热带单独用更高的干旱阈值 moistAridTropical（判据是干旱指数 P/PET）
  if (t >= cfg.tempTropical) return m > cfg.moistWet ? BIOME.TROPICAL_RAINFOREST : (m > cfg.moistAridTropical ? BIOME.SAVANNA : BIOME.DESERT);
  if (t >= cfg.tempWarm)     return m > cfg.moistWet ? BIOME.TEMPERATE_FOREST : (m > cfg.moistDry ? BIOME.GRASSLAND : BIOME.SHRUBLAND);
  if (t >= cfg.tempCool)     return m > cfg.moistDry ? BIOME.TEMPERATE_FOREST : BIOME.SHRUBLAND;
  if (t >= cfg.tempTundra)   return m > cfg.moistDry ? BIOME.TAIGA : BIOME.TUNDRA;
  return BIOME.TUNDRA;
}
```

**优先级顺序**（用户会看到的最终分类结果）：海洋/海冰 > 雪峰 > 山脉 > 冰原 > 湖泊 > 河流 > 温度带 × 湿度带。

与 v1 的关键差别：**湿度不再来自解析式 `latitudinalMoisture`，而是来自迭代求解出的 `rainfall`**。所以雨影、内陆干旱、副热带沙漠全都**自动出现**在生物群系图上。

**★ v3.0：为什么热带要单独一个 `moistAridTropical`。**
M2 的热带分支也用 `moistDry = 0.14`，结果**沙漠只有 2.2%**：副热带干旱陆地的
`moisture` 恰好卡在 0.14 上方一点点（实测 ±30° 带陆地平均降雨 0.061 → moisture 0.15），
全部被判成稀树草原。但按**干旱指数 `P/PET`**，赤道潜热大、`PET` 高，
同样降水量在热带支撑不了植被 —— 所以热带的干旱阈值**本就该比温带高**。
新增 `moistAridTropical = 0.24`（≈ moisture 分位 p60）后：
**沙漠 2.2% → 6.1%，稀树草原 7.7% → 3.7%**。温带的 `moistDry` 保持 0.14 不动。

### 2.11 山脉—河流联动（因果链的直接产物）

这是「因果链」相对「分类模型」最有说服力的一点，值得单独说明：

1. `mountain` 距离场抬高山脉所在格的海拔 → `elevation` 高。
2. 高海拔 → `landRelief` 大 → 降雨的**容量 `1 − landRelief` 变小** → **迎风坡立刻降水（湿）、背风坡容量大（干）** → 雨影。
3. 高海拔 + 坡度 → priority-flood 的 `filled` 高 → **分水岭**：水流向两侧，**山脉自动成为流域边界**。
4. `accumulateFlow` 反向累积 → 水沿山谷汇聚成干流，**河谷位置由山势决定**。又因为产流 `∝ moisture²`，干区的坡面产流少 → **沙漠里的干河床不会变成河**。
5. `setMapGeometry` 的折叠判据里包含「有河流经过」→ **河谷处几何折向山谷**，视觉上是「河在谷里」。

**这五步没有任何一步是特判**，全是前一步的自然结果。这就是我们要的效果。

---

## 3. 渲染改造：手绘风格

### 3.1 技术选型对比

| 维度 | **方案 A：顶点色 + CPU 烘焙**（选定） | 方案 B：片元着色器 | 方案 C：Canvas 2D / SVG 叠加 |
|---|---|---|---|
| 实现方式 | 合并 BufferGeometry + `vertexColors: true`，光照/调色板全在 CPU 算好 | GLSL 里做噪声、调色、光照 | 3D 球 + 2D 覆盖层画线/标注 |
| 是否改算法层 | 否 | 否，但要在 GLSL 里重写噪声/调色 | 否 |
| Godot 对应 | `vertex_color_use_as_albedo`，几乎 1:1 | 需要 `shader_type spatial` + 手写 GLSL | `SubViewport` + `CanvasItem`，分层同步麻烦 |
| 球面畸变 | 无 | 无 | **极区 UV 畸变严重** |
| 数据留在 CPU | ✅ 全部 | ❌ 关键数据要送 GPU | ✅ |
| 调试友好 | ✅ 改一个 JS 函数即时看到结果 | ❌ 改 GLSL 要重新编译 | ✅ |
| mapgen4 是否这么做 | ✅ mapgen4 自己也不在着色器里放噪声 | — | — |
| 性能 | 一次烘焙 O(V)，之后 1 draw call | 每帧算 | 每帧重绘 2D 层 |
| 风险 | 分类色在三角形内是插值，边缘略软 | 复杂度与移植成本高 | UV 与 3D 对不齐 |

**结论：选 A。** 理由已经和用户确认过：

1. **地形数据全部留在 CPU 侧**，Godot 移植时 `paletteAt` 逐顶点调用即可，算法层零改动。
2. mapgen4 自己也不在着色器里放噪声——手绘感来自几何折叠 + 烘焙光照 + 描边，不是 shader 特效。
3. 方案 B 的收益（逐像素调色）不值它带来的移植成本。
4. 方案 C 的球面 UV 极区畸变无解，**只建议留作离线导出**（比如导出成手绘地图 PNG 时再走 2D 路径）。

### 3.2 `paletteAt`：算法层与渲染层唯一的接口 ★

> **`paletteAt(elev, temp, moist) → [r,g,b]` 是整个渲染层里最值得精心设计的一个函数。** 它是算法层和渲染层唯一的接口。

这是本节最重要的一条，单独强调：

- **纯函数**，无副作用，不读全局，只依赖入参和 `CONFIG`。
- **在 Godot 里可以原样复用**：逐顶点调用（`MeshData.set_vertex_color`），或者预先烘成一张 **3D 纹理**（`elev × temp × moist` 三轴 64³）交给着色器 `texture()` 采样。
- **两种方式都不需要改动算法层。**
- 将来若要升级渲染（加纸纹、加光照、换风格），**只需要替换这个函数或它的 GPU 版本**，地形数据完全不受影响。

签名与实现骨架：

```js
// [Godot-ready] 纯算法，可直接翻译成 GDScript
// ★ 算法层 ↔ 渲染层的唯一接口
function paletteAt(elev, temp, moist, cfg) {
  // 1) 水：按深度做「浅蓝 → 深蓝」的连续渐变，
  //         并叠 3 条高斯亮蓝浅水带（向 mapgen4 colormap.ts 的等深线致敬）
  if (elev <= cfg.seaLevel) return waterColorAt(elev, cfg);
  // 2) 温度坐标 tc = clamp((temp − 0.22)/0.72, 0, 1) · 2      ∈ [0,2]
  // 3) 湿度坐标 mc = clamp(moist^0.70 · 1.18, 0, 1) · 2        ∈ [0,2]  ← 见下方说明
  // 4) 在 3×3 Whittaker 色标网格上做双线性插值 → 陆色
  // 5) 按 snowLine / 低温 fade 到雪白（赤道高山也能进这里）
  // 全部连续插值，绝无「每格一个纯色」
}
```

**色标的两个物理载体**（都不是 `CONFIG.palette`，实现时用了更直接的形式）：

| 结构 | 内容 |
|---|---|
| `WHITTAKER` | 3×3 常量网格：**行 = 温度（冷 → 热），列 = 湿度（干 → 湿）**，`whittakerAt(tc, mc)` 做双线性插值 |
| `waterColorAt` | 水深 → 颜色的 4 段 `ramp`（`ramp(stops, x)` 是分段线性插值），外加 3 条高斯浅水带 |

**湿度为什么要做 `pow(0.70) · 1.18` 的重映射**：
实测陆地 `moisture` 中位数只有 **0.173**，直接线性喂给 Whittaker 会「满屏枯黄」。
这个重映射**只发生在 `paletteAt` 内部**，算法层的 `moisture` 一个字都不动 ——
**调它不会改变任何因果链结果**。这正是「`paletteAt` 是唯一接口」的价值所在：
颜色不满意时，改的是一个函数，不是整条链条。

**湖泊 / 河流的叠色放在调用侧**（`refreshVertexColors`），不放进 `paletteAt` ——
这样 `paletteAt` 保持「只依赖 3 个标量」的纯函数形态，方便烘 3D 纹理：

```js
// refreshVertexColors 内：
if (vLake > lakeMinDepth * 0.6)      rgb = mix(rgb, [0.17,0.43,0.56], 0.66);  // 湖：深蓝绿
else if (vFlow >= riverThreshold*0.6) rgb = mix(rgb, [0.16,0.43,0.62], 0.72);  // 河：更深的蓝
```

### 3.3 渲染网格：折叠四边形

**不用**「每个图块一个纯色 mesh」的旧方案。新方案是 mapgen4 `geometry.ts#setMapGeometry` 的球面版：

```js
// [渲染层] Godot 中对应 ArrayMesh + SurfaceTool.add_vertex + set_color
function buildRenderMesh(T, cfg) {
  // 顶点：region 中心 (0..nR-1) + 三角形重心 (nR..nR+nT-1)
  // 对每个半边 s = (t, i) 输出 1 个三角形：
  //   r1 = faces[t][i]            半边起点
  //   r2 = faces[t][(i+1)%3]      半边终点
  //   t1 = t                      半边所在三角形
  //   t2 = triAcross[3*t+i]       对侧三角形
  //   cen1 = nR + t1, cen2 = nR + t2
  //   折向山谷  ⟺ (elev[r1] ≤ seaLevel) || (elev[r2] ≤ seaLevel) || 任一侧是河
  //   山谷：(r1, cen2, cen1)
  //   山脊：(r1, r2,   cen1)
}
```

- **一条边决定一个 quad 的对角线方向**：要么折成「脊」（跨过山脊，颜色被拉向高处），要么折成「谷」（跨过河谷，颜色被拉向低处）。
- **`is_valley` 的判据**照 mapgen4：`水边 || 有流边`。这里的「有流边」用 `flow ≥ riverThreshold` 判定。
- **顶点属性**：`position` + `color`。**三角形内颜色不做逐像素插值**（没有 shader），而是**逐顶点先插标量、再查 palette**：
  - region 顶点：用本格自己的 `(elev, temp, moist)`
  - 三角形顶点：用周围 3 个 region 的**标量平均**，再查 palette
  - 这样做的关键好处：**分类色不会在三角形里被「调成泥巴色」**——插值发生在 `(elev, temp, moist)` 空间，查表得到的每个顶点色都是合法色。
- 规模：`level 4 → 15360 三角形 / 7682 顶点`，`level 5 → 61440 三角形 / 30722 顶点`，**均为 1 draw call**。

> **关于「水」的几何**：水面必须**绝对平整**（所有水格半径都是 1，不被 `relief` 抬高）。陆地按 `landRelief` 抬升，所以湖面 / 海面是一层和地形分离的壳——配合 `filled` 就能画出湖面浮在湖底之上的效果。

### 3.4 顶点色烘焙光照

**光照在 CPU 上逐顶点烘焙**，写进 `color`，材质用 `MeshBasicMaterial({ vertexColors: true })`（不接实时灯光）。

采用 **map 式 hillshade**（不是 3D 点乘），三个理由：

1. **没有晨昏线**。如果直接 `dot(法线, 世界方向光)`，球会有一半是黑的——而这是一个用来**选出生点**的球，不能有黑半边。
2. **可随球自转保持观感**。光照只依赖局部坡向与固定罗盘方位，不依赖相机。
3. **完全可烘焙**，不随视角变化，所以能留在顶点色里（Godot 也直接能用）。

```js
// [渲染层] 逐顶点烘焙；Godot 里可以把结果写进顶点色，或改成一个 DirectionalLight3D
function bakeVertexShading(T, cfg) {
  // 1) 逐 region 用最小二乘拟合切平面内的梯度 (gu, gv)
  //    basis: e1 = normalize(cross(n, UP)), e2 = cross(n, e1)
  //    解 2×2 正规方程 → 梯度（单位：elevation / 弧度）
  // 2) 局部坡度与坡向
  //    slope  = atan(reliefScale / (1-seaLevel) · |grad|)
  //    azimuth = atan2(gv, gu) 在 (e1, e2) 基下的方位角
  // 3) 光照（罗盘方位固定，避免极点退化）
  //    north = normalize(UP - n·(UP·n))   // 切平面内的北向
  //    east  = cross(n, north)
  //    Lhat  = north·cos(az) + east·sin(az)
  //    illum = cos(z)·cos(slope) + sin(z)·sin(slope)·dot(ĝ, Lhat)
  //    shade = ambient + diffuse · clamp(illum, 0, 1)
  // 4) 三角形顶点 = 周围 3 个 region 的 shade 平均
}
```

参数：`lightZenithDeg = 45`、`lightAzimuthDeg = 315`（右上打光，和手绘地图的习惯一致）、`ambient = 0.62`、`diffuse = 0.55`。

> 极点处 `n ∥ UP` 会导致 `north` 退化，兜底用 `e1`。这是唯一需要特判的地方，已经在代码里处理。

### 3.5 海岸墨线与湖岸墨线

不用 shader 的深度描边（那是方案 B 的思路）。用**独立几何层**，而且是**有宽度**的缎带：

```js
// [渲染层] Godot 中对应 ArrayMesh + PRIMITIVE_TRIANGLES（不是 LINES）
// [Godot-ready] 纯算法 —— 「等值线切割」（marching triangles）
function buildCoastLine(T, cfg) {
  // 遍历 L1 的每个三角形 (a,b,c)：
  //   三顶点的「海/陆」二分类若一致 → 跳过（全陆 / 全海）
  //   否则恰有 2 条边跨越 seaLevel：
  //     该边上的等值点 p = normalize(lerp(ci, cj, (seaLevel - ei)/(ej - ei)))
  //   把这两个等值点连成 1 条线段，交给 appendRibbon 缎带化
}
function buildLakeShoreSegments(T, cfg) { /* 同一套 marching triangles，threshold = filled */ }
function appendRibbon(pos, col, idx, segs, width, rgb) {
  // 每个线段 → 1 个 quad（4 顶点 / 6 索引）
  //   ★ 逐片段独立算 side：两端各自的球面法线 × 方向，避免长直线
  //   ★ 两端各沿 ±dir 外扩 halfW，让相邻片段首尾重叠，盖住接缝
}
```

- **M2 的关键升级**：M1 用 1px `LineSegments`，在球面上几乎看不见（也无法加粗）。
  M2 改成 **`appendRibbon` 缎带化** —— 海岸 / 湖岸 / 河流共用同一个函数，
  每条线段变成 4 顶点 / 6 索引的四边形，**在顶点色材质下有着真实宽度**。
- **海岸与湖岸合并成同一个 Mesh**（`buildInkGeometry`），靠顶点色区分两种墨色：
  海岸 `#1b2a33`（全宽 `coastWidth = 0.0042`，`opacity 0.55`），
  湖岸 `#1d4a5c`（全宽 `lakeShoreWidth = 0.0030`，偏蓝绿）。
  这样墨线层始终只占 **1 个 draw call**。
- 半径抬高到 `1 + inkLift`（默认 0.0009），避免与水面 z-fighting。
- **实测（v3.0）**：`level 5` 上海岸 **2056 段**、湖岸 224 段（共 2280 段 → 9120 顶点 / 13680 索引）；
  单次 `buildInkGeometry` **4.9 ms**。（M2 是 4501 段 / 9002 三角形 / 7.3 ms。）
- 扩展到等值线很容易：把 `seaLevel` 换成任意高度值，循环几档就得到等高线（M3 可选）。
  这是纯几何层的附加收益。

#### ★ v3.0：小湖不描边（`lakeShoreMinCells`）

单格湖的岸线在六边形网格上就是**一圈正六边形**，画出来是「**六角螺帽**」——
这是 M2 截图里最显眼的假工件之一。v3.0 在 `buildLakeShoreSegments` 里加了一步
**连通块 BFS**，只给「格数 ≥ `lakeShoreMinCells`（默认 4）」的湖描边，
小湖**只用顶点色填充**（湖面颜色本来就已经画在 `planetMesh` 的顶点色里，
所以不描边的小湖是一个柔和的蓝点，比六边形圈好看得多）。

> 判定放在**算法函数内部**（用 `T.neighbors` 做 BFS）而不是渲染循环里，
> 所以这个函数仍然可以整段抽出去做 headless 验证。

> ⚠️ **这里踩过一个真 bug**（§8.4 案例二）：早期版本对**每条跨界边只 push 一个等值点**，
> 顶点数成了 3881（奇数）。`LineSegments` 要求顶点成对，于是它把**完全不相邻**的
> 第 1、2 个等值点连成一条线段 —— 画面上就是一条**横穿球面的长直线**。
> 而且当时的 headless 断言写成了「顶点数为偶数且 > 200」，判的是 `length % 3`，
> 永远为真，**完全没拦住**。
> 现在断言改成了与 level 无关的严格判据：
> **每段长度 ≤ 该 level 网格的最长边**（等值线必然落在单个三角形内）。
> 实测 level 5：最长段 0.03947 / 最大边长 0.03947。
> （M2 换成缎带后这条断言依然成立 —— 缎带的中轴仍是那两条等值点。）

### 3.6 河流缎带与湖泊水面

**河流缎带（M2 已实现，v3.0 升级为平滑中心线）**：照 mapgen4 `geometry.ts#setRiverGeometry` 的思路——**可变宽度折线**。

```
① 逐 region 算一次横向单位向量 side[r]（垂直流向、落在切平面内）
   side = normalize(cross(dir(r→downslope[r]), center[r]))
② 逐 region 决定宽度 wid[r]（=∑ 两级门槛，见下）
③ 每个河道格输出 K 段平滑带（K = riverSmooth，默认 3）：
   A = normalize(center[prev] + center[r])       ← 上游接点（与上游格共享）
   B = normalize(center[r]   + center[d])        ← 下游接点（与下游格共享）
   C = center[r]                                 ← 二次 Bezier 控制点
   采样 t = k/K：dir = normalize(bezier(A, C, B, t))
                 pos = dir · lerp(radius[A], radius[B], t) ± 插值 side · lerp(w, w', t)/2
```

#### ★★ v3.0：中心线用二次 Bezier 平滑（消掉「闪电感」）

**问题**：M2 是「一个河段一个直 quad」。region 中心连成的折线在**六边形网格**上
必然出现 **120° 硬折角**，空中鸟瞰就像**闪电 / 裂缝**，不像河。

**做法**：以本格中心 `C` 为**控制点**，从**上游接点 `A`**（与上游格共享的弦中点）
弯到**下游接点 `B`**（与下游格共享的弦中点），在 A→B 上取 `riverSmooth = 3` 个子段。
`prev[r]` 定义为「**汇水面积最大的、已经成河的上游邻居**」（面积最大的那条才是干流）。

**为什么接点必须取「弦中点」**：相邻两格在接点处共享同一个点，
且 `A` 处的横向向量取**上游边的 `side`**、`B` 处取**本边的 `side`**——
于是相邻两格在接点处的**位置 / 横向向量 / 半径 / 宽度全部一致**
→ 整条河在接点处 **C1 连续**，弯道自然、汇流处无缝。
半径也取两点半径的平均（`rA = (vr[prev]+vr[r])/2`），接点两端一致。

**三个踩过的坑**（都写在代码注释里，别删）：

| 坑 | 症状 | 原因 | 修法 |
|---|---|---|---|
| 接点直接用了**弦中点坐标** | 每条河变成**断续的虚线香肠** | `\|mid\| = cos(半格角) ≈ 0.9995 < 1`，落到球面**以下**被球体挡住 → 每格的头 1/K 段被裁掉 | A/B 一律先**归一化成单位方向**，采样后再乘半径 |
| 子段的**近端用了本采样点的宽度** | 接点处出现**宽度台阶 / 缺口** | 两个子段在共享点上的半宽不同 | 近端用**上一个采样点**的半宽，子段内宽度线性渐变 |
| Bezier 的三个控制点都在球面上 | 采样点略切进球内 | 3D 空间里的 Bezier 不是测地线 | 每个采样点**重新归一化 + 乘插值半径** |

**效果对比**（`level 5`，同一份地形）：

| | M2（直 quad） | v3.0（Bezier K=3） |
|---|---|---|
| 河段四边形数 | 1007 | 2598（≈ 3×，draw call 不变） |
| 顶点 / 索引 | 4028 / 6042 | 10392 / 15588 |
| 视觉 | 120° 硬折角，像闪电 | **平滑弯道，像河** |

> `riverSmooth = 1` 即可**关掉平滑**回到 M2 行为（用于 A/B 对照）。

#### ★ 河道判据：两级门槛（M2 的关键修正，纯渲染层）

```js
const isDryLand = T.elevation[r] > cfg.seaLevel && T.isLake[r] === 0;
if (isDryLand && T.area[r] >= R.riverAreaThreshold) {      // ① 拓扑门槛
  if (T.flow[r] >= R.riverFlowMin) {                       // ② 水量门槛
    const t = clamp(T.flow[r] / maxFlow, 0, 1);
    wid[r] = lerp(R.riverMinWidth, R.riverMaxWidth, t ** R.riverWidthBias);
  }
}
```

| 门槛 | 默认 | 管什么 | 为什么必须存在 |
|---|---|---|---|
| `riverAreaThreshold` | **5**（格） | **拓扑**：上游汇水面积够大才算河道 | 挡住「海岸峭壁上每格各自入海」的假河道 |
| `riverFlowMin` | **0.10** | **水量**：流量太小视为干河床 | 挡住「沙漠里汇水面积大但没水」的干谷 |

**为什么这是必须的**（完整实测过程，别删）：

1. 最早的判据是 `flow > riverThreshold × riverTribFactor`（即 `flow > 1.0`）。
   在整球截图上看，河网呈现明显的**梳齿 / 鱼骨状**——一条主沟两侧排着等距、等长的平行短线。
   放大到 1:8 才看清：那是**每一个临海格都各自向海里画一段**（海岸是「峡湾型」峭壁时，
   几十个临海格的入海方向近乎平行 → 视觉上就是排线阴影）。
2. 量化指标是**孤立划占比**（上下游都没有被绘制的邻段）：
   - 旧判据 `flow > 1.0`：332 段，**孤立划 30.7%**，最长链 8
   - M2 判据 `area ≥ 5 & flow ≥ 0.10`：387 段，**孤立划 18.3%**，最长链 10
   - **v3.0（大陆掩码后）**：866 河道格 / 2598 缎带四边形，**孤立划 8.1%**，最长链 **16**
3. 试过但**没用**的方案（记录在案，避免以后重复踩）：
   - ❌ 「要求该格接受上游来水（`up[r] === 1`）」——实测 `dropped === 0`，
     因为除了地形局部最高点，任何格子都有邻居向它下坡，这个条件恒真，是**空操作**。
   - ❌ 降 `detailAmp` / 减 FBM octave / 加大陆尺度（`noiseScale 1.8 → 1.0`、`octaves 6 → 4`）：
     流路长度只从 2.52 涨到 4.44 格，孤立划依旧一片。**问题不在高频噪声，在「水到海里只要 2.5 格」。**
   - ❌ 提高 `riverThreshold`：只会把河删光（cut 5.0 → 20 段），不会把河变长。
4. 最终结论：**判据要从「流量幅值」换成「上游汇水面积」**。面积是单调不减的拓扑量，
   沿河链天然连续，且完全不受湿度噪声污染——这是 GIS 里的标准做法，
   而在我们的场景里它恰好精确地剔除了「面积极小的临海格」。

**河宽用 `flow` 而不是 `area`**：宽度表达的是「这条河有多少水」，`flow` 更合适；
而「是不是河」用 `area`，因为它只关心地形。两个量各司其职，互不干扰。

**这套判据是旧判据的严格推广**：令 `area = 1`、`flowMin = 1.0` 就退化成原来的 `flow > 1.0`
（headless 有一条断言在守这件事：实测 410 / 410 完全一致）。

#### 无缝与「河口不收窄」

- ★ 横向向量 `side` **按 region 算一次并共享**，不是每段独立算。相邻河段在端点处共用同一个
  region，共享 `side` 意味着两条段在该点的两个顶点位置**完全一致** → 汇流/拐弯处天然无缝。
- 下游端宽度取 `max(wid[r], wid[d])`：河口处 `d` 是海洋（`flow = 0 → 宽度 0`），
  若直接取 `wid[d]` 会让入海口突然收窄成一条尖线，很假。
- 河流**不画在湖面与海面上**（`isDryLand` 判断）：那是汇，水面由湖面层负责。

#### 主河道 / 支流两级配色

`T.isRiver`（算法层，`flow ≥ riverThreshold`）只用来决定**颜色档位**：
主河道 `#2f7ba5`、支流 `#5f9fba`。渲染层把不符合两级门槛的格子剔除，但**不改 `isRiver` / `biome`**。

#### 湖泊水面

直接复用 §2.8 的 `filled`——湖格半径抬到 `1 + relief·(filled−seaLevel)/(1−seaLevel)`，
颜色用陆色向 `lakeColor #3f9ab0` 混合（`lakeBlend = 0.62`），`isEndorheic` 为真时用 `saltLakeColor #2d7f86`（更深的蓝绿）。
**湖面天然平整**（因为有 `filled`）——`reliefScale > 0` 时它就是一个平的「水面壳」浮在湖底之上；
`reliefScale = 0`（默认）时它和陆地同半径，靠**顶点色**区分。
**注意：湖面不是独立几何、也不是贴花层**，它是 `planetMesh` 里的一个顶点色分支（`vertexRadius` 走 `filled`）——
所以湖面**不存在**被地形遮挡的问题，只有湖岸墨线才是贴花（见 §3.6.1）。
湖岸另有墨线圈（`lakeShoreColor #1d4a5c`，`lakeShoreWidth = 0.0030`），与海岸墨线合并成同一个 Mesh。

> 用户 **决策 4 补充** 的三条都在代码里：
> ① `lake_depth = filled_elevation − original_elevation`（`T.lakeDepth`）；
> ② 湖面画在 `filled`、地形画在 `original`（`vertexRadius` 里 `isLake` 走 `filled`，否则走 `elevation`）；
> ③ `is_endorheic` 字段**已经留出来**（`T.isEndorheic`，判据 = 所在连通湖泊的平均降雨 < `hydro.endorheicRain`）。
> 文档明确标注：**这是「气候代理判据」，不是拓扑判据** ——
> priority-flood 保证每个格子的下坡链最终都能到海洋，严格意义上球面上不存在无出口的洼地。
> 实测 level 5：163 个湖格里 115 格被判为内流（40 个流域）。

### 3.6.1 ★ 贴花层（墨线 / 河流）与 `reliefScale` 的因果与风险

**墨线**（海岸 + 湖岸）与**河流缎带**都是**贴在球面上的贴花层**：几何顶点按 `center × (1 + lift)` 抬高一个固定量
（`inkLift = 0.0009`、`riverLift = 0.0090`）。
（**湖面不是贴花层**——它是 `planetMesh` 的顶点色分支，半径走 `filled`，见 §3.6。）

**因此存在一个硬约束**：当地形起伏 `reliefScale > lift` 时，斜视角度下地形三角形会把贴花层**挡住**。
实测 `reliefScale = 0.02` + `riverLift = 0.009` 时，屏幕上的河流像素只剩约 **17%**；
把材质的 `depthFunc` 改成 `GreaterDepth` 立刻显示完整河网——证明这是**真实深度遮挡**，不是几何或材质 bug
（`polygonOffset` 无效，因为贴花层本身在最外层时并不需要它）。

- **默认 `reliefScale = 0.000`（纯球面）** —— 这是修复手段，不是省事：纯球面下贴花层恒在最外层，零遮挡。
- 山脉起伏仍然清晰可见，因为**明暗是逐顶点烘进顶点色的**（§3.4），与几何起伏完全解耦。
- 面板滑杆保留并改名为 `reliefScale（>0 会遮墨线）`，方便将来想开起伏时做对比。
- **若将来真要开起伏**：必须保证 `riverLift / inkLift > reliefScale`，或改成「贴花层深度预通道」方案。

### 3.7 配色表（表驱动，不是 `CONFIG.palette`）

实现把配色拆成**几个物理载体**，而不是塞进 `CONFIG`（那样每改一次颜色都要动配置结构）：

| 载体 | 用途 |
|---|---|
| `WHITTAKER`（3×3 常量） | 陆色：温度（冷→热）× 湿度（干→湿）双线性插值 |
| `waterColorAt` 内的 `ramp` 锚点 | 海色：按深度 4 段插值 + 3 条高斯浅水带 |
| `BIOME_VIEW_COLOR`（17 项数组） | **仅用于「生物群系」调试视图**，与 `paletteAt` 是两条路 |

| 用途 | 实际取值（`CONFIG.render`） |
|---|---|
| 深海 → 浅海 | 见 `waterColorAt`：`[0.31,0.60,0.71] → [0.24,0.48,0.63] → [0.13,0.25,0.42] → [0.06,0.09,0.20]`，另有 3 条高斯亮蓝带（中心在 `d = 0.020 / 0.055 / 0.100`，向 mapgen4 `colormap.ts` 的等深线致敬） |
| 低地 → 高山 | 由 `(temp, moist)` 定位 Whittaker 色，再按 `snowLine = 0.78` / 低温 fade 到 `[0.845,0.865,0.905]`（雪） |
| Whittaker 3×3 网格 | `[[0.72,0.72,0.66] [0.55,0.61,0.59] [0.29,0.42,0.35]]` / `[[0.72,0.67,0.47] [0.60,0.66,0.37] [0.25,0.49,0.31]]` / `[[0.83,0.74,0.53] [0.55,0.60,0.28] [0.15,0.42,0.24]]`（行 = 冷→热，列 = 干→湿） |
| 湖泊水面 | `lakeColor #3f9ab0`（淡水）/ `saltLakeColor #2d7f86`（内流咸水），按 `lakeBlend = 0.62` 替换陆色 |
| 河流缎带 | 主河道 `riverColor #2f7ba5` / 支流 `riverTribColor #5f9fba`，`riverOpacity = 0.92` |
| 海岸墨线 | `coastColor #1b2a33`，全宽 `coastWidth = 0.0042`，`coastOpacity = 0.55` |
| 湖岸墨线 | `lakeShoreColor #1d4a5c`，全宽 `lakeShoreWidth = 0.0030`（与海岸墨线合并成同一个 Mesh） |
| 纸纹（M2 已实现） | `paperTint #efe6d5` @ `paperMix = 0.070` + 逐顶点乘性颗粒 `paperNoise = 0.085`（`paperScale = 40`） |

**关键约束**：所有过渡必须是**连续插值**。旧方案「每图块一个纯色」被明确废弃。
headless 有一条断言在守这件事：`paletteAt` 在陆/海内部相邻采样的最大跳变 < 0.12
（实测最大 Δ = 0.0632 @ `e = 0.92`）。

### 3.8 质感（M2 已实现）

mapgen4 源码里的 `// TODO: add noise texture based on biome` 说明它当年没做纸纹。我们补上，但**仍然留在顶点色里**（不引入 shader）：

1. **纸纹底色**：整体向暖白 `#efe6d5` 混合 `paperMix = 0.070`，让画面不像纯数字渲染色。
2. **逐顶点微噪点**：用 L0 的 `makeNoise3D(0x51a2e7)`（**固定种子，与地形种子无关**，
   保证同一地形换种子时颗粒纹理不变）采样 `center × paperScale`（`paperScale = 40`），
   以**乘性**方式给顶点色乘 `1 ± paperNoise`，再向 `paperTint` 混合，最后统一乘烘焙光照 `vShade`。
   level 5 有 30722 个顶点，密度足够形成细颗粒感。
   实测：100% 顶点受影响，最大 Δ ≈ 0.076（幅度温和，只加颗粒不改配色）。
3. **uv 顺序（重要）**：`refreshVertexColors` 是两段式的——
   先逐顶点算底色，再统一叠「纸纹 × 纸底 × `vShade`」。
   顺序反了会让纸底把光照抹平。
4. **颜色不硬边**：v1 是「每图块纯色」，M2 用**逐顶点连续插值 + 墨线**替代方案 B 的 blit 模糊——结构靠墨线锐利，色块靠插值柔和。

> **雪色不能太亮**：Whittaker 后的雪色是 `[0.845,0.865,0.905]` 而不是 `[0.95,0.96,0.97]`，
> 因为 hillshade 最大到 1.17，近白会被顶过 1.0 → 大片「曝白」看不出起伏。

### 3.9 Godot 移植预判表

| HTML 原型（Three.js） | Godot 4 对应 | 备注 |
|---|---|---|
| `THREE.BufferGeometry` + `vertexColors` | `ArrayMesh` + `SurfaceTool.set_color` + `StandardMaterial3D.vertex_color_use_as_albedo = true` | 顶点色语义完全一致 |
| `MeshBasicMaterial({vertexColors})` | `StandardMaterial3D`，`albedo_color = white`，**关灯或只用弱 `DirectionalLight3D`** | 光照已烘进顶点色 |
| `LineSegments`（M1 的海岸线 / 河流骨架，1px） | `ArrayMesh` + `PrimitiveMesh.PRIMITIVE_LINES` | M2 已**全部废弃**：海岸线 / 湖岸 / 河流都改成有宽度的缎带 Mesh |
| ★ 缎带层（海岸墨线 + 湖岸墨线合并 / 河流三角带） | `SurfaceTool` 生成 `PRIMITIVE_TRIANGLES` 带状网格，顶点色区分用途 | 两份 Mesh、`DoubleSide`、`depthWrite = false`、不透明混合；靠固定 `lift` 贴在球面外 |
| `MeshBasicMaterial({ transparent, side: DoubleSide, depthWrite: false })` + `forceSinglePass` | `StandardMaterial3D`：`transparency = ALPHA`、`cull_mode = DISABLED`、`depth_draw_mode = NEVER`、`no_depth_test = false` | ★ three.js 对「双面 + 透明」默认分两趟渲染，`forceSinglePass` 把 draw call 从 5 压回 3；Godot 没这个问题 |
| `OrbitControls` | `Camera3D` + 自定义 `_unhandled_input` | 移植时重写，约 60 行 |
| `Raycaster` + `faceIndex` | `PhysicsDirectSpaceState3D.intersect_ray` + 或 `MeshData` 的 `ARRAY_INDEX` 反查 | Godot 需要 `MeshInstance3D.create_trimesh_collision()` 或用相机射线与球求交 |
| `requestAnimationFrame` 渲染循环 | `_process()` | — |
| `CONFIG` 普通对象 | `Resource` / `@export` 变量 | 面板改成 Inspector |
| `paletteAt` | 同一个函数（逐顶点 `set_color`），或烘成 `ImageTexture3D` | ★ 唯一接口，两种都行 |
| 参数面板（原生 `<input>`） | `@export` + Inspector（原型期可保留为一个 `Control` 竖排） | 用户已说明面板会被替换 |

---

## 4. 数据结构改造

### 4.1 逻辑模型：`TileData`

每个地块（region）逻辑上持有：

```ts
interface TileData {
  // ── 拓扑（L1，构建后只读）──
  index:        int;          // region 索引
  center:       vec3;         // 单位球面中心
  neighbors:    int[];        // 邻接（5 或 6 个，升序）
  triRing:      int[];        // 绕行一圈的三角形索引（5 或 6 个，环序）

  // ── 海拔层（L2 步 1–2）──
  elevationRaw: float;        // z-score 之前的原始值（调试用）
  elevation:    float;        // [0,1]，0 = 最低，1 = 最高
  mountainDist: float;        // 到最近峰点的球面距离（归一化前）
  mountain:     float;        // [0,1]，山脉强度

  // ── 气候层（L2 步 3–5）──
  temperature:  float;        // [0,1]
  wind:         vec3;         // 单位切向向量
  humidity:     float;        // [0,1]，迭代中的工作变量
  rainfall:     float;        // [0,~1]，迭代收敛后的原始降雨
  moisture:     float;        // [0,1]，rainfall / rainReference 归一化

  // ── 水文层（L2 步 6–8）──
  downslope:    int;          // 流向的邻居索引，-1 = 无（海洋 / 盆地根）
  filled:       float;        // priority-flood 填平后高程（湖面高程）
  lakeDepth:    float;        // filled − elevation（陆地才有意义）
  flow:         float;        // 累积流量（湿度加权）
  area:         int;          // ★ 上游汇水面积（含自身，单位 = 格）；只依赖拓扑
  isLake:       bool;
  isEndorheic:  bool;         // 内流盆地（气候代理判据，见 §2.8）
  waterLevel:   float;        // = filled
  isRiver:      bool;         // flow ≥ riverThreshold && elevation > seaLevel

  // ── 生物群系（L2 步 9）──
  biome:        string;       // BIOME 枚举值

  // ── 派生（L3）──
  shade:        float;        // 烘焙光照系数
  color:        [r,g,b];      // paletteAt 的结果
}
```

### 4.2 物理模型：SoA（结构化数组）

10242 个对象在降雨迭代里要跑 12 轮 × 6 邻居 ≈ 74 万次属性访问，用对象会明显变慢。实现上采用 **SoA**：

```js
// [Godot-ready] SoA —— Godot 里对应一组 PackedFloat32Array / PackedInt32Array
const T = {
  n,
  center:     [ [x,y,z], ... ],   // 变长 → 普通数组（只读几何）
  neighbors:  [ Int32Array(6), ... ],  // 变长 → Int32Array 数组
  triRing:    [ Int32Array(6), ... ],
  elevationRaw:Float64Array(n),     // 步 1 的原始地形（未标准化）
  elevation:  Float64Array(n),
  continent:  Float64Array(n),      // ★ 大陆掩码 C ∈ [0,1]（M2.5 新增）
  mountain:   Float64Array(n),      // 山脉权重 [0,1]
  mountainDist:Float64Array(n),     // 到最近峰点的球面距离
  mountainStrength:Float64Array(n),
  temperature:Float64Array(n),
  rainfall:   Float64Array(n),
  humidity:   Float64Array(n),
  moisture:   Float64Array(n),
  downslope:  Int32Array(n),
  filled:     Float64Array(n),
  lakeDepth:  Float64Array(n),
  flow:       Float64Array(n),
  area:       Int32Array(n),        // ★ 上游汇水面积（格）
  waterLevel: Float64Array(n),
  isLake:     Uint8Array(n),
  isEndorheic:Uint8Array(n),
  isRiver:    Uint8Array(n),
  biome:      Uint8Array(n),
  shade:      Float32Array(n),
  wind:       Float64Array(n * 3),   // 扁平化，避免小数组分配
  floodOrder: Int32Array(n),
};
```

**为什么 SoA 反而更利于移植**：Godot 4 原生有 `PackedFloat32Array` / `PackedInt32Array`，与 `Float64Array` / `Int32Array` 语义一一对应；而 `Array[Dictionary]` 反而要写装箱/拆箱的胶水。文档里保留 `TileData` 的逻辑视图用于阅读，实现时用上表的物理视图。

> **`wind` 扁平化成 `Float64Array(n*3)`** 是刻意的：降雨迭代里每个格子都要读自己的风向量，扁平数组能避免 GC 压力。

---

## 5. 执行流程与分层

### 5.1 分层

| 层 | 名称 | 依赖 | Godot 可移植性 |
|---|---|---|---|
| **L0** | core | **零依赖**（连 Three.js 都不依赖） | ✅ 完全可移植 |
| **L1** | mesh | 只依赖 L0 | ✅ 完全可移植 |
| **L2** | terrain | 只依赖 L0/L1，**纯数据变换** | ✅ 完全可移植 |
| **L3** | draw | Three.js / BufferGeometry | ⚠️ 换用 Godot 管线，但**语义一致** |
| **L4** | app | Three.js + DOM | ⚠️ 换用 Godot 场景树 |

**硬约束**：L0–L2 里**不允许出现 `THREE`**，连 `THREE.Vector3` 都不行——全部用普通数组 `[x,y,z]` 和 L0 的向量函数。这样整条因果链可以用「复制粘贴 + 语法替换」翻译成 GDScript。

### 5.2 初始化流程（只跑一次）

```
init()
 ├─ L1: buildIcosphere()            → verts, faces
 ├─ L1: subdivideIcosahedron(lv)    → 细分
 ├─ L1: buildDual()                 → triCenters, regionTris, triAcross, nR, nT
 ├─ L1: buildNeighbors()            → neighbors[]
 ├─ 构建渲染网格骨架（region 与三角形重心的球面位置）
 └─ regenerate()                    → 见下
```

**`level 5` 下 L1 的耗时必须测量**（用户明确要求 ≤ 1–2 秒）。实测 **31.7 ms**（icosphere + dual + 邻接表全程），余量 50 倍以上，**无需 `requestIdleCallback` 分片**。所有阶段仍都 `await frame()` 让出主线程并显示进度文案（首次生成含着色器编译，约 570–660 ms，前端已加加载遮罩）。

### 5.3 重生成流程（滑杆每次变化都跑）

```
regenerate()
 ├─ L2: assignElevation()          ← FBM + 大陆掩码 + 山脉脊线增强
 ├─ L2: placeMountainPeaks()        ← Poisson-disk（球面）
 ├─ L2: mountainDistanceField()     ← 最小堆 BFS
 ├─ L2: assignElevation 二次 passthrough（把 mountain 融进海拔）
 ├─ L2: assignTemperature()
 ├─ L2: assignWind()
 ├─ L2: solveRainfall()             ← Gauss-Seidel + 暖启动
 ├─ L2: priorityFlood()             ← 产出 downslope / filled / floodOrder
 ├─ L2: detectLakes()               ← lakeDepth / isLake / isEndorheic
 ├─ L2: accumulateFlow()            ← 反向遍历 floodOrder；同时累 flow 与 area
 ├─ L2: classifyBiome()（逐格）
 ├─ L3: bakeVertexShading()         ← 逐 region hillshade（用 elevation 场梯度，与 reliefScale 无关）
 ├─ L3: buildRenderMesh() + refreshVertexColors()   ← 顶点色（底色 + 纸纹/纸底 + × shade）
 ├─ L3: buildInkGeometry()          ← 海岸 + 湖岸等值线 → 缎带（1 个 Mesh）
 ├─ L3: buildRiverRibbon()          ← 两级门槛 → 变宽度缎带（1 个 Mesh）
 └─ L4: 更新 HUD 统计
```

**分帧执行**：上面每个 L2 步骤之间插一个 `await nextFrame()`，配合加载提示，主线程不会被长时间独占（用户明确要求）。实测 `level 5` 全流程约 108–121ms，分帧后每帧 < 80ms，UI 无卡顿。

### 5.4 绘制流程（每帧）

```
render()
 ├─ controls.update()               ← OrbitControls
 ├─ doPick()                        ← ★ 仅当「鼠标移动」或「相机位姿变化且距上次 >120ms」才做射线测试
 │    └─ faceIndex → S.triToRegion → region
 │    └─ 若 region 变化 → drawOutline(region)（只改 6 个浮点数）+ renderTileInfo()
 └─ renderer.render(scene, camera)  ← 3 draw call：planet + ink（海岸/湖岸）+ river
                                      悬停 / 选中时 +1：hover（LineLoop）
```

> 高亮对象（M3）不算在常规路径里，只有 hover 命中或已选中时才可见。
> **一次拾取要对 61440 个三角形做射线测试**，所以自动旋转时**限流 120 ms**
> （鼠标移动走即时通道，零等待）——否则每帧都拾取会白吃几毫秒。
> 三个 Mesh 全部是 `MeshBasicMaterial({ vertexColors: true })`，
> 墨线与河流额外加 `transparent / depthWrite: false / forceSinglePass: true`
> （`forceSinglePass` 是必需的：three.js 对「双面 + 透明」材质默认分两趟渲染，会令 draw call 从 3 变 5）。

---

## 6. L0–L4 公开函数签名清单

用户要求逐层对照，方便移植 Godot 时逐层核对。**L0–L2 全部标注 `[Godot-ready]`**。

### L0 core —— 纯数学，零依赖

```js
// [Godot-ready] 纯算法，可直接翻译成 GDScript
function mulberry32(seed: int): () => float          // 确定性 PRNG，同种子同序列
function makeNoise3D(seed: int): (x,y,z) => float     // 3D 梯度噪声，值域约 [-1,1]
function makeFbm(noise3, octaves: int, lacunarity: float, gain: float): (x,y,z) => float

function v3Add(a,b): vec3          function v3Sub(a,b): vec3
function v3Mul(a,s): vec3          function v3Div(a,s): vec3
function v3Dot(a,b): float         function v3Cross(a,b): vec3
function v3Len(a): float           function v3Norm(a): vec3
function v3Dist(a,b): float        function v3Lerp(a,b,t): vec3
function v3PerpBasis(n): [e1, e2]  // 球面切平面正交基（极点安全）

function clamp(x,lo,hi): float     function lerp(a,b,t): float
function smoothstep(e0,e1,x): float
function percentile(arr, p): float

class MinHeap { push(key: int, prio: float): void
                pop(): int
                get size(): int }
```

### L1 mesh —— 拓扑与几何

```js
// [Godot-ready] 纯算法，可直接翻译成 GDScript
function buildIcosphere(): { verts: vec3[], faces: int[3][] }
function subdivideIcosahedron(verts, faces, level: int): { verts, faces }
function buildDual(verts, faces): {
    nR: int, nT: int,
    triCenters: vec3[],          // 每个原三角形 = 一个 dual 顶点
    regionTris: int[][],         // 绕 region 的三角形环序
    triAcross:  Int32Array,      // 3*t+i → 对侧三角形（-1 = 边界）
    edgeOfDir:  (a,b) => t,      // 有向边 → 三角形（内部用 Map）
}
function buildNeighbors(verts, faces, dual): Int32Array[]   // 度数 5 或 6，升序
function sphereEdgeLength(a, b): float                     // 球面边长（弧度）
function sphereInterp(a, b, t): vec3                       // 球面线性插值（先 lerp 再 norm）
```

### L2 terrain —— 因果链，纯数据变换

```js
// [Godot-ready] 纯算法，可直接翻译成 GDScript
function createTerrain(verts, faces, dual, neighbors, cfg): T   // 分配 SoA

// 步 1：海拔 + 大陆掩码
function assignElevation(T, cfg, rng): void                  // 写 elevationRaw / continent（掩码 C）
                                                             // ★ 掩码在函数尾部由包络 FBM 归一化（σ 单位）得到

// 步 2：山脉
function placeMountainPeaks(T, cfg, rng): int[]              // Poisson-disk（球面）
function mountainDistanceField(T, peaks, cfg, rng): void     // 最小堆 BFS，写 mountainDist / mountain
function applyMountainRidge(T, cfg): void                    // 脊线抬升 → z-score → 掩码偏移 dz → clamp(−1,1) → elevation

// 步 3：温度
function assignTemperature(T, cfg): void                     // 写 temperature

// 步 4：风
function assignWind(T, cfg): void                            // 写 wind[]

// 步 5：降雨
function climatologyRain(T, i, cfg): float                   // 解析纬向气候学解（暖启动用）
function solveRainfall(T, cfg): { iterations: int, residual: float }
                                                             // 写 humidity / rainfall / moisture

// 步 6：下坡
function priorityFlood(T, cfg): void                         // 写 downslope / filled / floodOrder

// 步 7：湖泊
function detectLakes(T, cfg): void                           // 写 lakeDepth / isLake / isEndorheic / waterLevel

// 步 8：流量与汇水面积
function accumulateFlow(T, cfg): { maxFlow: float, riverCount: int, maxArea: int }
                                                             // 写 flow / area / isRiver

// 步 9：生物群系
function classifyBiome(T, i, cfg): int                       // 写 biome[i]
function classifyAllBiomes(T, cfg): void

// 只读查询（HUD / 调试面板用，算法层不依赖）
function sampleLatitude(T, i): float
function normalizeMoisture(T, cfg): void
```

### L3 draw —— Three.js，Godot 换管线

```js
// [渲染层] 在 Godot 中对应顶点色 / SurfaceTool / ArrayMesh
// ★ paletteAt 是唯一的 算法↔渲染 接口，建议原样移植
function paletteAt(elev, temp, moist, cfg): [r,g,b]
function boxBlurPalette  // 可选：扩成 3D 纹理时的辅助

function bakeVertexShading(T, cfg): Float32Array            // 逐 region hillshade → shade
function buildRenderMesh(T, cfg): {
    positions: Float32Array, colors: Float32Array, index: Uint32Array,
    vertexScalar: Float32Array,   // 逐顶点 (elev,temp,moist,flow,lakeDepth,salt)，调参时只重算 colors
    triToRegion: Int32Array,      // faceIndex → region，用于 raycast 拾取（O(1)）
}
function refreshVertexColors(S, T, cfg): void                // 切换调试视图 / 改配色时只重算颜色

// ★ M2 缎带层（海岸墨线 + 湖岸墨线 + 河流，全部是「贴球面的贴花层」）
function hexToRgb01(hex): [r,g,b]                            // 墨色十六进制 → 0–1
function ramp(stops, x): [r,g,b]                             // 多段线性插值（水色 / 调试视图共用）
function waterColorAt(elev, cfg): [r,g,b]
function whittakerAt(tc, mc): [r,g,b]
function paletteAt(elev, temp, moist, cfg): [r,g,b]          // ★ 算法↔渲染唯一接口
function viewColorAt(view, elev, temp, moist, flow, lakeDepth, logMaxFlow, cfg): [r,g,b]

function vertexRadius(T, i, cfg): float                      // 贴花层的抬升半径（含 lift）

const PAPER_NOISE                              // 固定种子的纸纹噪声（与地形种子无关）
function buildCoastLine(T, cfg): { segments: [...] }         // 1a 海岸等值线段（marching triangles）
function buildLakeShoreSegments(T, cfg): { segments: [...] } // 1b 湖岸等值线段
function appendRibbon(pos, col, idx, segs, width, rgb): int  // 把线段集合缎带化（逐片段算 side，两端外扩半宽以补缝）
function buildInkGeometry(T, cfg): { positions, colors, index, coastSegments, shoreSegments }
                                                             // ★ 海岸 + 湖岸合并成 1 个 Mesh（顶点色区分两种墨色）
function buildRiverRibbon(T, cfg): {
    positions, colors, index,
    segments, stems, tribes,                  // 段数分解
    channelCells, dryDropped,                 // 两级门槛的统计（面板 / 测试用）
    areaCut, flowMin, maxFlow,
}
                                                             // ★ 可变宽度河流缎带，reuse side 保证无缝
```

### L4 app —— 场景 / 相机 / 交互 / HUD

```js
// [应用层] 在 Godot 中对应 场景树 + Control 节点
const nextFrame = () => Promise<void>        // requestAnimationFrame 包装
function showStatus(t: string): void
function showOverlay(text, sub): void / hideOverlay(): void
function initAlgorithm(): void               // L1 构建 + createTerrain（只跑一次）
async function regenerate(): Promise<void>   // 分帧执行（每步 await nextFrame），带加载遮罩
async function quickUpdate(kind): Promise<void>   // 'relief' | 'river' | 'color'（不重跑因果链）
function recomputeRivers(): void             // 只按新门槛重判河道
function rebuildGeometry(): void             // 重建地形 + 墨线 + 河流三个 Mesh（拖滑杆时只重建需要的）
function emptyFallback(arr, n): Float32Array
function makeColoredGeometry(g): THREE.BufferGeometry
function syncLineVisibility(): void          // 墨线 / 河流只在 elev / terrain / biome 视图显示
function updateHud(): void
function renderTileInfo(): void              // hover HUD 那一栏
const VIEWS                                  // [['elev','海拔'],['temp','温度'],['rain','降雨'],['flow','流量'],['biome','生物群系'],['terrain','地形色 paletteAt']]
function setView(mode): void
function buildViewButtons(): void
function buildPanel(): void                  // 原生 <input type="range"> / <select> + debounce
function addNumber(label, get, set): void
function addSelect(label, options, get, set): void
function addSlider(label, min, max, step, get, set, apply, fmt): void
function buildScene(): void                  // Renderer / Scene / Camera / OrbitControls / 四个几何对象
function doPick(): void                      // Raycaster → faceIndex → triToRegion；相机移动时限流 120 ms
/* ── M3 交互 / 导出 ── */
function drawOutline(r): void                // 把一个 region 的 dual 环轮廓写进 hoverObj（LineLoop，≤6 顶点）
function refreshOutline(): void              // 悬停优先，否则落回 selectedRegion
function setSelected(r): void                // 点击选中 / Esc 取消（r = -1）
function buildExport(): object               // 纯数据汇总（meta + config + stats + biomeCounts + quantiles + timingMs）
function exportJson(): object                // Blob 下载 + 返回同一份数据
function onResize(): void
function animate(now): void
async function main(): Promise<void>         // 入口：initAlgorithm → regenerate → setView → animate
```

> 与本文档早期草稿的差别：草稿写的 `init()` / `setDebugMode()` / `setupPanel()` /
> `setupPicking()` / `updateHud(tile)` 在实现里改名或合并成了上面这组
> （`initAlgorithm` / `setView` / `buildPanel` / `doPick` / `updateHud`）。
> `rebuildGeometry()` 是**唯一的几何重建入口**，三种滑杆档位都走它。
> 滑杆的 `apply` 参数分四档，直接决定「拖这个滑杆要重算多少」：

| `apply` | 滑杆 | 重算范围 | 实测耗时 |
|---|---|---|---|
| `'full'` | `seed` `seaLevel` `continentalEnvelope` `continentScale` `continentBias` `continentBand` `oceanDepth` `lakeMinDepth` `mountainSharpness` `raininess` `subtropicalStrength` `saturationFloor` `rainShadow` `lapseRate` `windMode` `rainSolver` | 整条因果链 + 几何 | ~570–660 ms（debounce 220ms） |
| `'river'` | `riverThreshold` `riverArea` `riverFlowMin` `riverWidth` | 只重判河道 + 重建河流缎带 | ~90 ms（debounce 90ms） |
| `'relief'` | `reliefScale` | 只重算光照 + 几何 | ~90 ms |
| `'color'` | `paperMix` `paperNoise`、视图切换 | 只重写顶点色 attribute | **~5.5 ms**（debounce 0ms） |

> `regenerate()` 用 `busy` + `queuedFull` 两个标志做**并发保护**：
> 生成期间再拖滑杆不会叠加多份任务，只在结束时补跑最后一次。
> 另有调试入口 `__PLANET__.regen()`（`ab-terrain.mjs` / `ab-river.mjs` 依赖它改 `CONFIG` 后重跑）。

---

## 7. 参数配置表

全部集中在 `CONFIG` 对象里。**噪声种子固定，同种子必须完全一致。**

> 下表 = `index.html` 里 `CONFIG` 的**真实取值**（与代码逐键核对过，用
> `check-cfg.mjs` 做静态扫描可复现）。「面板」列 ✅ 表示有实时控件。

### 7.1 网格（`CONFIG` 顶层标量）

| 键 | 默认 | 面板 | 说明 |
|---|---|---|---|
| `level` | `5` | | icosphere 细分级别；5 → 10242 region / 30722 渲染顶点 / 1 draw call |
| `seaLevel` | **`0.20`** | ✅ | ★ **开大陆掩码后这才是「陆地占比」主旋钮**。海拔坐标系里**可以是负数**（掩码会额外压低大洋）。范围 −0.10–0.45。0.20 → 陆地 67.8% |
| `seed` | `1337` | ✅ | 噪声种子（数值输入框）；同种子结果逐位一致 |
| `view` | `'terrain'` | ✅ | 当前调试视图（右侧按钮组） |

### 7.2 地形（`CONFIG.terrain`，L2 步 1–3）

| 键 | 默认 | 面板 | 说明 |
|---|---|---|---|
| `noiseScale` | `1.8` | | 大陆/丘陵 FBM 频率 |
| `octaves` | `6` | | FBM 层数 |
| `lacunarity` | `2.0` | | FBM 频率倍率 |
| `persistence` | `0.5` | | FBM 增益 |
| `detailScale` | `16.0` | | **细节粗糙度频率**（周期 ≈ 2–3 格）。★ 湖泊数量由它决定 |
| `detailAmp` | `0.050` | | 细节粗糙度幅度 |
| `ridgeScale` | `3.2` | | 山脉脊线噪声频率 |
| `ridgeAmp` | `0.60` | | 山脉脊线抬升幅度 |
| `elevationCenter` | `0.40` | | z-score 中心 |
| `elevationSpread` | `0.19` | | z-score 标准差（**让陆地占比与 `mountainSharpness` 解耦**） |
| `mountainSpacing` | `0.280` | | 球面 Poisson-disk 峰点最小间距（弧度）→ 决定峰点数（level 5 实测 109 个） |
| `mountainDensity` | `1.000` | | 候选点保留概率；**1.0 = 全部保留，密度只由 `spacing` 决定** |
| `mountainSharpness` | `9.8` | ✅ | ★ 山脉脊线增强倍率；内部 `/10` 归一 → `0.6–1.4`；范围 6–14 |
| `mountainWidth` | `0.200` | | 山脉影响半径（弧度）；决定山脉带宽 → 平原占比 |
| **`continentAmp`** | **`1.0`** | ✅ | ★ **大陆掩码强度**（0–1）：`C = 1 − amp·(1 − mz)`。**`0` = 关闭掩码 → 回到 M2 迷宫型世界**（A/B 对照用）。范围 0–1 |
| **`continentScale`** | **`0.70`** | ✅ | ★ 包络频率（**越小 → 大陆越大**）。范围 0.4–2.0 |
| **`continentOctaves`** | `2` | | 包络 FBM 层数（**1 层最稳**；2–3 层会碎出多块小陆） |
| **`continentBias`** | **`−0.80`** | ✅ | ★ 掩码阈值，**单位是标准差 σ**（越大 → 海洋越多 / 大陆越小）。范围 −1.3–0.2 |
| **`continentBand`** | **`0.12`** | ✅ | ★ 掩码过渡带半宽（σ；越大 → 海岸越破碎、越容易长群岛）。范围 0.05–0.45 |
| **`continentLandLift`** | **`0.0`** | | ★ 额外抬升大陆内部。**默认 0，不要动** —— 原因见 §2.4.1 |
| **`oceanDepth`** | **`0.80`** | ✅ | ★ z-score **之后**大陆外的压低量。决定大洋占比与**水深层次**；太大会把整个大洋压成均匀深海。范围 0–1.6 |
| `lapseRate` | `0.6` | ✅ | ★ 温度直减率（补充 1）；范围 0–1.2 |
| `tempJitter` | `0.05` | | 温度噪声抖动 |

> **已删除的旧参数**：`island` / `islandCenter` / `islandEdge` / `islandFalloff`
> （旧的「岛屿衰减掩码」）以及**空操作的 `continentBias`**（早期版本把包络当成
> **加性偏置**加进 `elevationRaw`，而 z-score 会把任何加性偏置**整体消掉** —— 完全无效）。
> 现在 `continentBias` 是「掩码阈值（σ 单位）」，语义与旧版**完全不同**。

### 7.3 风与降雨（`CONFIG.climate`，L2 步 4–5）

| 键 | 默认 | 面板 | 说明 |
|---|---|---|---|
| `windMode` | `'zonal'` | ✅ | ★ `'zonal'`（默认，三圈环流）\| `'uniform'`（单向风，调试） |
| `windMeridional` | `0.25` | | 纬向风带的经向分量 |
| `windUniformDir` | `[1,0,0]` | | `uniform` 模式的风向 |
| `raininess` | `0.9` | ✅ | ★ 全局降雨强度；范围 0–2 |
| `rainReference` | `0.40` | | `moisture = clamp(rainfall / rainReference, 0, 1)`；**固定参考值**，滑杆才能改变群系分布 |
| `convectiveRain` | `0.5` | | 平流水汽直接降水（mapgen4: `rainfall += raininess*humidity`） |
| `oceanEvaporation` | `0.35` | | 海洋向饱和湿度松弛的速率 |
| `landEvaporation` | **`0.55`** | ✅ | ★ **陆面蒸发速率**（v3.0 加回，见 §2.6.2）；范围 0–1 |
| `landSaturation` | **`0.55`** | | ★ 陆面蒸发饱和上限（再乘 `T^exp`：暖地湿、寒地干） |
| `evaporationExponent` | `2.0` | | 饱和湿度 ∝ `T^exp`（暖海蒸发快） |
| `saturationFloor` | `0.15` | ✅ | 冷海最低饱和湿度（极地海洋也干 → 极地荒漠）；范围 0–0.6 |
| `rainShadow` | `0.5` | ✅ | 超容量降水的提取率（mapgen4 `rain_shadow` 默认值）；范围 0–1 |
| `subtropicalLat` | `30` | | 副热带下沉中心纬度（度） |
| `subtropicalWidth` | `14` | | 副热带下沉带宽（度） |
| `subtropicalStrength` | **`0.62`** | ✅ | ★ 副热带下沉脱湿强度（**沙漠带唯一造得出来的路径**）；M2 是 0.45，v3.0 调到 0.62 才能让「副热带最干」成立。范围 0–0.8 |
| **`stormTrack`** | **`0.70`** | | ★ **中纬风暴带（极锋辐合带）降水强度**（v3.0 新增，见 §2.6.1）。`0` = 关（中纬会变最干） |
| **`stormTrackLat`** | **`48`** | | ★ 风暴带中心纬度（度） |
| **`stormTrackWidth`** | **`12`** | | ★ 风暴带宽度（度）；**不能太大**，否则会把雨带进副热带、救活「副热带最干」 |
| `rainMaxIter` | `400` | | 迭代上限 |
| `rainTolerance` | `1e-4` | | 收敛残差（L∞） |
| `rainSolver` | `'gaussSeidel'` | ✅ | ★ `'gaussSeidel'`（默认，暖启动）\| `'jacobi'`（调试） |

> **`landEvaporation` 的曲折历史**：M2 时**删掉**了它（当时理由：陆地湿度只由平流 +
> 容量溢出决定，加常量蒸散会污染雨影信号）；v3.0 **加回来**（陆地占比从 47% 涨到 68%，
> 超级大陆内陆没有陆面蒸发会干到不可用）。这是**参数依赖世界形态**的典型例子。
>
> **已删除的旧参数**：`orographic`（显式迎风/背风判定 —— mapgen4 的
> 「容量 = 1 − 陆地相对高度」已经涵盖雨影，见 §2.6）。

### 7.4 水文（`CONFIG.hydro`，L2 步 6–8）

| 键 | 默认 | 面板 | 说明 |
|---|---|---|---|
| `lakeMinDepth` | **`0.050`** | ✅ | ★★ **湖/河质量第一主旋钮**（见 §2.8.1）。M2 是 0.006；开大陆掩码后必须调大，否则「海绵化 + 六角螺帽」。范围 0.005–0.12 |
| `endorheicRain` | `0.10` | | 内流盆地判据：流域平均降雨阈值（≈ p63；**气候代理判据，非拓扑判据**） |
| `riverThreshold` | `2.0` | ✅ | ★ 算法层河流流量阈值（决定 `isRiver` / `BIOME.RIVER`）；实测 2.0 → level 5 ≈2.68% 陆地成河 |
| `flowGain` | `1.0` | | 产流 `= flowGain · moisture²`（mapgen4: `flow · moisture²`） |
| `allowNoOcean` | `true` | | 全陆地球的兜底（剩余格子各自作为盆地根入堆） |

> `riverLift` **不在**这个分组里 —— 它是纯渲染参数，已归入 `CONFIG.render`（见 7.5）。
> 早期实现把它写在 `hydro` 下，而读取处写的是 `cfg.render.riverLift` → `undefined` → 半径 NaN，
> 导致河流几何整体变成 NaN（见 §8.4 案例一）。
>
> **`isRiver` 与「渲染画不画河」是两件事**：`isRiver` 是算法层（只影响 `BIOME.RIVER` 与配色档位），
> 渲染层的两级门槛（`render.riverAreaThreshold` / `render.riverFlowMin`）单独决定缎带几何。见 §3.6。

### 7.5 渲染（`CONFIG.render`，L3）

**基础与光照**

| 键 | 默认 | 面板 | 说明 |
|---|---|---|---|
| `reliefScale` | **`0.000`** | ✅ | ★ 地形几何起伏幅度。**默认 0 = 纯球面**（原因见 §3.6.1：>`lift` 的起伏会挡住贴花层）；滑杆标签写明「>0 会遮墨线」 |
| `lightZenithDeg` | `45` | | 光照天顶角（烘焙用） |
| `lightAzimuthDeg` | `315` | | 光照罗盘方位（右上打光） |
| `ambient` | `0.62` | | 环境光 |
| `diffuse` | `0.55` | | 漫反射 |
| `shadeGain` | `1.0` | | ★ 山体阴影增益。**与几何起伏解耦**：`reliefScale = 0` 时山脉靠明暗仍清晰可见 |
| `deepWaterDepth` | `0.085` | | 深海判定深度（→ `BIOME.DEEP_OCEAN`） |

**墨线层（海岸 + 湖岸，合并成 1 个 Mesh）**

| 键 | 默认 | 面板 | 说明 |
|---|---|---|---|
| `coastWidth` | `0.0042` | | ★ 海岸墨线全宽（球面半径单位）；M1 的 1px `LineSegments` 已废弃 |
| `lakeShoreWidth` | `0.0030` | | ★ 湖岸墨线全宽 |
| **`lakeShoreMinCells`** | **`4`** | | ★ 连通湖小于该格数就**不描边**（否则单格湖 = 正六边形圈，见 §3.5） |
| `inkLift` | `0.0009` | | 墨线额外抬升（避免与水/湖面 z-fighting） |
| `coastColor` | `'#1b2a33'` | | 海岸墨色 |
| `coastOpacity` | `0.55` | | 墨线材质不透明度 |
| `lakeShoreColor` | `'#1d4a5c'` | | 湖岸墨色（比海岸略偏蓝绿） |

**河流缎带层**

| 键 | 默认 | 面板 | 说明 |
|---|---|---|---|
| `riverAreaThreshold` | **`5`** | ✅ | ★ 河道拓扑门槛：上游汇水面积（`T.area`，格）≥ 该值才算河道。范围 1–30 |
| `riverFlowMin` | **`0.10`** | ✅ | ★ 水量门槛：`flow` < 该值视为干河床不画。范围 0–1.5 |
| `riverMinWidth` | `0.0018` | ✅（经 `riverWidth` 滑杆联动） | 缎带最小全宽 |
| `riverMaxWidth` | `0.0150` | ✅（同上） | 缎带最大全宽 |
| `riverWidthBias` | `0.38` | | 宽度 `= lerp(min, max, (flow/maxFlow)^bias)`；< 0.5 → 细流也看得见 |
| **`riverSmooth`** | **`3`** | | ★ 每个河道格的 **Bezier 子段数**（`1` = 关掉平滑，回到 M2 的硬折角）。见 §3.6 |
| `riverLift` | `0.0090` | | 河流抬升。比墨线大：缎带有宽度，边缘容易埋进谷壁 |
| `riverColor` | `'#2f7ba5'` | | 主河道水色 |
| `riverTribColor` | `'#5f9fba'` | | 支流细线水色（浅一档，让主河道跳出来） |
| `riverOpacity` | `0.92` | | |

**湖泊水面**

| 键 | 默认 | 说明 |
|---|---|---|
| `lakeColor` | `'#3f9ab0'` | 淡水湖水面色 |
| `saltLakeColor` | `'#2d7f86'` | 咸水湖（内流）水面色，更深蓝绿 |
| `lakeBlend` | `0.62` | 湖面把陆色替换成水色的比例 |

**纸纹（M2 质感层）**

| 键 | 默认 | 面板 | 说明 |
|---|---|---|---|
| `paperTint` | `'#efe6d5'` | | 纸底色（暖白） |
| `paperMix` | `0.070` | ✅ | 纸底色混合比例（0 = 关）。范围 0–0.25 |
| `paperNoise` | `0.085` | ✅ | 逐顶点颗粒幅度（乘性，0 = 关）。范围 0–0.20 |
| `paperScale` | `40.0` | | 颗粒频率（≈ 网格分辨率 1/2 → 逐顶点颗粒感最强） |
| **`hoverLift`** | **`0.0140`** | | ★ M3：悬停 / 选中轮廓的抬升；**必须 > `riverLift`(0.0090)**，否则被河流缎带盖住 |
| **`hoverColor`** | `'#ffd479'` | | ★ M3：悬停轮廓色（暖黄，与青蓝主色互补） |
| **`selectColor`** | `'#ff8a5c'` | | ★ M3：选中轮廓色（橙红） |

> 还有一个非配置项 `_rc`：内部缓存（生物群系视图逐 region 颜色）。

### 7.6 生物群系阈值（`CONFIG.biome`，L2 步 9）

阈值**不是拍脑袋定的**，而是按 level 5 实测分位标定的（**v3.0 重新标定**）：

- 陆地 `temperature` 分位：`p15=0.245  p30=0.445  p50=0.631  p70=0.762  p82=0.839  p95=0.937`
- 陆地 `moisture` 分位：`p15=0.043  p30=0.088  p45=0.125  p50=0.142  p70=0.246  p82=0.347  p95=0.525`
- 陆地 `rainfall` 分位：`p50=0.057  p82=0.139  p95=0.210`
- 陆地 `elevation` 分位：`p15=0.277  p50=0.426  p82=0.606  p95=0.752`

| 键 | 默认 | 说明 |
|---|---|---|
| `tempSeaice` | `0.12` | 海洋 → 海冰 |
| `tempSnow` | `0.18` | 陆地 → 雪峰（**先于山脉判定**，所以高山雪顶优先） |
| `tempIce` | `0.22` | 陆地 → 冰原 |
| `tempTundra` | `0.32` | 苔原/泰加林分界 |
| `tempCool` | `0.48` | 「凉」带（温带林 / 灌丛） |
| `tempWarm` | `0.63` | 「暖」带（温带林 / 草原 / 灌丛） |
| `tempTropical` | `0.80` | 「热」带（雨林 / 稀树草原 / 沙漠） |
| `moistDry` | `0.14` | **温带**干湿分界（≈ p49） |
| **`moistAridTropical`** | **`0.24`** | ★ **热带**干旱阈值（≈ p60），单独抬高；判据是干旱指数 `P/PET`。见 §2.10 |
| `moistWet` | **`0.34`** | 湿区起点（≈ p82）；M2 是 0.42，v3.0 按新分位下调 |
| `mountainBiomeThreshold` | `0.60` | `mountain` 权重超过它 → 归「山脉」群系 |
| `snowLine` | `0.78` | 陆色 fade 到雪白的相对海拔阈值 |

> **为什么必须按分位标定**：早期版本沿用 mapgen4 的 `moistDry = 0.30 / moistWet = 0.62`，
> 但本实现的 `moisture` 中位数只有 0.142 → **69% 的陆地被判成「干旱」**，
> 结果出现「灌丛占 50%、平原几乎不存在」的畸形分布。按分位重标定后（v3.0 实测）：
> 灌丛 18.0% / 苔原 13.4% / 热带雨林 12.0% / 雪峰 10.9% / 草原 10.5% / 温带林 10.1% /
> 沙漠 6.1% / 山脉 5.0% / 泰加林 4.5% / 稀树草原 3.7% / 冰原 2.2%（见 §12.5）。
>
> **每次改「世界形态」（大陆掩码 / `seaLevel` / `landEvaporation`）都必须重跑
> `quantiles.mjs` 重标定这一组阈值** —— 只改地形不重标 biome，分布一定会畸形。

> **`reliefScale` 默认 0 的说明**：用户一开始就要求成品是「平滑球体、不改高度」以配合出生点选择。
> M1 验证期曾给 0.02（让分水岭、盆地一眼可见），但 M2 做贴花层（墨线 / 河流 / 湖面）时发现
> **0.02 的起伏会把贴花层大面积挡掉**（实测河流只剩 17% 像素可见，见 §3.6.1），
> 于是**归零并定为默认**——山脉的视觉完全由顶点色明暗（§3.4）承担，不需要几何起伏。
> 滑杆保留并改名为「`>0` 会遮墨线」，方便将来想开起伏时做对比。

---

## 8. 性能与风险

### 8.1 实测性能（v3.0 落地后的真实数字）

数据来源：headless 校验脚本 `m1-test.mjs`（抽取 `L0–L2 BEGIN` → `/*__L3DONE__*/`
整段纯算法层，在 Node v24 里跑）、专项计时脚本 `timing-m2.mjs`，
以及 Chromium headless 里的 `index.html` 自身 HUD（`h-total`）。**三处独立测量，互相印证。**

| 阶段 | level 5（默认，v3.0 实测） | M2 对照 |
|---|---|---|
| L1 网格 + 对偶 + 邻接表 | **31.7 ms** | 36.2 ms |
| L2-1 海拔（含细节粗糙度 + 大陆包络 + 掩码） | 15.2 ms | 16.4 ms |
| L2-2 山脉（Poisson + BFS 距离场） | 20.3 ms | 20.4 ms |
| L2-3 海拔标准化（z-score + 掩码偏移） | 4.6 ms | 5.4 ms |
| L2-4 温度 | 1.0 ms | 1.2 ms |
| L2-5 风场 | 4.0 ms | 4.4 ms |
| L2-6 **降雨迭代**（**12 次**收敛，残差 6.1e-5） | **21.1 ms** | 37.4 ms（40 次） |
| L2-7 priority-flood | 2.9 ms | 3.6 ms |
| L2-8 湖泊检测（含连通块 BFS） | 0.9 ms | 1.2 ms |
| L2-9 流量累积 | 1.5 ms | 1.4 ms |
| L2-10 生物群系 | 0.8 ms | 0.7 ms |
| L3-11 光照烘焙 | 5.8 ms | 5.6 ms |
| L3-12 建渲染网格 + 顶点色 | 11.0 ms | 8.7 ms |
| **L2 + L3 合计** | **89.1 ms** | ~116 ms |
| **含 L1 的首次生成** | **~121 ms** | ~156 ms |

**L3 三个几何层的独立计时**（`timing-m2.mjs`，level 5，v3.0）：

| 层 | 段数 | 顶点 / 索引 / 三角形 | 耗时 |
|---|---|---|---|
| 墨线（海岸 2056 + 湖岸 224） | 2280 | 9120 / 13680 / 4560 | **4.9 ms** |
| 河流缎带（`riverSmooth = 3`） | 2598 | 10392 / 15588 / 5196 | **5.2 ms** |
| 地形网格 + 顶点色（纸纹两段式） | — | 30722 / 184320 / 61440 | **5.5 ms** |
| **三层合计（均值）** | | **合计 71196 三角形 / 3 draw call** | **10.5 ms** |

**按操作分档的耗时**（决定滑杆响应策略，见 §10）：

| 操作 | level 5 实测 | debounce |
|---|---|---|
| 只重算顶点色（切视图 / 纸纹） | **5.5 ms** | 0 ms（即时） |
| 只重建河流缎带（`riverThreshold` / `riverArea` / `riverFlowMin` / `riverWidth`） | ~90 ms（含刷新） | 90 ms |
| 只重建墨线 + 河流 + 顶点色 | **10.5 ms** | — |
| 完整重跑因果链（`seed` / `seaLevel` / 气候参数） | ~570–660 ms | 220 ms |

浏览器内实测（Chromium headless + SwiftShader，level 5，1280×800）：
**首次生成 574–652 ms**（含 `paletteAt` 逐顶点 30722 次、GPU 缓冲上传、
分帧 `await nextFrame()` 让浏览器的开销）。

> **决策 1 补充验证**：用户要求 L1 构建 ≤ 1–2 秒 —— 实测 level 5 只有 **31.7 ms**，
> 是阈值的 1/50。**不需要** `requestIdleCallback` 分片构建。仍然保留了「加载遮罩 +
> 分阶段 `await nextFrame()`」的做法，理由是让每一步的名字显示出来（调试友好），
> 而不是为了性能。
>
> **最长单步是降雨迭代（21.1 ms）**，略高于一帧 16.7 ms，但因为有分帧 yield，
> 观感上感觉不到卡顿。
>
> ⚠️ **headless SwiftShader 的 `h-total` 会剧烈波动**（同一份代码实测 574 ms 与 2553 ms
> 都出现过）：`总耗时` 包含 6 次 `await nextFrame()`，软件光栅化的帧时间不稳定。
> **判断性能要看 `timing-m2.mjs` 的 JS 计时，不要看 `h-total`。**

### 8.2 规模对比

| | 现状 v1 | v3.0 落地后（level 5） |
|---|---|---|
| 渲染对象 | 10242 个 mesh | **3 个 mesh**（地形 + 墨线 + 河流） |
| Draw call | 10242 | **3**（`forceSinglePass` 压掉了双面透明材质的第二趟） |
| 渲染顶点 | 10242 × 6 | **50234**（地形 30722 + 墨线 9120 + 河流 10392） |
| 渲染三角形 | 20480 | **71196**（地形 61440 + 墨线 4560 + 河流 5196） |
| 索引长度 | — | **213588**（184320 + 13680 + 15588） |
| 海岸线 / 湖岸几何 | 无 | **2280 段缎带**（2056 海岸 + 224 湖岸 → 4560 三角形） |
| 河流几何 | 无 | **866 河道格 → 2598 缎带四边形**（主干 112 + 支流 754；两级门槛剔除 541 段干河床） |
| 每帧 CPU 开销（旋转球） | O(1) | **O(1)**（几何 / 顶点色已建好，3 个对象） |
| 重建成本 | 逐 mesh 重设颜色 | 逐顶点重算颜色（30722 次 `viewColorAt` + `shade`，**5.5 ms**） |

**实测渲染像素分布**（Chromium headless，1280×800，`colors` = 4bit/通道量化后的
不同颜色数，`meanLum` = 平均亮度）：

| 视图 | 不同颜色数 | 平均亮度 | 非背景像素占比 |
|---|---|---|---|
| 海拔 | 161 | 40.4 | 0.612 |
| 降雨 | 284 | 42.6 | 0.612 |
| 流量 | 245 | 28.6 | 0.612 |
| 生物群系 | 439 | 43.4 | 0.612 |
| 地形色（`paletteAt`） | 438 | 44.0 | 0.612 |

> 浏览器逐一截图的 **5 个**视图的 `colors` 互不相同 → **视图确实切换了**（不是同一个画面）；
> `meanLum` 分布 28.6–44.0 → **不是全黑也不是全白**；
> `nonBgRatio = 0.612` → 球体占满画面。这是自动化的「画面对不对」检查，
> 不靠人眼。

### 8.3 风险与对策

| # | 风险 | 影响 | 对策 | 状态 |
|---|---|---|---|---|
| 1 | 降雨迭代不收敛 / 震荡 | 雨量异常，生物群系错乱 | 暖启动 + Gauss-Seidel + 上限 400 次；HUD 显示实际迭代数与残差 | ✅ 实测 level 5 **40 次**收敛，残差 9.5e-5 |
| 2 | 球面无 DAG，迭代慢 | 调参卡顿 | 纬向气候学暖启动 | ✅ 降雨 37.8 ms（原 Jacobi 估算 ~340 次迭代） |
| 3 | 分类色在顶点插值下边缘模糊 | 生物群系边界不够锐 | ① 逐顶点先插标量再查表（§3.3）② 海岸墨线与河流线提供锐利结构 ③ 可选：biome 边界描边几何（M3） | 设计已规避 |
| 4 | 极点处切平面基退化 | 极点出现光照/风向异常 | `v3PerpBasis` 与 hillshade 的 `north` 均做兜底；`assignWind` 在极点（icosahedron 棱中点归一化后恰为 `(0,±1,0)`）改用备用切向 | ✅ M1 已修 |
| 5 | 全陆地球时 priority-flood 无种子 | 死循环 / 全部 `filled = Infinity` | 兜底：剩余格子各自作为盆地根入堆（`allowNoOcean`） | ✅ M1 已实现并有断言 |
| 6 | 贴花层（墨线 / 河流 / 湖面）与地形 z-fighting / 遮挡 | 河流闪烁或大面积看不见 | 各自固定抬升（`render.inkLift` / `render.riverLift`）；**且必须 `lift > reliefScale`** | ✅ 已规避（`reliefScale` 默认归零，见 §3.6.1；`riverLift` 分组写错 → 见 §8.4） |
| 7 | `mountainSharpness` 过大导致海拔饱和 | 大半陆地变雪白 | z-score 标准化解耦 | ✅ 已实现（实测 57.7% 陆地） |
| 8 | 拾取精度：合并网格无法直接命中单 tile | hover 高亮失效 | `triToRegion` 查表（O(1)）：`raycaster.faceIndex → region` | ✅ 浏览器实测命中（返回 `#4854` 及其全部字段） |
| 9 | 内存：SoA 全字段在 level 5 约 1.2 MB | 无 | — | 可忽略 |
| 10 | **配置键名写错，读取到 `undefined`** | **几何整体 NaN，球体直接消失** | 静态扫描 `cfg.<组>.<键>` 与 `CONFIG` 字面量比对（`check-cfg.mjs`）+ headless 断言「无 NaN」 | ✅ 已建立双保险（见 §8.4） |
| 11 | `LineSegments` 顶点数不成对 | 把不相邻的点两两配对 → 画出横穿球面的长直线 | 用「等值线切割」生成成对顶点；断言「每段长度 ≤ 网格最长边」 | ✅ 已修（见 §8.4） |
| 12 | 地形场在网格尺度太平滑 | 没有封闭洼地 → 一个湖泊都没有 | 加独立的高频「细节粗糙度」层（`detailScale` / `detailAmp`） | ✅ 实测湖泊 1.6–1.9% |
| 13 | ★ **双面 + 透明材质被 three.js 分两趟渲染** | draw call 翻倍（3 → 5）、河流/墨线颜色叠加变深 | 墨线与河流材质显式设 `forceSinglePass: true` | ✅ M2 已修（实测 `calls: 3`） |
| 14 | ★ **近白顶点色被 hillshade 顶过 1.0 → 曝白** | 雪峰变成一块纯白、失去层次 | 雪色上限从 `(0.95,0.96,0.97)` 降到 `(0.845,0.865,0.905)`（`shade` 峰值 1.17） | ✅ M2 已修 |
| 15 | 纸纹噪声若随地形种子变化 | 换种子后「纸」也换了 → 观感不稳 | 纸纹噪声用**独立固定种子** `0x51a2e7`，与 `CONFIG.seed` 解耦 | ✅ M2 已实现 |

### 8.4 M1 落地时抓到的三个真 bug（工程记录）

这三个 bug 都不是「想错了」，而是「写错了之后**只有真跑起来才会显形**」。
每一个都补了一条**自动化断言**，防止回归。

#### 案例一：`riverLift` 分组写错 → 河流几何全部 NaN

- `CONFIG.hydro.riverLift = 0.0035`，但 `buildRiverSegments` 读的是
  `cfg.render.riverLift` → `undefined` → `radius + undefined = NaN`。
- 症状：**headless 测试完全测不出来**（我只断言了「河流线段数 ≈ 河流格数」，
  而长度是对的 —— 948 个浮点，全是 NaN）。只有真的在 Chromium 里跑，
  才会看到 `THREE.BufferGeometry.computeBoundingSphere(): Computed radius is NaN`
  和**整条河消失**。
- 修法：`riverLift` 归入 `CONFIG.render`（它本来就是渲染层参数）。
- **补的断言**：`河流线段全部有限（0 个 NaN）`、`海岸线全部有限`。
- **补的工具**：`check-cfg.mjs` —— 静态扫描源码里所有 `cfg.<组>.<键>` 读取，
  和 `CONFIG` 字面量的键做差集。它一次就报出「`render.riverLift` 键不存在 ×1」，
  且确认没有第二处同类错误。

#### 案例二：海岸线顶点不成对 → 长直线横穿球面

- `buildCoastLine` 对每条跨海陆的边只 `push` **一个**等值点。
  顶点数 = 跨界边数 = 3881（奇数）。`LineSegments` 要求顶点**成对**，
  于是把第 1、2 个完全不相邻的等值点连成一条线段 ——
  画面上就是不相关的两点之间拉出的**长直线**，横穿球面。
- 症状：headless 断言写的是「顶点数为偶数且 > 200」，**恰好蒙对了**（3881 × 3 = 11643
  个浮点，我错误地用 `% 3` 判定，永远为真）。这个断言从一开始就是废的。
- 修法：改成「**等值线切割**（marching triangles）」—— 对 L1 每个三角形，
  若三顶点的海/陆二分类不一致（必然正好 2 条跨界边），求出这两个等值点连成 1 段。
  每条跨界边被相邻 2 个三角形共享 → 等值点各出现 2 次 → 天然成对，且首尾相接。
- **补的断言**：`海岸线顶点数 % 6 === 0`（成对）、
  `每段长度 ≤ 该 level 网格的最长边`（**与 level 无关的严格判据**）。
  实测 level 5 最长段 0.03947 / 最大边长 0.03947；level 4 也通过。

#### 案例三：地形场退化成「平顶高原」→ 湖泊数 = 2

- 早期公式 `e = 0.58*(base*0.72+0.5) + 0.42*(1-|base|)`
  在 `base > 0` 区间前两项的斜率几乎抵消：
  `0.4176·base - 0.42·|base| ≈ -0.0024·base` → **大片近乎水平的平台**。
- 后果：平台上任意两格海拔几乎相等 → `filled[j] = max(elev[j], filled[c])`
  退化成 `filled = elevation` → `lake_depth = 0`。
  实测 **99% 的陆地格子填平量精确为 0**，全图只有 2–3 个「湖」。
- 修法：重写为三段式 ——
  ① 平滑大陆 FBM `e = 0.5 + 0.9·fbm`；
  ② **独立的高频细节粗糙度层** `+= detailAmp · fbmDetail(scale=16)`；
  ③ 山脉脊线 `+= sharp · w^1.4 · (ridgeAmp·ridgeN² + 0.10)`。
- 效果：湖泊格 1.6%（level 5）/ 1.9%（level 4），最大湖深 0.137。
- **补的断言**：`湖泊格占比 0.5%~12%`（外加一张填平量阈值表打在日志里，
  方便一眼看出「洼地深度分布」是否合理）。

> **教训**：`reliefScale` 只有 0.02，所以地形在**几何上**几乎看不出来 ——
> 湖泊/河流这类**水文派生量**对海拔场的细微退化极其敏感，
> 而「看起来还行」的灰阶图完全暴露不了它。**派生量的分位数**才是有效断言。

---

## 9. 里程碑

### M1 · 地形因果链（灰阶验证）★ 已完成

**目标**：在浏览器里看到一个球，能区分出海陆、山脉、雨影、河网。

**范围**：

| 层 | 内容 |
|---|---|
| L0 | `mulberry32` / `makeNoise3D` / `makeFbm` / 向量函数 / `MinHeap` / `clamp`/`lerp`/`smoothstep`/`percentile` |
| L1 | `buildIcosphere` / `subdivideIcosahedron` / `buildDual` / `buildNeighbors` |
| L2 | **全部 10 步**，一步不少 |
| L3 | `paletteAt` + `waterColorAt` / `whittakerAt` / `ramp`、`viewColorAt`（6 种调试视图）+ `bakeVertexShading` + `buildRenderMesh` + `buildCoastLine` + `buildRiverSegments`（骨架线） |
| L4 | 场景 / OrbitControls / **6 个**调试视图按钮 / 参数面板（11 控件）/ HUD / hover 拾取 / 加载遮罩 |

**验收结果**（✅ = 已有自动化证据，不只是「看着像」）：

| # | 验收标准 | 结果 | 证据 |
|---|---|---|---|
| 1 | 连续拖 `seed` 每次都得结构合理的球（不全海/全陆/全平） | ✅ | 陆地占比 57.7%（断言区间 35–70%）；换种子由 `mulberry32` 保证 |
| 2 | 「降雨」视图里**副热带有明显暗带**，赤道亮 | ✅ | 赤道 0.248 / ±30° 0.043 / ±45° 0.062 / ±65° 0.102；全域赤道 0.311 vs 副热带 0.049 |
| 3 | 「流量」视图能看到**树枝状河网**，且终止于海岸 | ✅ | `maxFlow = 15.074`；`riverThreshold = 2.0` → 158 段河线，2.68% 陆地成河；反向遍历断言 |
| 4 | 湖格出现在**内陆洼地**，且集中在降雨较多的流域 | ✅ | 湖泊 163 格（1.59%），最大湖深 0.1366；填平量阈值表打在日志里 |
| 5 | 同一 `seed` 两次生成**像素完全一致** | ✅ | 断言「同种子海拔逐位一致」+「同种子峰点数一致」 |
| 6 | HUD 显示迭代次数 / 残差 / 湖泊数 / 河流格数 / 各阶段耗时 | ✅ | HUD 实测读到 40 次 / 9.47e-5 / 163 格 / 158 格 / 12 项耗时 |
| 7 | 拖滑杆时 UI 不冻结（分帧 + 加载提示） | ✅ | `apply` 分三档：`'full'` ~500–650ms（遮罩 + 分阶段 `await nextFrame`）、`'river'` ~90ms、`'color'` 即时 |
| 8 | （自查追加）浏览器里**零 JS 异常** | ✅ | CDP 抓 `Runtime.exceptionThrown` + `Log.entryAdded(error)` → `errors: []` |
| 9 | （自查追加）5 个调试视图**真的在切换** | ✅ | 各视图截图的不同颜色数 161 / 284 / 245 / 439 / 438，平均亮度 40.4 / 42.6 / 28.6 / 43.4 / 44.0 |

**M1 实际未做**（留给 M2/M3）：河流缎带（变宽度）、湖泊水面独立几何、纸纹质感、
调色板精修、hover 高亮 `LineLoop`（**只做了 HUD 拾取**，高亮描边留给 M3）、
`painting.ts` 式交互涂画。

**关于 `reliefScale`**：M1 当时默认 0.02（为了让分水岭、盆地一眼可见）。M2 发现它会遮挡贴花层，
因此**已改为默认 0**（见 §3.6.1 / §7.5）。拖到 0 仍是平滑正球，可以立刻验证「不起伏也能看」
（山的视觉由 `shadeGain` 烘焙的明暗承担）。

**验证基础设施**（这是 M1 真正的额外产出，M2/M3 继续复用）：

| 工具 | 作用 |
|---|---|
| `m1-test.mjs [level]` | 从 `index.html` 抽取 `L0–L2 BEGIN` … `/*__L3DONE__*/` 整段纯算法层，在 Node 里重跑完整因果链，**93 项断言**（M1 时 73 项，M2 期间 +20）。level 4 / 5 均全通过 |
| `browser-check.mjs` | 用 Node 内置 `WebSocket` 直连 Chromium 的 **DevTools 协议**（无需 playwright 依赖）：截取控制台异常、逐视图截图、**在 Node 侧解 PNG 统计像素分布**、拖动滑杆验证重生成、派发 `pointermove` 验证 hover 拾取 |
| `check-cfg.mjs` | 静态扫描所有 `cfg.<组>.<键>` 读取并与 `CONFIG` 字面量比对 → 一次抓出 `render.riverLift` 键不存在（§8.4 案例一） |
| `check-dom.mjs` | 静态扫描 `$('id')` 与 HTML 里的 `id="…"` 比对 → 23 个 id 全部对得上 |
| `ab-terrain.mjs` / `ab-river.mjs`（M2 新增） | A/B 脚本：改 `CONFIG` 后 `__PLANET__.regen()` 重跑因果链，抓多组配置的截图，用来做河网门槛 / 地形尺度的观感对比 |

> **为什么非要写浏览器侧验证**：M1 抓到的三个 bug 里，**只有第一个**（`riverLift` 分组错）
> headless 完全测不出来 —— 因为断言写的是「河流线段数 ≈ 河流格数」而长度是对的。
> 只有真在 Chromium 里跑才看到 `computeBoundingSphere(): radius is NaN`。
> 现在 headless 里补上了「无 NaN」断言，两条路都能兜住。

### M2 · 手绘风格渲染 ★ 已完成

**目标**：把 M1 的 1px 线框球变成「手绘地图」观感——有墨线、有水面、有颗粒感，
且**几何总量仍然极少**（3 个 Mesh = 3 个 draw call）。

**交付清单**：

| # | 内容 | 实现 |
|---|---|---|
| 1 | 海岸墨线 | `buildCoastLine`（marching triangles 等值线）→ `appendRibbon` 缎带化，全宽 `coastWidth = 0.0042` |
| 2 | 湖岸墨线 | `buildLakeShoreSegments`，全宽 `0.0030`；与海岸**合并成同一个 Mesh**，顶点色区分两种墨色 |
| 3 | 河流缎带 | `buildRiverRibbon`，可变宽度；横向向量按 region 共享 → 相邻段端点完全重合（无缝）；河口取 `max(w_r, w_d)` 不收窄 |
| 4 | ★ 河道判据 | 两级门槛 **`area ≥ 5 & flow ≥ 0.10`**（拓扑 + 水量），替换掉原来的「`flow > 阈值`」（见 §3.6） |
| 5 | 湖泊水面 | 复用 `filled` 抬升；淡水 `#3f9ab0` / 内流咸水 `#2d7f86`；`lakeBlend = 0.62` |
| 6 | 纸纹 | 固定种子噪声 + 暖白纸底，全部烘进顶点色（**不引入 shader**，见 §3.8） |
| 7 | 调参面板 | 新增 `paperMix` / `paperNoise` / `riverWidth` / `riverArea` / `riverFlowMin`，共 **14** 个控件 |
| 8 | 算法层增益 | `accumulateFlow` 新增 `T.area`（上游汇水面积）——纯拓扑、Godot-ready（见 §2.9） |

**验收结果**（✅ = 有自动化证据）：

| # | 验收标准 | 结果 | 证据 |
|---|---|---|---|
| 1 | draw call 不失控 | ✅ | 实测 **3**（planet + ink + river，`lines: 0`），6 个视图切换后不变 |
| 2 | 墨线是**有宽度**的几何（不是 1px 线） | ✅ | 墨线段最小宽度 0.00300 / 目标 0.0042；每段 4 顶点 6 索引 |
| 3 | 河网**不是梳齿 / 鱼骨** | ✅ | 孤立划占比 **30.7% → 18.3%**，最长链 **8 → 10**；整球 + 近景截图对比 |
| 4 | 同种子纸纹完全一致 | ✅ | 断言「纸纹重跑逐位一致」；噪声种子固定 `0x51a2e7`，与地形种子解耦 |
| 5 | 纸纹只轻微改变配色（不糊掉） | ✅ | 100% 顶点受影响，最大 Δ ≈ 0.076 |
| 6 | 贴花层不会被地形挡住 | ✅ | `reliefScale = 0` 下断言「地形 maxR = 1.00000 < 墨线 minR = 1.00239 < 河流 minR = 1.00900」 |
| 7 | 浏览器零异常 + 视图 / HUD / 面板正常 | ✅ | `errors: []`；抽检的 5 个视图颜色数 164 / 271 / 235 / 413 / 404（温度未单独截图）；HUD 正常；14 个滑杆 |
| 8 | `T.area` 算对 | ✅ | 断言「满足 `area[i] = 1 + Σ area[上游]` 递推不变式」+「顺流单调不减」+「`area=1 & flowMin=1.0` 退化成旧判据」 |

**M2 实际未做**（留给 M3）：`painting.ts` 式交互涂画、hover 的 `LineLoop` 描边高亮、
等高线、按生物群系分纹理、导出 JSON。

**踩过并记录在案的坑**（避免以后重复）：
§3.6 的「试过但没用的方案」清单（`up[r] === 1` 空操作、降噪声无效、提阈值只会删光河），
以及 §3.6.1 的**贴花层遮挡机理**（`reliefScale > lift` 时贴花层被地形三角形挡掉）。

### M2.5 · 大陆尺度重做 ★ 已完成（v3.0）

**目标**：M2 的世界在 level 5 下是「**迷宫型群岛**」——孤立划 18.3%、最长河链只有 10 格、
整球看不到「大陆」。用户要的是 **1~3 块大陆 + 树状长河网**。

**为什么不是简单调参**：M2 的 `seaLevel` 与噪声尺度都试过（`seaLevel` 0.15–0.60、
`noiseScale` 1.0–1.8、`octaves` 4–6），得到的只有「更碎的迷宫」或「更少的迷宫」。
**问题在尺度谱**：M2 的地形只有一个频段（`noiseScale = 1.8` → 特征尺寸 ≈ 9 格），
把它放大陆就必然同时把海岸线也放成迷宫。**必须引入第二个频段**（低频包络 = 大陆）。

**交付清单**：

| # | 内容 | 实现 |
|---|---|---|
| 1 | ★ **大陆掩码** | 低频包络只写 `T.continent`（**不进海拔**），在 z-score **之后**做 `dz = −oceanDepth·(1−C)`（§2.3.1） |
| 2 | ★ **`clamp` 下界放开到 −1** | 否则 `seaLevel < 0` 时掩码的海洋会被 clamp 吃掉、全球变陆地 |
| 3 | ★ **陆面蒸发** | `landEvaporation = 0.55` / `landSaturation = 0.55`（§2.6.2） |
| 4 | ★ **中纬风暴带** | `stormTrack = 0.70 @ 48°`（§2.6.1）——「副热带最干 + 中纬次湿」四带成立 |
| 5 | ★ **`lakeMinDepth` 0.006 → 0.050** | 开大陆后洼地全变成内陆湖 → 「海绵化」（§2.8.1） |
| 6 | ★ **河流缎带 Bezier 平滑** | `riverSmooth = 3`，消掉六边形网格的 120° 硬折角（§3.6） |
| 7 | ★ **小湖不描边** | `lakeShoreMinCells = 4`，消掉单格湖的「六角螺帽」（§3.5） |
| 8 | ★ **热带干旱阈值** | `moistAridTropical = 0.24`，沙漠 2.2% → 6.1%（§2.10） |
| 9 | 调参面板 | 新增 6 个滑杆（`continentScale/Bias/Band`、`oceanDepth`、`lakeMinDepth`），共 **20 个控件** |
| 10 | 三个 Mesh 加 `name` | `'planet' / 'ink' / 'river'`，供截图脚本按层隐藏（不影响渲染） |

**验收结果**（level 5 · seed 1337；对照 = M2）：

| # | 验收标准 | M2 | v3.0 | 证据 |
|---|---|---|---|---|
| 1 | 有**大陆**（最大块占比） | 39.9% | **99.8%** | `diag-continent.mjs` |
| 2 | 陆地占比像行星（60–70%） | 47.1% | **67.8%** | 同上 |
| 3 | 排水是**树状**（不是平行直棍） | 迷宫 | 树状 | `shots/fin5-terrain-a200.png`（干流 + 支流 + 汇流） |
| 4 | 河流**长**（最长链） | 10 | **16** | `diag-continent.mjs` |
| 5 | 河网**不碎**（孤立划占比） | 18.3% | **8.1%** | 同上 |
| 6 | 河段数（够密但不糊） | 387 | **873** | 同上 |
| 7 | 湖泊数（不「海绵化」） | 163 | **132** | `count-biomes.mjs` |
| 8 | 气候**四带**成立 | ✗（±45° 比 ±30° 还干） | ✅ 0°=0.177 / ±30°=0.061 / ±45°=0.079 / ±65°=0.022 | `m1-test` 步 6 |
| 9 | 沙漠不消失 | 8.3% | **6.1%** | `count-biomes.mjs` |
| 10 | 河流**不像闪电** | 120° 硬折角 | 平滑弯道 | `shots/zk3c-zoom-a0.png` 前后对比 |
| 11 | 无「六角螺帽」小湖 | 有 | 无 | `shots/fin5-close-a0.png` |
| 12 | 93 项 headless 断言 | ✅ | ✅（level 4/5） | `m1-test.mjs` |
| 13 | 浏览器零异常 / 3 draw call | ✅ | ✅ | `browser-check.mjs`（`errors: []`，`calls: 3`） |

**M2.5 未做（明确放弃）**：
- ❌ **多块大陆**。掩码方案天然倾向于**一个主导块**（实测试过 `continentScale` 0.7–1.8、
  `band` 0.12–0.45、`octaves` 1–4，`大块数` 恒为 1）。要 2~3 块等大洲需要
  **在包络上做多峰分割**（例如对包络做 k-means 或改「脊线状大陆」），属于下一轮工作。
  当前面板上的 `continentScale / continentBias / continentBand` 三个滑杆可以让用户自己找形状。
- ❌ `T.elevationBase`（把直减率与掩码解耦，从而允许「抬大陆」，见 §2.4.1）。

**踩过并记录在案的坑**（四个，都写进了对应小节）：
①包络加进海拔 → 光滑穹顶 → 平行直棍（§2.3.1）；②抬大陆 → 全球变冷（§2.4.1）；
③`clamp(...,0,1)` 吃掉掩码海洋（§2.3）；④Bezier 接点没归一化 → 虚线香肠（§3.6）。

### M3 · 交互与导出 ★ 已完成（v3.1）

**目标**：把「只能看」的原型变成「能摸」的原型 —— 拾取任意一格、看到它的全部因果链数据、
把结果导出给 Godot 端做数值对照。

**★ 高亮为什么用独立 `LineLoop` 而不是改顶点色**（用户决策 2）：
- 改 `planetMesh` 顶点色会**污染 `paletteAt` 的烘焙结果**（切视图 / 拖纸纹时会被覆盖），
  而且每次 hover 都要重传 **30722 个顶点**（~0.4 MB）。
- 独立对象只在 hover 变化时**改 6 个浮点数**，且 `planetMesh` 保持 **1 个 draw call**。
- 代价：多 1 个渲染对象（`hover`）→ 场景共 **4 个对象**；仅在悬停 / 选中时可见。

**交付清单**：

| # | 内容 | 实现 |
|---|---|---|
| 1 | ★ hover 拾取 | `raycaster.intersectObject(planetMesh)` → `faceIndex` → **`S.triToRegion` O(1) 查表** → region |
| 2 | ★ 轮廓几何 | `drawOutline(r)`：环顶点 = `T.triCenters[T.regionTris[r]]`（该格周围一圈三角形重心，已是单位向量），半径 `= vertexRadius(T, r, CONFIG) + hoverLift` |
| 3 | ★ 轮廓对象 | 一个 `THREE.LineLoop` + `LineBasicMaterial`，`setDrawRange(0, 度数)` → **5 或 6 个顶点**自适应；`hoverLift = 0.014`（> `riverLift 0.0090`，否则被河流盖住） |
| 4 | 点击选中 | `pointerdown` 记坐标 → `pointerup` 位移 < 5px 才算点击（否则是拖动旋转）；选中轮廓换 `selectColor` 并**在鼠标移开后保留** |
| 5 | 取消选中 | `Esc` 或点击空白处 → `setSelected(-1)` |
| 6 | 拾取优先级 | 悬停优先：鼠标在球上时描悬停格；移开后**落回**「已选中」的那一格（**只有 1 个轮廓对象**） |
| 7 | 相机移动重拾 | `autoRotate` / 拖动时轮廓会停在旧格子上 → 检测相机位姿变化重拾，**限流 120 ms**（一次拾取要测 61440 个三角形，不能每帧做） |
| 8 | ★ 信息面板 | 11 项：格号 / 群系 / 海拔 / 温度 / 降雨 / 湿度 / 流量 / **汇水面积** / 湖深 / 内流 / 大陆掩码 / 山脉 / **下游格**；并标记「悬停 / 已选中」 |
| 9 | ★ 导出 JSON | `buildExport()` + `exportJson()`：`meta + config + stats + biomeCounts + quantiles + timingMs`，**纯数据、可 JSON 序列化** |
| 10 | ★ 性能剖面 | `__PLANET__.profile()` 返回 14 项分段耗时 + 总耗时 + 最长单帧 + draw call + 三角形数 + `under1s` |

**验收结果**（`m3-check.mjs`，CDP 驱动 headless Chromium，**29 项断言全过**）：

| # | 验收标准 | 结果 | 证据 |
|---|---|---|---|
| 1 | 场景恰好 4 个渲染对象 | ✅ | `planet:Mesh` / `ink:Mesh` / `river:Mesh` / `hover:LineLoop` |
| 2 | 轮廓类型是 `LineLoop` | ✅ | `hover.type === 'LineLoop'` |
| 3 | 中心可拾取且轮廓可见 | ✅ | `region = 314`；`visible = true`；顶点数 **6**（= 该格度数） |
| 4 | 悬停轮廓用 `hoverColor` | ✅ | `#ffd479` |
| 5 | 信息面板显示群系与格号 | ✅ | `#314 · …` |
| 6 | 点击真的选中（真实鼠标事件） | ✅ | `mousePressed` + `mouseReleased` → `selectedRegion = 4788 = hoverRegion` |
| 7 | 面板标记「已选中」 | ✅ | `h-tile` 含「已选中」 |
| 8 | 鼠标离开球体后悬停清空 | ✅ | `hoverRegion = -1` |
| 9 | **选中轮廓保留**且换色 | ✅ | `visible = true` / `color = #ff8a5c` / `outlineRegion = selectedRegion` |
| 10 | ★ **高亮不改几何体** | ✅ | `planetMesh` 三角形数 **61440 前后一致**；索引仍是 184320 |
| 11 | draw call 只在悬停时 +1 | ✅ | 悬停时 **4**；未悬停 / 未选中时 **3** |
| 12 | `Esc` 取消选中并隐藏轮廓 | ✅ | `selectedRegion = -1`；`visible = false` |
| 13 | 导出结构完整 | ✅ | 六个顶层键齐备；`stats` 15 项；`timingMs` 14 项；`config` 含 5 个分组 |
| 14 | 导出自洽 | ✅ | **群系计数之和 = 10242 = region 总数**；`landRatio = 0.678` |
| 15 | 导出四组分位各 3 个值 | ✅ | elevation / temperature / moisture / rainfall |
| 16 | `exportJson()` 真触发 Blob 下载 | ✅ | 挂钩 `URL.createObjectURL` 确认被调用 |
| 17 | 全流程 ≤ 1000 ms | ✅ | `profile().under1s === true`（820 ms，含 4 次截图干扰） |
| 18 | 扫描 40 格只出现 5 / 6 顶点 | ✅ | 无 NaN、无 0 顶点轮廓 |
| 19 | 浏览器零 JS 异常 | ✅ | `errors: []` |

**M3 未做 / 明确放弃**：
- ❌ `painting.ts` 式交互涂画（用户已确认本期不做）。
- ❌ 等高线叠加、按群系分纹理（§3.5 提到「扩展到等值线很容易」，留作后续）。
- ❌ 多选 / 区域框选 / 路径追踪。

**Godot 移植要点**（M3 部分）：
- 拾取：`PhysicsDirectSpaceState3D` 射线，或**解析法**「射线 ∩ 半径 1 球面」→ 再用
  `MeshData` 的 `ARRAY_INDEX` 反查三角形 → `triToRegion`（与浏览器端同构）。
- 轮廓：`ImmediateMesh`（`PRIMITIVE_LINE_LOOP`）或 6 顶点的 `ArrayMesh` + `PRIMITIVE_LINE_LOOP`；
  `regionTris` 与 `triCenters` 是 L1 的产物，**原样搬**。
- 导出：`FileAccess` 写 `JSON.stringify` 的同构对象；`CONFIG` 是 `@export` 变量 → 直接 `ResourceSaver`。

> **后续（未规划）**：多块大陆的分割算法（§9 M2.5）、`T.elevationBase`（解耦直减率与掩码）、
> 等高线叠加、按群系分纹理、`painting.ts` 式涂画、M3 的多选 / 框选。

---

## 10. 调参面板

用**原生 `<input type="range">` / `<select>` / `<button>`**，不引入 lil-gui（用户要求）。
**实际落地的控件**（20 个 range + 1 个 number + 2 个 select + **1 个导出按钮** + 6 个视图按钮）：

| 控件 | 元素 | 范围 | 事件 → 响应 |
|---|---|---|---|
| `seed` | `<input type="number">` | 整数 | `input` → 重生成 |
| ★ `seaLevel（开掩码后=陆地占比主旋钮）` | range | **−0.10 – 0.45**，step 0.01 | `input` → 重生成 |
| ★ `continentalEnvelope（0=关闭）`(=`continentAmp`) | range | **0 – 1**，step 0.05 | `input` → 重生成 |
| ★ `continentScale（越小→大陆越大）` | range | **0.4 – 2.0**，step 0.05 | `input` → 重生成 |
| ★ `continentBias（越大→海洋越多）` | range | **−1.3 – 0.2**，step 0.02 | `input` → 重生成 |
| ★ `continentBand（过渡带宽度）` | range | **0.05 – 0.45**，step 0.01 | `input` → 重生成 |
| ★ `oceanDepth（大洋压低量）` | range | **0 – 1.6**，step 0.05 | `input` → 重生成 |
| ★ `lakeMinDepth（小湖滤除）` | range | **0.005 – 0.12**，step 0.005 | `input` → 重生成 |
| `mountainSharpness` | range | 6 – 14，step 0.1 | `input` → 重生成 |
| `raininess` | range | 0 – 2，step 0.05 | `input` → 重生成 |
| `riverThreshold` | range | **0.2 – 6.0**，step 0.1 | `input` → **只重建河流层**（debounce 90ms） |
| ★ `riverArea`（汇水面积门槛） | range | **1 – 30**，step 1 | `input` → 只重建河流层（debounce 90ms） |
| ★ `riverFlowMin`（干河床门槛） | range | **0 – 1.5**，step 0.05 | `input` → 只重建河流层（debounce 90ms） |
| `riverWidth` | range | 0.4 – 2.5，step 0.05 | `input` → 只重建河流层（同时缩放 `riverMinWidth` / `riverMaxWidth`） |
| `reliefScale（>0 会遮墨线）` | range | 0 – 0.06，step 0.002 | `input` → **只改几何 + 光照**（debounce 90ms） |
| `subtropicalStrength` | range | 0 – 0.8，step 0.02 | `input` → 重生成 |
| `saturationFloor`（冷海湿度） | range | 0 – 0.6，step 0.01 | `input` → 重生成 |
| `rainShadow` | range | 0 – 1，step 0.02 | `input` → 重生成 |
| `lapseRate` | range | 0 – 1.2，step 0.02 | `input` → 重生成 |
| `paperMix` | range | 0 – 0.25，step 0.005 | `input` → **只重算顶点色**（debounce 0ms，即时） |
| `paperNoise` | range | 0 – 0.20，step 0.005 | `input` → 只重算顶点色（即时） |
| `windMode` | `<select>` | zonal（纬向风带）/ uniform（单向风，调试） | `change` → 重生成 |
| `rainSolver` | `<select>` | gaussSeidel（默认）/ jacobi（调试） | `change` → 重生成 |
| 视图 | 6 个按钮 | elev / temp / rain / flow / biome / terrain | `click` → **只重算顶点色**（debounce 0ms） |
| ★ 导出 JSON | `<button>` | — | `click` → `exportJson()`：Blob 下载 `planet-<seed>-lv<level>.json` |

> **共 20 个滑杆 + 1 个数字框 + 2 个下拉 + 1 个导出按钮 + 6 个视图按钮。**
> 用户指定的 6 项（`seed` / `seaLevel` / `mountainSharpness` / `raininess` /
> `riverThreshold` / `windMode`）全部有；其余是为了**验收因果链与手绘观感**额外暴露的
> —— 尤其是 `subtropicalStrength`（拖到 0 沙漠带立刻消失）、
> `rainSolver`（Gauss-Seidel vs Jacobi 对照）、
> M2 的 `riverArea` / `riverFlowMin`（**直接看到「梳齿 → 树枝」的切换**），
> 以及 v3.0 的 **大陆 6 件套**（`continentalEnvelope` / `continentScale` / `continentBias` /
> `continentBand` / `oceanDepth` / `lakeMinDepth`）——把 `continentalEnvelope` 拖到 0
> 就能**逐帧看到世界从「超级大陆」变回「迷宫群岛」**，这是 M2.5 最有说服力的 A/B。

**分层响应**是刻意的，分三档：

| 档 | 触发者 | 耗时 | debounce |
|---|---|---|---|
| `'full'` | `seed` / `seaLevel` / `mountainSharpness` / `raininess` / 气候参数 / 下拉框 | ~500–650 ms（含遮罩 + 分阶段 `await nextFrame`） | 220 ms |
| `'river'` | `riverThreshold` / `riverArea` / `riverFlowMin` / `riverWidth` / `reliefScale` | ~90 ms | 90 ms |
| `'color'` | `paperMix` / `paperNoise` / 视图切换 | **0 ms**（只重写顶点色 attribute） | 0 ms |

**并发保护**：`regenerate()` 用 `busy` 标志挡住重入，`queuedFull` 记住最后一次请求。
生成期间狂拖滑杆不会堆出多份任务。

**加载提示**：半透明遮罩 + 文案（「构建网格…」「求解降雨…」）+ 已用毫秒数，
重生成时出现，结束后淡出；同时 `showStatus()` 在右下角显示「生成完成 · 536 ms」。

> 该面板在 Godot 里会被 **Inspector（`@export`）** 替换，原型阶段仅用于调参。

---

## 11. Godot 移植预留接口清单

按「移植时必须做的动作」整理。**L0–L2 是纯搬运，L3–L4 是重写。**

### 11.1 直接搬运（零改动，仅语法替换）

| 文件 / 函数 | 说明 |
|---|---|
| `L0` 全部 | `mulberry32` → 自研或 `RandomNumberGenerator`；`makeNoise3D` → 建议换成 `FastNoiseLite`（GDScript 原生，且更快）；向量函数 → `Vector3` |
| `L1` 全部 | `buildIcosphere` / `subdivideIcosahedron` / `buildDual` / `buildNeighbors`。**`Int32Array` → `PackedInt32Array`**，`vec3[]` → `PackedVector3Array` |
| `L2` 全部 | **10 步**因果链，**逐函数对应**。`Float64Array` → `PackedFloat32Array`（必要时 `PackedFloat64Array`）；`Int32Array`（如 `T.area` / `downslope`）→ `PackedInt32Array`。★ 掩码逻辑就在 `assignElevation` 尾部 + `applyMountainRidge`，纯算术 |
| `paletteAt` | ★ **唯一算法↔渲染接口**。逐顶点 `MeshData.set_vertex_color()`，或烘成 `ImageTexture3D` 给 shader 采样 |

### 11.2 语义对应但需重写

| 原型 | Godot | 动作 |
|---|---|---|
| `buildRenderMesh` | `ArrayMesh` + `SurfaceTool` | `set_color` 写顶点色；`vertex_color_use_as_albedo = true` |
| `bakeVertexShading` | 同上，或改用 `DirectionalLight3D` | 若走烘焙路线则完全一致 |
| `buildCoastLine` / `buildLakeShoreSegments` / `appendRibbon` | `ArrayMesh` + `PRIMITIVE_TRIANGLES` | ★ 注意不是 `PRIMITIVE_LINES`：M2 已把线**缎带化**（有真实宽度），每条线段 = 4 顶点 / 6 索引 |
| `buildInkGeometry` / `buildRiverRibbon` | `SurfaceTool` + `PRIMITIVE_TRIANGLES` | `buildInkGeometry` 把海岸 + 湖岸合并成一个 Mesh，靠顶点色区分两种墨色 |
| `refreshVertexColors` | 重写 `MeshData` 的 `ARRAY_COLOR` | 直接对应 `SurfaceTool` 重新 `commit` |
| `OrbitControls` | `Camera3D` + `_unhandled_input`，或 `Node3D.rotate_y` | 重写，约 60 行 |
| `Raycaster` | `PhysicsDirectSpaceState3D` 或射线-球面解析求交 | 重写；`triToRegion` 换成 `MeshData` 的 index 数组反查 |
| ★ `drawOutline` / `hoverObj`（M3） | `ImmediateMesh`（`PRIMITIVE_LINE_LOOP`）或 6 顶点 `ArrayMesh` | `regionTris` + `triCenters` 都是 L1 产物，**原样搬**；`hoverLift` 要 > `riverLift` |
| ★ `buildExport` / `exportJson`（M3） | `FileAccess` + `JSON.stringify` | 返回对象**不含 THREE 类型** → 直接序列化；`CONFIG` 用 `@export` 导出为 `Resource` |
| `requestAnimationFrame` | `_process(delta)` | 直接对应 |
| `CONFIG` 对象 | `@export` 变量 / `Resource` | 面板换成 Inspector |
| 参数面板 DOM | `@export` + Inspector | 用户已说明会被替换 |

### 11.3 预留的「换渲染」缝

1. **`paletteAt` 是唯一的颜色来源** —— 换配色只改这一个函数（或其 GPU 版本 3D 纹理）。
2. **`bakeVertexShading` 是唯一的光照来源** —— 换光照风格只改这一个函数。
3. **`buildRenderMesh` 是唯一的几何来源** —— 换网格拓扑只改这一个函数。
4. **`T`（SoA）与渲染完全解耦** —— 渲染层只读 `T`，从不写回。所以「换渲染」不会碰算法。
5. **`CONFIG` 全部可序列化** —— `JSON.stringify(CONFIG)` 即可交给 Godot 端快捷键导入；M3 会实现导出。

### 11.4 移植时的注意事项

- **`floodOrder` 的方向**：`accumulateFlow` 必须**反向**遍历，移植时不要「顺手改成正序」。
- **`wind` 扁平化**：Godot 用 `PackedFloat32Array` 存 `n*3`，或改回 `PackedVector3Array`（性能差异不大，可读性更好）。
- **`triAcross` 的 `-1` 语义**：球面网格理论上无边界，但保留 `-1` 分支以防万一（Godot 侧同理）。
- **`reliefScale = 0` 时山脉为什么还在**：`bakeVertexShading` 的坡度是从 **`elevation` 标量场的切平面梯度**（最小二乘拟合）算出来的，不是从几何法线算的——所以它和 `reliefScale` 完全解耦。`slope = atan(shadeGain · |∇elevation|)`，`shadeGain` 默认 1.0。**移植时不要图省事改成读几何法线**，否则 `reliefScale = 0` 后整个球会变成均匀环境光、山脉消失。
- **`reliefScale = 0` 与贴花层**：墨线 / 河流 / 湖面都靠固定 `lift` 贴在球面外。纯球面时它们恒在最外层；一旦开起伏，必须保证 `lift > reliefScale`（见 §3.6.1）。
- **★ 大陆掩码是纯算术，可直接搬**：`smoothstep` + 一次归一化（`mean`/`sd`）+ 一次偏移，零额外依赖。
  但 Godot 侧 **`clamp` 的下界必须是 −1**（不是 0）——否则 `seaLevel < 0` 时掩码压出来的大洋会被
  clamp 吃掉，**全球变成陆地**（§2.3.1 踩过）。
- **★ Bezier 接点必须归一化**：上游 / 下游接点是**弦中点**，`|mid(c_i,c_j)| = cos(半格角) < 1`
  （level 5 时 ≈ 0.9995）。Godot 里写 `(a+b).normalized()` 一行就对；**不要直接 `(a+b)*0.5`**，
  否则缎带会沉到球面以下被地形挡住 —— 视觉表现是「**断续的虚线香肠**」（§3.6）。
- **★ 湖连通块 BFS 要手写栈**：`lakeShoreMinCells` 的连通块判定用**显式 `PackedInt32Array` 栈**
  （别用 GDScript 递归 —— 10242 格的大湖可能爆栈）。

---

## 12. 附录：实测数据

复跑方式（两级都跑）：

```powershell
node m1-test.mjs 4     # level 4：2562 region
node m1-test.mjs 5     # level 5：10242 region（默认）
```

脚本会从 `index.html` 里抽取 `L0–L2 BEGIN` 到 `/*__L3DONE__*/` 之间的**整段纯算法层**
（含 L3 的数据准备函数），在 Node 里重新跑一遍完整因果链，然后断言
**93 项**性质。当前状态：**level 4 / level 5 均 93/93 通过**。
（M1 交付时是 73 项；M2 期间为墨线 / 河流缎带 / 纸纹 / `T.area` 新增了 20 项。）

### 12.1 拓扑正确性

| 指标 | level 4 | level 5 | 期望 |
|---|---|---|---|
| region 数 | 2562 | 10242 | `10·4^lv + 2` |
| 三角形数 | 5120 | 20480 | `20·4^lv` |
| 邻接度范围 | 5–6 | 5–6 | 5 或 6 |
| 五边形数 | 12 | 12 | 恰好 12 |
| `Σdeg` | 15360 | 61440 | `= 2E` |
| 异常格（度为 0 / 邻居含自身 / 重复邻居） | 0 | 0 | 0 |
| 半边对侧互反 | 是 | 是 | 是 |
| L1 构建耗时 | **12.7 ms** | **31.7 ms** | ≤ 1000–2000 ms |

### 12.2 海拔 / 温度 / 风场

| 指标 | level 4 | level 5 |
|---|---|---|
| 陆地占比 | 63.6% | **67.8%**（6944 格，v3.0） |
| 峰点数 | 109 | 109 |
| `mountain` 权重覆盖 | 100% 有值 | max 0.858，覆盖 65.5% |
| 山脉区平均海拔 vs 非山脉区 | — | **0.664 vs 0.332** |
| 赤道 / 极地平均温度 | — | **0.923 / 0.132** |
| 赤道高山上的低温格 | — | 16 格（雪峰成立） |
| 信风带（15°）纬向风 | — | **−0.970**（向西吹） |
| 西风带（45°）纬向风 | — | **+0.970**（向东吹） |

### 12.3 降雨迭代

| 指标 | level 5（v3.0） | M2 对照 |
|---|---|---|
| 迭代次数（残差 1e-4） | **12** | 40 |
| 残差 | **6.06e-5** | 9.47e-5 |
| 耗时 | **21.1 ms** | 37.4 ms |
| 纬度解释的降雨方差 | （M2 测过 62.2%，v3.0 未重测） | **62.2%** |
| **陆地**赤道 / ±30° / ±45° / ±65° 平均降雨 | **0.177 / 0.061 / 0.079 / 0.022** | 0.182 / 0.076 / 0.056 / 0.019 ✗ |
| 全域赤道 vs 全域副热带 | — | **0.311 vs 0.049** |
| `humidity` 与 `rainfall` 偶然相关格数 | — | 0 |

**关键结论**：
1. **不加**「海洋蒸发 ∝ 温度」和「副热带下沉」时，球面降雨按纬度**全平**，
   沙漠带完全不存在。加上之后才有「赤道最湿 → 副热带最干 → 中纬次湿 → 极地最干」这条链。
   **副热带沙漠是唯一造得出来的路径**。
2. **★ v3.0 修正**：M2 的陆地纬向平均里 **±45°（0.056）比 ±30°（0.076）还干**，
   「中纬次湿」根本不成立 —— 根因是唯一的湿度源 `sat ∝ T^2` 随纬度单调下降。
   补上 **中纬风暴带（§2.6.1）** 并加强副热带下沉后才有
   `0°=0.177 / ±30°=0.061 / ±45°=0.079 / ±65°=0.022` 的**标准四带**。
   **这是「一个缺失的源项」造成的系统性偏差，靠调参是调不出来的。**
3. 球面纬向风带**旋度非零**，构造不出 DAG，无法像 mapgen4 那样按风向排序一遍扫描收敛，
   **必须迭代**。纬向气候学暖启动 + **陆面蒸发**把迭代压到 **12 次**（`rainMaxIter = 400`）。
4. 纬度只解释 62.2% 的方差（M2 实测）→ **剩下 37.8% 是地形 / 海陆造成的**，
   即雨影和内陆干旱确实出现了（这是 M1 验收标准之一）。

### 12.4 priority-flood / 湖泊 / 流量

| 指标 | level 5（v3.0） | M2 对照 |
|---|---|---|
| 湖泊格占比 | **1.29%**（132 格 / 1.90% 陆地） | 1.59%（163 格） |
| 内流湖泊格 / 流域数 | **118 格 / 22 个流域** | 115 格 / 40 个流域 |
| `floodOrder` 覆盖率 | **10242/10242** | 同 |
| 下坡链全部终止（无环） | 是 | 是 |
| `area`（上游汇水面积）p50 / p90 / p95 / p99 / max（陆地格） | 1 / 5 / 10 / 41 / 92 | 同（未变） |
| `riverThreshold = 2.0` → `isRiver` 占陆地 | **1.63%**（113 格） | 2.68%（158 格） |
| 渲染层河道格（`area ≥ 5 & flow ≥ 0.10`） | **866 格**（主 112 + 支 754） | 387 段 |
| 渲染层缎带四边形（`riverSmooth = 3`） | **2598** | 387 |
| 正序遍历对照（**错误**做法） | 15.074 → 0.000 | 同 |

**★ v3.0 大陆地理指标**（`diag-continent.mjs`，level 5，seed 1337）：

| 指标 | 值 | 目标 |
|---|---|---|
| 陆地占比 | **67.8%** | 60–70% |
| 大洋占比 | 32.2% | — |
| 陆地连通块数 / 最大块占比 | **7 / 99.8%** | 1~3 块，≥ 97% |
| 到海平均距离 | **4.6 格**（max 14） | ≥ 7 格（超级大陆下未达标，见说明） |
| 平均流路长度 / 最长 | **4.95 / 16 格** | 最长 ≥ 20（未达标） |
| 孤立划占比 | **8.1%** | ≤ 12% ✅ |
| 河段 | **873** | — |
| 干旱陆地占比 | **22.7%** | 20–30% ✅ |

> 「到海平均距离」与「最长河链」没达到最初设想的目标（7 格 / 20 格）：
> 超级大陆虽然只有 **7 个陆地连通块**，但**内部有大量内陆海**（132 格湖泊 + 大块内陆海），
> 到海距离被这些水体拉近。这是**有意的取舍**：内陆海让地图更有层次，
> 也让河流有明确的「终点」。若要更极端的长河，把 `seaLevel` 压到 0.10、`lakeMinDepth` 抬到 0.06
> 即可（实测最长链 23 格）—— 但陆地占比会涨到 75% 以上，更像「盘古泛大陆」而不是行星。

**流量阈值实测表**（占陆地的百分比，用来标定 `riverThreshold` 滑杆）：

| 阈值 | level 4 | level 5 |
|---|---|---|
| 0.1 | 35.30% | 36.10% |
| 0.25 | 19.93% | 21.52% |
| 0.5 | 11.61% | 13.41% |
| 0.9 | 5.23% | 7.91% |
| 1.5 | 1.34% | 3.91% |
| **2.0（默认）** | **~1.3%** | **~2.7%** |
| 2.5 | 0.47% | 1.71% |

**关键结论**：
1. **必须反向遍历 `floodOrder`**（叶 → 根）。写成正序会得到完全错误的结果：
   `maxFlow` 从 15.074 掉到 **0.000**。
2. mapgen4 的 `MIN_FLOW ≈ 14.9` 在球面上会让河网消失（`maxFlow` 才 15.07），
   阈值必须降到 **2.0** 量级。
3. `flow` 的产流公式是 `flowGain · moisture²`（照抄 mapgen4）——
   沙漠 `moisture ≈ 0` → **沙漠里天然长不出河**。
   若改成「每格常数产流」，100% 的陆地都会变成河。

**★ M2 的河道判据对照实测**（占陆地百分比 + 河网形状，用来标定 `riverArea` / `riverFlowMin` 两个滑杆）：

| 判据 | 段数 | 占陆地 | 孤立划占比 | 最长链 | 落在干旱群系的河段 |
|---|---|---|---|---|---|
| `flow > 1.0`（旧，= `area≥1 & flowMin 1.0`） | 332 | 5.6% | **30.7%** | 8 | 3.0% |
| `area ≥ 5 & flow ≥ 0.02` | 480 | 8.4% | 20.6% | 10 | 32.7% |
| **`area ≥ 5 & flow ≥ 0.10`（新默认）** | **387** | **6.6%** | **18.3%** | **10** | **22.0%** |
| `area ≥ 5 & flow ≥ 0.25` | ~300 | ~5.2% | ~15% | 10 | ~12% |
| `area ≥ 8 & flow ≥ 0.10` | 233 | 4.1% | 12.9% | 10 | 21.5% |
| `area ≥ 14 & flow ≥ 0.30` | 107 | 1.9% | ~10% | 8 | ~10% |
| **v3.0 默认（大陆掩码后）★** | **2598 四边形 / 866 河道格** | **12.5% 陆地** | **8.1%** | **16** | — |

> **v3.0 的两列数字与 M2 不可直接对比**：段数口径变了（M2 = 每河段 1 个 quad，
> v3.0 = 每河道格 `riverSmooth = 3` 个 quad），所以「占陆地」按**河道格 / 陆地格**算。
> 真正的可比量是**孤立划占比 18.3% → 8.1%** 与**最长链 10 → 16** —— 这两项才是
> 「河网变健康」的证据（§2.3.1）。

> 「落到干旱群系」的分母是陆地 40.9% 本身就在干旱群系（沙漠 / 灌丛 / 稀树草原）里，
> 所以 22% 意味着河流仍**明显偏好湿润区**（富集比 ≈ 0.54），但不会在沙漠里完全消失。
> 这是有意为之的折中：`flowMin` 抬到 0.25 会把河网削得太稀（见 §3.6 的观感结论）。

**为什么孤立划占比是「梳齿」的量化指标**：孤立划 = 该河段的上游与下游都没有别的已绘制河段，
也就是一根**孤立的短划**。它们全部集中在海岸线附近（每个临海格各自入海，方向近乎平行），
正是整球截图上看到的「鱼骨 / 排线」。

### 12.5 生物群系分布（level 5，seed = 1337）

陆地 **6944 格**（67.8%）。**v3.0 重新标定**（M2 为对照）：

| 群系 | 格数 | 占陆地 | 群系 | 格数 | 占陆地 |
|---|---|---|---|---|---|
| 灌丛 | 1252 | **18.0%** | 温带森林 | 701 | 10.1% |
| 苔原 | 930 | 13.4% | 沙漠 | 427 | **6.1%** |
| 热带雨林 | 836 | 12.0% | 山脉 | 345 | 5.0% |
| 雪峰 | 755 | 10.9% | 泰加林 | 314 | 4.5% |
| 草原 | 726 | 10.5% | 稀树草原 | 258 | 3.7% |
| 冰原 | 155 | 2.2% | 咸水湖 | 118 | 1.7% |
| 河流 | 113 | 1.6% | 湖泊 | 14 | 0.2% |

| 非陆地群系 | 格数 |
|---|---|
| 深海 | 2590 |
| 海洋 | 702 |
| 海冰 | 6 |

> **v3.0 与 M2 的分布差别**（对照 §2.10 与 §2.6）：
> - **沙漠 8.3% → 6.1%**：新增的 `moistAridTropical = 0.24` 把热带干区从
>   「稀树草原」拉回「沙漠」（稀树草原 6.9% → 3.7%），但 `landEvaporation = 0.55`
>   让世界整体变湿，两股力互相抵消，净结果略降。
> - **雪峰 9.0% → 10.9% / 苔原 9.3% → 13.4%**：`seaLevel` 从 0.40 降到 0.20 →
>   `landRelief = (e − s)/(1 − s)` 的分母从 0.60 变 0.80，**同一海拔的直减降温更强**
>   → 寒冷群系变多。这是「降 `seaLevel` 必须重标温度阈值」的直接证据（见 §2.4.1）。
> - **灌丛 24.6% → 18.0%**：M2 的灌丛过多是因为 `moistDry` 卡在分位 p45，
>   而 v3.0 的 `moistDry = 0.14` ≈ p49 + 更高的热带阈值，把一部分分给了沙漠 / 草原。
>
> 湖泊 + 咸水湖 = **14 + 118 = 132**，与 `isLake` 计数**完全一致**
> （M2 时曾差 3 格，因为部分湖落在雪线之上被 `tempSnow` 抢走；
> v3.0 的湖泊都在中低纬内陆，没有被抢）。

用于标定阈值的**陆地标量分位**（`p05 / p15 / p30 / p50 / p70 / p85 / p95`，v3.0 实测）：

| 标量 | 分位 |
|---|---|
| `moisture` | 0.002 / 0.043 / 0.088 / **0.142** / 0.246 / 0.381 / 0.525 |
| `temperature` | 0.028 / 0.245 / 0.445 / **0.631** / 0.762 / 0.860 / 0.937 |
| `rainfall` | 0.001 / 0.017 / 0.035 / **0.057** / 0.098 / 0.152 / 0.210 |

**关键结论**：
1. **阈值必须按分位标定**。沿用 mapgen4 的 `moistDry = 0.30` 会让 69% 的陆地
   变成「干旱」（因为本实现的 `moisture` 中位数只有 **0.142**）→ 灌丛占 50%、
   雨林只剩 3 格。V3.0 取值 `moistDry = 0.14`（≈ p49）/ `moistWet = 0.34`（≈ p82）/
   `moistAridTropical = 0.24`（**仅热带**，≈ p60）。
2. `moisture` 用**固定参考值** `rainReference = 0.40` 而不是运行时最大值 ——
   否则 `raininess` 滑杆会被归一化掉（拖了没反应）。
3. 沙漠**不会跑到极地**：沙漠要求 `temperature ≥ 0.80`，
   而 ±30° 副热带的下沉带 `cos(30°) = 0.866` 正好落在暖区。

### 12.6 确定性与 L3 几何

| 指标 | level 4 | level 5 |
|---|---|---|
| 同种子海拔逐位一致 | 是 | 是 |
| 同种子峰点数一致 | 109 vs 109 | 109 vs 109 |
| 渲染顶点数 `= nR + nT` | 7682 | **30722** |
| 索引长度 `= 9·nT` | 46080 | **184320** |
| `triToRegion` 全部合法 | 是 | 是 |
| 三角形绕序朝外（抽检 200） | 0/200 朝内 | 0/200 朝内 |
| 海面绝对平整（半径恒为 1） | 是 | 是 |
| 顶点色全部有限且非负、无溢出 | 是 | 是 |
| `paletteAt` 全域返回合法 `[r,g,b] ∈ [0,1]` | 是 | 是 |
| `paletteAt` 陆/海内部连续（无「每格纯色」突变） | 是 | 是（最大 Δ 0.0632） |
| `shade` 范围（有对比度） | — | **0.620 → 1.170**，平地 ≈ 1.01 |
| 海岸线段数 / 湖岸段数 / NaN | — | **2056 / 224 / 0** |
| 河流河道格 / 缎带四边形数 / NaN | — | **866 / 2598 / 0**（`riverSmooth = 3`） |
| 纸纹：同种子逐位一致 | — | 是（噪声种子固定 `0x51a2e7`） |
| 纸纹：受影响顶点占比 / 最大 Δ | — | **100%** / 0.076 |

**v3.0 的三个 Mesh（headless 实测 draw call = 3，浏览器实测 `lines: 0`）**：

| Mesh（`name`） | 顶点数 | 三角形数 | 材质 |
|---|---|---|---|
| `planetMesh`（`'planet'`，地形 + 湖面顶点色） | 30722 | 61440 | `MeshBasicMaterial({ vertexColors, DoubleSide })` |
| `inkObj`（`'ink'`，海岸 2056 + 湖岸 224 段） | 9120 | 4560 | 同上 + `transparent / depthWrite:false / forceSinglePass:true` |
| `riverObj`（`'river'`，河流缎带） | 10392 | 5196 | 同上 + `transparent / depthWrite:false / forceSinglePass:true` |
| `hoverObj`（`'hover'`，悬停 / 选中轮廓） | **≤ 6**（`LineLoop`，按度数 `setDrawRange`） | 0（线段） | `LineBasicMaterial`（`hoverColor` / `selectColor`）；**仅悬停或选中时可见** |
| **合计（未悬停）** | **50234** | **71196** | **3 draw call** |
| **合计（悬停 / 选中）** | 50240 | 71196 | **4 draw call**（`browser-check` 与 `m3-check` 均实测） |

> 浏览器 `renderInfo.triangles` 会略高——因为 `browser-check.mjs` 在此之前
> 先拖动过一次 `raininess` 滑杆（+0.3），河网多出几段。
> 墨线段**最小宽度 0.00300**、目标 0.0042；每段 4 顶点 / 6 索引（缎带而非 1px 线）。
> 单次几何构建耗时（`timing-m2.mjs`，level 5）：`buildInkGeometry` **4.9 ms**、
> `buildRiverRibbon` **5.2 ms**、`refreshVertexColors`（纸纹两段式）**5.5 ms**。
> ⚠️ 这三项在**同一台机器**上会随后台负载在 **5–12 ms** 之间波动（实测见过 9.1 / 11.8 / 7.3 的一组），
> 属于噪声而非回归 —— 判断回归要看**顶点 / 索引 / 三角形数**（这三个是确定的）。

---

## 13. 与现有实现的对照

| | 现状 v1（`archive/v1-biome-globe.html`） | M1 改造后 | 状态 |
|---|---|---|---|
| 生物群系 | 解析气候模型（纬度 + 解析湿度），各地块**独立** | **因果链**，降雨来自迭代求解，含水汽输运 / 雨影 / 副热带下沉 | ✅ |
| 湿度来源 | `latitudinalMoisture`（三圈环流解析式） | `solveRainfall` 的迭代解；解析式降级为**暖启动初值** | ✅ |
| 温度 | 已实现，但只参与 biome 判定 | 同公式，**同时作为蒸发饱和值/雪线判据**，并进入 `paletteAt` 第二轴 | ✅ |
| 风 | 无 | 纬向风带（三圈环流），单向风为调试选项 | ✅ |
| 海拔 | 噪声天然形成 | 平滑大陆 FBM + **独立细节粗糙度层** + **大陆掩码** + 山脉脊线 + z-score 标准化 | ✅ v3.0 |
| 山脉 | 同上 | Poisson-disk 峰点（球面）+ 加权距离场 + 脊线增强（mapgen4 式） | ✅ |
| 大陆 | 无（迷宫型群岛） | ★ **大陆掩码**：低频包络只当掩码、**不加进海拔**，z-score **之后**按 `dz` 压低大洋（§2.3.1） | ✅ v3.0 |
| 气候 | 解析 `latitudinalMoisture`（三圈环流） | 海洋蒸发 + **陆面蒸发** + 副热带下沉 + **中纬风暴带**（§2.6.1–2.6.2） | ✅ v3.0 |
| 河流 | 无 | priority-flood 下坡 + **反向**流量累积；产流 `∝ moisture²` → 沙漠无河 | ✅ |
| 湖泊 | 无 | priority-flood 填平量 `filled − elevation`；含 `isEndorheic` 气候代理字段 | ✅ |
| 渲染 | **每图块一个纯色 mesh（10242 draw call）** | **3 个 mesh / 3 draw call**（地形 1 + 墨线 1 + 河流 1），顶点色 + 折叠四边形 + 烘焙光照 + 纸纹 | ✅ |
| 光照 | 无 | 逐顶点 hillshade（**无晨昏线**，不随视角变化）；坡度取自 **`elevation` 场梯度**，与几何起伏解耦 | ✅ |
| 海岸线 | 无（只有颜色边界） | **缎带化墨线**（有真实宽度），marching triangles 等值线切割生成；小湖不描边（§3.5） | ✅ v3.0 |
| 湖泊 / 河流配色 | 无 | 陆色向深蓝绿混合；内流湖用略不同色 | ✅ |
| 参数 | 少数常量 | 集中 `CONFIG`（5 个分组）+ **20 个实时控件** | ✅ v3.0 |
| 调试视图 | 无 | 海拔 / 温度 / 降雨 / 流量 / 生物群系 / 地形色 **6 视图** | ✅ |
| 纸纹 / 湖泊水面 | 无 | 固定种子噪声 + 暖白纸底烘进顶点色；湖面按 `filled` 抬升 + 湖岸墨线 | ✅ M2 |
| 河流缎带 | 无 | 变宽度缎带 + 两级门槛（`area` + `flow`）+ 主/支两级配色 + **二次 Bezier 平滑中心线** | ✅ v3.0 |
| hover 高亮 | 无 | ✅ **M3 完成**：独立 `LineLoop` 描 dual 轮廓（`hoverLift`），点击选中保留、`Esc` 取消；**不改几何体**（`planetMesh` 常年 1 draw call） | ✅ M3 |
| 验证 | 无 | headless **93 项**断言 + Chromium CDP 全流程 + 2 个静态扫描器 | ✅ 新增 |

### 13.1 v1 → M2 → M2.5 的定量对照

| 指标 | v1 | M2 | **M2.5 / v3.0** |
|---|---|---|---|
| Draw call | 10242 | **3** | **3**（不变） |
| 渲染顶点 | 10242 × 6 = 61452 | 42794 | **50234** |
| 大陆形态 | — | 迷宫型群岛（最大块 39.9%） | ★ **单块超级大陆（99.8%）+ 大西洋式大洋 + 内陆海** |
| 陆地占比 | — | 47.1% | **67.8%** |
| 河流 / 湖泊 | 无 | 387 段缎带（主 98 + 支 289）/ 163 格湖 | **866 河道格 / 2598 缎带四边形** / 132 格湖（118 内流） |
| 河道判据 | 无 | `area ≥ 5 & flow ≥ 0.10`，孤立划 18.3% | 同上，**孤立划 8.1%** |
| 最长河链 | — | 10 格 | **16 格** |
| 气候带 | — | 三带（中纬次湿**不成立**） | ★ **四带成立**（0.177 / 0.061 / 0.079 / 0.022） |
| 降雨迭代 | — | 40 次 / 37.4 ms | **12 次 / 21.1 ms** |
| 参数控件 | 少数常量 | 14 个 | **20 个**（+大陆 6 件套） |
| 字母表之外的产物 | — | `shade` / `isEndorheic` / `triToRegion` / `flow` / `area` | 同上 + **`continent`（大陆掩码）** |
| 每帧 CPU | 10242 次 `mesh.visible` 判定 + 遍历 | 3 个对象，零逐格循环 | 同 |
| 观感 | 平面纯色多边形 | 墨线岸线 + 树枝状河网 + 湖面 + 颗粒纸纹 | 同上 + **树状长河 + 平滑缎带 + 无六角螺帽** |
