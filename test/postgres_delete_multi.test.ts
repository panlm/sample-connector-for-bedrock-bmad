import { describe, it, expect, vi } from 'vitest';

// —— 边界 mock：隔离 pg 驱动，PGClient 直接实例化后手动注入 pool stub ——
vi.mock('pg', () => ({ Pool: vi.fn() }));

import PGClient from '../src/util/postgres';

// 构造一个记录 SQL 的假 pool；deleteMulti 走 this.query → this.pool.query
function clientWithSpy(rowCount = 1) {
  const client = new PGClient();
  const calls: { sql: string; params: any }[] = [];
  client.pool = {
    query: async (sql: string, params: any) => {
      calls.push({ sql, params });
      return { rows: [], rowCount };
    },
  };
  return { client, calls };
}

// 断言必须命中真正的错误信息，而不是任何碰巧含 "where" 字样的异常，
// 这样把「非空 where」这条契约钉死，防后人把守卫弱化成 truthy 检查。
const REFUSAL = /non-empty "where"/i;

describe('deleteMulti 拒绝空/缺失 where', () => {
  it('缺失 where（undefined）→ 抛错且不执行 query', async () => {
    const { client, calls } = clientWithSpy();
    await expect(client.deleteMulti('users', { params: [] })).rejects.toThrow(REFUSAL);
    expect(calls).toHaveLength(0);
  });

  it('where = null → 抛错且不执行 query', async () => {
    const { client, calls } = clientWithSpy();
    await expect(client.deleteMulti('users', { where: null })).rejects.toThrow(REFUSAL);
    expect(calls).toHaveLength(0);
  });

  it('where = "" → 抛错且不执行 query', async () => {
    const { client, calls } = clientWithSpy();
    await expect(client.deleteMulti('users', { where: '' })).rejects.toThrow(REFUSAL);
    expect(calls).toHaveLength(0);
  });

  it('where = "   "（纯空白）→ 抛错且不执行 query', async () => {
    const { client, calls } = clientWithSpy();
    await expect(client.deleteMulti('users', { where: '   ' })).rejects.toThrow(REFUSAL);
    expect(calls).toHaveLength(0);
  });

  // 额外守卫（review 补强）：非字符串 where 也必须被守卫拦下，防止 truthy 检查漏网
  it('where 是非字符串（对象）→ 抛错且不执行 query', async () => {
    const { client, calls } = clientWithSpy();
    await expect(client.deleteMulti('users', { where: {} as any })).rejects.toThrow(REFUSAL);
    expect(calls).toHaveLength(0);
  });

  it('正向：正常 where 仍然拼出 SQL 并正常删除', async () => {
    const { client, calls } = clientWithSpy(1);
    const ok = await client.deleteMulti('users', { where: 'id = $1', params: [1] });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('delete from users where id = $1');
    expect(calls[0].params).toEqual([1]);
  });

  // 正向 0 行：正常 where 命中 0 行时返回 false（rowCount > 0 的假分支）
  it('正向：正常 where 命中 0 行 → 返回 false', async () => {
    const { client, calls } = clientWithSpy(0);
    const ok = await client.deleteMulti('users', { where: 'id = $1', params: [999] });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('delete from users where id = $1');
  });
});
