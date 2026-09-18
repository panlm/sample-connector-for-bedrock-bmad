import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import ts from 'typescript';

import realService from '../src/service/thread';
import RealAbstractController from '../src/controller/AbstractController';

// 回归测试 BMAD-143 / case file BMAD-156：
// `/user/thread/list` 未按 key_id 过滤，跨 key 泄露会话。
//
// 本测试驱动**真实** ThreadController.list + **真实** service/thread.ts，只把 DB 换成
// 一个忠实复刻 src/util/postgres.ts where/params 语义的内存实现，从而在无 Postgres
// 的环境覆盖父 issue 验收标准：
//   1) 正向可见：A key 能看到自己的 thread；
//   2) 反向隔离：A key 看不到 B key 的 thread（核心断言，两个方向都断）；
//   3) 客户端可控 ?key_id= 越权面被赋值覆盖中和（case file Deduction 2）。
//
// 去掉 ThreadController.list 里注入 key_id 的那行，本测试即红。
//
// 为什么在测试里转译控制器而不是直接 import：ThreadController.ts 的 `routers` 方法用了
// `import("koa-router") <any, {}>` 这种 tsc 能过、但 vitest 的 esbuild 转换器解析不了的
// 类型注解（SessionController 同样如此）。修 that 注解属本卡范围外的顺手改动，故此处用
// TypeScript 官方转译器（其 parser 容忍该注解）加载真实控制器源码，并注入真实 service /
// AbstractController，保证「改前红改后绿」严格绑定 ThreadController.ts 里的根因修复。

// —— 用 tsc 转译真实 ThreadController 源码并执行，注入真实依赖 ——
function loadThreadController() {
  const file = resolve(__dirname, '../src/controller/user/ThreadController.ts');
  const source = readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: false,
    },
  }).outputText;

  const shimRequire = (id: string) => {
    if (id === '../../service/thread') return { default: realService };
    if (id === '../AbstractController') return { default: RealAbstractController };
    return require(id);
  };
  const moduleObj: any = { exports: {} };
  const factory = new Function('exports', 'require', 'module', '__dirname', '__filename', js);
  factory(moduleObj.exports, shimRequire, moduleObj, dirname(file), file);
  return moduleObj.exports.default as (router: any) => any;
}

// —— 内存 DB：复刻 postgres.ts list/count 的语义 ——
// service/thread.ts 产出形如 "1=1 and key_id = $1" 的 where + params 数组，
// 这里按同样口径求值：仅命中 where 里所有等值条件的行才返回。
type Row = { id: number; key_id: number; prompt: string; session_id?: number };

function makeDb(rows: Row[]) {
  const match = (row: Row, where: string, params: any[]) => {
    const eqRe = /and (\w+) = \$(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = eqRe.exec(where)) !== null) {
      const col = m[1] as keyof Row;
      const idx = ~~m[2] - 1;
      if (String(row[col]) !== String(params[idx])) return false;
    }
    return true;
  };
  return {
    list: async (_table: string, conditions: any) => {
      const where = conditions.where || '1=1';
      const params = conditions.params || [];
      return rows.filter((r) => match(r, where, params)).sort((a, b) => b.id - a.id);
    },
    count: async (_table: string, conditions: any) => {
      const where = conditions.where || '1=1';
      const params = conditions.params || [];
      return rows.filter((r) => match(r, where, params)).length;
    },
  };
}

// 同一用户持两把 key：A=101、B=102，各持一条 thread。
const THREADS: Row[] = [
  { id: 1, key_id: 101, prompt: 'A-secret' },
  { id: 2, key_id: 102, prompt: 'B-secret' },
];

const makeThreadController = loadThreadController();
const controller: any = makeThreadController({ get() {} });

async function listAs(userId: number, query: Record<string, any> = {}) {
  const ctx: any = { query, user: { id: userId }, db: makeDb(THREADS) };
  await controller.list(ctx);
  return ctx.body.data.items as Row[];
}

describe('/user/thread/list 按 key_id 隔离（回归 BMAD-143）', () => {
  it('A key（101）能看到自己的 thread —— 正向可见', async () => {
    const items = await listAs(101);
    expect(items.map((t) => t.id)).toContain(1);
    expect(items.some((t) => t.prompt === 'A-secret')).toBe(true);
  });

  it('A key（101）看不到 B key（102）的 thread —— 反向隔离', async () => {
    const items = await listAs(101);
    expect(items.map((t) => t.id)).not.toContain(2);
    expect(items.some((t) => t.prompt === 'B-secret')).toBe(false);
    expect(items.map((t) => t.id)).toEqual([1]);
  });

  it('B key（102）只看到自己的、看不到 A key（101）的 —— 另一方向同样隔离', async () => {
    const items = await listAs(102);
    expect(items.map((t) => t.id)).toEqual([2]);
    expect(items.some((t) => t.prompt === 'A-secret')).toBe(false);
  });

  it('客户端伪造 ?key_id=102 也拿不到 B 的 thread —— 赋值覆盖中和越权面', async () => {
    const items = await listAs(101, { key_id: 102 });
    expect(items.map((t) => t.id)).toEqual([1]);
    expect(items.some((t) => t.prompt === 'B-secret')).toBe(false);
  });
});
