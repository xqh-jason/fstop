# Fstop · 光圈 —— M0 可行性验证实测记录

> 对应项目计划 §九 M0。**本文件只记录实测到的事实**，与计划冲突的地方逐条列出，不修改计划原文，
> 等 M0 收口时再统一回填。日期：2026-09-23 / 24。

## 0. 测量环境（所有数字都受它约束）

| 项 | 值 |
|---|---|
| 机器 | Apple M2（MacBook Air），macOS 27 |
| 环境 A | omp 托管 Chromium，headless；`WEBGL_debug_renderer_info` = `ANGLE (Apple, ANGLE Metal Renderer: Apple M2)`，**非软件光栅化** |
| 环境 B | **系统 Chrome 153.0.0.0（headless，`channel: 'chrome'`）**，由 `pnpm bench` 驱动 —— 这才是权威环境 |
| WebGPU | 可用；`adapter.info` 为空对象，**无法据此判定软硬件适配器**（必须用 WebGL 渲染器名兜底） |
| 网络 | 本机经 HTTP 代理，实测 ~0.45 MB/s（Node 端）；用户直连 HF 为 2.6 MB/s（计划附录 A） |
| 语料 | 合成语料（60% 4032×3024 + 20% 4000×3000 + 10% 6000×4000 + 10% 小图），JPEG q0.85，单张仅 ~200 KB |
| 拓扑 | 1 个 embed worker（串行）+ 3 路并发解码；缩略图 320px q0.8；向量写 OPFS 扁平矩阵 |

> **头号教训：浏览器构建版本对数字的影响大于模型选择。** 同一台机器、同一份语料：
> 环境 A 得到 4.38 photos/s，环境 B 得到 9.96 photos/s（decode 175 ms → 43 ms，embed 320 ms → 201 ms）。
> 因此**任何基准结果必须连浏览器 user agent 一起记录**，否则数字没有意义。
> 环境 A 的绝对值不应再被引用。

## 1. 首启体积与 dtype（§九 第 1 项）

从 HF API（`?blobs=true`）实测的**确切字节数**，不是估算：

| 模型 | fp32 | fp16 | q4f16 | q4 | uint8 | bnb4 |
|---|---|---|---|---|---|---|
| `Xenova/chinese-clip-vit-base-patch16`（**默认**） | 753.7 MB | 377.4 MB | **131.8 MB** | 177.7 MB | 190.2 MB | 167.0 MB |
| `Xenova/chinese-clip-vit-large-patch14` | 1625.8 MB | 813.7 MB | 255.1 MB | 315.2 MB | 409.4 MB | 291.0 MB |
| `Xenova/clip-vit-base-patch32`（vision+text 合计） | 605.8 MB | 303.4 MB | 125.8 MB | 189.4 MB | 152.7 MB | 181.7 MB |

浏览器端实测（weights 已缓存时）：`loadMs` 7.9–9.1 s、`warmupMs` 0.43–0.54 s。
首次（未缓存）实测：**67.2 s** 完成 `onnx/model_q4f16.onnx` 的下载 + 会话初始化（0.45 MB/s 链路）。

### 与计划的差异

1. **§7.2 的「默认档 125.8 MB」错位**：125.8 MB 是 `clip-vit-base-patch32` 的 vision+text 之和；
   **默认模型的 q4f16 是 131.8 MB**。
2. **§7.2 的 dtype 表写法不成立**：Chinese-CLIP 是**单文件双塔**模型，只有一个
   `onnx/model_q4f16.onnx`，不存在「vision 一个档 + text 一个档」。
3. **「不显式指定 dtype 的代价」是 753.7 MB**，不是 606 MB（后者是另一个模型）。
4. 实测确认了 transformers.js 的默认值风险：不指定 dtype 且 `device: 'webgpu'` 时走 fp32。

## 2. 单张向量化延迟（§九 第 2 项）

24 张的中位值（环境 B = 系统 Chrome 153）：

