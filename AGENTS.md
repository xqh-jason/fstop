# Fstop · 光圈 — 给自动化协作者（agent）的常驻规范

> 这份文件是**长期有效的工作协议**，不是某一次任务的工单。具体任务写在会话里，
> 别把工单内容留在这里（上一版就是一份已完成的排障工单，过期后只会误导人）。

## 这个项目是什么

跑在桌面 Chromium 标签页里的**本地照片语义检索层**：File System Access 拿文件句柄（不复制照片）、
WebGPU 跑 CLIP 家族模型、索引落在浏览器自己的存储（OPFS 扁平 Float32 矩阵 + SQLite）。
没有服务端、没有账号、没有 CUDA、没有 Docker。卖点是**零安装、零拷贝、核心可读**，不是速度。

## 状态（会过期 —— 改完活在同一个提交里更新这一行）

M1 / M2 / M3 已收口；本地提交攒着，**不推 origin**。当前进度与暂停点见
`docs/Fstop-光圈-交接说明.md` §0，实测数字见 `docs/Fstop-光圈-M0-实测记录.md`。

## 门禁（唯一验收标准，没有第二个）

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"   # 默认 node 是 v18，项目要 ≥22.22
cd <repo>
pnpm format && pnpm verify        # 单测 + typecheck + lint + 静态零外发断言
```

改了 UI 或关键路径，再补对应的端到端（各自起浏览器与服务器，并断言运行时除模型 origin 外零外发）：

```bash
node bench/e2e-app.mjs      # 扫描 → 索引 → 检索 → 增量复扫 → 离线面板
node bench/e2e-wall.mjs     # 万张照片墙虚拟滚动
node bench/e2e-tabs.mjs     # 第二标签页退化成只读
node bench/e2e-similar.mjs  # 相似/重复图分组
node bench/e2e-faces.mjs    # 人脸检测 → 聚类 → 命名/合并/拆分 + 面板渲染
pnpm build && node bench/e2e-samples.mjs   # 构建产物静态托管 + 内置样例
```

**UI 改动必须带像素级断言**（元素存在 + 尺寸符合算式 + 可见窗口对准目标中心 + 裁切区像素有内容）。
只有数据断言时会出现「断言全绿、用户看到白图」——这个坑已经踩过一次。

## 红线（踩了就回滚重做）

1. `src/core/` 手写、逐行可解释；不允许把 `src/core/` 交给工具生成。
2. **每一次外发都要申报**：白名单只有模型权重下载（`src/storage/models.ts`）。
   禁止遥测、分析、错误上报、第三方脚本；禁止把 ORT wasm 之类指到 CDN。
3. 派生的模型权重（`bench/export-towers.py --deploy` 产物）**只本地生成、不分发**，
   落在 gitignore 的 `public/models/derived/`；上传等于再分发。
4. **同一语义不允许两份实现**（扩展名表、query 匹配、预处理、HTTP 取图都曾各存两份并悄悄分叉）。
5. 不跨模型归因：成本与质量的对照必须在同一模型内做单变量。
6. 不并发开 `opfs-sahpool`；`mtime + size` 不算身份。
7. 夹具错了先修夹具，不要改算法迎合夹具。
8. 临时诊断打点收尾时全部摘除；不留残留进程（重跑前 `pkill -f "user-data-dir=.*bench-profile"`）。

## 提交纪律

- 一个逻辑改动一个提交；信息写「为什么」，用中文 `feat(scope): …` / `fix(scope): …`。
- 提交要带验证结果（单测数、端到端输出、基准数字）。
- 用 `git -c commit.gpgsign=false`；`main` 受保护，功能走 `feature/*`；**不推 origin**。
- 里程碑收口打 tag + 写变更说明（模板见 `docs/Fstop-光圈-发布材料.md` §五）。
- 发布物用 `pnpm build && pnpm release:package` 生成：**产物里不许出现任何 `.onnx`**
  （`public/models/derived/` 是派生权重，上游未授权再分发，脚本发现权重会失败），
  并且要用 `E2E_DIST=<发布物目录> node bench/e2e-samples.mjs` 验证**发布物本身**。

## 文档归属（谁是权威）

| 文件                                       | 定位                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `docs/Fstop-光圈-项目计划-v0.2.md`         | 设计源头：范围、技术选型、里程碑、指标、DoD                                  |
| `docs/Fstop-光圈-交接说明.md`              | 接手第一份：§0 状态、环境事实、已知坑、下一步                                |
| `docs/Fstop-光圈-M0-实测记录.md`           | 所有实测数字与结论（M0 §1–§9，M1/M2 §9.10–§9.18，M3 与 UI 修复 §9.19–§9.21） |
| `docs/Fstop-光圈-技术说明.md`              | 对外讲清「怎么做到不装不搬不上传」                                           |
| `docs/Fstop-光圈-发布材料.md`              | 发布时直接取用：口径、帖子草稿、检查清单、版本说明                           |
| `README.md` / `CONTRIBUTING.md` / `NOTICE` | 对外第一屏、贡献规则、模型许可与出处                                         |

**改代码的同一批里同步文档**：数字变了就把引用它的文档一起改（README 的 Status、技术说明的 §3/§4
都引用实测记录，别让它们漂移）。
