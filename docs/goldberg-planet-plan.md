# Goldberg 球体生物群系星球 — 实现规划文档

> 目标交付物：单个可直接在浏览器中打开的 `index.html`，内含全部 CSS 与 JavaScript（ES Module + Three.js CDN），实现一个由六边形与 12 个五边形组成的 Goldberg 球体，并按程序化地形数据以纯色绘制山脉、河流、沙漠、森林、冰原、海洋等生物群系。
>
> 本文档为**编码前的规划与设计说明**，包含原理、算法伪代码、数据结构、参数表、风险与验收标准。确认后即可据此实现。

---

## 1. 目标与范围

### 1.1 必须实现（MVP）

| 编号 | 功能 | 说明 |
| --- | --- | --- |
| F1 | Goldberg 球体网格生成 | 二十面体 → 递归细分 → 归一化到单位球面 → 求对偶图 |
| F2 | 图块数据结构 | 每个多边形含 `center` / `vertices` / `elevation` / `biome` / `latitude` |
| F3 | 程序化高度 | 3D Simplex 噪声 + FBM（4~6 八度），归一化到 `0~1` |
| F4 | 生物群系分类 | 基于 `elevation` 与 `latitude` 的规则判定，含河流 |
| F5 | 纯色渲染 | 每图块一个 `Mesh` + `MeshBasicMaterial`，放入 `Group` |
| F6 | 交互 | `OrbitControls` 旋转/缩放；`Raycaster` 悬停高亮 |
| F7 | HUD | 左上角显示悬停图块的海拔、生物群系、纬度 |

### 1.2 非目标（本期不做，列为后续增强）

- 贴图/纹理、法线贴图、真实光照与阴影
- LOD、分块加载、Web Worker 并行
- 真实水文模拟（下坡流向、流域汇聚、湖泊）
- 导出模型（OBJ/GLB）、截图导出
- 移动端触控专项适配（`OrbitControls` 自带基础触控支持）

---

## 2. 技术选型与依赖

### 2.1 依赖清单

| 依赖 | 版本 | 引入方式 | 用途 |
| --- | --- | --- | --- |
| Three.js | `0.160.0` | jsDelivr CDN，`importmap` 映射 `three` | 渲染核心 |
| OrbitControls | 随 three 0.160.0 | `three/addons/controls/OrbitControls.js` | 拖拽旋转、滚轮缩放 |
| SimplexNoise | 随 three 0.160.0 | `three/addons/math/SimplexNoise.js` | 3D 噪声 |

> **说明**：`SimplexNoise` 位于 three 的 `examples/jsm/math/` 目录，**不在** `build/three.module.js` 核心包中，因此不能写 `THREE.SimplexNoise`。它内部 `import { MathUtils } from 'three'`，所以**必须**使用 `importmap` 把裸模块名 `three` 映射到 CDN 地址，否则浏览器无法解析裸导入。

### 2.2 importmap 与模块引入写法

```html
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
  }
}
</script>

<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
</script>
```

### 2.3 CDN 备选方案

若主 CDN 不可达，按顺序替换 `importmap` 中的域名即可，代码零改动：

1. `https://cdn.jsdelivr.net/npm/three@0.160.0/...`（默认）
2. `https://unpkg.com/three@0.160.0/...`
3. `https://esm.sh/three@0.160.0`（注意 `esm.sh` 的子路径规则与 jsDelivr 不同，需单独验证 `addons` 路径）

若改用独立的 `simplex-noise` npm 包，需注意 **API 差异**：v4 导出的工厂函数 `createNoise3D()` 返回噪声函数，与 three addons 的 `new SimplexNoise().noise3d()` 类式 API 完全不同。**统一封装**在 `sampleNoise3D(x, y, z)` 内部，业务代码不感知具体实现：

```js
// 统一噪声采样入口，便于将来替换噪声实现
function sampleNoise3D(x, y, z) {
  return noise.noise3d(x, y, z); // 返回 [-1, 1]
}
```

### 2.4 可复现性（重要）

`new SimplexNoise()` 默认使用 `Math.random` **随机填充置换表**，**每次刷新地形都不同**。为让地形可复现（便于对照调参、截图对比、问题复现），传入带种子的伪随机数生成器。

> ⚠️ **坑点**：three@0.160.0 的 `SimplexNoise` 构造函数内部执行的是 `r.random()`，**不是 `r()`**：
> ```js
> constructor( r = Math ) {
>   for ( let i = 0; i < 256; i ++ ) this.p[ i ] = Math.floor( r.random() * 256 );
> }
> ```
> 因此**必须传入「带 `random()` 方法的对象」**，直接传函数会在构造时就抛
> `TypeError: r.random is not a function`，整个页面白屏（且因为是模块顶层代码，报错位置容易被忽略）。
> 默认的 `Math` 恰好自带 `random()`，所以默认路径不会有问题——这也正是这个坑容易被漏掉的原因。

```js
// mulberry32：32 位种子 PRNG，返回 [0,1)
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const noise = new SimplexNoise({ random: mulberry32(CONFIG.seed) });   // 注意是对象，不是函数
```

---

## 3. 几何原理

### 3.1 从二十面体到 Goldberg 多面体

正二十面体：`V = 12`、`E = 30`、`F = 20`。其 12 个顶点每个连接 5 个三角形。

> ⚠️ **`buildIcosahedron()` 返回的 12 个顶点，在做任何事之前必须逐个 `normalize()`。**
> 常用的二十面体顶点公式 `(0, ±1, ±φ)`、`(±1, ±φ, 0)`、`(±φ, 0, ±1)`（`φ = (1+√5)/2`）给出的点**模长约为 1.902，并非单位长度**；只有写法 `a = 1/√(1+φ²)` 的变体才接近 1。
> 无论采用哪种写法，都必须显式归一化，否则：(1) `getMidpoint` 中先 `add` 再 `normalize` 的结果会与预期不符；(2) `center.y` 不再等于 `sin(纬度)`，纬度判定会整体偏移；(3) `dualPos` 重心归一化后的分布不再均匀。

**第一步：细分（Geodesic Sphere / Icosphere）**

递归地把每个三角形一分为四（取三边中点，归一化到单位球面），迭代 `level` 次：

```
V(level) = 10 · 4^level + 2
E(level) = 30 · 4^level
F(level) = 20 · 4^level
```

| level | 三角形数 F | 顶点数 V | 备注 |
| --- | --- | --- | --- |
| 0 | 20 | 12 | 正二十面体 |
| 1 | 80 | 42 | |
| 2 | 320 | 162 | |
| 3 | 1280 | **642** | **推荐默认**：视觉精度与性能平衡 |
| 4 | 5120 | 2562 | 高精度，面片更细腻 |

**第二步：求对偶图（Dual）得到 Goldberg 多面体**

- 对偶图的**面** ↔ 原网格的**顶点**（因此对偶面数 = `V`）
- 对偶图的**顶点** ↔ 原网格的**面**（即每个三角形的重心，因此对偶顶点数 = `F`）

原网格中顶点度数为 6（普通点）或 5（原二十面体的 12 个顶点），所以对偶面是六边形或五边形 —— 且**恰好 12 个五边形**，这正是 Goldberg 多面体（`GP(3,0)` 型，即测地线球的对偶）。

欧拉公式校验：对偶多面体 `V' = F`、`F' = V`，`V' - E' + F' = F - E + V = 2` ✔

> **验收关键点**：生成的图块中五边形必须恰好 12 个，其余全部为六边形。

### 3.2 关键实现细节

#### 3.2.1 边中点缓存（保证顶点唯一、无重复）

如果对每个三角形独立计算中点，共享边会产生两个浮点近似相等的顶点（也可能因归一化顺序不同而略有差异），后续「按顶点聚类三角形」会失败。**必须**用 `Map` 缓存边中点索引，用无序顶点对作为键：

```
function subdivide(vertices, faces, level):
    for each iteration in 1..level:
        cache = Map()
        newFaces = []
        for each (a,b,c) in faces:
            ab = getMidpoint(a,b)
            bc = getMidpoint(b,c)
            ca = getMidpoint(c,a)
            newFaces.push((a,ab,ca), (b,bc,ab), (c,ca,bc), (ab,bc,ca))
        faces = newFaces

function getMidpoint(i, j):
    // 数值键：min*1e6 + max。顶点总数远小于 1e6（level=4 时 V=2562），故键唯一
    key = Math.min(i, j) * 1e6 + Math.max(i, j)
    if cache.has(key) return cache.get(key)
    v = vertices[i].clone().add(vertices[j]).normalize()   // 投影到单位球面
    idx = vertices.push(v) - 1
    cache.set(key, idx)
    return idx
```

#### 3.2.2 对偶顶点的绕序（环绕排序）

要得到多边形顶点**按顺序环绕**的数组，需把相邻三角形重心投影到该顶点的切平面，再按极角排序：

