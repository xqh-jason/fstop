# Fstop · 光圈 — 项目计划 v0.2

> 项目代号：**Fstop**（中文名：**光圈**）
> 创建日期：2026-09-23 ｜ v0.2 同日修订
> v0.1 → v0.2 的依据：对浏览器能力（BCD）、模型体积与许可（HF）、存储语义（SQLite WASM 文档）、同类项目现状（GitHub）做了一轮实测核对。原文中三处前提被证伪，已在本文中修正；所有可核事实见附录 A。

## 变更摘要（相对 v0.1）

| # | 变化 | 原因 |
|---|---|---|
| 1 | 定位追加「桌面 Chromium 专属」；移动端从路线图移除 | `showDirectoryPicker` 在 Safari / Firefox 无实现（BCD），移动端 Web 不存在可行通路 |
| 2 | 新增 §二「与现有方案的区别」，并把对比表放进 README 第一屏 | 中文语义搜索本地素材已有 1966★ 的活跃开源项目（MaterialSearch），v0.1 §三「当前无解」不成立 |
| 3 | 明确 `dtype`，模型首启体积从「≈150 MB」改为按档位列表 | transformers.js 的 `dtype` 在 WebGPU 下默认 `fp32`，不显式指定将下载 606 MB |
| 4 | 删除 `sqlite-vec` 依赖，向量检索自实现 | npm 包只有原生 `dylib/so/dll`，浏览器需自建 wasm；且 1 万条量级暴力检索是毫秒级 |
| 5 | 存储 VFS 定为 `opfs-sahpool` | `opfs` VFS 需要 COOP/COEP 响应头，GitHub Pages 无法设置 |
| 6 | 数据模型：`*_status` ×3 → `jobs` 表；删除 `index_runs.cursor` | 三列无法表达重试与跳过；队列可由状态派生，无需游标 |
| 7 | Worker 拓扑：embed 单实例 + N 个 CPU worker | 避免 4 份权重各自解析、内存峰值冲穿红线 |
| 8 | 指标：1 万张 10 分钟 → 20 分钟验收 / 10 分钟冲刺；「上传流量恒为 0」措辞修正 | 60 ms/张的预算经拆解不成立；权重下载本身就是出站请求 |
| 9 | M0 从 3 天改为 5 天，交付物改为 `bench/` + 合成语料 + CC0 样例库，新增部署 spike | 20 张样例图无法暴露唯一头号风险（端到端吞吐） |
| 10 | 新增 §十一 工程约定：`LICENSE`（MIT，已定）/ `NOTICE`（权重许可矩阵）/ CONTRIBUTING 的 AI 政策（接受 AI 辅助）/ CI 零外发断言 | 开源项目的许可与治理是硬约束，v0.1 未涉及 |

---

## 一、一句话定位

> **Fstop 是一个跑在桌面 Chromium 里的本地照片检索层。选定一个文件夹，AI 就在你的设备上为照片建立索引，之后你可以用一句自然语言找到任意一张照片——照片不复制、不上传、不安装任何东西、核心代码完全可读。**

三个必须同时成立的限定词，缺一个就不是这个产品：

| 限定词 | 含义 | 边界 |
|---|---|---|
| **桌面 Chromium** | Chrome / Edge 86+ | 不是「浏览器」，是「这一个浏览器」。见 §五 |
| **不复制** | 只持有文件句柄，原文件原地不动 | 不做导入、不做托管目录 |
| **开源可读** | 索引与检索的核心逻辑可被任何人逐行审阅 | 见 §十一 |

它不是相册，不是备份工具，是**给已有照片库加的一个「本地的眼睛」**。

## 二、与现有方案的区别

这一节是整个立项的理由，也是 README 的第一屏。**不要跳过它去讲技术。**

