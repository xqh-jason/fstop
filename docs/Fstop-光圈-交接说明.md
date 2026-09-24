# Fstop · 光圈 —— 交接说明

> 给接手的人/agent。**先读这一份，再读计划与实测记录。** 最后更新：2026-09-24（检索质量补测后）。

## 0. 一句话状态

工程骨架、`src/core/` 契约、M0 五项实测**已完成并提交**；M0 收口四项（质量 / files 根因 / 拆塔 spike / 阶段成本口径）
**也已完成**（2026-09-24）；**M1（MVP）尚未开始**。
拆塔 spike 的结论改变了 M1 的第一个决策：**方案 C 的运行时路线出局，且「白算文本塔」的归因被推翻**——
真正的瓶颈是视觉塔（占单张成本 97%），1 万张的计算下限 ≈ 11.3 分钟，够不到 10 分钟冲刺线（见 §4、§9B）。

## 1. 按顺序读这些

| 文件 | 作用 |
|---|---|
| `docs/Fstop-光圈-项目计划-v0.2.md` | **设计真相源**：定位、边界、技术选型、里程碑、指标、DoD |
| `docs/Fstop-光圈-M0-实测记录.md` | M0 五项实测数据 + **对计划数字的修正**（含 4 处冲突） |
| `CONTRIBUTING.md` | 三条硬约定、AI 政策、基准怎么跑 |
| `NOTICE` | 权重与样例图的许可矩阵（硬约束，改依赖/加资产必须同步） |
| 本文件 | 现状、环境事实、已知坑、下一步 |

## 2. 现状：代码清单

| 路径 | 状态 | 说明 |
|---|---|---|
| `src/core/model.ts` | ✅ 手写区 | §7.6 七张表的 DDL + 行类型；`SCHEMA_VERSION` |
| `src/core/photo-source.ts` | ✅ 手写区 | `PhotoSource` / `PhotoRef` / `PhotoStat` 契约 |
| `src/core/embedding-provider.ts` | ✅ 手写区 | `EmbeddingProvider` 契约（含「向量必须 L2 归一化」等不变量） |
| `src/storage/migrations.ts` | ✅ | 手写迁移链 + 事务化 `applyMigrations`（失败整体回滚） |
| `src/storage/models.ts` | ✅ | **全项目唯一允许联网的模块**；模型目录（含实测字节数、`towers` 字段）、运行时 env 配置 |
| `src/storage/opfs.ts` | ✅ | OPFS 基础操作 |
| `src/storage/photo-source-opfs.ts` | ✅ | `PhotoSource` 的 OPFS 实现（合成根） |
| `src/storage/vector-matrix.ts` | ✅ | 自实现扁平向量矩阵（顺序追加；槽位同步预留） |
| `src/storage/db.worker.ts` | ✅ | `opfs-sahpool` VFS + 迁移 + 批量入库（M0 级，无选主） |
| `src/workers/decode.ts` | ✅ | EXIF 摆正 + 降采样 + 缩略图 |
| `src/workers/embed.worker.ts` | ✅ | 单实例推理 Worker；**双塔/单塔两种加载路径** |
| `src/shared/env.ts` | ✅ | 能力探测（FSA / OPFS / WebGPU / persist） |
| `src/app`、`src/ui` | ✅ 壳 | 应用装配 + 能力面板；**检索 UI 未做** |
| `bench/` | ✅ M0 级 | 探针、基准页、检索延迟页、**检索质量页（§9A2 已完成）**、Playwright 驱动器、合成语料、HTTP 语料源 |
| `scripts/` | ✅ | 零外发检查、样例/权重/语料/HEIC 夹具脚本 |
| `tests/unit/` | ✅ 23 项 | 用 `node:sqlite` 跑**真实建表与约束**（不是正则断言 SQL 文本） |
| `public/samples/` | ✅ | 39 张 CC0 样例图 + `manifest.json`（逐张来源/许可/sha256） |
| 索引状态机 / 任务队列 | ❌ | 计划 §7.4 说属于 `src/core/`，**M1 第一件事** |
| 缩略图墙 / 检索 UI / 人物页 | ❌ | M1 |
| Playwright 端到端测试 | ❌ | M1；注意 §7 里 `files` 模式那条坑 |
| 部署（Cloudflare Pages 等） | ❌ | M0 第 5 项只验证了 `opfs-sahpool` 的多标签页行为 |