```
function buildDual(vertices, faces):
    // 1) 对偶顶点 = 每个三角形的归一化重心，索引与 faces 一一对应
    dualPos[fi] = normalize( (vertices[a] + vertices[b] + vertices[c]) / 3 )

    // 2) 顶点 -> 相邻三角形索引
    vertexFaces = Array(vertices.length).fill().map(() => [])
    faces.forEach((f, fi) => f.forEach(vi => vertexFaces[vi].push(fi)))

    // 3) 每个原顶点生成一个多边形
    for vi in 0 .. vertices.length-1:
        n = vertices[vi]                       // 已归一化，作为切平面法线
        // 构造切平面正交基
        helper = (abs(n.x) < 0.9) ? (1,0,0) : (0,1,0)
        u = normalize(cross(helper, n))
        w = cross(n, u)                        // 已归一化
        ring = vertexFaces[vi].map(fi => {
            const p = dualPos[fi]
            const d = p.clone().sub(n.clone().multiplyScalar(p.dot(n)))  // 投影到切平面
            return { fi, ang: Math.atan2(d.dot(w), d.dot(u)) }
        })
        ring.sort((x, y) => x.ang - y.ang)
        // 只保存索引，不保存坐标副本 —— 这是「方案 B 无缝隙」成立的前提（见 §6.1）
        polygon = { center: n, vertexIndices: ring.map(x => x.fi) }

    return { dualPos, polygons }        // 不变式：polygons[i].center === vertices[i]
```

**返回值契约（务必遵守）**：

```js
{
  dualPos:  THREE.Vector3[],   // 长度 = faces.length，每个元素是某三角形的归一化重心
  polygons: Array<{
    center:        THREE.Vector3,   // = 对应的原网格顶点（单位向量），即对偶面中心
    vertexIndices: number[],        // 长度 5 或 6，环形排序后指向 dualPos 的下标
  }>,
}
// 不变式 1：polygons.length === vertices.length（原网格顶点数）
// 不变式 2：polygons[i].center === vertices[i]（第 i 个多边形对应第 i 个原顶点）
// 不变式 3：polygons[i].vertexIndices.length 为 5 或 6，且其中恰有 12 个长度为 5
```

**注意**：
- 多边形只保存**索引**，绝不在这一步拷贝坐标。真正的渲染坐标由全局共享的 `renderPos` 数组统一给出（§6.1），索引是「共享顶点」语义的载体。若此处改成保存坐标副本，后续顶点偏移将失去共享基准，图块之间会重新出现缝隙。
- 由于对偶面是凸多边形，`ring` 排序后的顺序天然构成合法环绕，**无需**再做凸包判断。
- 该基向量构造满足 `u × w = n`（推导：`u × w = u × (n × u) = n(u·u) − u(u·n) = n`），因此从球外观察，环序**始终为逆时针**，与 `helper` 取 `(1,0,0)` 还是 `(0,1,0)` 无关。材质仍保留 `side: THREE.DoubleSide` 作为防御性措施。
- 当 `|n.x| >= 0.9` 时 `helper` 改用 `(0,1,0)`：此条件下 `n` 已远离 Y 轴，叉乘不会退化；而当 `|n.x| < 0.9` 时 `n` 与 X 轴夹角至少约 26°，叉乘模长 ≥ sin(26°) ≈ 0.44，同样安全。

---

## 4. 数据结构

### 4.1 图块（Tile）对象

```js
/**
 * @typedef {Object} Tile
 * @property {number}            index          图块索引
 * @property {THREE.Vector3}     center         图块中心单位向量（未偏移，用于噪声采样/交互/朝向）
 * @property {number[]}          vertexIndices  环形排序的多边形顶点索引（指向全局 dualPos，是拓扑真值）
 * @property {THREE.Vector3[]}   vertices       渲染用顶点坐标数组，满足 vertices[i] === renderPos[vertexIndices[i]]
 *                                              （已应用海拔偏移；由顶点索引映射而来，多边形之间共享同一批 Vector3 引用）
 * @property {number}            elevation      海拔，0~1
 * @property {string}            biome          生物群系枚举值
 * @property {number}            latitude       纬度，等于 center.y，范围 -1（南极）~ 1（北极）
 * @property {number}            avgRadius      该图块所有顶点半径的算术平均（调试/统计用，非渲染必需）
 * @property {THREE.Mesh}        mesh           渲染网格
 * @property {THREE.Color}       baseColor      基础色，= new THREE.Color(BIOME_COLOR[biome])（用于悬停复原）
 */
```

> **字段关系（关键）**：`vertexIndices` 是拓扑（来自 §3.2.2 的 `buildDual`），`vertices` 是几何（渲染坐标）。
> 数据流是单向的：`vertexIndices` → 查 `renderPos` → `vertices`。
> **不要**反过来从 `vertices` 反推拓扑，也不要让两个字段各自独立计算坐标，否则会重新引入缝隙。
>
> 补充：原始需求中「`vertices`：构成该图块的顶点数组（用于构建几何体）」由本表的 `vertices` 字段满足；`vertexIndices` 是为保证顶点共享而额外引入的拓扑字段。

### 4.2 生物群系枚举

> **v1.5 变更**：由 7 种扩展为 12 种。原先只有「森林/平原」一种绿色植被，
> 无法表达随纬度变化的气候带，导致冰原旁边也能长出热带森林。
> 现在按**温度带 × 湿度带**展开为完整气候序列。

```js
const BIOME = {
  OCEAN:      'ocean',       // 海洋
  SEA_ICE:    'seaIce',      // 极地海冰
  RIVER:      'river',       // 河流
  DESERT:     'desert',      // 沙漠（炎热 + 干旱）
  GRASSLAND:  'grassland',   // 草原（半干旱）
  FOREST:     'forest',      // 温带森林
  RAINFOREST: 'rainforest',  // 热带雨林（炎热 + 湿润）
  TAIGA:      'taiga',       // 针叶林（寒温带）
  TUNDRA:     'tundra',      // 苔原（亚寒带）
  MOUNTAIN:   'mountain',    // 山脉
  SNOW:       'snow',        // 雪峰
  ICE:        'ice',         // 极地冰原
};
```

### 4.3 颜色映射表

| 生物群系 | 枚举 | HEX | 预览 |
| --- | --- | --- | --- |
| 海洋 | `ocean` | `#1a3a6b` | 深蓝 |
| 海冰 | `seaIce` | `#cfe2ee` | 浅蓝白 |
| 河流 | `river` | `#3a9bd9` | 亮蓝 |
| 沙漠 | `desert` | `#e0c56e` | 沙黄 |
| 草原 | `grassland` | `#9ab54f` | 黄绿 |
| 温带森林 | `forest` | `#3d8c40` | 草绿 |
| 热带雨林 | `rainforest` | `#1f6b2e` | 深绿 |
| 针叶林 | `taiga` | `#2f6b4f` | 暗青绿 |
| 苔原 | `tundra` | `#8b9683` | 灰绿 |
| 山脉 | `mountain` | `#7a7a7a` | 中灰 |
| 雪峰 | `snow` | `#f0f0f0` | 近白 |
| 冰原 | `ice` | `#dce8f2` | 冷白（与雪峰区分，体现冰盖质感） |

```js
const BIOME_COLOR = {
  [BIOME.OCEAN]:      0x1a3a6b,
  [BIOME.SEA_ICE]:    0xcfe2ee,
  [BIOME.RIVER]:      0x3a9bd9,
  [BIOME.DESERT]:     0xe0c56e,
  [BIOME.GRASSLAND]:  0x9ab54f,
  [BIOME.FOREST]:     0x3d8c40,
  [BIOME.RAINFOREST]: 0x1f6b2e,
  [BIOME.TAIGA]:      0x2f6b4f,
  [BIOME.TUNDRA]:     0x8b9683,
  [BIOME.MOUNTAIN]:   0x7a7a7a,
  [BIOME.SNOW]:       0xf0f0f0,
  [BIOME.ICE]:        0xdce8f2,
};
```

---

## 5. 地形生成算法

### 5.1 高度生成：FBM 叠加

直接在单位球面上采样 3D 噪声（无需 UV 映射，天然无缝、无极区畸变）。

**推荐做法：大陆度 + 细节双层混合**，比单层 FBM 更自然 —— 低频噪声决定海陆轮廓，高频噪声决定局部起伏：

```
function rawElevation(p):                     // p 为单位向量
    // 低频：大陆/海洋格局（波长长，决定海陆分布）
    const c = fbm(p.clone().multiplyScalar(CONFIG.continentScale),
                  CONFIG.continentOctaves, 2.0, 0.5)          // ∈ [-1,1]
    const continent01 = c * 0.5 + 0.5

    // 高频：山地细节
    const d = fbm(p.clone().multiplyScalar(CONFIG.detailScale),
                  CONFIG.detailOctaves, 2.0, 0.5)
    const detail01 = d * 0.5 + 0.5

    // 混合（权重之和为 1）
    return CONFIG.continentWeight * continent01
         + (1 - CONFIG.continentWeight) * detail01

function fbm(p, octaves, lacunarity, gain):
    let amp = 1, freq = 1, sum = 0, norm = 0
    for i in 0 .. octaves-1:
        sum  += amp * sampleNoise3D(p.x*freq + OFFSET.x,
                                    p.y*freq + OFFSET.y,
                                    p.z*freq + OFFSET.z)
        norm += amp
        amp  *= gain
        freq *= lacunarity
    return sum / norm                            // ∈ [-1,1]
```

**要点**：
- `OFFSET` 是一个固定的随机三维偏移向量（由种子生成），避免噪声在原点处的对称瑕疵。
- **八度数**：`continentOctaves = 4`、`detailOctaves = 6`，满足「4~6 个八度」要求。
- 每个图块的 `elevation` 只依赖其 `center`，因此**每个多边形只采样一次**，性能与面数线性相关。

#### 5.1.1 全局标准化（保证海陆比可预测）

