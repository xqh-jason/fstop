import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/storage/**'],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 80 },
    },
  },
})