| 配置 | embed 中位 | decode 中位 | 端到端 photos/s | 1 万张外推 |
|---|---|---|---|---|
| Chinese-CLIP ViT-B/16 q4f16（默认，`dualTower: true`） | **201 ms** | 43 ms | 9.96 | **16.7 分钟** |
| clip-vit-base-patch32 q4f16（**显式单塔**，`dualTower: false`） | **72 ms** | 37 ms | 20.76 | **8 分钟** |
| 环境 A 同配置（仅作对照，不应再引用） | 320 ms | 175 ms | 4.38 | 38 分钟 |

**双塔白算的代价被量化了：每张 ~129 ms，占 embed 时间的 64%。**

按 §九 的通过线：

- 默认模型 201 ms → 落在「150 ms–1 s → 降规格」区间；单塔模型 72 ms → 通过（≤150 ms）。
- 1 万张外推：默认 16.7 分钟（**过 20 分钟验收线，未过 10 分钟冲刺线**）；单塔 8 分钟（过冲刺线）。
- 但这两组都是**合成语料**（单张 ~200 KB，真实相机 3–6 MB），read/decode 被低估，真实语料复测见 §4。

### 关键发现：单文件双塔 + 库的解析方式

- `Xenova/chinese-clip-vit-base-patch16` 的 ONNX 图把两个塔的输入都声明为必填：
  只喂 `pixel_values` → `Missing the following inputs: input_ids`；
  只喂 `input_ids` → `Missing the following inputs: pixel_values`。
  ONNX Runtime 会计算图里声明的**全部输出**，所以每次图像 embedding 都会连文本塔一起算。
- `Xenova/clip-vit-base-patch32` **有**分文件的 `vision_model*` / `text_model*`，但
  `AutoModel` 与 `pipeline('feature-extraction')` 都会解析成**双塔 `CLIPModel`**
  （实测：`feature-extraction` 管道调用文本时同样报缺 `pixel_values`）。
  要真正只跑单塔，必须显式用 `CLIPVisionModelWithProjection` / `CLIPTextModelWithProjection`。
- transformers.js 里**没有** Chinese-CLIP 的分塔类，也没有 `ChineseCLIPProcessor`
  （`processing_auto.js` 无 `chinese_clip` 条目）→ 文本侧必须单独 `AutoTokenizer`。

### 结论（按计划 §九 的通过线）

- 热延迟：默认 201 ms / 单塔 72 ms，**分居 150 ms 线的两侧**；
- 1 万张外推：默认 16.7 分钟（过验收线、未过冲刺线）、单塔 8 分钟（过冲刺线）；
- 差距全部来自「白算另一塔」，因此 **M1 的第一个待决项就是怎么拆掉它**，三条路：

| 方案 | 收益 | 代价 |
|---|---|---|
| A. 英文库用 `CLIPVisionModelWithProjection` + `CLIPTextModelWithProjection`（已实现并实测 72 ms） | 立即拿到单塔速度 | **中文文本检索质量丢失**，违背默认模型选型的初衷 |
| B. 保留 Chinese-CLIP 现状（双塔） | 零改动，中文质量最好 | 16.7 分钟，达不到 10 分钟冲刺线；每次查询也白算视觉塔 |
| C. 拆塔导出（optimum 转换）或直接用 `onnxruntime-web` 只 fetch 需要的输出 | 中文质量 + 单塔速度 | 自己写预处理/会话管理，正是计划 §十 标记的 5 天上限路径；需要验证 ORT 的按需输出剪枝是否真的生效 |

**M0 阶段不做选择**：A 已在代码里（`towers: 'split'`），B 是当前默认，C 需要一次 spike。
另有一个 M0 完全没测的维度：**检索质量**（中文 query 命中率），它才是 B/C 之争的真正裁判。

## 3. HEIC 解码（§九 第 3 项）