上面得到的 `rawElevation` **不能直接当 `elevation` 用**。FBM 的取值集中在均值附近（近似正态），若直接使用：
- `elevation` 会挤在 0.5 附近的一小段区间里，地形几乎没有层次；
- 海平面 `0.35` 会切出完全不可预期的海陆比（可能 5%，也可能 60%），调参变成盲猜。

因此改为**两步法**：先算出全部图块的原始值，做一次全局 z-score 标准化，再线性映射到 0~1：

```
function computeElevations(tiles):
    raw = tiles.map(t => rawElevation(t.center))

    mean = mean(raw);  std = stddev(raw)
    for i in 0 .. tiles.length-1:
        z = (raw[i] - mean) / std                    // 标准化：均值 0，标准差 1
        tiles[i].elevation = clamp01(CONFIG.elevationCenter + z * CONFIG.elevationSpread)
```

**为什么这样做**：标准化之后，`elevation` 的分布形态与原噪声的具体幅度无关，只由两个参数控制：

| 参数 | 作用 | 实测影响 |
| --- | --- | --- |
| `elevationCenter` | 分布中心位置 | 调高 → 整体抬升 → 海洋减少 |
| `elevationSpread` | 分布展开幅度 | 调大 → 极端值变多 → 海洋与雪峰同时增多 |

在实际实现中实测（level=3，seed 固定）：

| center | spread | 海洋占比 | 雪峰占比 |
| --- | --- | --- | --- |
| 0.42 | 0.28 | 39.9% | 9.5% |
| 0.46 | 0.34 | 37.2% | 16.2% |
| **0.45** | **0.30** | **36.8%** | **9.8%** |
| 0.50 | 0.40 | 35.2% | 23.5% |

> **实现说明**：本文档 v1.0 曾计划用 `Math.pow(e, heightPower)` 做对比度增强。实际实现时发现单点幂函数既无法把分布拉开，也无法控制海陆比，因此改用上述全局标准化方案，`heightPower` 参数已被移除。

### 5.2 河流生成

**方案 A（默认，简单且效果好）：脊线噪声**

用另一路噪声构造「零值线」，`|noise|` 接近 0 的地方即为河道，形成天然的网状水系：

```
function isRiver(p, elevation):
    if (elevation <= SEA_LEVEL + 0.02)          return false   // 海面以下不算河
    if (elevation > CONFIG.riverMaxElevation)   return false   // 高山雪线以上不算河
    const r = Math.abs(sampleNoise3D(p.x*CONFIG.riverScale + riverOffset.x,
                                     p.y*CONFIG.riverScale + riverOffset.y,
                                     p.z*CONFIG.riverScale + riverOffset.z))
    // 越靠近河源（海拔越高）河道越窄，越接近入海口越宽
    const t = (elevation - SEA_LEVEL) / (CONFIG.riverMaxElevation - SEA_LEVEL)   // 0 近海 → 1 高山
    const width = CONFIG.riverWidth * (0.4 + 0.6 * (1 - t))
    return r < width
```

**方案 B（可选增强）**：真正的随机游走 / 下坡流向。
以图块邻接关系构建图，从高海拔图块开始按「最陡下降」逐格流动，被流经的图块标记为河流，直到进入海洋或被局部极小值困住（此时形成湖泊）。需要建立图块邻接表（对偶图邻接 = 共享对偶边的多边形对），实现成本高，列为二期。

> **河流后处理**：把河流图块的 `elevation` 略微下调（如 `e -= 0.02`），让河道在启用顶点偏移时形成视觉上的凹陷。

### 5.3 生物群系分类（气候模型，v1.5 重写）

> **原始版本的问题**：纬度只参与两条线（沙漠带、冰原线），中间 `0.55 < |lat| < 0.80`
> 这一段完全无约束，于是「冰原旁边长着热带森林」。原因是把 `elevation` 当成了唯一的地形
> 依据，而**气候本质上是纬度驱动的**。
>
> **v1.5 改为标准气候模型**：先由纬度与海拔推出**温度**、由纬度推出**湿度**，
> 再用 (温度, 湿度) 二维表划分群系。

#### 5.3.1 温度

太阳高度角随纬度下降，到达地表的辐射能量正比于 `cos(地理纬度)`。
而 `center.y === sin(地理纬度)`，所以：

```
insolation = cos(纬度) = sqrt(1 - lat²)          // lat = tile.center.y
landRelief = max(0, (elevation - SEA_LEVEL) / (1 - SEA_LEVEL))   // 陆地相对高度 0~1
temperature = clamp01(insolation - landRelief * lapseRate + 噪声)
```

- 用「陆地相对高度」而不是直接减 `elevation`，这样**平原不会被平白无故降温**。
- `lapseRate = 0.50`：对应气温直减率，让赤道高山（乞力马扎罗）也能进入寒冷带。
- 温度随纬度的实际取值：赤道带 ≈ 0.87，中纬 ≈ 0.62，极地 ≈ 0.23。

#### 5.3.2 湿度 —— 三圈环流

**这是沙漠能被做出来的关键。** 赤道与副热带的温度几乎相同，但一个是雨林、一个是沙漠，
差别全部来自降水。地球大气的三圈环流给出了降水的纬度带状分布：

```
赤道（|lat| ≈ 0.00）  上升气流 → 湿润   （热带雨林带）
副热带（≈ 0.40）      下沉气流 → 干旱   （撒哈拉、阿拉伯、澳洲沙漠带）
中纬（≈ 0.72）        西风带   → 湿润   （温带森林带）
极地（≈ 1.00）        下沉气流 → 干旱
```

用三个高斯峰叠加：

```js
function latitudinalMoisture(absLat) {
  const wetEquator   = Math.exp(-Math.pow(absLat / 0.30, 2));
  const wetMidLat    = Math.exp(-Math.pow((absLat - 0.72) / 0.26, 2));
  const drySubtropic = Math.exp(-Math.pow((absLat - 0.40) / 0.16, 2));
  return Math.max(wetEquator, wetMidLat) * 1.15 - drySubtropic * 0.85;
}
```

再叠加一路噪声（`moistureNoise = 0.30`），让沙漠与森林的边界不规则，避免出现完美的环带。

#### 5.3.3 判定树

```
1. elevation <= SEA_LEVEL        → SEA_ICE（|lat| > 0.93）否则 OCEAN
2. elevation > 0.80              → SNOW        // 高山，与纬度无关
3. elevation > 0.65              → MOUNTAIN    // （乞力马扎罗在赤道同样有冰川）
4. temperature < tempIce   0.22  → ICE         // 极地冰盖
5. river                         → RIVER       // 各气候带都可能有过境河
6. temperature < tempTundra 0.42 → TUNDRA
7. temperature < tempTaiga  0.62 → TAIGA
8. moisture < moistureDesert 0.30 → DESERT
9. moisture < moistureGrassland 0.48 → GRASSLAND
10. temperature > tempTropical 0.85 → RAINFOREST
11. 否则                          → FOREST
```

**设计说明**：

- **高山单独判定，且优先于气候带**：雪线与纬度无关，赤道上的高山同样积雪。
- **河流晚于冰盖判定**：避免在冰盖上出现河道；但早于气候带，所以沙漠里也能有过境河（尼罗河）。
- **温度带负责南北分异**（冰原 / 苔原 / 针叶林 / 温带 / 热带），**湿度带负责在温带与热带内部细分**（沙漠 / 草原 / 森林）。两者缺一不可。
- 干旱带中心 `0.40`、宽度 `0.16` 是调过的：太宽会把中纬度的温带森林和草原一起吃掉。

**可选扩展调色板**（不在 MVP，若后续想更丰富）：

| 扩展群系 | 触发条件 | 建议色 |
| --- | --- | --- |
| 草原 `grassland` | `0.35 < e <= 0.45` 且 `0.45 <= \|lat\| < 0.7` | `#8fae5b` |
| 针叶林 `taiga` | `0.45 < e <= 0.65` 且 `0.55 <= \|lat\| < 0.8` | `#2f6b4f` |
| 苔原 `tundra` | `0.35 < e <= 0.55` 且 `0.7 <= \|lat\| < 0.8` | `#9aa79b` |
| 海冰 `seaice` | `e <= SEA_LEVEL` 且 `\|lat\| > 0.9` | `#d8e8f0` |

> ✅ v1.5 已实现：上表的四个扩展群系（`grassland` / `taiga` / `tundra` / `seaIce`）连同
> `rainforest` 一并落地，见 §19。

---

## 6. 渲染设计

### 6.1 坐标与偏移：如何避免图块之间的缝隙（关键技术点）

**问题**：若每个多边形各自沿自身 `center` 法线偏移自己的顶点，相邻两个多边形共享的那条边会因为偏移方向/幅度不同而**分裂**，球面出现明显裂缝。

**三种方案对比**：

| 方案 | 做法 | 缝隙 | 性能 | 独立高亮 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **A 不偏移** | 所有图块半径恒为 1，仅靠颜色/贴图区分 | 无 | 最好 | 支持 | ✅ **当前采用**（见 §18：本星球是选点界面，不需要立体起伏） |
| **B 共享顶点偏移** | 每个「对偶顶点」（= 原三角形重心）计算**唯一**半径，被 3 个多边形复用 | **无** | 好 | 支持 | 可选方案。实现已保留，把 `enableHeightOffset` 改为 `true` 即可启用 |
| C 单体网格 + 顶点色 | 全球合成一个 `BufferGeometry`，高度写入顶点色 | 无 | 最优 | 需改顶点色，较复杂 | 面数上万时再考虑 |