## 3. 提交历史

| 提交 | 内容 |
|---|---|
| `098b0bf` | 初始化：Vue 3 + Vite 8 + TS 工程、LICENSE/NOTICE/CONTRIBUTING、`src/core/` 契约、零外发静态检查、CI |
| `fe86c9f` | M0 探针、合成语料生成器、`fetch-models` / `fetch-samples` 脚本 |
| `966b64f` | 端到端链路打通（OPFS 语料 → 解码 → 单实例 embed → 向量矩阵 → sqlite 入库）+ 39 张 CC0 样例库 |
| `4c1db81` | `pnpm bench` 可复现驱动器 + **单塔路径**（量化双塔代价） |
| `1c4d653` | 驱动器与语料抓取的 4 个真 bug 修复 |
| `101dcca` | **真实语料 783 张基准跑通，M0 五项实测全部出数** + 4 个静默卡死修复 |
| `d6c772d` | M0 收口三件：检索质量页 / 拆塔 spike 页 / files 根因探针 |
| `fd113de` | 修复双塔 `embedText` 误取占位零图的 `image_embeds`（文本检索与输入无关） |
| `5031d7e` | 文档回填：方案 A 出局、files 根因、spike 进度 |
| `2d11397` | **拆塔 spike 出数**：ORT WebGPU EP 不剪枝（方案 C 运行时路线出局）+ 推翻「白算 59%」的归因 + 成本口径修正（实测记录 §9） |

## 4. M0 实测结论（细节见 `docs/Fstop-光圈-M0-实测记录.md`）

环境：Apple M2 / macOS 27 / **系统 Chrome 153 headless**（`pnpm bench` 用 `channel: 'chrome'`）。

| 项 | 结果 | 判定 |
|---|---|---|
| 1 首启体积 | 默认档 q4f16 = **131.8 MB**；不指定 dtype = **753.7 MB**；冷启 67 s（0.45 MB/s 链路），缓存命中 1.1 s | 计划 §7.2 的 125.8 / 606 MB 是**另一个模型**的数字，须修正 |
| 2 单张向量化 | embed **154 ms**（真实语料、双塔）/ 72 ms（显式单塔）；decode 47 ms | 154 ms 略高于 150 ms 门线 |
| 3 HEIC | `createImageBitmap` 解不开真实 HEIF/HEVC | 定稿：**明确排除 + 界面告知**；libheif wasm 列 M1 待评估 |
| 4 端到端吞吐 | 783 张真实 CC0 原图（1.71 GB）→ **13.6 photos/s，1 万张外推 12.3 分钟** | **过验收线（≤20 分钟），未过冲刺线（≤10 分钟）** |
| 5 多标签页 | 无选主第二标签页硬失败 `NoModificationAllowedError`；Web Locks 选主后优雅退化 | §7.3 方案验证有效，**必须做** |
| 附加·检索延迟 | 文本向量化 70.8 ms + 1 万条 × 512 维暴力余弦 7.3 ms = **78.1 ms** | 预算 300 ms，通过（⚠ 见 §7 的向量 bug 说明：延迟有效，但当时向量是错的） |
| 附加·检索质量（2026-09-24 补测） | **中文 R@1 = 100%**（Chinese-CLIP 双塔）；英文 CLIP 单塔中文 R@1 = **13%** | **方案 A 出局**，细节见实测记录 §7 |
| 附加·拆塔 spike（2026-09-24） | 指定 `['image_embeds']` 后 59 ms vs 全输出 62 ms（**1.1×**），且返回的输出键确实只剩 1 个 | **ORT 的 WebGPU EP 不剪枝 → 方案 C 的运行时路线出局**，见实测记录 §9.1 |
| 附加·成本口径重测（2026-09-24） | 文本塔 0.24 ms/token（入库占位 2 token → 白算 0.5 ms）；视觉塔 ≈ 59 ms = **单张成本的 97%**；解码并发 1 → 6 时 embed 中位 68 → 368 ms 而吞吐只 9.05 → 14.36 photos/s | **「白算 59%」归因被推翻**；embed 中位是排队时间；1 万张计算下限 ≈ **11.3 分钟**，见实测记录 §9.2/§9.4 |

