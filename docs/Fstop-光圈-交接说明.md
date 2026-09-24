# Fstop · 光圈 —— 交接说明

> 给接手的人/agent。**先读这一份，再读计划与实测记录。** 最后更新：2026-09-24，对应提交 `101dcca`。

## 0. 一句话状态

工程骨架、`src/core/` 契约、M0 五项实测**已完成并提交**；**M1（MVP）尚未开始**。
仓库有本地提交但**未推送**（`main` 比 `origin/main` 多 6 个提交）。

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
| `bench/` | ✅ M0 级 | 探针、基准页、检索延迟页、Playwright 驱动器、合成语料、HTTP 语料源 |
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

## 4. M0 实测结论（细节见 `docs/Fstop-光圈-M0-实测记录.md`）

环境：Apple M2 / macOS 27 / **系统 Chrome 153 headless**（`pnpm bench` 用 `channel: 'chrome'`）。

| 项 | 结果 | 判定 |
|---|---|---|
| 1 首启体积 | 默认档 q4f16 = **131.8 MB**；不指定 dtype = **753.7 MB**；冷启 67 s（0.45 MB/s 链路），缓存命中 1.1 s | 计划 §7.2 的 125.8 / 606 MB 是**另一个模型**的数字，须修正 |
| 2 单张向量化 | embed **154 ms**（真实语料、双塔）/ 72 ms（显式单塔）；decode 47 ms | 154 ms 略高于 150 ms 门线 |
| 3 HEIC | `createImageBitmap` 解不开真实 HEIF/HEVC | 定稿：**明确排除 + 界面告知**；libheif wasm 列 M1 待评估 |
| 4 端到端吞吐 | 783 张真实 CC0 原图（1.71 GB）→ **13.6 photos/s，1 万张外推 12.3 分钟** | **过验收线（≤20 分钟），未过冲刺线（≤10 分钟）** |
| 5 多标签页 | 无选主第二标签页硬失败 `NoModificationAllowedError`；Web Locks 选主后优雅退化 | §7.3 方案验证有效，**必须做** |
| 附加·检索延迟 | 文本向量化 70.8 ms + 1 万条 × 512 维暴力余弦 7.3 ms = **78.1 ms** | 预算 300 ms，通过 |

分阶段中位：read 4 / hash 1 / **decode 47** / **embed 154** / thumb 2 ms → 瓶颈在 embed（约 70%）。

**最重要的一条**：`Xenova/chinese-clip-vit-base-patch16` 是**单文件双塔**，ORT 会计算全部输出，
每次图像 embedding 都白算文本塔（合成语料上 embed 176 → 72 ms，占 59%）。三条出路见计划讨论与 §9。

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

## 9. 下一步

### A. M0 收口（都不阻塞结论）
1. `pnpm bench -- --headed` 复测一次，确认 headless 数字不偏乐观；
2. **检索质量**（中文 query 命中率）——M0 完全没测，却是默认模型选型的**真正裁判**；
3. 拆塔方案 C 的 spike：直接用 `onnxruntime-web` 只 fetch 需要的输出，验证 ORT 是否真能剪掉另一塔；
4. `files` 模式（`<input webkitdirectory>`）在持久化 profile 下静默失败的根因——M1 的 Playwright 端到端若要复用，必须先弄清。

### B. M1 第一个决策：怎么拆掉双塔白算

| 方案 | 收益 | 代价 |
|---|---|---|
| A 英文库用单塔类（**已实现并实测**） | 立即拿到单塔速度（embed 72 ms） | 中文文本检索质量丢失，违背默认模型选型初衷 |
| B 维持双塔（当前默认） | 零改动、中文质量最好 | 12.3 分钟（过验收线、未过冲刺线）；每次查询也白算视觉塔 |
| C 拆塔导出（optimum）或直接用 ort 只 fetch 需要的输出 | 中文质量 + 单塔速度 | 要自己写预处理/会话管理，正是计划 §十 标记的 5 天上限路径 |

**不要只比速度就选**：先测检索质量（§A2），否则会选错模型。

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