**方案 B 的精确公式**（推荐采用）：

```
// 1) 每个多边形先算出自己的海拔 elevation（第 5 节）
// 2) 每个对偶顶点（三角形 fi）的半径 = 其三个原顶点的多边形海拔的平均
dualRadius[fi] = 1 + displacement( (elev[a] + elev[b] + elev[c]) / 3 )

// 3) displacement：陆地抬高、海洋压平（保持光滑球面）
function displacement(e):
    if (e <= SEA_LEVEL) return 0                     // 海面保持半径 1 → 海洋是光滑球面
    const t = (e - SEA_LEVEL) / (1 - SEA_LEVEL)      // 0..1
    return t * CONFIG.heightScale                    // 默认 heightScale = 0.10

// 4) 渲染坐标：dualPos[fi] 是共享的，任何多边形引用它得到的坐标完全相同 → 无边缝
renderPos[fi] = dualPos[fi].clone().multiplyScalar(dualRadius[fi])
```

**为什么无缝隙**：缝隙的根源是「同一条边的两个端点在不同多边形里坐标不同」。方案 B 中，坐标由**全局的 `dualRadius` 数组**统一决定，多边形只是引用索引，因此共享边的顶点坐标**逐字节相同**。

> 注意：这里多边形的各顶点半径不同，面片不再是严格平面，但这不影响 `MeshBasicMaterial` 的渲染（三角形会被正确光栅化），只是多边形在视觉上略微「鼓」起，恰恰增强了地形的起伏感。

### 6.2 几何体构建

每个图块构建一个 `BufferGeometry`，采用**三角形扇**展开多边形（n 边形 → n 个三角形）：

```
function buildTileGeometry(tile):
    const verts = tile.vertices          // 已就绪的渲染坐标（= renderPos[vertexIndices[i]]），环绕顺序
    const n = verts.length               // 5 或 6

    // 扇心：直接用多边形中心方向 center（单位向量）乘以顶点平均半径。
    // 不要用「顶点坐标的算术平均」——那会落到球体内部（六边形约 0.98R、五边形更低），
    // 造成视觉上的凹陷，且在顶点半径不等（方案 B）时会偏离面片平面。
    const avgR = verts.reduce((s, v) => s + v.length(), 0) / n
    const c = tile.center.clone().multiplyScalar(avgR)

    const positions = []
    for (let i = 0; i < n; i++) {
        const a = verts[i], b = verts[(i + 1) % n]
        positions.push(c.x, c.y, c.z,  a.x, a.y, a.z,  b.x, b.y, b.z)
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    // MeshBasicMaterial 不需要法线；若将来换光照材质则需 geo.computeVertexNormals()
    return geo
```

> `center` 本身已是单位向量，因此**不需要**再 `normalize()`；乘 `avgR` 即得到贴合球面的扇心，与多边形顶点处于同一半径量级，三角形扇更均匀、无内凹。

> **备选**：也可用 `THREE.Shape` + `ShapeGeometry` 在局部平面构建后再旋转贴合，但需要额外的坐标系变换，且在大球面上会有轻微畸变。**直接用球面坐标做三角形扇更简单、更精确**，故采用后者。

### 6.3 材质

```js
// 每个图块都执行一次 new，禁止缓存复用
const material = new THREE.MeshBasicMaterial({
  color: BIOME_COLOR[tile.biome],
  side: THREE.DoubleSide,   // 防御性措施（环序实际已自洽，见 §3.2.2）
});
```

> ⚠️ **硬性约束：必须为每个图块独立 `new THREE.MeshBasicMaterial(...)`，严禁按 `biome` 缓存或共享材质实例。**
> 「按生物群系缓存材质」是极其自然的优化冲动（`materialCache[biome]`），但它会让悬停高亮**污染所有同色图块**——改一个海洋图块的颜色，全部海洋一起变色。
> 该优化在此规模下**没有任何收益**：642 个材质实例的内存与状态切换开销完全可以忽略。
> 同理，`materialFor(biome)` 这个函数名容易诱导写出缓存实现，建议直接内联 `new`，或将其签名改为 `createMaterial(tile)` 以消除歧义。
- `MeshBasicMaterial` 不受光照影响，符合「纯色」需求。
- **可选增强**：换成 `MeshLambertMaterial` + 一盏 `DirectionalLight` + 微弱 `AmbientLight`，可获得朝向相关的明暗，立体感更强 —— 但这偏离「纯色」的原始需求，默认关闭，留作开关。

### 6.4 场景组装

```
场景 Scene（背景色 #05070d，星空感）
 ├─ Group "planet"
 │   ├─ Mesh tile[0]
 │   ├─ Mesh tile[1]
 │   └─ ... × 642
 ├─ (可选) 一圈背光的球体做大气光晕
 └─ Camera (PerspectiveCamera, fov 50, position (0, 0, 3.2))
OrbitControls(camera, renderer.domElement)  // enableDamping = true
```

渲染器：`WebGLRenderer({ antialias: true })`，`setPixelRatio(Math.min(devicePixelRatio, 2))`，`setSize`，`ResizeObserver` 或 `window.resize` 监听。

### 6.5 交互：射线拾取与高亮

```
// 每帧只做一次 raycast，避免 pointermove 高频触发
let pointerNDC = new THREE.Vector2()      // 归一化设备坐标
let needsPick = false

renderer.domElement.addEventListener('pointermove', (ev) => {
    const rect = renderer.domElement.getBoundingClientRect()
    pointerNDC.x =  ((ev.clientX - rect.left) / rect.width)  * 2 - 1
    pointerNDC.y = -((ev.clientY - rect.top)  / rect.height) * 2 + 1
    needsPick = true
})

function updateHover() {
    raycaster.setFromCamera(pointerNDC, camera)
    // 只对图块 mesh 做拾取，不要传 planetGroup.children ——
    // 该组将来可能混入描边 LineLoop、大气光晕、坐标轴辅助等对象，会被误命中
    const hits = raycaster.intersectObjects(tileMeshes, false)
    const tile = hits.length ? hits[0].object.userData.tile : null
    if (tile === hoveredTile) return
    // 复原上一个
    if (hoveredTile) {
        hoveredTile.mesh.material.color.copy(hoveredTile.baseColor)
    }
    // 高亮新的
    if (tile) {
        tile.mesh.material.color.copy(tile.baseColor).lerp(new THREE.Color(0xffffff), 0.35)
        showHUD(tile)
    } else {
        hideHUD()
    }
    hoveredTile = tile
}
```

在 `animate()` 中：`if (needsPick) { updateHover(); needsPick = false; }` —— `pointermove` 可能每帧触发多次，用标志位合并到渲染循环中执行。

**高亮策略（可叠加）**：
1. **变亮**（默认）：颜色向白色插值 35%。
2. **描边**（可选）：维护一个全局 `LineLoop`，悬停时把它的顶点更新为当前多边形的顶点并抬高一点点（`...multiplyScalar(1.005)`）以避免 z-fighting，用亮色 `#ffffff` 画轮廓。
3. **微抬升**（可选）：`mesh.position` 不动，改为把该图块的顶点乘 `1.01` —— 成本较高，不推荐。

### 6.6 HUD

固定在左上角，`position: fixed`，半透明深色底 + 圆角 + 等宽字体，避免遮挡交互：

```html
<div id="hud">
  <div class="row"><span class="k">生物群系</span><span class="v" id="hud-biome">-</span></div>
  <div class="row"><span class="k">海&nbsp;&nbsp;&nbsp;&nbsp;拔</span><span class="v" id="hud-elev">-</span></div>
  <div class="row"><span class="k">纬&nbsp;&nbsp;&nbsp;&nbsp;度</span><span class="v" id="hud-lat">-</span></div>
  <div class="row"><span class="k">经&nbsp;&nbsp;&nbsp;&nbsp;度</span><span class="v" id="hud-lon">-</span></div>
  <div class="row"><span class="k">图&nbsp;&nbsp;&nbsp;&nbsp;块</span><span class="v" id="hud-id">-</span></div>
</div>
```

字段计算：
```
latitude  = center.y                                  // ∈ [-1,1]，即 sin(地理纬度)
latDeg    = asin(Clamp(center.y,-1,1)) * 180/π        // 显示用，-90° ~ 90°
lonDeg    = atan2(center.x, center.z) * 180/π         // 以 +Z 为 0°，向东为正
```

> **注**：此处经度是**世界坐标系下的固定经度**。因为没有行星自转参考系，相机绕球旋转时同一个图块的 HUD 数值不会变化——这是刻意为之。它只是一个便于区分图块的「伪经度」，不要当作真实地理经度使用（若将来启用自转，需把经度改为相对行星本体的坐标）。

另外在左下角放一行小字操作提示：拖动旋转 / 滚轮缩放 / 悬停查看。

---

## 7. 文件结构与代码骨架

### 7.1 单文件结构

