const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const vue = require('eslint-plugin-vue');
const vueParser = require('vue-eslint-parser');
const babelParser = require('@babel/eslint-parser');

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

  // --- Frontend block (Story 1.1 / BMAD-352) ---
  // Wire eslint-plugin-vue's `flat/essential` preset, scoped strictly to
  // src-frontend/ so Vue rules never match backend files (AD-1/AD-4). The
  // preset is applied verbatim (no rule downgrade/disable) to keep the first
  // lint baseline honest (AD-5). `flat/essential` mirrors the repo's legacy
  // `plugin:vue/essential` (OQ-1 default).
  ...vue.configs['flat/essential'].map((cfg) => ({
    ...cfg,
    files: ['src-frontend/**/*.{js,vue}'],
  })),
  {
    // Parser wiring only (necessary to lint the frontend at all — not to hide
    // findings): parse .vue via vue-eslint-parser and hand the inner <script>
    // to @babel/eslint-parser. The root babel.config.js references the
    // uninstalled @vue/cli-plugin-babel/preset, so requireConfigFile:false +
    // inline babelOptions bypass it (AD-4; babel.config.js stays out of scope).
    files: ['src-frontend/**/*.{js,vue}'],
    languageOptions: {
      parser: vueParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        parser: babelParser,
        requireConfigFile: false,
        babelOptions: {
          babelrc: false,
          configFile: false,
          presets: [],
        },
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
  },
];