- 夹具：`sips` 从样例 JPEG 转出的真实 HEIF/HEVC（`ISO Media, HEIF Image HEVC Main`），3 个。
- 结果：`createImageBitmap` → **`The source image could not be decoded.`**（失败）
- 结论：**Chromium 解不开 HEIC**，与 MDN 不含 HEIF/HEVC 一致。
- **定稿决定（2026-09-24）**：用户无 iPhone HEIC / 相机 RAW 样张，真机覆盖无法补齐，
  因此按计划 §九 的第二个预案落地 —— **明确排除 + 界面告知**；
  libheif wasm（+1–2 MB）降级为 M1 待评估项，不进 M0 结论。RAW 本就不在 P0/P1 范围。
- 残留风险：本机只测了 macOS 上的两个 Chromium 构建；Windows/Linux 未测。

## 4. 端到端吞吐（§九 第 4 项）

`pnpm bench` 已可复现（Playwright 驱动系统 Chrome，语料经 `<input webkitdirectory>` 注入，不复制文件）。

| 语料 | 配置 | photos/s | 1 万张外推 |
|---|---|---|---|
| 合成 24 张（单张 ~200 KB） | 默认 Chinese-CLIP 双塔 | 9.96 | 16.7 分钟 |
| 合成 24 张 | 英文 CLIP 单塔 | 20.76 | 8 分钟 |
| **真实 CC0 原图 1000 张** | 待测（`scripts/fetch-corpus.mjs` 抓取中） | — | — |

分阶段中位（默认配置，合成语料）：read 1 ms、hash 1 ms、decode 43 ms、embed 201 ms、thumb 2 ms
→ **瓶颈完全在 embed**；真实语料会抬高 read/decode（真实相机 JPEG 3–6 MB、12–24 MP）。

入库链路已跑通：迁移在浏览器内真实执行（`schemaVersion: 1`、`applied: 1`），
`photos/embeddings/jobs` 行数与照片数一致，向量矩阵槽位数一致，缩略图写入 OPFS。

## 5. `opfs-sahpool` 多标签页（§九 第 5 项）

| 场景 | 结果 |
|---|---|
| 两个标签页同时开库（无选主） | 第一个成功；第二个 **`NoModificationAllowedError`**（硬失败，不是优雅退化） |
| 两个标签页 + Web Locks `ifAvailable` 选主 | 主标签页 `leader: true` 且开库成功；第二个 `leader: false`，**未尝试开库、无异常** |

结论：计划 §7.3 的选主方案**实测有效**，且是必须的——不加选主就是硬失败。
补充事实：换一个 VFS 目录名并不能规避（说明冲突来自同 origin 的活跃实例，而不是目录残留）；
同一标签页内重复 `installOpfsSahPoolVfs` 也会失败，因此「一个 Worker 只开一次」必须在代码结构上保证。

## 6. 顺带证伪/确认的工程细节（都会影响 M1）

| 事实 | 影响 |
|---|---|
| `RawImage.read` 不接受 `ImageBitmap`（只收 Blob/canvas/RawImage） | `EmbeddingProvider.embedImage(bitmap)` 契约需要在 Worker 内加一层 `drawImage` + `getImageData` 转换（已实现，512² ≈ 1 MB 拷贝） |
| `JSON.stringify` 对可调用对象（transformers.js 的 processor）返回 `undefined` | 任何把 processor 塞进日志/JSON 的地方都要兜底 |
| OPFS `getFileHandle` 拒绝含 `/` 的名字 | 向量矩阵文件名不能用模型 id（`Xenova/...`），必须用 `space` 标识（已修） |
| 语料/缩略图/向量的 OPFS 写入均正常，`createWritable` 保持打开可行 | §7.4 的存储分层成立 |

## 7. 尚未完成（M0 收口前必须补）

1. 1000 张**真实**照片库的端到端 photos/s（等用户提供库）；
2. 在用户自己的 Chrome（有头、硬件加速）上复测第 2、4 项；
3. 真实 iPhone HEIC 样张的第 3 项复测；
4. 单塔路径的数字（决定默认模型是否要换）；
5. `pnpm bench` 的 Playwright 驱动器（目前靠浏览器工具驱动页面，尚不可「任何人复现」）。