```
index.html
├── <head>
│   ├── <meta charset / viewport>
│   └── <style>            HUD 与画布样式（全屏 canvas、无滚动条）
├── <body>
│   ├── <div id="hud">     信息面板
│   ├── <div id="hint">    操作提示
│   └── <script type="importmap">
└── <script type="module">
    ├── §0  CONFIG                 全局配置常量
    ├── §1  导入与工具函数           clamp / lerp / mulberry32 / normalize
    ├── §2  噪声封装                createNoise / fbm / sampleNoise3D
    ├── §3  球体网格生成            buildIcosahedron / subdivide / buildDual
    ├── §4  地形生成                computeElevation / isRiver / classifyBiome
    ├── §5  几何与材质              buildTileGeometry / buildPlanet
    ├── §6  场景与渲染器             scene / camera / renderer / controls / lights
    ├── §7  交互                    Raycaster / hover 高亮 / HUD
    ├── §8  动画循环与窗口自适应      animate / onResize
    └── §9  启动                    init()
```

> ⚠️ **实现时的最高裁决原则**：若在本文档中发现任何数据字段或函数签名前后不一致的地方（例如 `buildDual` 的返回值、`buildTileGeometry` 的参数），**一律以 §7.2 中 `init()` 的实际使用方式为准**。该小节是数据流的唯一权威描述，其余章节均为解释性说明。

### 7.2 主流程（`init()` 伪代码）

```
function init():
    // 1. 生成球体网格（对偶图）
    const ico  = buildIcosahedron()                            // 12 个【已归一化】顶点 / 20 面
    const geo  = subdivide(ico.vertices, ico.faces, CONFIG.level)
    const dual = buildDual(geo.vertices, geo.faces)
    // dual = { dualPos: Vector3[], polygons: [{ center, vertexIndices }] }

    // 2. 生成地形数据（把 polygon 就地升级为 tile）
    for (let i = 0; i < dual.polygons.length; i++):
        const tile = dual.polygons[i]
        tile.index     = i
        tile.elevation = computeElevation(tile.center)
        tile.latitude  = tile.center.y
        tile.river     = isRiver(tile.center, tile.elevation)
        tile.biome     = classifyBiome(tile.elevation, tile.latitude, tile.river)

    // 3. 计算全局共享半径（方案 B：无缝隙）
    //    长度 = geo.faces.length；第 i 项由 dual.polygons[a/b/c].elevation 求出，
    //    a/b/c 为 geo.faces[i] 的三个顶点索引（依赖不变式 polygons[k].center === vertices[k]）
    const dualRadius = computeDualRadius(geo.faces, dual.polygons, CONFIG)
    const renderPos  = dual.dualPos.map((p, i) => p.clone().multiplyScalar(dualRadius[i]))

    // 4. 构建场景
    scene, camera, renderer, controls = setupScene()
    planetGroup = new THREE.Group()
    tileMeshes  = []          // 只装图块 mesh，供 raycaster 使用（见 §6.5）
    for each tile in dual.polygons:
        // 4.1 拓扑索引 → 渲染坐标：多边形之间共享同一批 Vector3 实例，保证共享边坐标逐字节相同
        tile.vertices  = tile.vertexIndices.map(i => renderPos[i])
        tile.avgRadius = tile.vertices.reduce((s, v) => s + v.length(), 0) / tile.vertices.length

        // 4.2 几何体 + 【独立】材质（禁止按 biome 共享材质！见 §6.3）
        const g   = buildTileGeometry(tile)
        const mat = new THREE.MeshBasicMaterial({
            color: BIOME_COLOR[tile.biome],
            side:  THREE.DoubleSide,
        })
        const mesh = new THREE.Mesh(g, mat)
        mesh.userData.tile = tile
        tile.mesh      = mesh
        tile.baseColor = new THREE.Color(BIOME_COLOR[tile.biome])   // 悬停复原用，必须在此初始化
        tileMeshes.push(mesh)
        planetGroup.add(mesh)
    scene.add(planetGroup)

    // 5. 交互与循环
    setupInteraction()
    animate()
```

**`init()` 是数据流的唯一权威**：`buildDual` → 地形数据 → `dualRadius`/`renderPos` → `tile.vertices` → 几何体。任何其他章节与此冲突时，以本节为准。

---

## 8. 参数配置表（`CONFIG`）

| 参数 | 默认值 | 含义 | 调参建议 |
| --- | --- | --- | --- |
| `seed` | `20261016` | 噪声种子 | 换值即换一颗星球，结果可复现 |
| `level` | `5` | 细分层级 | 2 更快、4 更细腻；对应 642 / 2562 个图块 |
| `seaLevel` | `0.35` | 海平面阈值 | 调高 → 海洋变少、陆地变多 |
| `seaIceLatitude` | `0.93` | 海冰起始 \|latitude\| | 0.9~0.97 |
| `continentScale` | `0.80` | 大陆噪声频率 | 越小 → 大陆越大块 |
| `continentOctaves` | `4` | 大陆噪声八度 | 3~5 |
| `continentWeight` | `0.65` | 大陆噪声权重 | 0.5~0.8，越大海陆越分明 |
| `detailScale` | `3.00` | 细节噪声频率 | 2~4 |
| `detailOctaves` | `6` | 细节噪声八度 | 4~6 |
| `elevationCenter` | `0.45` | 高度分布中心 | 调高 → 整体抬升 → 海洋减少 |
| `elevationSpread` | `0.30` | 高度分布展开幅度 | 调大 → 海洋与雪峰同时增多 |
| `riverScale` | `2.20` | 河流噪声频率 | 越大河网越密 |
| `riverWidth` | `0.13` | 河流判定阈值 | 实测：0.035→0.6%、0.08→2.5%、**0.13→4.5%**、0.16→5.3% |
| `riverMaxElevation` | `0.62` | 河流出现的海拔上限 | 调低 → 河流止于山腰 |
| `heightScale` | `0.10` | 地形抬升幅度 | 仅当 `enableHeightOffset` 为 true 时生效 |
| `enableHeightOffset` | `false` | 是否启用顶点偏移 | 见 §18：选点界面保持光滑球面 |
| **气候模型** | | | |
| `lapseRate` | `0.50` | 海拔递减率 | 调大 → 高山更快进入寒冷带 |
| `climateScale` | `1.50` | 气候扰动噪声频率 | 越大气候边界越碎 |
| `tempNoise` | `0.05` | 温度扰动幅度 | 让等温线不是完美的圆 |
| `moistureNoise` | `0.30` | 湿度扰动幅度 | 让沙漠/森林边界不规则 |
| `tempIce` | `0.22` | 冰原温度上限 | ≈ 纬度 77° 以上 |
| `tempTundra` | `0.42` | 苔原温度上限 | ≈ 纬度 65° 以上 |
| `tempTaiga` | `0.62` | 针叶林温度上限 | ≈ 纬度 52° 以上 |
| `tempTropical` | `0.85` | 热带温度下限 | ≈ 纬度 32° 以内 |
| `moistureDesert` | `0.30` | 沙漠湿度上限 | 调低 → 沙漠变少 |
| `moistureGrassland` | `0.48` | 草原湿度上限 | 以上为森林 |
| **其他** | | | |
| `enableRotation` | `false` | 行星自转 | 演示时可开 |
| `rotationSpeed` | `0.05` | 自转速度 rad/s | |
| `debugAssert` | `true` | 启动时输出自测结果到控制台 | 交付时可置 false |

> 表中是**实际调参后的最终取值**，与 v1.0 规划稿的初始值有出入：
> `riverWidth` 0.035→0.13、新增 `elevationCenter` / `elevationSpread`、移除 `heightPower` 与 `lang`。
> v1.4 起 `enableHeightOffset` 置 false；v1.5 移除 `iceLatitude` / `desertLatitude`，改由气候模型（温度带 × 湿度带）判定，见 §19。
> 参数扫描结果见 §5.1.1 与本节 `riverWidth` 一行。

---

## 9. 性能分析

| 项目 | level = 3 | **level = 4（默认）** | level = 5 | 说明 |
| --- | --- | --- | --- | --- |
| 图块数（= draw call） | 642 | **2562** | 10242 | 每个图块一个 `Mesh` |
| 材质实例 | 642 | **2562** | 10242 | 必须独立，否则高亮会互相污染 |
| 三角形总数（扇展开） | 3840 | **15360** | 61440 | 每个 n 边形展开为 n 个三角形 |
| 渲染顶点数 | 11520 | **46080** | 184320 | = 三角形数 × 3 |
| position 缓冲合计 | 0.13 MB | **0.53 MB** | 2.11 MB | 每图块独立 `BufferGeometry` |
| `subdivide` 实测 | 0.7 ms | **1.1 ms** | 7.8 ms | |
| `buildDual` 实测 | 3.1 ms | **4.1 ms** | 34.1 ms | |
| 地形（噪声）实测 | 1.4 ms | **6.9 ms** | 9.1 ms | 每图块 3 次 FBM 采样 |
| 几何体构建实测 | 1.0 ms | **3.5 ms** | 13.9 ms | |
| **生成总计实测** | 6.2 ms | **15.6 ms** | 64.9 ms | 一次性开销，用户几乎无感 |

> **实测环境**：Node v24（同机 CPU），数据来自 `bench.mjs`。
> 关键结论：**浏览器端的体感瓶颈不是生成时间，而是 draw call 数量**。
> 桌面 Chrome 通常能顺畅处理 2000~3000 次 draw call，上万次会明显掉帧。
> 因此 **level 4 是当前「每图块一个 Mesh」架构下的实用上限**；若要上 level 5，
> 必须改用方案 C（单一 `BufferGeometry` + 顶点色，draw call 降到 1）。
>
> 另外，`level` 每提升一级，图块数与生成耗时都约 **×4**。
> 在 1080p 全屏下，球体周长约 2500 px：level 3 时单个图块约 12~16 px（肉眼可见多边形），
> **level 4 约 6~8 px（已相当细腻）**，level 5 约 3~4 px（接近肉眼下限，收益递减）。

