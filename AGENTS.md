# Fstop · 光圈 — 当前任务规范

## 背景
产品路径索引吞吐异常：基准 18.56 photos/s（54 ms/张），产品页 40 张 6 分钟未跑完。
临时探针 bench/index-probe.mjs 端到端复现（12 张 14 分钟未完，正常 ≤1 分钟）。
db 模式已排除「每张两次事务」（writeBatch 0.45 ms/行、completeJob ≈0 ms）。

## 任务
1. 读 bench/index-probe.mjs 与 src/app/App.vue 的索引编排（领批 → 逐条 decode → embed → 写库/缩略图/向量）。
2. 找慢因，按可能性：解码并发丢失（基准 decode=3）/ 等待链串行化 / 向量+OPFS 无背压互相等。
3. 修复：保持 src/core/ 接口不动、不引入新网络访问、遵守 docs/Fstop-光圈-交接说明.md §10 红线（不跨模型归因、不并发开 opfs-sahpool、mtime+size 不算身份）。
4. 验收（必须全过再移交）：
   - `pnpm verify`（唯一门禁：单测 + lint + typecheck + 零外发断言）
   - `PROBE_PHOTOS=12 node bench/index-probe.mjs` 端到端 ≤ 90 s（重置默认开），报出 ms/张
5. 硬规则：提交信息 `fix(scope): 中文描述`，`git -c commit.gpgsign=false`；不推 origin；不动 docs/ 下两份交接文档；成品单步可复现。

## 分工
omp 负责改码与调试；Hermes 负责验收与出入成文。
