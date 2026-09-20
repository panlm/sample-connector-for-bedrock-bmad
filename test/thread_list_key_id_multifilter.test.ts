import { describe, it, expect } from 'vitest';

// 补充回归（bmad-testarch-automate 扩覆盖）：
// 核心 key_id 隔离在「与其它过滤条件（session_id / q）共存」时仍必须成立。
// 动机：service 层 (src/service/thread.ts) 用位置参数 $1..$n 依 keys 顺序拼 where，
// 多过滤共存时占位符编号偏移是已知脆弱点（stage 2 open_question #2）。
// 这里穿透 真实 ThreadController → 真实 thread service → fake db，
// 忠实复刻 `col = $n` / `like $n` / `1=1` 的 WHERE 求值。

import threadControllerFactory from '../src/controller/user/ThreadController';

function applyWhere(rows: any[], conditions: any): any[] {
  const where: string = conditions?.where ?? '1=1';
  const params: any[] = conditions?.params ?? [];
  const clauses = where.split(/\s+and\s+/i).map((c) => c.trim()).filter(Boolean);
  return rows.filter((row) =>
    clauses.every((clause) => {
      if (clause === '1=1') return true;
      const eq = clause.match(/^(\w+)\s*=\s*\$(\d+)$/);
      if (eq) {
        return String(row[eq[1]]) === String(params[Number(eq[2]) - 1]);
      }
      // (prompt like $n or completion like  $n)
      const like = clause.match(/^\((\w+)\s+like\s+\$(\d+)\s+or\s+(\w+)\s+like\s+\$(\d+)\)$/i);
      if (like) {
        const raw = String(params[Number(like[2]) - 1] ?? '');
        const needle = raw.replace(/%/g, '');
        return String(row[like[1]] ?? '').includes(needle) || String(row[like[3]] ?? '').includes(needle);
      }
      throw new Error('fake db 未支持的 where 子句: ' + clause);
    })
  );
}

function makeDb(threads: any[]) {
  return {
    list: async (_t: string, c: any) => {
      const filtered = applyWhere(threads, c);
      const offset = ~~c.offset || 0;
      const limit = ~~c.limit || 20;
      return filtered.slice(offset, offset + limit);
    },
    count: async (_t: string, c: any) => applyWhere(threads, c).length,
  };
}

function getListHandler(): (ctx: any) => Promise<any> {
  let handler: any;
  const fakeRouter: any = { get: (p: string, fn: any) => { if (p === '/user/thread/list') handler = fn; } };
  threadControllerFactory(fakeRouter);
  if (!handler) throw new Error('未捕获到 /user/thread/list 的 handler');
  return handler;
}

// A=100 有两条 thread（含关键字 hello），B=200 有一条也含 hello。
function seed() {
  return [
    { id: 1, key_id: 100, session_id: 's-a', prompt: 'hello from a', completion: '', tokens_in: 1, tokens_out: 1, fee: 0 },
    { id: 3, key_id: 100, session_id: 's-a', prompt: 'another a', completion: '', tokens_in: 1, tokens_out: 1, fee: 0 },
    { id: 2, key_id: 200, session_id: 's-b', prompt: 'hello from b', completion: '', tokens_in: 1, tokens_out: 1, fee: 0 },
  ];
}

async function listAs(keyId: number, query: any = {}) {
  const handler = getListHandler();
  const ctx: any = { query: { ...query }, user: { id: keyId }, db: makeDb(seed()) };
  await handler(ctx);
  return ctx.body.data;
}

describe('/user/thread/list key_id 隔离 — 多过滤共存 & 多行/空结果', () => {
  it('A key 多条 thread 时只看到自己的全部（不含 B）', async () => {
    const ids = (await listAs(100)).items.map((t: any) => t.id).sort();
    expect(ids).toEqual([1, 3]);
    expect((await listAs(100)).total).toBe(2);
  });

  it('q 过滤共存时 key_id 仍隔离：A key 搜 "hello" 看不到 B 的同名 thread(id=2)', async () => {
    const data = await listAs(100, { q: 'hello' });
    const ids = data.items.map((t: any) => t.id);
    expect(ids).toContain(1);
    expect(ids).not.toContain(2);   // B 的 hello thread 必须被 key_id 挡住
  });

  it('session_id 过滤共存时 key_id 仍隔离：伪造 B 的 session_id 也拿不到 B 的 thread', async () => {
    const data = await listAs(100, { session_id: 's-b' }); // A 试图用 B 的 session
    const ids = data.items.map((t: any) => t.id);
    expect(ids).not.toContain(2);
    expect(ids).toEqual([]);         // session 属 B、key 属 A → 交集为空
  });

  it('key 无 thread 时返回空且 total=0（不泄露他人数据）', async () => {
    const data = await listAs(999);
    expect(data.items).toEqual([]);
    expect(data.total).toBe(0);
  });
});
