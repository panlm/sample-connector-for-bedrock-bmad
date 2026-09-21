import { describe, it, expect, vi } from 'vitest';

// 隔离外部依赖：不真正连 pg，只注入 fake pool 观察 deleteMulti 的行为。
vi.mock('pg', () => ({ Pool: vi.fn() }));

import PGClient from '../src/util/postgres';

// 造一个带 fake pool 的 PGClient：pool.query 记录收到的 SQL 并返回可控 rowCount。
// 关键：坏输入若“未被护栏拦住”，就会走到 pool.query（当前 HEAD 的缺陷行为）；
// 被护栏拦住则在到达 pool.query 之前抛错。
function clientWithSpyPool(rowCount = 1) {
  const client = new PGClient();
  const query = vi.fn(async (sql: string, _params: any) => ({ rows: [], rowCount }));
  client.pool = { query };
  return { client, query };
}

describe('deleteMulti — 坏 where 输入必须抛错，拒绝退化成无条件/危险删除', () => {
  it('where 缺失（无 where key）→ 抛错', async () => {
    const { client, query } = clientWithSpyPool();
    await expect(client.deleteMulti('users', {})).rejects.toThrow(/where/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('where 为 null → 抛错', async () => {
    const { client, query } = clientWithSpyPool();
    await expect(client.deleteMulti('users', { where: null })).rejects.toThrow(/where/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('where 为空字符串 "" → 抛错', async () => {
    const { client, query } = clientWithSpyPool();
    await expect(client.deleteMulti('users', { where: '' })).rejects.toThrow(/where/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('where 为纯空白 "   " → 抛错', async () => {
    const { client, query } = clientWithSpyPool();
    await expect(client.deleteMulti('users', { where: '   ' })).rejects.toThrow(/where/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('正向用例：合法 where 仍正常删除，未被护栏堵住', async () => {
    const { client, query } = clientWithSpyPool(1);
    const result = await client.deleteMulti('users', { where: 'id = $1', params: [42] });
    expect(result).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('delete from users where id = $1');
    expect(params).toEqual([42]);
  });
});