分阶段中位：read 4 / hash 1 / **decode 47** / **embed 154** / thumb 2 ms → 瓶颈在 embed（约 70%）。
（⚠ **embed 154 ms 是「排队 + 计算」**，单张真实计算 ≈ 68 ms，口径见实测记录 §9.4。）

**最重要的一条（2026-09-24 改写）**：单张成本几乎全是**视觉塔**（≈ 59 ms / 97%）。
`Xenova/chinese-clip-vit-base-patch16` 是**单文件双塔**，ORT 会计算全部输出，但入库时喂的占位文本只有 2 token，
「白算文本塔」的真实代价只有 **≈ 0.5 ms**（原「104 ms / 59%」是跨模型混淆，见实测记录 §9.2）；
而且视觉塔的分辨率被导出**钉死在 224²/197 token**（喂 112² 直接报错），不能拿分辨率换速度。
→ **1 万张的冲刺线（10 分钟）只能靠降低视觉塔成本来够**（更少视觉 token 的骨干 / 可降分辨率的导出 / 更合适的 dtype），
见 §9B 与实测记录 §9.5。

## 5. 硬约束（违反即拒绝合并）

1. **`src/core/` 手写**：数据模型、索引状态机、任务队列、两个接口必须人设计、逐行可解释。
2. **任何新增网络请求必须显式声明**：`src/` 里除白名单 `src/storage/models.ts` 外不得出现
   `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `sendBeacon` / 远程 import；
   `pnpm check:egress` 是 CI 闸门。**运行时请求日志断言（Playwright）属于 M1，尚未实现。**
3. **`src/core/` 单测覆盖 ≥ 80%**（`pnpm test:coverage` 已设阈值）。
4. **许可纪律**：代码 MIT；**权重不进仓库**（只给下载+校验脚本，`NOTICE` 记录来源与许可）；
   内置样例图**只收 CC0/公有领域**（带署名义务的一律不要），逐张记录见 `public/samples/manifest.json`。
5. **AI 政策**：接受 AI 辅助，但提交者必须能逐行解释；审查标准不降低（见 `CONTRIBUTING.md`）。
6. Conventional Commits；`main` 受保护、功能走 `feature/*`（当前 6 个提交直接落在本地 `main`，尚未推送）。

## 6. 怎么跑

```bash
pnpm install
pnpm dev                 # 开发服务器
pnpm verify              # typecheck + lint + 零外发断言 + 单测
pnpm build               # typecheck + 生产构建

# 基准（Playwright 驱动系统 Chrome，持久化 profile 在 .cache/bench-profile）
pnpm bench                                   # 合成语料（OPFS，可复现基线）
pnpm bench -- --source http                  # 真实语料（需先抓，见下）
pnpm bench -- --source http --limit 200      # 分块跑
pnpm bench -- --query                        # 检索延迟（§八 ≤300 ms）
pnpm bench -- --quality                      # 检索质量：中文 query 命中率（实测记录 §7）
pnpm bench -- --quality --model Xenova/clip-vit-base-patch32   # 对照：英文单塔
pnpm bench -- --towers                       # 拆塔 spike：ORT 指定输出是否剪枝（实测记录 §9）
pnpm bench -- --towers --device wasm         # 同一 spike 换 EP 对照
pnpm bench -- --decode 1                     # 解码并发（1 = 不排队，才看得到 embed 真实计算时间）
pnpm bench -- --headed                       # 有头模式（尚未复测，建议补一次）

# 数据准备（都走代理时需要 NODE_USE_ENV_PROXY=1）
NODE_USE_ENV_PROXY=1 node scripts/fetch-models.mjs            # 权重 → .cache/models（不入库）
NODE_USE_ENV_PROXY=1 node scripts/fetch-corpus.mjs --count 800 # 真实语料 → bench/corpus（不入库）
NODE_USE_ENV_PROXY=1 node scripts/fetch-corpus.mjs --verify    # 校验语料 sha256
node scripts/fetch-samples.mjs --refresh                      # 内置 CC0 样例库（入库）
node scripts/make-heic-fixtures.mjs [含 .heic 的目录]          # HEIC 夹具（macOS 用 sips）
```

结果落在 `bench/results/*.json`（gitignore）。

## 7. 环境事实（会咬人的）

| 事实 | 后果 |
|---|---|
| Node **≥22.22** | 单测用 `node:sqlite`（实验 API，默认开启）跑真实 schema |
| pnpm 11 不再读 `package.json` 的 `pnpm` 字段 | 设置必须写 `pnpm-workspace.yaml`（`onlyBuiltDependencies: []` 在那里） |
| TypeScript 固定 **6.0.3** | `typescript-eslint@8` 对 TS 7 **直接抛错**，别升 |
| `lib` 需要 **ES2024** | `Promise.withResolvers` 在 ES2023 lib 下不存在 |
| Playwright 用 `channel: 'chrome'` | 不下载自带 Chromium；**基准跑在用户真实浏览器上** |
| 浏览器缓存按 **origin** 隔离 | 基准端口一换（5199→5201）权重就重下；固定用默认端口 |
| Node 的 `fetch` 不读代理环境变量 | 脚本要 `NODE_USE_ENV_PROXY=1` |
| Vite 默认只监听 `::1`，Node 的 `localhost` 可能解析到 `127.0.0.1` | 脚本里一律钉 `--host 127.0.0.1` |
| 强杀会留下 `SingletonLock` | Chrome 直接拒绝启动；驱动器已在启动前清理 |
| 基准是**单实例**的 | 不要并发跑两轮基准（profile 与端口都会撞） |
| **Node 默认是 18，项目要 ≥22.22** | `pnpm bench` 在 Node 18 下直接报 `Playwright requires Node.js 20 or higher`；本机可用 `PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"` |
| Worker 里发出的请求，`page.on('response')` 收不到 | 要挂 `context.on('response')` 才能看到（模型权重是 Worker 里 fetch 的） |
| 页面加载时那条 `/favicon.ico` 404 | `public/` 里没有 favicon、HTML 也没引用，Chrome 自动请求 → **无害**，别当故障追 |
| `RawImage.resize` 是 **async** | 直接塞给 processor 会报 `undefined is not iterable`（towers 扫描首跑就白丢了一整组数据） |
| `ChineseCLIPFeatureExtractor` 的 `do_resize: true` + `size 224×224` | **任何输入都会被重缩到 224**：想拿图像尺寸当自变量必须绕开 processor 手工做 CHW 张量，否则三档测出来一模一样 |
| 视觉塔位置编码写死 **197 token**（14×14+1） | 喂非 224² 的 `pixel_values` 会在 `/vision_model/embeddings/Add` 报 broadcast 错——分辨率不能拿来做速度杠杆 |

## 8. 已知坑（都已修或已绕开，别踩回去）

| 坑 | 根因 | 现状 |
|---|---|---|
| 页面「静默空转」，无任何错误 | 批次写失败 → promise 拒绝，页面不显示、`pageerror` 当时没接出来 | 已修：页面进度 + 5 秒心跳（含当前阶段）转发到驱动器；`pageerror` 立刻打印 |
| `UNIQUE (model_id, matrix_offset)` 冲突 | `VectorMatrix.append` 的 offset 在 `await write()` 之后自增 → 并发算出同一槽位 | 已修：**同步预留槽位**再 await 写入 |
| 批量入库互相打断 | 数据库单连接，`BEGIN` 不能并发 | 已修：批量写串行化 |
| `setInputFiles` 对**软链目录**静默置空（对真实文件正常） | Chromium 忽略软链 | 基准已改用 dev server + HTTP 语料源；`--limit` 用**硬链接**子集目录 |
| Playwright 拒绝给 `webkitdirectory` 传文件数组 | 库的显式校验 | 同上；`files` 模式仍在，但基准不用它 |
| 驱动器提前返回中间态 | 就绪条件写成「结果存在」 | 已修：按模式等**终态字段**（`photosPerSecond` / `textEmbedMs`） |
| OPFS 文件名不能含 `/` | `getFileHandle` 直接抛 | 向量矩阵用 `space` 标识而非模型 id |
| `RawImage.read` 不接受 `ImageBitmap` | 库只收 Blob/canvas/RawImage | Worker 内加一层 `drawImage` + `getImageData` |
| `JSON.stringify(可调用对象)` 返回 `undefined` | transformers.js 的 processor 是可调用对象 | 日志/序列化处要兜底 |
| Wikimedia 缩略图只服务**特定宽度档**（1280/1920/3840；2000/2560 被 400） | 上游策略 | 语料脚本用已验证档位 + 原图兜底 |
| `info.url` 现在带 `?utm_...` | API 变更 | 拼 URL 前先剥查询串 |
| 语料候选被博物馆扫描件淹没 | 低熵、体积小，会把 read/decode 带偏 | 加 **EXIF 相机型号**过滤 |
| 文件名碰撞导致清单条目落空 | 长标题截断后 slug 相同 | 文件名附标题哈希；清单加载时校验 sha256 并剔除不一致项 |
| **双塔 `embedText` 返回的是占位零图的 `image_embeds`**（所有 query 同一个常量向量，检索结果与文本无关） | 双塔 ONNX 图同时输出 `image_embeds`/`text_embeds`，`firstEmbedding` 按优先级永远先命中前者 | 已修：`embeddingFor(outputs, 模态)` 显式选输出；质量页加「不同文本 → 不同向量」烟雾测试。**M0 已录的检索延迟数字仍有效**（计算量相同），详见实测记录 §7 |
| **拿「跨模型」的差值去归因阶段成本**（「双塔比单塔慢 104 ms = 白算文本塔」，占 59%） | 两个模型的**视觉塔 token 数差 4×**（B/16 的 196 vs B/32 的 49），差值其实来自骨干 | 已纠正（实测记录 §9.2）：同一模型内实测文本塔 0.24 ms/token、入库占位 2 token → 白算仅 **0.5 ms**。**教训：成本归因必须在同一模型内做单变量对照** |
| **把「分阶段中位」当计算时间**（embed 176 / 368 ms） | 串行化的 `embedChain` 外面打点，量到的是**排队 + 计算** | 已澄清（实测记录 §9.4）：要看真实计算成本就 `--decode 1`（embed 68 ms）；并发只改吞吐不改单张成本 |
| 指定输出列表后「输出键少了」被当成剪枝生效 | 二者是两件事：ORT 尊重 `fetches`，但 WebGPU EP 仍执行整图 | 已实测钉死（实测记录 §9.1）：1.1×，与噪声同量级。**别再按「ORT 会按需剪枝」做设计** |

## 9. 下一步

### A. M0 收口（都不阻塞结论）
1. `pnpm bench -- --headed` 复测一次，确认 headless 数字不偏乐观；**仍未做**；
2. ~~检索质量（中文 query 命中率）~~ → **已完成（2026-09-24）**：`pnpm bench -- --quality`，
   Chinese-CLIP 中文 R@1 = **100%** / MRR 1.0，英文 CLIP 单塔中文 R@1 = **13%** → **方案 A 出局**（实测记录 §7）；
3. ~~拆塔方案 C 的 spike~~ → **已完成（2026-09-24）**，见实测记录 §9：
   ① ORT 的 WebGPU EP **不剪枝**（指定输出 59 vs 全输出 62 ms，但输出键确实只剩 1 个）；
   ② 只喂单侧输入仍被拦；③ 剪枝/全量输出余弦 = 1。
   **同时推翻了两条旧结论**：入库时「白算另一塔」只有 0.5 ms（不是 104 ms）；`embed` 分阶段中位是排队时间（不是计算时间）。
4. ~~`files` 模式（`<input webkitdirectory>`）在持久化 profile 下静默失败的根因~~ → **已完成（2026-09-24）**：
   Chromium 枚举目录时**逐项过滤软链**（安全机制，枚举不中断；混合目录只丢软链项，更隐蔽），
   与 Playwright、持久化 profile 均无关。探针 `node bench/files-probe.mjs`（real/hardlink/softlink/mixed 对照）。
   **给 M1 的两条**：① E2E 夹具目录一律复制或硬链接，禁止软链；② 生产同理——真实用户选中的文件夹里若有软链照片（或软链子目录）会被静默跳过，索引页应展示「选中数 vs 入库数」差值（可观测性），软链子目录是否被跟进可用探针扩展验证。
5. **视觉塔成本模型（新，M1 前最值得做的一项）**：把 59 ms 拆成「每 token 成本」与「固定开销」。
   现有唯一证据是跨模型粗对照（CLIP B/32 49 token ≈ 34 ms vs Chinese-CLIP B/16 196 token ≈ 66 ms 整页中位），
   不足以判断「小分辨率导出」能否够到冲刺线。做一次单塔测量（图手术导出 / 或 `bench/towers.ts` 里跑分塔模型）
   即可定量——它直接决定 §9B 的 D1/D2 哪条值得走。

### B. M1 第一个决策：怎么让 1 万张进 10 分钟（2026-09-24 重写）

**旧表（A/B/C）的前提已经变了**：A 因中文质量出局（§7）；C 的**运行时**路线出局（不剪枝，实测记录 §9.1）；
而 C 原本的收益前提——「拆掉白算的另一塔能省 59%」——被实测推翻（真实只有 0.5 ms，实测记录 §9.2）。
**所以「拆塔」不再是一个能改变吞吐的方向**：单张 68 ms 里 59 ms 是视觉塔，1 万张的计算下限 ≈ 11.3 分钟，
而实测已经贴在这个下限上（14.36 photos/s / 11.6 分钟）。冲刺线只能靠**降低视觉塔成本**来够。

| 方案 | 收益 | 代价 / 风险 | 前置 |
|---|---|---|---|
| D1 换更便宜的**视觉骨干**（如 Chinese-CLIP 的 RN50 版；文本塔仍是中文 RoBERTa，质量前提不破） | 视觉塔成本可能降数倍 → 冲刺线可够 | 需确认 HF 上有可用的 ONNX 版与许可；需重跑质量页守中文 R@1 | 先做 §9A5 的成本模型 + 一次骨干对照 |
| D2 重导出**可控分辨率**的视觉塔（optimum / 图手术 + 位置编码插值，如 112²） | token 数 4× 减少 | 正是计划 §十 标记的 5 天上限路径；质量要重新验证（小分辨率对 CLIP 类模型通常可接受） | 同上 |
| D3 **dtype 档位对照**（q4f16 vs fp16 vs q4）：q4f16 走 `MatMulNBits`，未必是最快的 | 可能免费拿到 10–30% | 需下载 fp16（377 MB，代理链路约 0.45 MB/s） | 无，最便宜的一项 |
| D4 **接受 11.6 分钟**，把冲刺线降级为「过验收线即可」（验收线 20 分钟早已达标） | 零成本，M1 可以立刻开工 | 放弃 §八 的冲刺目标 | 用户决策 |

**建议顺序**：D3（一次对照，几乎零成本）→ §9A5（成本模型）→ D1/D2（按成本模型选）→ 若都不划算则 D4。

### C. M1 范围（按计划 §九）
文件夹选择 + 权限持久化 + `navigator.storage.persist()`；`content_hash` + `deleted_at` 增量识别；
缩略图墙 + 虚拟滚动（**显式 `ImageBitmap.close()` + 约 300 张活跃的 LRU**）；
索引期间可检索；索引进度与断点续算；`src/core/` 的**索引状态机与任务队列**；
Web Locks 选主（第二标签页退化为只读）；CI 的**运行时**零外发断言。

## 10. 不要做的事

- 不要为了跑通而把权重或真实语料提交进仓库（`NOTICE` 的承诺是结构性的，不是措辞）。
- 不要用 `mtime + size` 当照片身份（备份恢复/跨盘复制会让整库重算）——用 `content_hash`。
- 不要在生成缩略图/向量**之后**才应用 EXIF 方向。
- 不要并发打开 `opfs-sahpool`（同 origin 第二实例硬失败），也不要绕过 `src/core/` 的接口另写一套。
- 不要在 `src/` 里引入未声明的网络访问；不要引入埋点/遥测。
- 不要用「合成语料跑得快」来推断真实语料——两者结论相反过（真实语料反而更快）。
- 不要拿**跨模型**的差值归因阶段成本（「双塔比单塔慢 104 ms = 白算文本塔」就是这么错的：
  两个模型的视觉塔 token 数差 4×）。成本归因要在**同一模型内做单变量对照**。
- 不要把分阶段中位当计算时间引用：`embed` 中位里绝大部分是排队等 GPU（要 `--decode 1` 才看得到真实计算成本）。
- 不要按「ORT 会按需剪枝输出」做设计——WebGPU EP 实测不剪枝，指定输出列表只是少返回张量，不少算。
