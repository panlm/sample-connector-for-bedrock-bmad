import { describe, it, expect } from 'vitest';

// 回归测试：/user/thread/list 必须按 key_id 隔离（对齐 SessionController.list）。
// 缺陷根因在控制器层（ThreadController.list 未把 ctx.user.id 注入 options.key_id），
// 所以这里走完整链路：真实 ThreadController → 真实 thread service → fake db。
// fake db 忠实执行 service 生成的 where/$N 求值，这样过滤只要缺一环测试就会红。

import threadControllerFactory from '../src/controller/user/ThreadController';

// —— 忠实复刻 service 产出的 WHERE 求值（只支持 `col = $n` 等值子句 + `1=1`）——
// service 用位置参数 $1..$n 拼 where；这里按同样规则过滤内存行，等价于真实 SQL。
function applyWhere(rows: any[], conditions: any): any[] {
  const where: string = conditions?.where ?? '1=1';
  const params: any[] = conditions?.params ?? [];
  const clauses = where.split(/\s+and\s+/i).map((c) => c.trim()).filter(Boolean);
  return rows.filter((row) =>
    clauses.every((clause) => {
      if (clause === '1=1') return true;
      const m = clause.match(/^(\w+)\s*=\s*\$(\d+)$/);
      if (!m) {
        throw new Error('fake db 未支持的 where 子句: ' + clause);
      }
      const col = m[1];
      const val = params[Number(m[2]) - 1];
      return String(row[col]) === String(val);
    })
  );
}

function makeDb(threads: any[]) {
  return {
    list: async (_table: string, conditions: any) => {
      const filtered = applyWhere(threads, conditions);
      const offset = ~~conditions.offset || 0;
      const limit = ~~conditions.limit || 20;
      return filtered.slice(offset, offset + limit);
    },
    count: async (_table: string, conditions: any) => applyWhere(threads, conditions).length,
  };
}

// 通过 fake router 捕获生产环境注册的那个 list handler（与真实注册路径一致）。
function getListHandler(): (ctx: any) => Promise<any> {
  let handler: any;
  const fakeRouter: any = {
    get: (path: string, fn: any) => {
      if (path === '/user/thread/list') handler = fn;
    },
  };
  threadControllerFactory(fakeRouter);
  if (!handler) throw new Error('未捕获到 /user/thread/list 的 handler');
  return handler;
}

// 同一用户持有的两把 key：A=100、B=200，各自都有一条 thread。
function seedThreads() {
  return [
    { id: 1, key_id: 100, session_id: 's-a', prompt: 'a', completion: 'ca', tokens_in: 1, tokens_out: 1, fee: 0 },
    { id: 2, key_id: 200, session_id: 's-b', prompt: 'b', completion: 'cb', tokens_in: 1, tokens_out: 1, fee: 0 },
  ];
}

async function listAs(keyId: number) {
  const handler = getListHandler();
  const ctx: any = { query: {}, user: { id: keyId }, db: makeDb(seedThreads()) };
  await handler(ctx);
  return ctx.body?.data;
}

describe('/user/thread/list 跨 key 隔离', () => {
  it('A key(100) 能看到自己的 thread(id=1)', async () => {
    const data = await listAs(100);
    const ids = data.items.map((t: any) => t.id);
    expect(ids).toContain(1);
  });

  it('A key(100) 看不到 B key(200) 的 thread(id=2)', async () => {
    const data = await listAs(100);
    const ids = data.items.map((t: any) => t.id);
    expect(ids).not.toContain(2);
    expect(ids).toEqual([1]);
    expect(data.total).toBe(1);
  });

  it('B key(200) 能看到自己的 thread(id=2)', async () => {
    const data = await listAs(200);
    const ids = data.items.map((t: any) => t.id);
    expect(ids).toContain(2);
  });

  it('B key(200) 看不到 A key(100) 的 thread(id=1)', async () => {
    const data = await listAs(200);
    const ids = data.items.map((t: any) => t.id);
    expect(ids).not.toContain(1);
    expect(ids).toEqual([2]);
    expect(data.total).toBe(1);
  });

  it('客户端伪造 ?key_id= 也不能越权：服务端以 ctx.user.id 覆盖', async () => {
    // A key(100) 试图传 key_id=200 去看 B 的 thread，必须被服务端身份覆盖挡住。
    const handler = getListHandler();
    const ctx: any = { query: { key_id: 200 }, user: { id: 100 }, db: makeDb(seedThreads()) };
    await handler(ctx);
    const ids = ctx.body.data.items.map((t: any) => t.id);
    expect(ids).toEqual([1]);
  });
});
