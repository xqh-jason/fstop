# Fstop · 光圈 —— 交接说明

> 给接手的人/agent。**先读这一份，再读计划与实测记录。** 最后更新：2026-09-25（M1 收口后）。

## 0. 一句话状态

工程骨架、`src/core/` 契约、M0 五项实测**已完成并提交**；M0 收口补测（质量 / files 根因 / 拆塔 spike /
成本口径 / 导出塔 / 有头复测）**全部完成**（2026-09-24）；**M1（MVP）核心已收口**（2026-09-25）——
「1 万张进 10 分钟」「产品路径索引吞吐」「缩略图墙万张虚拟滚动」「多标签选主」四项全部落地并实测，
`pnpm verify` 11 个测试文件 / 115 项全绿。剩下的 M1 边角只有索引侧预处理（**已决定不做**）
与人工精编 query（**卡在取材**），理由见 §9B 末段。

**产品路径吞吐的收口没有靠调优，而是靠定位一个死循环**：`writeBatch` 落库时先把任务标成 `done`，
随后的 `completeJob` 因严格守卫（只接受 `running/pending`）匹配不到行而抛错，外层 catch 又把任务
`failJob` 回 `pending`（attempts 卡在 1↔2，永不到重试上限）→ 同一批任务被无限重做。
端到端 12 张从 **900 s 超时未完** 降到 **1.5 s**。教训：CPU 在真干活、界面无报错、只是永不收尾的
「慢」，要优先怀疑**状态机闭环**，而不是事务次数（实测每张两次事务只占 0.45 ms/行）。

**M1 的第一个决策已经有答案，而且已经实测**：把视觉塔从原图重导出一份 **192²** 单塔
（位置编码插值 + 形状常量改写），接进 `embed.worker.ts` 的第三条路径（探测不到就回落原生双塔）。
同一轮 200 张真实语料的单变量对照：

| 嵌入路径 | photos/s | 1 万张外推 | embed 中位 | 文本查询 | 首启权重 |
|---|---|---|---|---|---|
| 原生单文件双塔 224² | 13.49 | 12.4 分钟 | 172 ms | 69 ms | 131.8 MB |
| **重导出单塔 192²** | **18.56** | **9.0 分钟** | **113 ms** | **28 ms** | **47.5 MB** |

