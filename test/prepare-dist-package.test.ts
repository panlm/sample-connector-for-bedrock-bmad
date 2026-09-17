import { describe, it, expect } from 'vitest';

// 被测：build-only 脚本导出的纯裁剪函数。裁剪逻辑决定了写进 dist/ 的 package.json，
// 是本次缺陷（devDependencies 被带进镜像→npm ERESOLVE）的根因所在。
import { makeRuntimePackage } from '../scripts/prepare-dist-package.mjs';

describe('makeRuntimePackage', () => {
  it('有 devDependencies 的输入 → 输出不含 devDependencies', () => {
    const out = makeRuntimePackage({
      name: 'x',
      version: '1.0.0',
      dependencies: { koa: '^2.0.0' },
      devDependencies: { vite: '^6.3.3', 'vue-router': '^5.0.2' },
    });
    expect(out.devDependencies).toBeUndefined();
  });

  it('dependencies 原样逐 key 逐值保留', () => {
    const deps = { koa: '^2.16.3', pg: '^8.18.0', sharp: '0.34.5' };
    const out = makeRuntimePackage({
      name: 'x',
      version: '1.0.0',
      dependencies: deps,
      devDependencies: { vite: '^6.3.3' },
    });
    expect(out.dependencies).toEqual(deps);
  });

  it('version 始终保留（dist/server/index.js 运行时 require("../package.json").version 需要）', () => {
    const out = makeRuntimePackage({ name: 'x', version: '0.0.41', dependencies: {} });
    expect(out.version).toBe('0.0.41');
  });

  it('丢弃 scripts / packageManager / pnpm / devDependencies 等非运行时字段', () => {
    const out = makeRuntimePackage({
      name: 'x',
      version: '1.0.0',
      dependencies: {},
      scripts: { build: 'tsc' },
      packageManager: 'pnpm@10.34.5',
      pnpm: { onlyBuiltDependencies: ['sharp'] },
      devDependencies: { vite: '^6.3.3' },
    });
    expect(out.scripts).toBeUndefined();
    expect(out.packageManager).toBeUndefined();
    expect(out.pnpm).toBeUndefined();
    expect(out.devDependencies).toBeUndefined();
  });

  it('缺 license / main 的输入不崩，且不产生 undefined 键', () => {
    const out = makeRuntimePackage({ name: 'x', version: '1.0.0', dependencies: {} });
    expect(() => JSON.stringify(out)).not.toThrow();
    expect('license' in out).toBe(false);
    expect('main' in out).toBe(false);
  });

  it('保留白名单内出现的 main / license', () => {
    const out = makeRuntimePackage({
      name: 'x',
      version: '1.0.0',
      main: 'index.js',
      license: 'MIT',
      dependencies: {},
    });
    expect(out.main).toBe('index.js');
    expect(out.license).toBe('MIT');
  });
});
