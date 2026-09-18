import { describe, it, expect } from 'vitest';

// 回归测试 BMAD-214：/user/thread/list 必须按 key_id 过滤，
// 否则同一 owner 用 A key 能列出 B key 的 thread（跨 key 泄漏）。
//
// 被测的判定逻辑 100% 是产品代码：这里导入**真实的** ThreadController 与
// **真实的** service/thread，只把 db 层换成内存 stub —— stub 逐条执行 service
// 真实生成的 where/params，语义与 Postgres 对 `1=1` / `key_id = $N` 一致。

import buildController from '../src/controller/user/ThreadController';
import service from '../src/service/thread';

type Row = { id: number; key_id: number; session_id?: number; prompt?: string; completion?: string };

// —— 内存 db stub：执行 service 生成的 where 字符串 + params 数组 ——
function rowMatches(row: Row, where: string, params: any[]): boolean {
  for (const raw of where.split(' and ')) {
    const clause = raw.trim();
    if (clause === '1=1') continue;
    let m: RegExpMatchArray | null;
    if ((m = clause.match(/^key_id = \$(\d+)$/))) {
      if (row.key_id != params[+m[1] - 1]) return false;
    } else if ((m = clause.match(/^session_id = \$(\d+)$/))) {
      if (row.session_id != params[+m[1] - 1]) return false;
    } else if (clause.startsWith('(prompt like')) {
      const idx = [...clause.matchAll(/\$(\d+)/g)].map((x) => +x[1])[0];
      const needle = String(params[idx - 1]).replace(/%/g, '');
      if (!((row.prompt || '').includes(needle) || (row.completion || '').includes(needle))) return false;
    } else {
      throw new Error(`unsupported where clause in stub: "${clause}"`);
    }
  }
  return true;
}

function makeDb(rows: Row[]) {
  const filter = (conditions: any) => rows.filter((r) => rowMatches(r, conditions.where, conditions.params));
  return {
    list: async (_table: string, conditions: any) => {
      const matched = filter(conditions);
      const start = ~~conditions.offset || 0;
      const end = start + (~~conditions.limit || 20);
      return matched.slice(start, end).map((r) => ({ id: r.id, prompt: r.prompt, session_id: r.session_id }));
    },
    count: async (_table: string, conditions: any) => filter(conditions).length,
  };
}

// —— 真实 controller：用捕获式 fake router 把 handler 抓出来 ——
function getListHandler() {
  const handlers: Record<string, (ctx: any) => any> = {};
  const fakeRouter: any = { get: (path: string, handler: (ctx: any) => any) => { handlers[path] = handler; } };
  buildController(fakeRouter);
  return handlers['/user/thread/list'];
}

// 同一 owner 两把 key：key 101 → thread {1,2}，key 102 → thread {3,4}
const SEED: Row[] = [
  { id: 1, key_id: 101, prompt: 'A-key first' },
  { id: 2, key_id: 101, prompt: 'A-key second' },
  { id: 3, key_id: 102, prompt: 'B-key SECRET prompt' },
  { id: 4, key_id: 102, prompt: 'B-key second' },
];

async function listAs(keyId: number) {
  const handler = getListHandler();
  const ctx: any = { query: {}, user: { id: keyId }, db: makeDb(SEED), body: undefined };
  await handler(ctx);
  const items = ctx.body.data.items as { id: number }[];
  return items.map((i) => i.id).sort((a, b) => a - b);
}

describe('/user/thread/list 按 key_id 过滤（跨 key 隔离，双向）', () => {
  it('A key(101) 只看到自己的 thread {1,2}', async () => {
    expect(await listAs(101)).toEqual([1, 2]);
  });

  it('A key(101) 看不到 B key(102) 的 thread {3,4}', async () => {
    const ids = await listAs(101);
    expect(ids).not.toContain(3);
    expect(ids).not.toContain(4);
  });

  it('B key(102) 只看到自己的 thread {3,4}', async () => {
    expect(await listAs(102)).toEqual([3, 4]);
  });

  it('B key(102) 看不到 A key(101) 的 thread {1,2}', async () => {
    const ids = await listAs(102);
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(2);
  });
});
