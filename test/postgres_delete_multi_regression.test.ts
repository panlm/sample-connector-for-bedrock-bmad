import { describe, it, expect, vi } from 'vitest';

// TEA (BMAD-96 / stage3) 追加回归覆盖 —— 与 stage2 的 postgres_delete_multi.test.ts 互补，
// 守护 stage2 那五条没覆盖到的契约面：非字符串 where 类型分支、空白变体、错误信息内容、
// 缺失 conditions 入参、返回值语义。deleteMulti 的校验发生在拼 SQL 之前，与真实库无关，
// 故用桩捕获 query 的 SQL/params，桩永不被调用即证明"拒绝执行"。
vi.mock('pg', () => ({ Pool: vi.fn() }));

import PGClient from '../src/util/postgres';

function makeClient(rowCount = 1) {
  const client = new PGClient();
  const captured: { called: boolean; sql?: string; params?: any } = { called: false };
  client.query = vi.fn(async (sql: string, params: any) => {
    captured.called = true;
    captured.sql = sql;
    captured.params = params;
    return { rows: [], rowCount };
  }) as any;
  return { client, captured };
}

describe('deleteMulti 追溯 — 非字符串 where 类型必须逐类被拒（typeof !== "string" 分支）', () => {
  // stage2 只测了 null；这里补齐 typeof 分支的其余坏类型，每类一条独立断言。
  it('where 为 number(0) → 抛错，query 从未被调用', async () => {
    const { client, captured } = makeClient();
    await expect(client.deleteMulti('users', { where: 0 as any })).rejects.toThrow(/deleteMulti.*where/i);
    expect(captured.called).toBe(false);
  });

  it('where 为 boolean(true) → 抛错，query 从未被调用', async () => {
    const { client, captured } = makeClient();
    await expect(client.deleteMulti('users', { where: true as any })).rejects.toThrow(/deleteMulti.*where/i);
    expect(captured.called).toBe(false);
  });

  it('where 为对象 {} → 抛错，query 从未被调用', async () => {
    const { client, captured } = makeClient();
    await expect(client.deleteMulti('users', { where: {} as any })).rejects.toThrow(/deleteMulti.*where/i);
    expect(captured.called).toBe(false);
  });
});

describe('deleteMulti 追溯 — 空白变体必须被 trim 拦下（不止半角空格）', () => {
  it('where 为制表符 "\\t" → 抛错，query 从未被调用', async () => {
    const { client, captured } = makeClient();
    await expect(client.deleteMulti('users', { where: '\t' })).rejects.toThrow(/deleteMulti.*where/i);
    expect(captured.called).toBe(false);
  });

  it('where 为换行 "\\n\\n" → 抛错，query 从未被调用', async () => {
    const { client, captured } = makeClient();
    await expect(client.deleteMulti('users', { where: '\n\n' })).rejects.toThrow(/deleteMulti.*where/i);
    expect(captured.called).toBe(false);
  });
});

describe('deleteMulti 追溯 — 缺失 conditions 入参本身也不能退化成无条件删除', () => {
  it('conditions 为 undefined → 抛错（conditions = conditions || {} 后 where 缺失），query 从未被调用', async () => {
    const { client, captured } = makeClient();
    await expect(client.deleteMulti('users', undefined as any)).rejects.toThrow(/deleteMulti.*where/i);
    expect(captured.called).toBe(false);
  });

  it('conditions 为 null → 抛错，query 从未被调用', async () => {
    const { client, captured } = makeClient();
    await expect(client.deleteMulti('users', null as any)).rejects.toThrow(/deleteMulti.*where/i);
    expect(captured.called).toBe(false);
  });
});

describe('deleteMulti 追溯 — 错误信息必须可诊断（防"永远绿"的泛化抛错）', () => {
  it('错误信息点名表名与缺失的 where，而非泛化 throw', async () => {
    const { client } = makeClient();
    // 断言消息内容具体：含表名 users + "where" 字样 + "delete" 语义，
    // 这样即便实现改成 `throw new Error("bad")` 也会红，而不是被 /where/ 之外任何抛错蒙混。
    await expect(client.deleteMulti('accounts', { where: '' })).rejects.toThrow(
      /deleteMulti requires a non-empty "where".*accounts/i
    );
  });
});

describe('deleteMulti 追溯 — 合法 where 的返回值语义（正向路径没被堵）', () => {
  it('rowCount>0 → 返回 true，且 SQL/params 正确透传', async () => {
    const { client, captured } = makeClient(2);
    const result = await client.deleteMulti('users', { where: 'status = $1', params: ['stale'] });
    expect(captured.called).toBe(true);
    expect(captured.sql).toMatch(/^delete from users where status = \$1\s*$/);
    expect(captured.params).toEqual(['stale']);
    expect(result).toBe(true);
  });

  it('rowCount=0（没命中行）→ 返回 false，但仍正常执行（不抛错）', async () => {
    const { client, captured } = makeClient(0);
    const result = await client.deleteMulti('users', { where: 'id = $1', params: [99999] });
    expect(captured.called).toBe(true);
    expect(result).toBe(false);
  });

  it('合法 where 但无 params → 仍拼出语句并透传 undefined params', async () => {
    const { client, captured } = makeClient(1);
    const result = await client.deleteMulti('users', { where: "name = 'x'" });
    expect(captured.sql).toMatch(/^delete from users where name = 'x'\s*$/);
    expect(captured.params).toBeUndefined();
    expect(result).toBe(true);
  });
});
