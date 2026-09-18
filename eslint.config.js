const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const pluginVue = require('eslint-plugin-vue');

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**', 'src/ui/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // TypeScript 编译器已负责这两类检查，core 规则在 TS 上会误报（类型引用、重载签名等），按标准做法关闭。
      'no-unused-vars': 'off',
      'no-undef': 'off',
    },
  },
  // 前端块：复用 eslint-plugin-vue 的 flat/recommended 预设（内部已挂好 vue-eslint-parser），
  // 并用 files 把作用域收敛到 src-frontend，避免预设默认的 **/*.vue 越界命中后端或其它目录。
  ...pluginVue.configs['flat/recommended'].map((c) => ({
    ...c,
    files: ['src-frontend/**/*.{vue,js}'],
  })),
];
