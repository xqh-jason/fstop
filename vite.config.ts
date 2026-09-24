import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // 覆盖范围与硬约束一致（交接说明 §5 第 3 条写的是「`src/core/` 单测覆盖 ≥ 80%」）。
      // 额外纳入两个**纯逻辑**的 storage 模块——它们不依赖浏览器 API，能在 node 里真跑：
      //   - `models.ts`：模型目录 / 下载量 / 运行时装配（含「wasm 不能来自 CDN」这条断言）
      //   - `migrations.ts`：迁移链与版本校验
      // 其余 storage 模块（`db.worker` / `opfs` / `photo-source-opfs` / `vector-matrix`）依赖 OPFS
      // 与 sqlite-wasm，node 环境里连 import 都过不去。把它们算进阈值只会让门禁**长期假红**
      // （实测：纳入后全局 57%，门禁形同虚设）；它们由基准层覆盖——`pnpm bench` 跑的是真实
      // 索引流水线（解码 → 嵌入 → 缩略图 → OPFS 矩阵 → SQLite）。
      include: ['src/core/**', 'src/storage/models.ts', 'src/storage/migrations.ts'],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 80 },
    },
  },
})