| 方案 | 形态 | 与 Fstop 的关系 |
|---|---|---|
| [MaterialSearch](https://github.com/chn-lee-yumi/MaterialSearch)（1966★，GPL-3.0，2026-09 仍活跃） | Windows 包 / Docker + GPU；默认模型同为 `chinese-clip-vit-base-patch16` | **最直接的重合**。差异只有两点，但这两点是全部：① 它要安装、要挂载路径、要显卡；② **它的核心闭源**（README 明言 API 实现不开源，前端有意混淆） |
| [Immich](https://github.com/immich-app/immich)（114k★） | 自托管服务端 | 需要一台服务器。数据不出内网，但仍要运维、要部署、要占一台机器 |
| [PhotoPrism](https://github.com/photoprism/photoprism) | 自托管服务端 | 同上 |
| [rollfilm](https://github.com/pasqualkreher/rollfilm)（16★，MIT，Electron） | 桌面原生壳，隐私优先，支持 RAW | 同类形态，走的是 Electron 路线。佐证：桌面壳 + RAW 是有人要的 |
| semantic-file-explorer / CLIP-Finder2 | Swift / macOS 原生 | 单平台、单生态 |

**这张表说明了一件事：性能不是本项目的战场。** 对面可以挂 CUDA，浏览器永远打不过。Fstop 赌的是另外三件事：**零安装、零复制、核心可审计**。因此 §八 的指标里，红线不是速度，是「照片零复制、字节零外发、核心可读」。

## 三、问题定义

三个仍然成立、且上面那些方案都不解决的场景：

1. 硬盘里存着几万张照片（跨十年、多目录、含相机 RAW/HEIC），想找「我妈穿红裙子在西湖的那张」，只能一张张翻。系统不索引你的硬盘，服务端方案要求你先把它搬进去。
2. 已有的本地智能检索方案，都要你先安装、挂载路径、准备显卡或一台服务器——为了找照片而先做一次运维。
3. 想给照片库加 AI 能力，但不愿意为「数据离开设备」付代价，也不愿意相信一个核心不可读的二进制。

Fstop 的答案：**能力在本地，文件原地不动，一个字节不外发，核心逐行可读，打开浏览器就能用。**

## 四、名字

**Fstop（光圈）** —— 相机上控制「有多少光能进来」的部件。这个产品做的是同一件事的另一面：**决定谁能看见你的光**。光圈只对你打开，照片只留在你这里。

- 英文 `Fstop`：5 个字母、2 个音节，不会拼错，摄影语义明确，不会被误认为通用 AI 工具
- 中文「光圈」：两个字，任何人一看就懂，自带摄影语境
- **命名可用性（已核实）**：npm `fstop` 空闲（`aperture` 已被占用）；GitHub 上 108 个同名仓库，最热的 16★ 且是地图/游戏项目，**没有任何照片检索项目占用此名**
- 非商用开源条件下，「光圈 = Apple 已停产的 Aperture」不构成商标风险，真实代价只是搜索混淆。因此 repo 的 description 与 topics 必须包含 `photo-search` / `semantic-search` / `clip` / `local-first`，README 首行必须自解释

## 五、产品边界

### 5.1 目标平台：桌面 Chromium，其他全部不支持

这不是取舍，是可行性结论。核实的浏览器兼容数据：

| API | Chrome / Edge | Firefox | Safari |
|---|---|---|---|
| `showDirectoryPicker` | 86+ | **无** | **无** |
| `showOpenFilePicker` | 86+ | 无 | 无 |

没有目录选择器，就没有「选定一个文件夹」这个 P0 动作；`<input webkitdirectory>` 只能一次性拿到文件列表，拿不到可持久化、可增量重扫的目录句柄。

**移动端从路线图移除**，理由不止一条：

1. iOS Safari 无目录选择器，也无持久句柄；移动端 Web 无法承载「索引一次、长期复用」。
2. WebKit 对**全部脚本可写存储**（IndexedDB、LocalStorage、SessionStorage、Service Worker 注册与缓存）实施**7 天无交互即删除**；仅「添加到主屏」的 Web App 走独立计数器。OPFS 属脚本可写存储之列。
3. Android 14 起有「部分照片访问」权限，Photo Picker 亦有选择上限——不存在稳定、完整、可增量的相册视图。
4. 产品层面：手机上「找照片」的对手是系统相册本身（iOS 相册已提供设备端语义搜索），且开启「优化 iPhone 存储空间」后本地库本身残缺——索引一个残缺的库会给出错误的确定答案，比不索引更伤信任。

> 「在手机上看 PC 上的库」是同步问题，不是索引问题，属于另一个产品。

### 5.2 目标环境

- 操作系统：macOS / Windows / Linux（Chrome / Edge）
- 基准设备：M2 MacBook Air + Chrome（所有性能指标以此为准）
- 需要：WebGPU（缺失则降级 WASM 并明确提示）、OPFS、File System Access

### 5.3 明确不做

| 不做 | 原因 |
|---|---|
| 移动端（任何形态） | 移动端 Web 无可行通路；原生移动端要挑战的正是系统相册本身，收益为负 |
| 手机相册自动备份 | 浏览器无法实现，且不是本产品的定位 |
| 多用户 / 分享 / 协作 | 属于服务端职责，会破坏「零部署」的前提 |
| Docker / NAS 部署 | 一旦引入服务端，「零部署 + 零上传 + 零成本」三个前提同时失效 |
| 云端 AI 接口调用 | 与「照片不离开设备」的核心承诺直接冲突 |
| 照片编辑 / 修图 | 与检索定位无关 |
| 性能军备竞赛 | 打不过 Docker + CUDA 方案，本项目赌的是零安装与可审计（见 §二） |
| 埋点 / 遥测 / 分析 | 与「零外发」冲突；本项目的用户界面就是网络面板 |

## 六、核心能力与优先级

| 优先级 | 能力 | 说明 |
|---|---|---|
| **P0** | 文件夹接入与扫描 | 只取文件句柄，不复制文件 |
| **P0** | 本地模型推理 | 浏览器内执行，`dtype` 显式指定 |
| **P0** | 语义检索 | 输入一句话，返回匹配照片 |
| **P0** | 索引持久化 + 断点续算 | 落盘；任何一张照片的处理状态都可从数据库查询 |
| **P0** | 许可与治理（`LICENSE` / `NOTICE` / CONTRIBUTING） | 开源项目的硬约束，见 §十一 |
| **P0** | 零外发 CI 断言 | 把 §十一点 2 从人工勾选变成可执行测试 |
| **P1** | 人脸聚类与命名（含合并 / 拆分） | 「找出我和家人的合照」 |
| **P1** | 相似图 / 重复图分组 | 精确重复用哈希，视觉相似用向量 |
| **P1** | 离线能力可视化 | 让「零上传」可被用户亲眼验证 |
| **P1** | 可复现 benchmark + 合成语料 | 开源项目发布性能数字的前提，见 §九 |
| **P2** | 文字识别检索 | 票据、招牌、书页上的文字 |
| **P2** | 自动相册 | 按时间 / 场景 / 人物聚类生成 |
| **P2** | 英文界面 | 界面以中文为主，README 与 demo 以英文优先（见 §十一） |

## 七、技术方案

### 7.1 选型（版本为 2026-09-23 实测）

| 层 | 选型 | 版本基线 |
|---|---|---|
| 应用框架 | Vue 3 + Vite + TypeScript | Vue 3.5+ / Vite 8+ |
| 包管理与脚本 | pnpm | 11+ |
| 推理运行时 | `@huggingface/transformers`（WebGPU 后端） | 4.3+ |
| 模型执行 | `onnxruntime-web` | 1.30+ |
| 本地数据库 | `@sqlite.org/sqlite-wasm` | 3.53+ |
| 向量检索 | **自实现**（OPFS 扁平 `Float32Array` + Worker 内暴力余弦） | — |
| Worker 通信 | `comlink` | 4.4+ |
| 文件访问 | File System Access API | 浏览器原生 |
| 持久化存储 | OPFS（`opfs-sahpool` VFS）+ Cache Storage + IndexedDB | 浏览器原生 |
| 单元测试 | Vitest | 最新 |
| 端到端测试 | Playwright | 最新 |

**已删除 `sqlite-vec`**：npm 上的 `sqlite-vec@0.1.9` 只发布 `index.cjs`（1.5 KB）/ `index.mjs`（1.6 KB）/ `index.d.ts` / `package.json` 四个文件，`index.mjs` 的唯一逻辑是 `db.loadExtension(<原生 .dylib/.so/.dll 路径>)`，按 darwin / linux / win32 的 x64 / arm64 解析——**不含 wasm**。浏览器要用它必须自行获取或编译 `vec0.wasm`，属于额外构建风险。而 1 万条 512 维向量的余弦排序约 10 MFLOP，10 万条约 100 MFLOP，在 Worker 内遍历扁平数组是**毫秒级**。这一层不是本项目的技术风险点，自实现更少依赖、更可读。

### 7.2 模型与 `dtype`（体积以实测文件为准）

候选模型与 ONNX 文件实际体积：

| 文件 | fp32 | fp16 | int8 / q8 | q4f16 |
|---|---|---|---|---|
| `Xenova/clip-vit-base-patch32` vision | 351.7 MB | 176.1 MB | 88.6 MB | 53.3 MB |
| 同上 text | 254.1 MB | 127.3 MB | 64.1 MB | 72.5 MB |
| **合计** | **605.8 MB** | 303.4 MB | **152.7 MB** | **125.8 MB** |

关键事实：transformers.js 的 `dtype` 默认值 **WebGPU 为 `fp32`、WASM 为 `q8`**。因此：

- 不显式指定 `dtype` 而使用 `device: 'webgpu'` → 首启下载 **606 MB**；
- 默认组合 **125.8 MB（vision `q4f16` + text `q4f16`）**；
- v0.1 写的「≈150 MB」对应的是 WASM 的 `q8` 组合（152.7 MB）。

**决定**：默认 `vision: q4f16` + `text: q4f16`（125.8 MB），提供 `fp16` 档（303.4 MB）作为质量选项。首启下载量必须在界面上明示。

**模型选择**：

| 用途 | 模型 | 理由 |
|---|---|---|
| 默认（中文库） | `Xenova/chinese-clip-vit-base-patch16`（transformers.js ONNX 版本存在） | 中文文本侧质量显著优于原版 CLIP；MaterialSearch 也用同一基座，适用性已被验证 |
| 可替换（英文 / 更小） | `Xenova/clip-vit-base-patch32` | 通过 `EmbeddingProvider` 切换 |
| 人脸检测（P1） | SCRFD（`immich-app/scrfd_34g_gnkps`，MIT） | 直接可用的 ONNX |
| 人脸识别（P1） | `immich-app/antelopev2`（insightface 系，`license: other`） | 非商用条款，必须在 NOTICE 标注 |

**注意**：原版 CLIP 与 Chinese-CLIP 的图像侧**不在同一向量空间**，两套模型 = 两套向量列，不得共用索引。

**权重分发原则：不把权重收进仓库。** 只提供下载 / 转换 / 哈希校验脚本，来源与校验值写进 `NOTICE`。这样「唯一的外发请求 = 你自己声明的模型下载」是结构上成立的，而非措辞上的。

### 7.3 存储与部署形态

SQLite WASM 的 OPFS 支持有两条路，必须二选一：

| | `opfs` VFS | **`opfs-sahpool` VFS（选定）** |
|---|---|---|
| COOP/COEP 响应头 | **必需**（否则无 `SharedArrayBuffer`，VFS 不加载） | **不需要** |
| 性能 | 基准 | **批量操作明显更快** |
| 并发连接 | 支持多连接（需处理 `SQLITE_BUSY`） | **不支持多连接** |
| 同源第二个实例 | 可共存 | **初始化失败** |

选定 `opfs-sahpool`：换来「任何静态托管都能部署」，代价是必须处理单实例约束。因此需要：

1. 数据库只在一个专用 Worker 中打开（OPFS 本身也只在 Worker 上下文可用）；
2. 用 **Web Locks 选主**：第二个标签页不初始化 VFS，退化为只读视图并提示「已在另一个窗口管理索引」；
3. 处理「读取也会加锁」这一 OPFS 特性——事务保持短小，不长期持有语句。

> 部署目标：支持自定义响应头的静态托管（Cloudflare Pages / Netlify）或 GitHub Pages 均可。选 `opfs-sahpool` 后不再依赖响应头。

### 7.4 架构分层

```
┌──────────────── 主线程 ────────────────┐
│  UI 层（Vue）                          │
│    检索框 / 图墙 / 人物页 / 索引进度      │
│                                        │
│  领域层（src/core/，手写）              │
│    数据模型 · 索引状态机 · 任务队列      │
│    PhotoSource 接口 · EmbeddingProvider │
└───────────────┬────────────────────────┘
                │ comlink RPC
┌───────────────▼────────────────────────┐
│  Worker 池                              │
│    embed.worker  × 1   独占 GPU，权重一份 │
│    decode.worker × N   解码 / 缩略图 / 入库 │
└───────────────┬────────────────────────┘
                │
┌───────────────▼────────────────────────┐
│  存储层                                 │
│    OPFS   sqlite 数据库（sahpool VFS）   │
│    OPFS   向量矩阵（扁平 Float32Array）  │
│    OPFS   缩略图缓存                     │
│    Cache  模型权重                       │
│    IDB    文件夹句柄                     │
└────────────────────────────────────────┘
```

**拓扑决策**：v0.1 的「并发数 = 核数-1，上限 4」若应用在 embed worker 上，会变成 4 份权重各自解析（内存峰值冲穿 1.5 GB 红线，且多个 GPU 会话互相争用）。正确形态是 **embed 单实例 + N 个 CPU worker**（解码、缩略图、写库都可并行，GPU 不可）。

**索引期间必须可检索**：v0.1 未涉及。规则——查询请求走独立通道，优先于索引进度回调送入 embed worker；或预留准入配额。UI 在冷索引期间必须可搜索，否则用户会以为产品坏了。

### 7.5 `src/core/` 的两个接口

这两个接口是「`core/` 手写」这条约定的真正价值来源，同时也是 M4 换壳与社区贡献的契约：

```ts
// 文件来源：FSA 实现 / OPFS 合成实现（测试）/ 未来的 Tauri 原生实现
interface PhotoSource {
  list(): AsyncIterable<PhotoRef>;          // 增量扫描的单位
  read(ref: PhotoRef): Promise<Blob>;       // 按需读取，不缓存原图
  stat(ref: PhotoRef): Promise<{ size: number; mtime: number; hash?: string }>;
}

// 推理后端：WebGPU / WASM / 未来的 CoreML
interface EmbeddingProvider {
  readonly modelId: string;
  readonly dim: number;
  embedImage(bitmap: ImageBitmap): Promise<Float32Array>;
  embedText(text: string): Promise<Float32Array>;
  warmup(): Promise<void>;                  // 着色器编译，冷启 1–3 s 必须前置
}
```

`PhotoSource` 的第二个实现（OPFS 合成根）是 **Playwright 能跑通端到端测试的唯一途径**——原生目录选择器无法被自动化驱动。

### 7.6 数据模型（SQLite）

| 表 | 关键字段 |
|---|---|
| `meta` | `schema_version`, `created_at` |
| `roots` | id, handle_key, label, permission_state |
| `photos` | id, root_id, rel_path, ext, size, mtime, **content_hash**, taken_at, exif_orientation, width, height, thumb_key, **deleted_at** |
| `jobs` | id, photo_id, kind(`embed`/`face`/`ocr`), status, attempts, last_error, updated_at |
| `embeddings` | photo_id, model_id, dim, vector（BLOB 或矩阵偏移） |
| `faces` | id, photo_id, bbox, cluster_id, vector |
| `clusters` | id, name, cover_face_id |

相对 v0.1 的四处修正：

1. **`*_status` ×3 → `jobs` 表**。三列无法表达「失败，已重试两次」「跳过（不支持格式）」，且每加一个能力就要加一列。
2. **删除 `index_runs.cursor`**。任务队列完全可由 `SELECT ... WHERE status='pending' LIMIT n` 派生，崩溃后天然续算；游标的语义与一致性维护都是纯成本。**不允许存在内存态的隐式进度。**
3. **新增 `content_hash`**（`size` + 首尾 64 KB 哈希）。v0.1 的「mtime + size」在从备份恢复、跨盘复制后会让 mtime 全变 → 整库重算；重命名目录只改 `rel_path` → 也全废。内容身份让移动/重命名不触发重算。
4. **新增 `deleted_at` / `ext` / `exif_orientation` / `schema_version`**。增量扫描发现文件消失时必须标记；EXIF 方向必须在生成缩略图与向量**之前**应用，否则两者都是错的。

### 7.7 通信

**只用 comlink，不手写消息协议。** v0.1 同时选了 comlink 又手写了一套 `{type, jobId}` 协议与 `protocolVersion`——comlink 已经定义了 RPC 语义，再叠一层等价的 wire format 是纯冗余，且版本号维护成本翻倍。

- `core/` 的护城河放在**索引状态机**上，不是消息枚举上；
- 进度用 comlink 的显式回调通道（`progress(done, total)`），取消用 `AbortSignal`；
- 需要补的：批量提交（一次 16–32 张，摊薄 `postMessage` 开销）、worker 崩溃恢复、超时。

## 八、验收指标

在 M2 MacBook Air / Chrome / WebGPU / 默认 `q4f16` 下：

| 指标 | 目标 |
|---|---|
| 1 万张首次索引耗时 | **≤ 20 分钟**（验收线）；≤ 10 分钟为冲刺目标 |
| 单张图像向量化（热会话） | ≤ 150 ms |
| 语义检索响应（1 万张） | ≤ 300 ms |
| 冷启动（已建索引，不含用户手势） | ≤ 2 s |
| 模型首次下载 | 默认档 125.8 MB；二次打开走本地缓存 |
| 主线程长任务 | 无任何 > 50 ms |
| 内存峰值 | ≤ 1.5 GB |
| **照片复制量** | **恒为 0 字节** |
| **出站请求** | **除模型权重外，零请求**（由 CI 断言强制，见 §十一） |

**为什么把「10 分钟」放宽到 20 分钟**：1 万张 ÷ 10 分钟 = 每张 60 ms 的端到端预算，需装下解码（12 MP JPEG 用 `createImageBitmap` + `resizeWidth` 降采样，30–60 ms）、向量化（20–40 ms）、缩略图编码（5–15 ms）、OPFS + sqlite 写入（3–8 ms），串行约 150 ms/张 ≈ 25 分钟；4 路并行受 GPU 队列争用限制，乐观落在 6–10 分钟。≤10 分钟是上限而非预期，因此作为冲刺目标存在，不作为验收线。

**说清「热会话」**：冷启动的第一次推理包含 1–3 s 的着色器编译，必须通过 `warmup()` 前置到模型加载阶段，否则指标会被误判。

**修正 v0.1 的自相矛盾**：原文第七章「上传流量恒为 0 字节」与「模型首次下载 ≈150 MB」直接冲突——权重下载本身就是出站请求。改为「除模型权重外，无任何携带用户数据的出站请求」，并把权重同源自托管 / 由脚本拉取作为实现手段，使 §七「离线能力可视化」可以给出可验证的结论（只出现一个 origin）。

## 九、里程碑计划

### M0 · 可行性验证（硬性上限 5 天）

v0.1 为 3 天，交付物是「20 张样例图的验证页」。**这不足以暴露唯一的头号风险**——端到端吞吐。改为：

**五项实测（半天至一天，决定后续所有数字）**

| # | 实测项 | 通过线 |
|---|---|---|
| 1 | 显式 `dtype` 下的首启体积与下载耗时 | 125.8 MB 档在目标网络下可接受；链路速率留档 |
| 2 | 单张向量化冷 / 热延迟 | 热 ≤ 150 ms → 继续；150 ms–1 s → 降规格；> 1 s → 换推理路径 |
| 3 | HEIC 能否 `createImageBitmap` 解开 | 能 → 直接支持；不能 → 定 libheif wasm 或明确排除 |
| 4 | **1000 张真实照片库端到端 photos/s**（含解码、缩略图、入库） | 外推到 1 万张 ≤ 20 分钟 |
| 5 | `opfs-sahpool` 的两标签页行为 | 第二实例能优雅退化而非报错 |

> 第 3 项是产品级风险：iPhone 照片默认 HEIC，而 MDN 的浏览器支持图片格式表**不含 HEIF/HEIC**。家庭照片库中这是最高频格式之一，解不开等于一半库检索不到。
>
> 第 4 项取代 v0.1 的「单张延迟」作为主决策点。

**交付物（替代 v0.1 的「可公开访问的验证页」）**

1. `bench/` + **确定性合成语料生成器**：任何人 `pnpm bench` 都能得到 photos/s 并贴进 issue。开源项目发布性能数字必须可被复现，而私人照片库无法公开。
2. **内置 CC0 样例库**（20–50 张，几 MB）：访客点开即可体验语义检索，**无需授权任何文件夹**。要求访客授权整个照片文件夹的转化率接近于零。
3. 部署 spike 结论：`opfs-sahpool` 在目标托管上的可用性 + 多标签页选主方案。

### M1 · MVP（2–3 周）

- 文件夹选择 + 权限持久化 + `navigator.storage.persist()`（v0.1 遗漏：OPFS 是 best-effort 存储，不请求 persist 就等于接受「存储被清理 → 索引丢失」）
- 扫描与增量识别（`content_hash` + `deleted_at`）
- 缩略图墙 + 虚拟滚动（**显式 `ImageBitmap.close()` / `revokeObjectURL` + 约 300 张活跃的 LRU**，否则 1.5 GB 内存红线必失守）
- 语义检索（索引期间可用）
- 索引进度与断点续算
- `LICENSE` / `NOTICE` / CONTRIBUTING / CI 零外发断言
- **交付**：可公开发布的第一个版本

### M2 · 差异化能力（2–3 周）

- 人脸聚类与人物命名（含**合并 / 拆分**——v0.1 只写了 name/cover，不能合并聚类是必然被抱怨的）
- 相似图 / 重复图分组（精确重复用哈希，近似重复用感知哈希，视觉相似用向量）
- 检索结果按时间 / 相似度重排
- 离线能力可视化面板（用户可亲眼确认只有模型请求）
- **交付**：具备完整记忆点的版本

### M3 · 发布与传播（1–2 周）

- 静态站点部署，内置 CC0 样例库，打开即可体验
- **英文优先的 README**，第一屏是「与现有方案的区别」表（§二）
- 一篇技术说明：在浏览器里完成检索索引的原理与取舍（含五项实测数据）
- 发布节奏：GitHub topics（`photo-search` / `semantic-search` / `clip` / `local-first` / `privacy`）、Hacker News、V2EX、少数派
- **交付**：公开版本 + 宣传材料

### M4 · 能力扩张（持续）

| 方向 | 说明 |
|---|---|
| 桌面外壳 | Tauri 2（官方支持桌面 + 移动）补齐「浏览器无法后台处理」的短板。**得益于 `PhotoSource` + `EmbeddingProvider`，这是替换实现而不是重写** |
| 常驻后台索引 | 仅原生壳可行：标签页关闭即停是浏览器路线的固有短板 |
| 检索层 SDK | 把索引与检索能力抽成可复用模块，允许接入其它照片来源 |
| 文字识别 | 票据 / 招牌 / 书页内容进入检索范围 |

### 时间表

| 里程碑 | 周期 | 累计 |
|---|---|---|
| M0 可行性验证 | 5 天 | 第 1 周 |
| M1 MVP | 2–3 周 | 第 4 周 |
| M2 差异化能力 | 2–3 周 | 第 7 周 |
| M3 发布与传播 | 1–2 周 | 第 9 周 |
| M4 能力扩张 | 持续 | — |

## 十、技术风险与预案

**保留自 v0.1**：WebGPU 不可用、文件夹授权过期、大图解码内存暴涨、索引过程中断、模型下载失败、图库规模增长、浏览器存储被清理。

**新增五项**：

| 风险 | 影响 | 预案 |
|---|---|---|
| **HEIC / HEIF 无法解码** | 家庭库中最高频格式之一完全检索不到 | M0 第 3 项实测；不能解则引 libheif wasm（+1–2 MB）或明确排除并告知 |
| **多标签页冲突** | `opfs-sahpool` 第二实例初始化失败；两个标签页同时扫描同一文件夹造成重复工作 | Web Locks 选主；非主标签页退化为只读视图并提示 |
| **部署响应头限制** | `opfs` VFS 在无法设置 COOP/COEP 的托管上不可用（GitHub Pages 即如此） | 已通过选 `opfs-sahpool` 规避；M0 第 5 项验证 |
| **中文文本检索质量** | 原版 CLIP 文本侧不懂中文，`自然语言检索` 的承诺落空 | 默认 Chinese-CLIP；两套模型 = 两套向量列 |
| **索引期间无法检索** | 冷索引数分钟至数十分钟，用户以为产品坏了 | 查询通道优先 / 预留准入配额；UI 明示「索引中，可直接搜索」 |
| **许可不明** | 权重许可未明示时重新分发会带来法律风险 | 不分发权重，只给下载 / 转换 / 校验脚本；`NOTICE` 列明全部来源与许可（见附录 B） |

**降级预案的代价要说清**：v0.1 写「> 1 s → 3 天内完成推理路径替换，不延期」。手动管理 ONNX 会话意味着自己写预处理（resize / 归一化）、会话管理、WebGPU buffer 生命周期——这不是 3 天的工作量。改为：优先降模型规格（`q4f16` / 更小视觉塔），更换推理路径作为独立评估项，上限放宽到 5 天。

## 十一、工程约定

### 11.1 目录结构

```
fstop/
├── src/
│   ├── app/                应用装配与路由
│   ├── core/               ★ 手写区：数据模型 / 索引状态机 / 任务队列 / 两个接口
│   ├── workers/            推理 Worker（embed 单实例）
│   ├── storage/            OPFS、sqlite、模型缓存
│   ├── ui/                 视图与组件
│   └── shared/             工具与类型
├── bench/                  可复现基准 + 合成语料生成器
├── public/models/          模型清单与校验值（不存放权重）
├── docs/                   设计文档
├── tests/                  单元测试与端到端测试
├── LICENSE
├── NOTICE                  ★ 权重与第三方资产的来源、许可、校验值
└── CONTRIBUTING.md
```

### 11.2 许可

- **代码许可：MIT（已定）**。落地 `LICENSE` 文件（`Copyright (c) 2026 Fstop contributors`），README 顶部显示许可徽章。放弃 Apache-2.0：本项目无专利诉求，MIT 更短、更易被采纳。
- **`NOTICE` 必须列明全部第三方权重**：来源、许可、校验值、是否可再分发。实测结果见附录 B。
- **不把权重收进仓库**。

### 11.3 三条不可妥协的约定

1. **`src/core/` 手写**。数据模型、索引状态机、任务队列、两个接口，必须由人设计并逐行确认。其余部分可以借助工具加速，但必须通过类型检查、lint 与单元测试。
2. **任何新增网络请求必须显式声明**。代码中不允许出现隐式的埋点、上报、遥测；引入任何三方脚本都需要单独评审。
3. **`core/` 单测覆盖率 ≥ 80%**，其余模块以端到端测试覆盖关键路径。

### 11.4 把约定 2 变成 CI 断言

v0.1 的 DoD 靠人眼看网络面板。改为两条机器执行的检查，任一失败即红：

1. **静态检查**：`fetch(` / `XMLHttpRequest` / `WebSocket` 只允许出现在 `src/storage/models.ts` 白名单文件内。
2. **运行时断言**：Playwright 跑完整流程（建索引 + 检索），断言请求日志中除模型 origin 外**零请求**。

这两条同时是最有说服力的 README 徽章。

### 11.5 协作约定

- 提交信息遵循 Conventional Commits
- `main` 分支受保护，功能走 `feature/*`
- 每个里程碑结束打 Git tag 并出一份变更说明
- **接受 AI 辅助的贡献（已定）**。CONTRIBUTING 里要把话说死，不要含糊——这是当下开源社区的真实分裂点（同类项目 MaterialSearch 就明确写着不接受 AI 生成的代码贡献）。政策表述：欢迎 AI 辅助，但提交者须能逐行解释自己提交的代码；`src/core/` 与测试同样接受，但审查标准不降低（类型检查、lint、单测一视同仁，审查者可要求解释任意一行）。

## 十二、完成定义（DoD）

一个里程碑被视为完成，必须同时满足：

- [ ] 所有 P0/P1 能力在目标浏览器上手工验证通过
- [ ] §八 的性能指标全部达标（验收线，非冲刺线）
- [ ] 单元测试与端到端测试通过
- [ ] 断网状态下核心功能完全可用
- [ ] **CI 的零外发断言通过**（静态检查 + 运行时请求日志断言）
- [ ] `NOTICE` 与实际使用的权重一致
- [ ] 文档更新到与实现一致

## 十三、下一步（立即执行）

1. 建仓库，定名 `fstop`，初始化 Vue 3 + Vite 8 + TypeScript 工程；同时落地 `LICENSE` / `NOTICE` / `CONTRIBUTING.md`
2. 写 `src/core/` 的两个接口（`PhotoSource` / `EmbeddingProvider`）与数据模型定义——**先于任何推理代码**
3. 执行 §九 M0 的五项实测，记录数据；同时产出 `bench/` 与合成语料
4. 数据达标 → 进入 M1；不达标 → 先降模型规格，再评估更换推理路径（上限 5 天，不延期）

---

## 附录 A：本文引用的已核实事实

| 事实 | 数值 / 结论 | 出处 |
|---|---|---|
| `showDirectoryPicker` 支持 | Chrome 86 / Edge 86 / Firefox 无 / Safari 无 | `@mdn/browser-compat-data`（api/Window.json） |
| `showOpenFilePicker` 支持 | Chrome 86 / Edge 86 / Firefox 无 / Safari 无 | 同上 |
| WebKit 脚本可写存储 7 天清除 | 覆盖 IndexedDB、LocalStorage、SessionStorage、Service Worker 注册与缓存；主屏 Web App 走独立计数器 | WebKit 博客《Full Third-Party Cookie Blocking and More》（2020-03-24） |
| `opfs` VFS 需要 COOP/COEP | 需要 `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`，否则无 `SharedArrayBuffer` | SQLite WASM 文档 `persistence.md` |
| `opfs-sahpool` 特性 | 不需要响应头；批量性能最好；不支持多连接；同源第二实例初始化失败 | 同上 |
| OPFS 仅 Worker 可用 / 读取也会加锁 | — | 同上 |
| `sqlite-vec@0.1.9` 浏览器可用性 | npm 包只含 JS 加载器，加载原生 `dylib/so/dll`；不含 wasm | npm 包 `index.mjs` |
| transformers.js `dtype` 默认值 | WebGPU → `fp32`；WASM → `q8` | transformers.js 官方文档 |
| CLIP ViT-B/32 ONNX 体积 | vision fp32 351.7 / fp16 176.1 / int8 88.6 / q4f16 53.3 MB；text fp32 254.1 / fp16 127.3 / int8 64.1 / q4f16 72.5 MB；合计 fp32 605.8 / fp16 303.4 / q8 152.7 / q4f16 125.8 MB | HF API `Xenova/clip-vit-base-patch32?blobs=true` |
| Chinese-CLIP ONNX 可用性 | `Xenova/chinese-clip-vit-base-patch16`、`-vit-large-patch14` 均存在（transformers.js + onnx） | HF API 检索 |
| 模型下载速率（本机实测） | 直连 HF 2.6 MB/s；hf-mirror 1.6 MB/s；`cdn-lfs.huggingface.co` 的 DNS 返回 `31.13.83.2`（污染特征） | `curl` 计时 |
| 依赖版本 | Vue 3.5.43 / Vite 8.3.0 / `@huggingface/transformers` 4.3.0 / `onnxruntime-web` 1.30.0 / `@sqlite.org/sqlite-wasm` 3.53.4 / comlink 4.4.2 | npm registry |
| npm 命名占用 | `fstop` 未被占用；`aperture` 已占用（7.0.0） | npm registry |
| 同类项目 | MaterialSearch 1966★ GPL-3.0，2023-03 创建、2026-09-21 仍在提交，Windows 包 + Docker，核心闭源，默认模型同上；Immich 114,858★；rollfilm 16★ MIT Electron（2026-07 创建） | GitHub API |
| HEIC 浏览器支持 | MDN 的浏览器支持图片格式表中**不含 HEIF/HEIC**（需 M0 实测 `createImageBitmap`） | MDN《Image file type and format guide》 |

## 附录 B：许可矩阵（实测）

| 组件 | 许可 | 可否随项目分发 |
|---|---|---|
| Chinese-CLIP 仓库代码（OFA-Sys/Chinese-CLIP） | **MIT** | 可 |
| `OFA-Sys/chinese-clip-vit-base-patch16` 权重 | HF 模型卡**无 `license` 字段**（同门 `chinese-clip-rn50` 标 `apache-2.0`） | **不明示 → 不再分发**，仅提供脚本与校验值 |
| `Xenova/chinese-clip-vit-base-patch16`（ONNX） | 同源，无许可标签 | 同上 |
| `openai/clip-vit-base-patch32` / `Xenova/clip-vit-base-patch32` | MIT | 可 |
| `immich-app/scrfd_34g_gnkps`（人脸检测） | **MIT** | 可 |
| `immich-app/antelopev2`（人脸识别，insightface 系） | **`license: other`**（非商用研究用途） | 非商用开源项目可用；**必须在 NOTICE 标注**，且意味着此路以后不能转商用 |
| `@huggingface/transformers` / `onnxruntime-web` / `@sqlite.org/sqlite-wasm` / `comlink` / Vue / Vite | Apache-2.0 / MIT / 见各自仓库 | 可 |
