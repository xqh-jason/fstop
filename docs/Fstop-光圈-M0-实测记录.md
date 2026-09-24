# Fstop · 光圈 —— M0 可行性验证实测记录

> 对应项目计划 §九 M0。**本文件只记录实测到的事实**，与计划冲突的地方逐条列出，不修改计划原文，
> 等 M0 收口时再统一回填。日期：2026-09-23 / 24。

## 0. 测量环境（所有数字都受它约束）

| 项 | 值 |
|---|---|
| 机器 | Apple M2（MacBook Air），macOS 27 |
| 浏览器 | omp 托管 Chromium，headless；`WEBGL_debug_renderer_info` = `ANGLE (Apple, ANGLE Metal Renderer: Apple M2)`，**非软件光栅化** |
| WebGPU | 可用；`adapter.info` 为空对象，**无法据此判定软硬件适配器**（必须用 WebGL 渲染器名兜底） |
| 网络 | 本机经 HTTP 代理，实测 ~0.45 MB/s（Node 端）；用户直连 HF 为 2.6 MB/s（计划附录 A） |
| 语料 | 合成语料 24 张（60% 4032×3024 + 20% 4000×3000 + 10% 6000×4000 + 10% 小图），JPEG q0.85 |
| 拓扑 | 1 个 embed worker（串行）+ 3 路并发解码；缩略图 320px q0.8；向量写 OPFS 扁平矩阵 |

> 环境差异要说清：本记录里的绝对延迟来自 headless 模式，比有头模式通常略差或略好，**不是验收数字**；
> 权威数字必须在用户自己的 Chrome（有头、硬件加速）上复测（M0 收口时补）。

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

24 张的中位值（含首次调用）：

| 配置 | embed 中位 | decode 中位 | 端到端 photos/s | 1 万张外推 |
|---|---|---|---|---|
| Chinese-CLIP ViT-B/16 q4f16（默认） | **320 ms** | 175 ms | 4.38 | **38 分钟** |
| clip-vit-base-patch32 q4f16（对照） | 223 ms | 123 ms | 6.93 | 24 分钟 |

**两个配置的 `dualTower` 都是 true**，即两者都在白算另一塔——见下一节。

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

- 热延迟 320 ms / 223 ms，**都在 150 ms–1 s 区间** → 按计划应当「降规格」；
- 1 万张外推 38 分钟，**未达 20 分钟验收线**（24 分钟也差得远）；
- 但这两组数字里都含有「白算另一塔」的冤枉开销。**在拿到单塔数字之前，不应据此换模型**——
  这是 M1 的第一个待决项，三条路：
  1. 英文库走 `CLIPVisionModelWithProjection` + `CLIPTextModelWithProjection`（最省事，但中文文本侧质量差，违背默认模型的初衷）；
  2. 保留 Chinese-CLIP，接受双塔开销（当前 320 ms/张，需在真实 Chrome 上复测）；
  3. 拆塔导出（optimum 转换）或直接用 `onnxruntime-web` 指定 fetch 以剪掉另一塔
     —— 代价是自己写预处理，正是计划 §十 已经标记的 5 天上限路径。

## 3. HEIC 解码（§九 第 3 项）

- 夹具：`sips` 从样例 JPEG 转出的真实 HEIF/HEVC（`ISO Media, HEIF Image HEVC Main`），3 个。
- 结果：`createImageBitmap` → **`The source image could not be decoded.`**（失败）
- 结论：**托管 Chromium 解不开 HEIC**，与 MDN 不含 HEIF/HEIC 一致。
  计划 §九 的预案成立：要么引 libheif wasm（+1–2 MB），要么明确排除并告知用户。
- 残留风险：本机只测了 macOS 上的一个 Chromium 构建；Windows/Linux 未测。
  **真实 iPhone 原图（HDR gain map、10-bit、Live Photo 容器）尚未覆盖**，需要用户提供样张。

## 4. 端到端吞吐（§九 第 4 项）

上表的 4.38 / 6.93 photos/s 是 24 张合成语料的结果，**不构成 1000 张真实库的结论**：

- 缺 1000 张真实照片库（用户后续提供）；
- 分阶段中位：read 1 ms、hash 2–3 ms、decode 123–175 ms、embed 223–320 ms、thumb 3–6 ms；
  **瓶颈完全在 embed**，decode 次之；
- 入库链路已跑通：迁移在浏览器内真实执行（`schemaVersion: 1`、`applied: 1`），
  `photos/embeddings/jobs` 各 24 行，向量矩阵 24 槽位，缩略图写入 OPFS。

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