**优化预留**：
- 若面数继续提升（level ≥ 5），改用方案 C：单一 `BufferGeometry` + 顶点色 + `raycaster` 的 `faceIndex` 反查图块，draw call 降到 1。
- 图块几何体**无法跨图块复用**：每个多边形的顶点坐标都不同，即使同为六边形扇结构也不能共享 `BufferGeometry`。
- 已实施：`tileMesh.matrixAutoUpdate = false`。图块位置完全由顶点坐标决定，自身永不移动，关掉后省去每帧 N 次本地矩阵重算（level 4 时 2562 次/帧）。
- 噪声采样可移入 `Web Worker`，但当前耗时很低，暂不需要。

---

## 10. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| **`file://` 打开时模块加载受限** | 页面空白 | 内联 `<script type="module">` 本身不受限，从 `file://` 页面 import 远程 HTTPS 模块（CDN 返回 `Access-Control-Allow-Origin: *`）通常可用。若浏览器策略拦截，改用本地静态服务器：`python -m http.server 8080`，然后访问 `http://localhost:8080`。**文档中须给出这一 fallback 说明** |
| 忘记 `importmap` | `import 'three'` 解析失败，控制台报 bare specifier 错误 | 必须提供 `importmap`，且 `three/addons/` 映射末尾要带 `/` |
| `THREE.SimplexNoise` 不存在 | `undefined is not a constructor` | 从 `three/addons/math/SimplexNoise.js` 单独 import |
| 对偶多边形绕序反了 | 图块不可见 | 材质加 `side: THREE.DoubleSide`，从根上规避 |
| 顶点偏移导致缝隙 | 球面出现裂缝 | 采用「共享 `dualRadius` 数组」的方案 B；或关闭偏移 |
| 细分时未做中点缓存 | 顶点重复、邻接关系错误、五边形数量不对 | 必须使用 `Map` 缓存边中点 |
| 浮点误差导致顶点聚类失败 | 图块缺失/畸形 | 因使用索引化的 `vertexFaces` 邻接，不做坐标比较，从根本上避免 |
| 悬停时 raycast 高频触发 | 卡顿 | `pointermove` 只记录坐标，实际拾取合并到 `requestAnimationFrame` |
| 12 个五边形数量不符 | 网格不是 Goldberg | 用第 11 节的自测脚本校验 |
| 极区颜色异常 | 冰原/海洋判定冲突 | 按第 5.3 节明确的优先级顺序判定 |
| CDN 不可达 | 页面无法加载 | 见 2.3 节备选 CDN |

---

## 11. 验收与自测清单

实现完成后，在浏览器控制台运行以下校验（或临时嵌入 `init()` 末尾）：

```
// 校验 1：面数公式
assert(tiles.length === 10 * 4**level + 2)          // level=3 → 642

// 校验 2：五边形恰好 12 个
assert(tiles.filter(t => t.vertices.length === 5).length === 12)

// 校验 3：多边形只有 5 或 6 个顶点
assert(tiles.every(t => t.vertices.length === 5 || t.vertices.length === 6))

// 校验 4：数据合法
assert(tiles.every(t => t.elevation >= 0 && t.elevation <= 1))
assert(tiles.every(t => Number.isFinite(t.center.x + t.center.y + t.center.z)))
assert(tiles.every(t => Math.abs(t.center.length() - 1) < 1e-6))

// 校验 5：无缝隙 —— 共享边的顶点在任何多边形中必须是【同一个 Vector3 实例】
// 方案 B 下 tile.vertices[i] 直接取自 renderPos，因此相邻图块的顶点存在同一引用，
// 坐标差恒等于 0。可随机取两个相邻图块，检查其顶点集合交集非空且为同一对象引用。

// 校验 6：生物群系统计（打印各类别数量，确认分布合理）
```

**人工检查项**：

- [ ] 页面加载后能看到一个由六边形/五边形拼成的球体，五边形位置对称分布
- [ ] 存在明显的海洋（深蓝）、森林（绿）、沙漠（黄）、山脉（灰）、雪峰（白）、极地冰原
- [ ] 河流呈细线状蜿蜒分布在陆地中等海拔区域
- [ ] 鼠标拖拽可旋转、滚轮可缩放，阻尼平滑
- [ ] 悬停图块明显变亮，移开后恢复原色
- [ ] HUD 数值随悬停变化，纬度在南北极接近 ±90°
- [ ] 控制台无报错、无警告
- [ ] 窗口缩放后画面正确自适应

---

## 12. 实施步骤（里程碑）

| 阶段 | 内容 | 产出 | 预估 |
| --- | --- | --- | --- |
| M1 | 骨架搭建：HTML 结构、importmap、场景/相机/渲染器、`OrbitControls`、占位二十面体 | 能旋转的空场景 + 一个多面体 | 小 |
| M2 | 细分 + 对偶图：`buildIcosahedron` / `subdivide` / `buildDual`，先全部用同一颜色渲染 | 可见的 Goldberg 球面网格 | 中 |
| M3 | 数据校验：跑第 11 节校验 1~3，确认 12 个五边形 | 控制台断言通过 | 小 |
| M4 | 地形：噪声封装 + FBM + 高度归一化，用灰阶映射验证高度分布是否自然 | 灰阶地形球 | 中 |
| M5 | 生物群系分类 + 颜色映射，接入 6 色 | 彩色星球 | 中 |
| M6 | 河流生成 + 调参，确定 `riverScale` / `riverWidth` | 出现清晰水系的星球 | 中 |
| M7 | 高度偏移（方案 B）与 `heightScale` 调参，确认无缝隙 | 有立体起伏的星球 | 中 |
| M8 | 交互：`Raycaster` 悬停高亮 + HUD 面板 + 描边 | 完整交互 | 中 |
| M9 | 打磨：HUD 样式、加载提示、窗口自适应、参数注释、`file://` fallback 说明 | 交付 `index.html` | 小 |

---

## 13. 后续可扩展方向（Backlog）

1. **真实水系**：基于图块邻接图做下坡流向、流域汇聚、湖泊生成。
2. **气候模拟**：引入温度（纬度 + 海拔）与降水（纬度带 + 距海距离）双变量，用 Whittaker 图分类更多群系。
3. **大气与视觉增强**：Fresnel 大气光晕、星空背景、太阳方向光、行星自转与昼夜晨昏线。
4. **性能架构**：单一网格 + `InstancedMesh` / 顶点色、`Web Worker` 生成地形、LOD 分级。
5. **交互扩展**：点击选中图块、悬浮显示邻接图块、按群系筛选高亮、导出 PNG/GLB。
6. **参数面板**：接入 `lil-gui` 或自绘面板，实时拖动调参（种子、海平面、八度数、河流密度）。

---

## 14. 已确定的默认取值

以下取值已确认，**实现时直接采用，无需再逐项确认**（如需变更，改 `CONFIG` 即可）：

| 项目 | 确定值 | 说明 |
| --- | --- | --- |
| 细分层级 | `level = 5` | 10242 个图块 / 61440 个三角形 |
| 顶点高度偏移 | `enableHeightOffset = **false**` | 本星球是「选择出生地」的俯视界面，刻意保持光滑球面（v1.4 变更，见 §18） |
| 生物群系判定 | **气候模型**（温度带 × 湿度带） | 12 种群系（v1.5 变更，见 §19） |
| 河流生成 | 方案 A（脊线噪声） | 方案 B（下坡流向）列入 backlog |
| 极地冰原颜色 | `#dce8f2` 冷白 | 与雪峰 `#f0f0f0` 区分 |
| 可选扩展调色板 | **已实现** | 草原 / 针叶林 / 苔原 / 海冰 / 热带雨林，见 §19 |
| 交付文件 | `planet_demo/index.html` | 单文件，双击可开 |

**实现原则**：

1. §7.2 的 `init()` 是数据流的唯一权威描述，其余章节与之冲突时以它为准。
2. 遇到本文档未覆盖的细节，选择**实现更简单、更不易出错**的方案，并在代码注释中说明取舍。
3. 完成 M3（几何校验）后先跑通自测清单，再继续做地形与交互。

---

## 15. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.0 | 2026-10-16 | 初版规划 |
| v1.1 | 2026-10-16 | 依评审修订，见下 |
| v1.2 | 2026-10-16 | 实现阶段修订与验证，见 §16 |
| v1.3 | 2026-10-16 | 精细度提升 level 3 → 4，见 §17 |
| v1.4 | 2026-10-16 | 改为光滑球面（关闭高度起伏），见 §18 |
| v1.5 | 2026-10-16 | 引入气候模型（温度带 × 湿度带），12 种群系，见 §19 |

**v1.1 修订明细**：

