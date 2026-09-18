import { describe, it, expect, vi } from 'vitest';

// —— 边界 mock：deleteMulti 只碰 SQL 拼装层，不真连库。桩掉 query 捕获拼出的 SQL/params ——
vi.mock('pg', () => ({ Pool: vi.fn() }));

import PGClient from '../src/util/postgres';

// 构造一个 query 被桩掉的 client，捕获 deleteMulti 实际拼出的 SQL 与 params。
function makeClient() {
  const client = new PGClient();
  const captured: { sql?: string; params?: any } = {};
  client.query = vi.fn(async (sql: string, params: any) => {
    captured.sql = sql;
    captured.params = params;
    return { rows: [], rowCount: 1 };
  }) as any;
  return { client, captured };
}

describe('deleteMulti — 坏 where 输入必须被校验层拒绝并抛描述性错误', () => {
  it('where 缺失（conditions 无 where 键）→ 抛错，不执行删除', async () => {
    const { client, captured } = makeClient();
    await expect(client.deleteMulti('users', {})).rejects.toThrow(/deleteMulti.*where/i);
    expect(captured.sql).toBeUndefined(); // 拒绝执行：query 从未被调用
  });

  it('where 为 null → 抛错，不执行删除', async () => {
    const { client, captured } = makeClient();
    await expect(client.deleteMulti('users', { where: null })).rejects.toThrow(/deleteMulti.*where/i);
    expect(captured.sql).toBeUndefined();
  });

  it('where 为空字符串 "" → 抛错，不执行删除', async () => {
    const { client, captured } = makeClient();
    await expect(client.deleteMulti('users', { where: '' })).rejects.toThrow(/deleteMulti.*where/i);
    expect(captured.sql).toBeUndefined();
  });

  it('where 为纯空白 "   " → 抛错，不执行删除', async () => {
    const { client, captured } = makeClient();
    await expect(client.deleteMulti('users', { where: '   ' })).rejects.toThrow(/deleteMulti.*where/i);
    expect(captured.sql).toBeUndefined();
  });
});

describe('deleteMulti — 正常 where 仍正常工作', () => {
  it('合法 where 串 → 拼出 delete from <table> where <where> 且 params 透传', async () => {
    const { client, captured } = makeClient();
    const result = await client.deleteMulti('users', { where: 'id = $1', params: [2] });
    expect(captured.sql).toMatch(/^delete from users where id = \$1\s*$/);
    expect(captured.params).toEqual([2]);
    expect(result).toBe(true); // 桩返回 rowCount=1 → deleteMulti 返回 true
  });
});
