import { describe, it, expect } from 'vitest';

import makeThreadController from '../src/controller/user/ThreadController';

// —— 内存表：同一用户的两把 key，各自有一条 thread ——
// key_id=100 属于 A key，key_id=200 属于 B key。
const ROWS = [
  { id: 1, key_id: 100, prompt: 'A-secret', completion: '', session_id: 's1', tokens_in: 0, tokens_out: 0, fee: 0 },
  { id: 2, key_id: 200, prompt: 'B-secret', completion: '', session_id: 's2', tokens_in: 0, tokens_out: 0, fee: 0 },
];

// 忠实还原 service.list 生成的 SQL 语义：where 里带 `key_id = $N` 才按 key 过滤，
// 不带就是 `1=1`（全表）。以此暴露「controller 未注入 key_id → 跨 key 泄露」。
function applyWhere(conditions: any) {
  const where: string = conditions.where || '1=1';
  const params: any[] = conditions.params || [];
  let rows = ROWS.slice();
  const km = where.match(/key_id = \$(\d+)/);
  if (km) {
    const kid = params[parseInt(km[1], 10) - 1];
    rows = rows.filter((r) => String(r.key_id) === String(kid));
  }
  const sm = where.match(/session_id = \$(\d+)/);
  if (sm) {
    const sid = params[parseInt(sm[1], 10) - 1];
    rows = rows.filter((r) => String(r.session_id) === String(sid));
  }
  return rows;
}

const db = {
  list: async (_table: string, conditions: any) => applyWhere(conditions),
  count: async (_table: string, conditions: any) => applyWhere(conditions).length,
};

// controller 的 list 是路由处理器；用 mock router 拿到实例后直接调 list(ctx)。
const controller: any = makeThreadController({ get: () => {} });

async function callList(userKeyId: number, query: Record<string, any>) {
  const ctx: any = { query, user: { id: userKeyId }, db };
  await controller.list(ctx);
  return ctx.body.data.items as Array<{ id: number; prompt: string }>;
}

describe('/user/thread/list 跨 key 隔离', () => {
  it('方向 A（正向可见）：A key 看得到自己的 thread', async () => {
    const items = await callList(100, {});
    const ids = items.map((i) => i.id);
    expect(ids).toContain(1); // 自己的 thread 必须可见
  });

  it('方向 B（跨 key 隔离，核心）：A key 看不到 B key 的 thread（省略 key_id）', async () => {
    const items = await callList(100, {});
    const ids = items.map((i) => i.id);
    expect(ids).not.toContain(2); // 不得泄露 B key 的 thread
    expect(ids).toEqual([1]); // 只应返回自己的
  });

  it('方向 B（IDOR）：A key 显式传 ?key_id=200 也读不到 B key 的 thread', async () => {
    const items = await callList(100, { key_id: 200 });
    const ids = items.map((i) => i.id);
    expect(ids).not.toContain(2); // 服务端身份必须覆盖客户端传入的 key_id
    expect(ids).toEqual([1]);
  });
});
