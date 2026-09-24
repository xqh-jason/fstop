import pluginVue from 'eslint-plugin-vue'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'

export default defineConfigWithVueTs(
  {
    name: 'fstop/ignores',
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'docs/**', '*.tsbuildinfo'],
  },
  pluginVue.configs['flat/recommended'],
  vueTsConfigs.recommended,
  {
    name: 'fstop/rules',
    rules: {
      // 网络访问的唯一约束点是 scripts/check-egress.mjs（见 docs 项目计划 §11.4），
      // 这里不重复声明同类规则。
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  skipFormatting,
  {
    name: 'fstop/scripts',
    files: ['scripts/**/*.mjs', 'bench/**/*.mjs'],
    // 命令行脚本的输出就是它的产物
    rules: { 'no-console': 'off' },
  },
)