| # | 位置 | 修订内容 |
| --- | --- | --- |
| 1 | §3.2.2 / §4.1 / §7.2 | 统一 `buildDual` 返回值为 `vertexIndices`（索引），消除与 `init()`、`buildTileGeometry` 的字段矛盾；补三条返回契约与不变式 |
| 2 | §6.2 | 扇心由「顶点坐标算术平均」改为 `center × avgRadius`（原实现落入球体内部，且有内凹） |
| 3 | §3.1 | 补充硬性说明：二十面体初始顶点必须先 `normalize()`（标准公式模长 ≈ 1.902） |
| 4 | §6.3 | `materialFor` 改为「禁止按 biome 共享材质」的加粗硬性约束 |
| 5 | §9 / §14 | 修正三角形总数：3840 / 15360（原 3852 / 15372 有误） |
| 6 | §7.2 | 显式补上 `tile.baseColor` 与 `tile.vertices` / `avgRadius` 的初始化时机 |
| 7 | §4.1 | `radius` → `avgRadius`（方案 B 下半径逐对偶顶点定义，图块无单一半径） |
| 8 | §6.5 | raycast 目标由 `planetGroup.children` 改为专用 `tileMeshes` 数组 |
| 9 | §3.2.1 | 边中点缓存键由字符串改为数值键 `min*1e6 + max` |
| 10 | §3.2.2 | 更正绕序说明：该基构造恒满足 `u × w = n`，环序自洽；`DoubleSide` 降级为防御性措施 |
| 11 | §4.3 | 冰原色改为 `#dce8f2`，与雪峰 `#f0f0f0` 区分 |
| 12 | §5.2 / §8 | 河流海拔上限硬编码 `0.62` 提取为配置项 `riverMaxElevation` |
| 13 | §6.6 | 注明经度为固定世界坐标系下的「伪经度」 |
| 14 | §7.1 | 新增最高裁决原则：文档内部冲突以 §7.2 的用法为准 |
| 15 | §14 | 由「待确认事项」转为「已确定的默认取值」 |

---

## 16. v1.2 — 实现阶段的修订与验证结果

已按本文档产出 `index.html`（单文件，约 700 行）。实现过程中有若干处与规划稿不同，均记录如下。

### 16.1 实现中发现的规划缺陷

| # | 位置 | 问题 | 处理 |
| --- | --- | --- | --- |
| 1 | §2.4 | **`new SimplexNoise(mulberry32(seed))` 会直接抛错**。three@0.160.0 的构造函数执行的是 `r.random()` 而非 `r()`，传函数会得到 `TypeError: r.random is not a function`，且因为位于模块顶层，页面直接白屏 | 改为 `new SimplexNoise({ random: mulberry32(seed) })`，并在文档中标注该坑 |
| 2 | §5.1 | 用 `Math.pow(e, heightPower)` 做对比度增强**达不到目的**：单点幂函数无法拉开分布，也无法控制海陆比，海平面 0.35 会切出不可预期的结果 | 改为「先算全部原始值 → 全局 z-score 标准化 → 线性映射」，新增 §5.1.1 与实测对照表，移除 `heightPower` |
| 3 | §6.2 | 用「顶点坐标算术平均」作扇心会内凹 | 改为 `center × avgRadius`。**实测**：算术平均最深处内凹仅 **0.44%**（半径 0.9956，且是极端情况），改用新方案后扇心半径与顶点同量级（1.0000~1.0896） |
| 4 | §7 | OrbitControls 只更新相机的位置/朝向，`matrixWorld` 要到 `render()` 才刷新 | 在 `updateHover()` 中显式 `camera.updateMatrixWorld()`，避免快速旋转时拾取延迟 1 帧 |
| 5 | §8 | `riverWidth = 0.035` 会让河流只有 **0.6%** 的图块，视觉上几乎不可见 | 实测扫描后改为 `0.13`（4.5%），既有清晰河网又不泛滥 |

### 16.2 验证方式

用 Node 脚本从 `index.html` 中**提取真实 module 源码**（而非另抄一份），注入最小化的 THREE / DOM mock 后执行，并追加一组独立于页面内 `runSelfTest()` 的校验，避免"自测自己"。

### 16.3 验证结果（level = 3，seed = 20261016）

**网格结构 —— 21/21 通过**

| 校验项 | 结果 |
| --- | --- |
| 原网格顶点数 `V = 10·4ⁿ + 2` | 642 ✅ |
| 原网格面数 `F = 20·4ⁿ` | 1280 ✅ |
| 对偶面数 `F' = V` | 642 ✅ |
| 对偶顶点数 `V' = F` | 1280 ✅ |
| **欧拉公式 `V' − E' + F' = 2`** | `1280 − 1920 + 642 = 2` ✅ |
| 五边形数量 = 12 | 12 ✅ |
| 其余均为六边形 | 630 ✅ |
| 每个对偶顶点被恰好 3 个多边形引用 | min=3 max=3 ✅ |
| 多边形内无重复索引 | ✅ |
| 切平面投影为凸且同向（环绕顺序正确） | minCross = 5.37e-3 ✅ |
| 原网格 / 对偶顶点均为单位向量 | ✅ |
| 共享顶点为同一引用（**无缝隙**） | ✅ |
| 渲染顶点全部落在 `[1, 1+heightScale]` 球壳 | [1.0000, 1.0993] ✅ |
| 扇心无内凹 | [1.0000, 1.0896] ✅ |

**地形分布 —— 七个生物群系全部出现**

| 生物群系 | 图块数 | 占比 |
| --- | --- | --- |
| 海洋 | 236 | 36.8% |
| 森林 / 平原 | 138 | 21.5% |
| 冰原 | 74 | 11.5% |
| 山脉 | 69 | 10.7% |
| 雪峰 | 63 | 9.8% |
| 沙漠 | 33 | 5.1% |
| 河流 | 29 | 4.5% |

> 河流的两种口径：`isRiver()` 判定为 `true` 的有 32 个，其中 29 个最终落为「河流」群系（另外 3 个被更高优先级的海洋 / 冰原覆盖）。

### 16.4 浏览器端仍待人工确认

以下项目依赖真实 WebGL 环境，Node 无法覆盖，需在浏览器中目视确认：

- [ ] 页面加载后球体正常显示，无黑屏 / 报错
- [ ] 五边形（12 处）与六边形拼接处**无可见缝隙**
- [ ] 地形隆起（`heightScale = 0.10`）立体感自然，海洋为光滑球面
- [ ] 悬停高亮与 HUD 数值正确，移开后颜色复原
- [ ] 拖拽旋转 / 滚轮缩放流畅，阻尼正常
- [ ] 控制台 `[自测]` 表格全部通过

---

## 17. v1.3 — 精细度提升（level 3 → 4）

针对「球体看着不够精细」的反馈，把默认 `level` 由 3 提升到 4，并补了一个渲染期的微优化。

### 17.1 各档位实测规模

| level | 图块数 / draw call | 三角形数 | 生成耗时 | 1080p 下单图块视觉尺寸 |
| --- | --- | --- | --- | --- |
| 3 | 642 | 3840 | 6.2 ms | 约 12~16 px（肉眼可见多边形） |
| **4（默认）** | **2562** | **15360** | **15.6 ms** | **约 6~8 px（相当细腻）** |
| 5 | 10242 | 61440 | 64.9 ms | 约 3~4 px（接近肉眼下限，收益递减） |

### 17.2 结论

1. **`level` 是唯一的调节旋钮**，图块数与生成耗时每级约 ×4。
2. **生成耗时不是瓶颈** —— 即使 level 5 也只要 65 ms，用户几乎无感。
3. **真正的瓶颈是 draw call**。在「每图块一个 `Mesh` + 独立材质」的架构下，
   桌面浏览器能顺畅处理 2000~3000 次 draw call，**level 4 已是实用上限**。
4. 若要继续提升到 level 5，必须改造为**方案 C**（单一 `BufferGeometry` + 顶点色 + `faceIndex` 反查图块），
   代价是失去「每个图块一个 `Mesh`」的结构（该结构是原始需求的一部分），且悬停高亮需改为修改顶点色。

### 17.3 顺带实施的优化

- `tileMesh.matrixAutoUpdate = false`：图块位置完全由顶点坐标决定、自身永不移动，
  关掉本地矩阵自动更新可省去每帧 2562 次无意义的矩阵重算。
  代码中已注明：若将来需要单独移动某个图块，必须改回 `true`。
- 星空 `Points` 同样关闭 `matrixAutoUpdate`。

### 17.4 level = 4 的验证结果

**21/21 全部通过**，其中：

| 校验项 | level = 4 结果 |
| --- | --- |
| 原网格顶点数 / 面数 | 2562 / 5120 ✅ |
| 对偶面数 / 顶点数 | 2562 / 5120 ✅ |
| **欧拉公式 `V' − E' + F' = 2`** | `5120 − 7680 + 2562 = 2` ✅ |
| 五边形 12 个 / 六边形 2550 个 | ✅ |
| 切平面投影为凸且同向 | minCross = 1.33e-3 ✅ |
| 渲染顶点全部落在 `[1, 1+heightScale]` | [1.0000, 1.1000] ✅ |

生物群系分布（与 level 3 的比例几乎一致，这正说明 §5.1.1 的标准化起到了作用）：

| 生物群系 | 图块数 | 占比 |
| --- | --- | --- |
| 海洋 | 947 | 37.0% |
| 森林 / 平原 | 524 | 20.5% |
| 冰原 | 303 | 11.8% |
| 山脉 | 281 | 11.0% |
| 雪峰 | 241 | 9.4% |
| 沙漠 | 154 | 6.0% |
| 河流 | 112 | 4.4% |

---

## 18. v1.4 — 改为光滑球面（关闭高度起伏）

### 18.1 背景与决策

本星球的产品定位是**「选择出生地」的俯视选点界面**，而不是可供 3D 角色行走探索的地形。
因此：

