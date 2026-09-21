import { describe, it, expect } from 'vitest';

// 回归测试：/user/thread/list 必须按 key_id 过滤（跨 key 隔离）。
// 缺陷：ThreadController.list 未注入 options.key_id = ctx.user.id，
// 导致 service.list 以 WHERE 1=1 全表返回，A key 能看到 B key 的 thread。
// 对照基准：src/controller/user/SessionController.ts:18-24（list 里 options.key_id = ctx.user.id）。
//
// 本测试走真实的 ThreadController -> service/thread.list -> db 路径，
// 只把 db 换成忠实复刻 WHERE 过滤的内存假实现，因此对 key_id 注入敏感：
// 去掉 ThreadController.list 里的 options.key_id 一行，反向断言必红。

import buildController from '../src/controller/user/ThreadController';

// 同一用户持有的两把 key（认证后即 ctx.user）：A=101、B=102，各 2 条 thread。
const KEY_A = 101;
const KEY_B = 102;
const ROWS = [
  { id: 1, key_id: KEY_A, prompt: 'a1', completion: '', session_id: 's1', tokens_in: 0, tokens_out: 0, fee: 0 },
  { id: 2, key_id: KEY_A, prompt: 'a2', completion: '', session_id: 's1', tokens_in: 0, tokens_out: 0, fee: 0 },
  { id: 3, key_id: KEY_B, prompt: 'b1', completion: '', session_id: 's2', tokens_in: 0, tokens_out: 0, fee: 0 },
  { id: 4, key_id: KEY_B, prompt: 'b2', completion: '', session_id: 's2', tokens_in: 0, tokens_out: 0, fee: 0 },
];

// 按 service/thread.list 生成的 where/params 过滤：只解释等值条件 `col = $N`。
function applyWhere(rows: any[], where: string, params: any[]) {
  const eq = [...where.matchAll(/(\w+)\s*=\s*\$(\d+)/g)];
  return rows.filter((row) =>
    eq.every(([, col, idx]) => String(row[col]) === String(params[Number(idx) - 1]))
  );
}

function fakeDb() {
  return {
    list: async (_table: string, conditions: any) => {
      const filtered = applyWhere(ROWS, conditions.where, conditions.params);
      return filtered.slice(conditions.offset, conditions.offset + conditions.limit);
    },
    count: async (_table: string, conditions: any) =>
      applyWhere(ROWS, conditions.where, conditions.params).length,
  };
}

// 用假 router 实例化控制器（routers() 只登记路由，不产生副作用）。
const controller = buildController({ get() {} }) as any;

async function listAs(keyId: number) {
  const ctx: any = { user: { id: keyId }, query: {}, db: fakeDb(), body: undefined };
  await controller.list(ctx);
  return ctx.body.data as { items: any[]; total: number };
}

describe('/user/thread/list 跨 key 隔离', () => {
  it('A key 能看到自己的 thread（正向）', async () => {
    const res = await listAs(KEY_A);
    const ids = res.items.map((t) => t.id).sort();
    expect(ids).toEqual([1, 2]);
    expect(res.total).toBe(2);
  });

  it('A key 看不到 B key 的 thread（反向，核心断言）', async () => {
    const res = await listAs(KEY_A);
    const ownerKeys = res.items.map((t) => t.id);
    // B 的 thread（3、4）绝不能出现
    expect(ownerKeys).not.toContain(3);
    expect(ownerKeys).not.toContain(4);
    expect(res.total).toBe(2);
  });

  it('B key 只看到自己的 thread（对称验证）', async () => {
    const res = await listAs(KEY_B);
    const ids = res.items.map((t) => t.id).sort();
    expect(ids).toEqual([3, 4]);
    expect(res.total).toBe(2);
  });
});
