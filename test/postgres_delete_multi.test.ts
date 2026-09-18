import { describe, it, expect, vi } from 'vitest';

import PGClient from '../src/util/postgres';

// —— 隔离真实数据库：桩住 query。守卫应在拼 SQL / 下发 query 之前就拦下坏输入，
//    所以坏输入用例断言 query 从未被调用；正向用例则断言 query 收到了预期 SQL/params。——
function makeClient(rowCount = 1) {
  const client = new PGClient();
  client.query = vi.fn(async (_sql: string, _params: any) => ({ rows: [], rowCount })) as any;
  return client;
}

describe('deleteMulti — 空/缺失 where 守卫（回归：无条件 DELETE 缺陷）', () => {
  it('where 缺失（undefined）→ 抛错拒绝，不下发 DELETE', async () => {
    const client = makeClient();
    await expect(client.deleteMulti('victims', {})).rejects.toThrow(/where/i);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('where 为 null → 抛错拒绝，不下发 DELETE', async () => {
    const client = makeClient();
    await expect(client.deleteMulti('victims', { where: null })).rejects.toThrow(/where/i);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('where 为空字符串 "" → 抛错拒绝，不下发 DELETE', async () => {
    const client = makeClient();
    await expect(client.deleteMulti('victims', { where: '' })).rejects.toThrow(/where/i);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('where 为纯空白 "   " → 抛错拒绝，不下发 DELETE', async () => {
    const client = makeClient();
    await expect(client.deleteMulti('victims', { where: '   ' })).rejects.toThrow(/where/i);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('正向：合法 where 仍然正常删除（守卫未误伤 happy path）', async () => {
    const client = makeClient(1);
    const ok = await client.deleteMulti('victims', { where: 'id=$1', params: [1] });
    expect(ok).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = (client.query as any).mock.calls[0];
    expect(sql).toContain('where id=$1');
    expect(params).toEqual([1]);
  });
});