- 山脉与平原的视觉差别**由贴图表达**（后续接入手绘素材），而不是几何高度；这类似 RimWorld 的平面地图 —— 岩石、草地、沙漠的区别体现在贴图上，地图本身是平的。
- 之前用 `heightScale = 0.10` 做顶点隆起，在选点视角下只会让球面显得"疙疙瘩瘩"，既不好看也没有信息价值。
- 结论：**保持一个完全光滑的球面**，把全部视觉层次交给颜色 / 贴图。

### 18.2 改动内容

| 位置 | 改动 |
| --- | --- |
| `CONFIG.enableHeightOffset` | `true` → **`false`** |
| `init()` 步骤 3 | 关闭偏移时 `renderPos` 直接复用 `dual.dualPos`，不再逐个 `clone()` 并乘半径 |
| `displacement()` | 保留实现，仅在 `enableHeightOffset` 为 `false` 时恒返回 0（代码注释已说明恢复方式） |

**为什么可以直接复用 `dual.dualPos`**：对偶顶点本身就是单位向量，半径恒为 1 时
`renderPos[i] = dualPos[i] × 1`。直接共享这批 `Vector3` 实例既省去 N 次克隆，
又天然保证「相邻图块共享边坐标完全一致」—— 无缝隙、无疙瘩。

**方案 B 并未删除**：`computeDualRadius()` / `displacement()` / `heightScale` 全部保留，
把 `enableHeightOffset` 改回 `true` 即可完整恢复立体感。

### 18.3 验证结果

追加了一条针对性校验，**22/22 全部通过**：

| 校验项 | 结果 |
| --- | --- |
| **渲染球面严格为单位球（无高低起伏）** | `max \|r−1\| = 2.22e-16` ✅ |
| 所有渲染顶点半径 | min = 1.0000, max = 1.0000 ✅ |
| 扇心半径 | min = 1.0000, max = 1.0000 ✅ |
| 共享顶点为同一引用（无缝隙） | ✅ |

`2.22e-16` 已是双精度浮点的舍入极限，说明球面在数值上绝对光滑 —— 不存在任何图块凸起或凹陷。

### 18.4 为后续接入手绘贴图做的准备

当前每图块独立 `Mesh` + 独立 `Material` 的结构，对将来替换为手绘素材是友好的：

- 把 `MeshBasicMaterial` 换成带 `map` 的材质即可，每个图块可以用自己的一张图；
- 需要注意：目前几何体是**三角形扇且没有 UV 坐标**，接入贴图时需要为每个图块补 UV。
  由于每个图块形状是近似的球面正多边形，推荐做法是**生成一张图集（atlas）**，
  按 `biome` 或图块索引切分出 UV 区域；
- 另一种更省事的思路：既然图块是**纯色填充**，也可以用 1×1 的贴图（或 `CanvasTexture` 生成的色块）
  做渐进式替换 —— 先支持贴图管线，再逐步换成手绘素材。

> 这部分仅为方向性说明，**尚未实现**，留待接入美术素材时再做。

---

## 19. v1.5 — 引入气候模型（纬度温度带 × 三圈环流湿度带）

### 19.1 问题

用户反馈：**「目前在冰原附近都能看到热带森林，这明显有问题」**。

根因在于 v1.4 的分类树把 `elevation` 当作唯一地形依据，纬度只参与两条线：

```
alat > iceLatitude(0.80)  → 冰原
alat < desertLatitude     → 沙漠
其余                       → 一律是 forest / mountain / snow
```

于是 `0.55 < |lat| < 0.80` 这一大段（纬度 33°~53°，且包含更靠极地的所有非冰原陆地）
完全没有纬度约束 —— 70° 的地方只要 `elevation > 0.45` 就会长出「森林 / 平原」。

**更本质的一点**：热带森林与冰原的区别是**温度**，不是海拔。海拔只能解释局部差异，
纬度才能解释全球分异。

### 19.2 方案

引入两维气候场，再用 (温度, 湿度) 二维表划分群系：

| 维度 | 驱动因子 | 公式要点 |
| --- | --- | --- |
| **温度** | 太阳辐射（纬度）+ 海拔直减 | `cos(纬度) = sqrt(1 - lat²)`，再减 `landRelief × lapseRate` |
| **湿度** | 三圈环流（纬度）+ 噪声 | 赤道湿 / 副热带干 / 中纬湿 / 极地干，叠加 `moistureNoise` |

**必须强调**：单靠温度做不出沙漠。赤道与副热带的温度几乎一样，但前者是雨林、后者是沙漠 ——
差别全部来自降水。所以沙漠必须由「**热 + 干**」共同决定。地球的副热带高压下沉带
（撒哈拉、阿拉伯、澳洲沙漠）就是这个机制。

判定树（完整版见 §5.3.3）：

```
海洋/海冰 > 高山（雪峰/山脉）> 极地冰原 > 河流 > 温度带 > 湿度带
```

### 19.3 群系由 7 种扩展为 12 种

| 群系 | 触发条件 |
| --- | --- |
| 海洋 / 海冰 | `elevation <= seaLevel`，`\|lat\| > 0.93` 时为海冰 |
| 雪峰 / 山脉 | `elevation > 0.80` / `> 0.65`（与纬度无关） |
| 冰原 | `temperature < 0.22` |
| 苔原 | `temperature < 0.42` |
| 针叶林 | `temperature < 0.62` |
| 沙漠 | `moisture < 0.30` |
| 草原 | `moisture < 0.48` |
| 热带雨林 | `temperature > 0.85` |
| 温带森林 | 其余 |
| 河流 | 各气候带均可能出现（含穿越沙漠的过境河） |

### 19.4 调参过程中发现的问题

**副热带干旱带一开始设得太宽**（中心 0.42、宽度 0.20、幅度 0.90），把中纬度的温带森林
和草原一起吃掉了 —— 实测沙漠 1151 块、草原只有 145 块，比例明显失真。
收窄为**中心 0.40、宽度 0.16、幅度 0.85** 后：

| 群系 | 调参前 | 调参后 |
| --- | --- | --- |
| 沙漠 | 1151 | 1037 |
| 草原 | 145 | 142 |
| 温带森林 | 535 | 624 |
| 热带雨林 | 463 | 491 |

### 19.5 验证结果（level = 5，**29/29 全部通过**）

新增了 7 条**气候合理性**校验，直接针对用户反馈的那一类问题：

| 校验项 | 实测值 | 结果 |
| --- | --- | --- |
| 温度随纬度单调下降 | 赤道带 0.870 → 中纬 0.624 → 极地 0.233 | ✅ |
| 赤道与极地温差显著 (>0.35) | ΔT = 0.637 | ✅ |
| **热带雨林只出现在低纬度 (\|lat\| < 0.6)** | max\|lat\| = 0.237 | ✅ |
| **极地(\|lat\|>0.93)无森林/草原/沙漠** | 0 块 | ✅ |
| 冰原/苔原只出现在高纬度 (\|lat\| > 0.65) | min\|lat\| = 0.766 | ✅ |
| 沙漠集中在副热带 (0.20 < 平均\|lat\| < 0.65) | 平均\|lat\| = 0.390 | ✅ |
| 赤道附近(\|lat\|<0.25)无冰原 | 0 块 | ✅ |

> 注：原先还写了一条「温度与纬度强负相关 r < −0.85」的校验，实测 r = −0.778 未通过。
> 原因是海拔项本身带有与纬度无关的方差，会稀释相关系数 —— **是校验方式不合理，不是模型错了**，
> 因此改成更稳健的「分带均值比较」。

**生物群系分布**（level = 5，共 10242 块）：

| 生物群系 | 图块数 | 占比 |
| --- | --- | --- |
| 海洋 | 3483 | 34.0% |
| 山脉 | 1370 | 13.4% |
| 雪峰 | 1293 | 12.6% |
| 沙漠 | 1037 | 10.1% |
| 温带森林 | 624 | 6.1% |
| 针叶林 | 531 | 5.2% |
| 热带雨林 | 491 | 4.8% |
| 河流 | 470 | 4.6% |
| 海冰 | 320 | 3.1% |
| 苔原 | 292 | 2.9% |
| 冰原 | 189 | 1.8% |
| 草原 | 142 | 1.4% |

**气候带在纬度上的排布**（由赤道向极地）：

```
赤道    雨林 → 草原 → 沙漠 → 温带森林 → 针叶林 → 苔原 → 冰原    极地
        (湿)   (过渡)  (副热带干)  (西风带湿)  (寒)     (亚寒)  (冰盖)
```

这与地球的实际气候带顺序一致。

### 19.6 遗留的可调项

- **山脉 + 雪峰占陆地约 41%**，视觉上偏多。这是 v1.2 时代就存在的取值
  （`elevationCenter = 0.45` / `elevationSpread = 0.30` 下，`0.65` 约为 +0.67σ）。
  若希望陆地以植被为主，可把 `MOUNTAIN_LEVEL` 提高到 `0.72`、`SNOW_LEVEL` 提高到 `0.86`。
- **草原偏少**（1.4%）。若想加宽草原带，把 `moistureGrassland` 从 `0.48` 提到 `0.55`，
  代价是温带森林相应缩小。

---

*文档版本：v1.5 ｜ 状态：**已实现（光滑球面 + 气候模型，12 种群系），待接入手绘贴图与浏览器目视验收** ｜ 交付物：`index.html`*