质量损失在 783 张 / 106 条 query 上**测不出来**——而且是**产品路径上的对照**：
zh R@1 48.1% → 46.2%（只有原生命中 7 条、只有派生命中 5 条，**配对检验 p = 0.774**），
en 38.7% → 34.9%（9 vs 5，p = 0.424）。细节见实测记录 §9.5/§9.9/**§9.10** 与本文 §9B。

> ⚠ 修正记录：§9.6 曾据 39 张样例 / 23 条 query 判「160² 中文 R@1 仍 100%、免费」。
> 图库扩到 **783 张 / 106 条**后 160² 掉 **−9.4 pp（p = 0.021，显著）**，
> 于是目标分辨率改为 192²（208²/192²/176² 与 224² 分不出高下，160² 是第一个测得出退化的档）。
> **教训：小样本上的「100%」不能用来做决策。** 见实测记录 §9.9。
>
> ⚠ 另一条修正记录：§9.9 的 `≈9.7 分钟` 是**外推**，当时明确写了「不实测不算数」。
> §9.10 实测为 **9.0 分钟**，结论方向不变，但数字以外推为准会偏保守约 7%。

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
| `src/core/index-queue.ts` | ✅ M1 手写区 | **索引任务队列状态机**：无游标（`pending` 派生队列）、崩溃恢复、重试上限、`skipped` 终态；13 条单测 |
| `src/core/incremental-scan.ts` | ✅ M1 手写区 | **增量识别**：内容身份（`size` + 首尾 64 KB）、六种落点（新增/未变/重算/移动/恢复/删除）、三条安全规则（空扫描不毁库、移动要哈希唯一、同路径优先）；17 条单测 |
| `src/core/content-hash.ts` | ✅ M1 手写区 | `content_hash`：只读首尾各 64 KB（小文件只切一次），`crypto.subtle` 出 SHA-256；**不读整图** |
| `src/core/photo-files.ts` | ✅ M1 手写区 | 文件名规则：扩展名表（含 HEIC/HEIF/HIF/TIFF）、跳过目录、`/` 归一。**全项目只有这一份** |
| `src/core/scan-apply.ts` | ✅ M1 手写区 | 把扫描计划落成 SQL：插入/移动/恢复/重算/标记删除 + 任务重排；**整段一个事务**、**移动两步法**（防链式改名撞唯一约束）、内容变了只把任务打回 pending 不删向量槽位；12 条单测 |
| `src/storage/photo-source-fsa.ts` | ✅ M1 | `FileSystemAccessSource`：只持句柄不复制文件；递归遍历（带深度上限、单层失败只跳过该层）、`stat()` 顺带算内容哈希 |
| `src/storage/folder-access.ts` | ✅ M1 | 文件夹授权与权限持久化：句柄存 IndexedDB、启动查 `queryPermission`、`prompt` 时由用户手势触发 `requestPermission`；用窄接口 + 能力检测（不同 TS 版本的 `lib.dom` 时有时无） |
| `src/storage/vector-matrix.ts` | ✅ M1 | M0 只追加；M1 补：`open()` 按文件现有大小**接着写**（否则重开一次就覆盖已有向量，且不报错）、`writeAt()` 就地覆盖（重算写回同一槽位）、`snapshot()` 读出矩阵供检索、**`flush()` 按批提交**（不提交的写入只在 `.crswap` 里，检索读不到；见 §9.12）；10 条单测 |
| `tests/unit/vector-matrix.test.ts` | ✅ M1 | 用复刻 **crswap 语义**的假句柄钉住写入可见性：未 flush 不可见 / flush 后可见 / 重开不覆盖 / 尾部半截忽略 / 关闭后禁写（10 条） |
| `bench/matrix-probe.mjs` | ✅ 诊断 | 列出 OPFS 里向量文件的真实大小 + 跑一发检索看 `ranked`——§9.12 那个 bug 就是它抓的（保留，日后查「结果不对」先用它） |
| `src/app/index-runner.ts` | ✅ M1 | 编排：扫描 → 判断 → 落库 → 领批 → 逐条处理。读不到=重试、解不开=跳过，两类分开；缩略图用内容哈希命名 |
| `src/app/search.ts` | ✅ M1 | 文本塔编码 → 矩阵余弦 → top-K；每次查询重读矩阵，换来「索引期间可检索」。命中带 `takenAt`/`mtime`（时间重排用） |
| `src/core/result-order.ts` | ✅ M2 | 检索结果排序纯函数：相似度 / 时间（新→旧、旧→新）。时间优先 EXIF `taken_at`、缺了退回 `mtime`、两者都缺排最后并在界面标注「时间未知」（不塞假时间）；同时间用相似度做 tiebreaker。14 条单测 |
| `src/app/App.vue` | ✅ M1 | 产品外壳：选文件夹 / 建索引 / 进度 / 检索 + 照片墙入口与从页只读态。`?root=opfs` 走合成根，供端到端自动化 |
| `src/app/wall-layout.ts` | ✅ M1 | 照片墙窗口计算（纯函数）：列数/行数/撑高 + 可视行与 overscan；**万张级只渲染可视行**，9 条单测 |
| `src/app/thumbnail-cache.ts` | ✅ M1 | 缩略图 LRU（默认 300）+ **显式 `revokeObjectURL`**；同 key 并发只加载一次；7 条单测钉住淘汰顺序与 revoke |
| `src/ui/PhotoWall.vue` | ✅ M1 | 虚拟滚动照片墙：rAF 节流、`contain: strict`、退出时 `clear()` 释放全部 objectURL |
| `src/storage/tab-primary.ts` / `tab-primary-browser.ts` | ✅ M1 | 多标签选主：可注入的选主逻辑（4 条单测）+ `navigator.locks` 薄封装（长持锁靠回调挂起） |
| `bench/e2e-app.mjs` | ✅ M1 | 产品路径端到端（`node bench/e2e-app.mjs`）：播种 → 索引 → 三个查询 → 增量复扫 → **产品页零外发断言** |
| `bench/e2e-tabs.mjs` | ✅ M1 | 多标签端到端：从页只读提示 / 无索引按钮 / 关主页后自动接管 |
| `bench/e2e-wall.mjs` | ✅ M1 | 照片墙端到端：200 张只渲染 21 格、滚到底仍 17 格、缩略图走 `blob:` |
| `bench/index-probe.mjs` / `bench/trace-run.mjs` | ✅ M1 | 索引吞吐探针（端到端 + CPU 剖面 + 零外发）与逐阶段打点驱动器；**死循环根因就是它们抓出来的** |
| `src/storage/migrations.ts` | ✅ | 手写迁移链 + 事务化 `applyMigrations`（失败整体回滚） |
| `src/storage/models.ts` | ✅ | **全项目唯一允许联网的模块**；模型目录（含实测字节数、`towers` 字段）、运行时 env 配置 |
| `src/storage/opfs.ts` | ✅ | OPFS 基础操作 |
| `src/storage/photo-source-opfs.ts` | ✅ | `PhotoSource` 的 OPFS 实现（合成根） |
| `src/storage/vector-matrix.ts` | ✅ | 自实现扁平向量矩阵（顺序追加；槽位同步预留） |
| `src/storage/db.worker.ts` | ✅ | `opfs-sahpool` VFS + 迁移 + 批量入库（M0 级，无选主） |
| `src/workers/decode.ts` | ✅ | EXIF 摆正 + 降采样 + 缩略图 |
| `src/workers/embed.worker.ts` | ✅ | 单实例推理 Worker；**三条加载路径**：`derived`（重导出单塔，M1）/ 原生单文件双塔 / 原生分塔；回落原因不静默 |
| `src/workers/embed-derived.ts` | ✅ M1 | 派生单塔加载器：自建 ORT 会话（wasm 钉同源）、文本塔懒加载、动态 `import()` |
| `src/workers/embed-preprocess.ts` | ✅ M1 | `ImageBitmap` → NCHW 预处理；**产品 Worker 与基准页共用同一份** |
| `src/shared/env.ts` | ✅ | 能力探测（FSA / OPFS / WebGPU / persist） |
| `src/app`、`src/ui` | ✅ 壳 | 应用装配 + 能力面板；**检索 UI 未做** |
| `bench/` | ✅ M0 级 | 探针、基准页、检索延迟页、**检索质量页（§9A2 已完成）**、Playwright 驱动器、合成语料、HTTP 语料源 |
| `scripts/` | ✅ | 零外发检查、样例/权重/语料/HEIC 夹具脚本 |
| `tests/unit/` | ✅ 98 项 | 用 `node:sqlite` 跑**真实建表与约束**（不是正则断言 SQL 文本）；含派生塔探测与 CHW 预处理 |
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
| `30b93a4` | 同上收口（拆塔 spike 的文档与参数化补完） |
| `0b5f3fc` | **导出塔 spike 出数**：160² 重导出过冲刺线，D3 定案 fp16 快 13–16% 但体积 3.5×；顺带修 `fetch-models` 覆盖清单的缺陷（实测记录 §9.5–§9.8） |
| `33c4afc` | **783 张图库 / 106 条 query 复测**：推翻 160² 的「免费」结论（−9.4 pp，p=0.021），目标分辨率定为 **192²**；新增 `bench/corpus-queries.json` 与 `?queries=corpus`（实测记录 §9.9） |
| `5c06f6b` | **M1：派生单塔接进产品路径**——`derived` 路径 + 文本塔懒加载 + `--deploy` 部署闭环；实测 1 万张 **9.0 分钟**过冲刺线（12.4 → 9.0）；修掉 ORT wasm 从 jsdelivr 外发；落地运行时零外发断言（实测记录 §9.10） |

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
| 附加·导出塔 spike（2026-09-24） | 图手术切出单塔：视觉塔 **62 / 38 / 29 / 22 ms**（224²/160²/112²/64²），拟合 **17.5 ms + 0.2216 ms/token**；`image_embeds` 余弦 1.000000 | **图手术可行，分辨率锁解开**，见实测记录 §9.5 |
| 附加·大图库质量复测（2026-09-24） | **783 张 / 106 条** query：R@1 224² 48.1% → 208² 45.3%（p=.51）→ **192² 44.3%（p=.34）** → 176² 42.5%（p=.15）→ **160² 38.7%（p=.021，显著）** → 112² 24.5% | **160²「免费」被推翻，目标分辨率定为 192²**（≈9.7 分钟/1 万张），见实测记录 §9.9 |
| 附加·D3 dtype 对照（2026-09-24） | 同条件单变量：fp16 **快 13–16%**（160² 33 vs 38 ms）但体积 3.5×（164.5 vs 47.4 MB），质量同为 R@1 100% | **默认仍 q4f16**，fp16 记为可选加速档，见实测记录 §9.8 |
| 附加·有头复测（2026-09-24） | headless 13.09 photos/s vs **有头 14.49 photos/s**（同语料 200 张 / decode 3） | headless **不偏乐观**（保守约 10%），见实测记录 §9.7 |
| **M1·产品路径质量对照（2026-09-24）** | 同 harness 单变量、783 张 / 106 条：zh R@1 原生双塔 **48.1%** → 192² 单塔 **46.2%**（p = 0.774）；en 38.7% → 34.9%（p = 0.424）。口径可信度：这轮原生 224² 与 §9.9 的 224² 行**逐位重合** | **192² 的质量损失在产品路径上测不出显著**；§9.9 的 −3.7 pp 偏悲观，真实 −1.9 pp，见实测记录 §9.10 |
| **M1·派生单塔落地（2026-09-24）** | 接进产品路径后同条件单变量：原生双塔 13.49 → **派生单塔 18.56 photos/s**（1 万张 12.4 → **9.0 分钟**），embed 中位 172 → 113 ms，文本查询 69 → 28 ms，首启权重 131.8 → **47.5 MB** | **冲刺线（≤10 分钟）实测通过**；顺带修掉 ORT wasm 从 jsdelivr 外发的违规，见实测记录 §9.10 |

分阶段中位：read 4 / hash 1 / **decode 47** / **embed 154** / thumb 2 ms → 瓶颈在 embed（约 70%）。
（⚠ **embed 154 ms 是「排队 + 计算」**，单张真实计算 ≈ 68 ms，口径见实测记录 §9.4。）

**最重要的一条（2026-09-24 第三次改写）**：单张成本几乎全是**视觉塔**，而视觉塔的分辨率原本被导出**钉死**
在 224²/197 token —— 但那个锁是**三重常量**（位置编码 + 96 个 Reshape 常量 + `extract_model` 带出的
667 条 `value_info` 注解），**全部改写后同一份权重就能跑任意分辨率**。
实测：**重导出 192² 单塔接进产品路径后，1 万张 9.0 分钟（实测，非外推）**，质量损失在 783 张 / 106 条
query 上测不出来（p = 0.34）。**所以 M1 第一步不是优化流水线、也不是换骨干，而是「按 192² 重导出单塔」——
这一步已经做完了。** 见 §9B 与实测记录 §9.10。

## 5. 硬约束（违反即拒绝合并）

1. **`src/core/` 手写**：数据模型、索引状态机、任务队列、两个接口必须人设计、逐行可解释。
2. **任何新增网络请求必须显式声明**：`src/` 里除白名单 `src/storage/models.ts` 外不得出现
   `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `sendBeacon` / 远程 import；
   `pnpm check:egress` 是静态闸门，**`bench/runner.mjs` 的运行时请求日志断言是第二道闸**
   （非模型 origin 的外部 host → 非零码退出；计划 §11.4 已落地）。
3. **`src/core/` 单测覆盖 ≥ 80%**（`pnpm test:coverage` 阈值 80%，当前 96.5% 语句 / 87.9% 分支）。
   覆盖范围 = `src/core/**` + 三个能在 node 里真跑的 storage 模块（`models.ts` / `migrations.ts` / `photo-source-fsa.ts`）。
   **浏览器专属的 storage 模块（`db.worker` / `opfs` / `photo-source-opfs` / `vector-matrix`）不计入阈值**——
   它们依赖 OPFS 与 sqlite-wasm，node 里连 import 都过不去，算进去只会让门禁长期假红；
   它们由基准层覆盖（`pnpm bench` 跑真实索引流水线）。
4. **许可纪律**：代码 MIT；**权重不进仓库**（只给下载+校验脚本，`NOTICE` 记录来源与许可）；
   内置样例图**只收 CC0/公有领域**（带署名义务的一律不要），逐张记录见 `public/samples/manifest.json`。
   **派生产物（图手术切出的塔）同样按权重对待**：只本地生成、`public/models/derived/` 已 gitignore，
   且**不得上传到任何公开仓库**（源模型卡未声明 license，上传即再分发）。
5. **派生路径必须是可选的**：`embed.worker.ts` 探测不到派生产物时**必须回落原生双塔**，
   且回落原因要带出来（`derivedError`）。不能因为用户没跑过 Python 生成脚本就用不了。
6. **AI 政策**：接受 AI 辅助，但提交者必须能逐行解释；审查标准不降低（见 `CONTRIBUTING.md`）。
7. Conventional Commits；`main` 受保护、功能走 `feature/*`（当前若干提交直接落在本地 `main`，尚未推送）。

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
pnpm bench -- --derived 0                    # 关掉派生单塔（A/B 对照用）
pnpm bench -- --derived 192                  # 钉住档位（默认：探测到什么用什么）
pnpm bench -- --query                        # 检索延迟（§八 ≤300 ms）
pnpm bench -- --quality                      # 检索质量：中文 query 命中率（实测记录 §7）
pnpm bench -- --quality --model Xenova/clip-vit-base-patch32   # 对照：英文单塔
pnpm bench -- --towers                       # 拆塔 spike：ORT 指定输出是否剪枝（实测记录 §9）
pnpm bench -- --towers --device wasm         # 同一 spike 换 EP 对照
pnpm bench -- --decode 1                     # 解码并发（1 = 不排队，才看得到 embed 真实计算时间）
pnpm bench -- --headed                       # 有头模式（实测记录 §9.7）
# 基准结束时打印「运行时零外发」结论；出现非模型 origin 的外部 host 会以非零码退出

# 数据准备（都走代理时需要 NODE_USE_ENV_PROXY=1）
NODE_USE_ENV_PROXY=1 node scripts/fetch-models.mjs            # 权重 → .cache/models（不入库）
NODE_USE_ENV_PROXY=1 node scripts/fetch-corpus.mjs --count 800 # 真实语料 → bench/corpus（不入库）
NODE_USE_ENV_PROXY=1 node scripts/fetch-corpus.mjs --verify    # 校验语料 sha256
node scripts/fetch-samples.mjs --refresh                      # 内置 CC0 样例库（入库）
node scripts/make-heic-fixtures.mjs [含 .heic 的目录]          # HEIC 夹具（macOS 用 sips）

# 派生单塔（M1：让 1 万张进 10 分钟）——产物是权重，只本地生成、不入库
python3 bench/export-towers.py --sizes 192 --deploy 192       # 切塔 + 落到 public/models/derived/（gitignore）
python3 bench/export-towers.py --sizes 224 160 112 64         # 只要产物、不部署（质量/速度扫描用）
```

**跑基准前先预热一次依赖**：vite 发现新依赖（如 `onnxruntime-web`）会重新预打包并**整页重载**，
若正好发生在基准跑到一半，页面会空转（CPU 0.1%）直到超时。先 `pnpm dev` 起一次再关掉即可。

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
| 视觉塔位置编码写死 **197 token**（14×14+1），编码器里还有 **96 个写死 197 的 Reshape 常量** | 直接喂非 224² 的 `pixel_values` 会在 `/vision_model/embeddings/Add` 报 broadcast 错 | **可以解开**（实测记录 §9.5）：位置编码插值 + 形状常量改写 + 清空 `value_info` 注解，同一份权重就能跑任意 `(n²+1)` token。**别把它当成不可越过的约束** |
| HF 长连接经代理会 `ECONNRESET`（`Client network socket disconnected before secure TLS connection was established`） | 377 MB 的 fp16 直连下到一半就断；Node `fetch` 的 `withRetry` 是整段重来 | 用 `curl -L --retry 200 --retry-all-errors -C -` 断点续传（实测 3.9 MB/s 一次拉完）；短连接探测（`-r 0-1000000`）能通不代表长连接能通 |
| **同一模型的不同 dtype 导出，图结构可能不一样** | q4f16 把位置编码常量折叠成 `Gather_output_0` 大张量（Reshape 常量 96 个），fp16 保留 `Gather(weight, arange(197))`（Reshape 常量 0 个） | 图手术（改写常量）必须**逐档重新验证**：fp16 档漏改位置 id 会报 `Gather: indices element out of data bounds`（实测记录 §9.8） |

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
| **索引跑完但检索零命中**，界面写「库内 40 张、已落盘 0 张」 | 写句柄全程不 `close()`：OPFS 的写入在提交前只落在 `.crswap` 交换文件里，`handle.getFile()` 读到的还是**旧长度（新文件 0 字节）**。检索看不到新向量；且未提交的写入在刷新/关页时可能整体丢失（索引白跑） | 已修（实测记录 §9.12）：写入**按批提交**（`VectorMatrix.flush()` 关句柄 = 落盘，下次写入懒开 `keepExistingData`），`index-runner` 每批调一次；`snapshot()` 自己先 flush。10 条单测用**复刻 crswap 语义**的假句柄钉住 |
| 端到端偶发「0 张缩略图」/「外部 origin = 空」 | 两个脚本侧假红：① 缩略图是命中后懒生成的，固定等待会抓空；② `blob:` 请求的 `hostname` 是空串，被零外发断言当成外部 origin | 已修：缩略图改成轮询等待；零外发只统计 `http(s)`。**假红会掩盖真红，见到就修** |
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
| 改完图里的常量，ORT 仍报同一个 `Add` 不兼容 | `extract_model` 会把**源图的 `value_info` 形状注解**（667 / 1472 条）一起复制出来，注解里写死 197，形状推导拿它当真 | 已修（实测记录 §9.5）：`sanitize()` 先清空 `value_info` 再重新推导。**图手术后不清注解，等于没改** |
| `fetch-models.mjs` 分次运行会丢校验值 | 每次运行都**覆盖** `public/models/manifest.json`（`recorded` 是每次新建的数组） | 已修：与既有清单**合并**（按 model/dtype/file 去重）并写真实日期；NOTICE §5 要求该清单是校验值唯一真相源 |
| **ORT 的 wasm 运行时默认来自 jsdelivr CDN** | transformers.js 的 `initOrtEnv` 在 `wasmPaths` 未设置时把它指向 CDN（`transformers.js:13473`）；冷缓存首访真的会发一次 25.6 MB 的请求 | 已修（实测记录 §9.10）：`configureModelRuntime()` 钉到同源资源，缺失时**抛错而非静默跳过**。之所以长期没被发现：缓存热了走 Cache API，不产生网络请求，静态扫描也看不见 → 靠 `bench/runner.mjs` 的运行时断言守 |
| `InferenceSession.create` 报 `[webgpu] TypeError: …webgpuInit is not a function` | `onnxruntime-web/webgpu` 导出的是 **`.bundle.` 构建**（内嵌 glue），必须配 **asyncify** wasm 且**不能给 `mjs`**；给 jsep 或给 mjs 都会让它去加载不兼容的独立 glue | 已修（实测记录 §9.10）：`{ wasm: asyncify.wasm }`，与 transformers.js 一致 |
| `transferToImageBitmap` 抛 `InvalidStateError`，整轮基准卡在 `load:models` 直到一小时超时 | 没有 2d context 的 `OffscreenCanvas` 不能 transfer | 已修：预热假图前先 `getContext('2d')` + `fillRect` |
| 基准跑到一半页面空转（CPU 0.1%，无报错） | vite 发现**新依赖**（`onnxruntime-web`）要重新预打包 → 整页重载，基准状态丢失 | 已记入 §6：跑基准前先起一次 `pnpm dev` 预热 `node_modules/.vite/deps` |
| 质量页报「query 没有命中任何照片」而 exported 页同样数据正常 | **两份 match 匹配逻辑**：quality 页只做前缀匹配，而 corpus query 的 `match` 是**含扩展名的完整文件名**（精确匹配） | 已修：抽成 `bench/query-targets.ts` 一处实现，两页共用。**同一语义不允许有第二份实现** |
| 链式改名（a→b、b→c）在写库时撞 `UNIQUE(root_id, rel_path)` | 一次性把 `rel_path` 改成目标值，而目标值还被另一条记录占着 | 已修：移动分两步（先 `__moving__<id>` 再落目标），整段在一个事务里；两条记录互换路径同理 |
| 端到端基准跑的通路与用户真实通路**悄悄分叉** | `photo-source-opfs.ts` 自己有一份扩展名表、且 `list()` 不递归；FSA 实现又要写一份 → 两份迟早对不上，而表现是「某些照片静默不被索引」 | 已修：扩展名/跳过规则抽到 `core/photo-files.ts`；OPFS 来源**委托给 FSA 实现**（同一个 DOM 接口），并因此让基准语料有了真实内容哈希 |
| `pnpm test:coverage` **全局红**（57%），看起来像测试写得不够 | 阈值 `include` 写成了 `src/storage/**`，把浏览器专属模块（OPFS/sqlite-wasm）也算进去——它们 node 里 0%，于是门禁长期假红、没人当真 | 已修：范围收敛到 §5 约束写的那部分（`src/core/**` + `models.ts` + `migrations.ts`），并给 `models.ts` 补了纯函数测试；现在 97.3% / 86.7% |
| `curl 127.0.0.1:5199` 返回 000，但端口明明在监听 | Vite 默认只监听 `::1`，而 `127.0.0.1` 是 IPv4；Node 与 curl 各自的 `localhost` 解析策略还不一样 | 起服务时钉 `--host 127.0.0.1`（基准与端到端脚本都已加），或访问 `localhost` 而非 `127.0.0.1` |
| 同一浏览器第二个标签打开应用 → 界面显示「还没有可索引的文件夹」 | sqlite-wasm 的 `opfs-sahpool` VFS **每 origin 只允许一个实例**（§7.3 明文约束），第二个标签 `db.open()` 直接失败 | **已修**：Web Locks 选主（`storage/tab-primary*.ts`）。从页不建 db worker、只读并明确提示，主页关闭后自动接管 |
| 浏览器进程重启后 OPFS 里的语料全没了 | 自动化用的临时 profile 每次启动都是新的，OPFS 随之清空 | 端到端脚本用**持久 profile**（`.cache/bench-profile`）；表现上先看到「0 张可检索」而不是报错，容易误判成产品 bug |
| 页面 `await main()` 抛错时驱动器白等满一小时 | runner 只认「页面把异常渲染成 `phase === 'error'`」，**未捕获**异常不走那条路（实测踩到：停在 `load:samples`） | 已修：runner 与 `pageerror` 竞速，未捕获异常立即失败并打印原文 |

## 9. 下一步

### A. M0 收口（**全部完成**，2026-09-24）
1. ~~`pnpm bench -- --headed` 复测~~ → **已完成**：有头 14.49 vs headless 13.09 photos/s，
   **headless 不偏乐观**（实测记录 §9.7）；
2. ~~检索质量（中文 query 命中率）~~ → **已完成**：中文 R@1 **100%**，英文 CLIP 单塔中文只有 **13%** → 方案 A 出局（§7）；
3. ~~拆塔方案 C 的 spike~~ → **已完成**：ORT 的 WebGPU EP **不剪枝**（指定输出 59 vs 全输出 62 ms，
   输出键确实只剩 1 个），方案 C 的「运行时指定输出」路线出局（实测记录 §9.1）；
   顺带推翻两条旧结论：入库「白算另一塔」只有 0.5 ms（不是 104 ms）、`embed` 分阶段中位是排队时间（§9.2/§9.4）；
4. ~~`files` 模式静默失败的根因~~ → **已完成**：Chromium 逐项过滤软链（与 Playwright、profile 无关），
   探针 `node bench/files-probe.mjs`。给 M1：E2E 夹具一律复制/硬链接；索引页展示「选中数 vs 入库数」；
5. ~~视觉塔成本模型~~ → **已完成**：图手术切出单塔后拟合出 **固定开销 15.7 ms + 0.239 ms/token**，
   并给出分辨率↔成本↔质量三张表（实测记录 §9.5）。**结论见 §9B。**

### B. M1 第一个决策：怎么让 1 万张进 10 分钟（**已定案**）

| 方案 | 结论 |
|---|---|
| A 英文单塔库 | **出局**：中文 R@1 崩到 13% |
| B 维持 224² 双塔 | 12.3 分钟，**过验收线、过不了冲刺线**；作为保底仍在 |
| C 运行时指定输出拆塔 | **出局**：WebGPU EP 不剪枝；且「白算」本只有 0.5 ms，拆了也不提速 |
| D1 换更便宜的骨干（如 chinese-clip-rn50） | **不必要**：`Xenova/` 下没有现成 ONNX，要自己转换；D2 已经够到冲刺线 |
| **D2 重导出单塔视觉塔** | ✅ **采用，分辨率定 192²**：1 万张 ≈9.7 分钟（刚过冲刺线），R@1 −3.7 pp 但**统计上测不出**（p=0.34）；208² 过不了线（≈11.0 分钟），160² 已能测出 −9.4 pp（p=0.021）。首启 131.8 → 47.4 MB |
| D3 dtype 档位对照（q4f16 vs fp16） | **已完成**：同条件下 fp16 比 q4f16 **快 13–16%**（160²：33 vs 38 ms），质量同为 R@1 100%，
但体积 3.5×（164.5 vs 47.4 MB）→ **默认仍用 q4f16**，fp16 记为可选加速档（实测记录 §9.8） |
| D4 接受 11.5 分钟、降级冲刺线 | 不再需要 |

**M1 的 D2 落地清单（全部完成，2026-09-24）**：
1. ✅ `python3 bench/export-towers.py --sizes 192 --deploy 192` 生成视觉塔（47.5 MB）+ 文本塔（77.9 MB），
   校验值记入 `bench/export/manifest.json`，并落到 app 能发现的位置 `public/models/derived/`（**已 gitignore，不入库**）；
2. ✅ **派生产物只走本地生成**（已定）：源模型模型卡未声明 license，上传到 HF 等于再分发，与 NOTICE §1 冲突。
   生成脚本留在 `bench/`，用户机器上按需跑；**app 在派生产物缺失时回落原生双塔**（224²，12.4 分钟），
   回落原因写进 `EmbedInitResult.derivedError`（不静默）；
3. ✅ `src/workers/embed.worker.ts` 新增 `derived` 路径：视觉塔 + 文本塔两个独立 ORT 会话，
   文本塔**懒加载**（首次文本查询才下 77.9 MB，就绪 520 ms）；新增 `warmupText()` 与 `derivedBytes` 上报；
4. ✅ **已实测收口**：同条件单变量对照 13.49 → **18.56 photos/s**（1 万张 12.4 → **9.0 分钟**），
   `embed` 中位 172 → 113 ms，文本查询 69 → 28 ms，首启权重 131.8 → 47.5 MB（实测记录 §9.10）；
5. ⬜ 索引阶段的预处理仍走 512² 再缩到 192²；可直接让 decode 出 192²，省掉画布缩放；
6. ⬜ `bench/corpus-queries.json` 目前 106 条、来自 Commons 标题，可再补一批**人工精编**的 query
   （更像真实用户问法）交叉验证 192² 的结论。

**顺带修掉的一个真违规**：ORT 的 wasm 运行时原先由 transformers.js 默认指向 **jsdelivr CDN**，
冷缓存首访会外发一次 25.6 MB 的 wasm（证据：基准 profile 的 CacheStorage 里有该 URL 的条目）。
已在 `configureModelRuntime()` 钉到同源资源；`bench/runner.mjs` 新增**运行时零外发断言**
（非模型 origin 的 host 一律点名并非零码退出），计划 §11.4 的那条从人工勾选变成机器检查。

### C. M1 范围（按计划 §九）

| M1 项 | 状态 |
|---|---|
| 文件夹选择 + 权限持久化 | ✅ `folder-access.ts` + `App.vue` |
| `content_hash` + `deleted_at` 增量识别 | ✅ `core/incremental-scan.ts` + `core/scan-apply.ts` |
| 索引状态机 / 任务队列（`src/core/`） | ✅ `core/index-queue.ts`（无游标、崩溃恢复、重试上限） |
| 索引期间可检索 | ✅ `search.ts` 每次查询重读矩阵，`partial` 如实标注 |
| 缩略图墙（万张虚拟滚动） | ✅ `src/ui/PhotoWall.vue` + `app/wall-layout.ts`（纯窗口计算）+ `app/thumbnail-cache.ts`（LRU 300 + 显式 `revokeObjectURL`）。实测 200 张只渲染 **21** 个格子、滚到底 17 个（`bench/e2e-wall.mjs`） |
| **产品路径索引吞吐** | ✅ **已收口**：死循环（见下）+ 向量未落盘（见下）修完后，产品路径 200 张 **12.8 s = 15.6 张/秒**（1 万张外推 10.7 分钟；基准页 17.69 张/秒 / 9.4 分钟，余差 12% 已定位：产品路径每张多一次单条入库与缩略图写）。达成手段：**批内并发 3 + 只把 GPU 嵌入串起来**（`src/core/concurrency.ts`）。⚠ 反例记牢：直接把 `embedImage` 并发提交会让标签页**空转卡死**。修复前同参数 900 s 超时未完 |
| 多标签选主（Web Locks） | ✅ `storage/tab-primary.ts`（可注入的选主逻辑）+ `tab-primary-browser.ts`。从页只读并明确说明，主页释放后自动接管（`bench/e2e-tabs.mjs` 三断言）。坑：`request()` 的 `signal` 与 `ifAvailable` 不能同时传 |
| 运行时零外发断言 | ✅ 基准页 + 产品页（`bench/e2e-app.mjs`）；静态断言在 `.github/workflows/ci.yml` |

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
