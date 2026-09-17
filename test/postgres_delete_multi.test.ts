import { describe, it, expect, beforeEach } from 'vitest';

import PGClient from '../src/util/postgres';

// deleteMulti 把 conditions.where 裸插进 `delete from <table> where <where>`。
// 缺陷：where 缺失 / null / "" / 纯空白 时不应生成/执行任何 DELETE，必须抛错拒绝执行
// （绝不能默认成 "1=1" —— 那会退化成无条件全表删除）。
// 用一个记录 SQL 的 query stub 隔离真实 pg：既能断言坏输入下「一条 SQL 都没发」，
// 也能断言正向用例下 DELETE 照常执行。

function makeClient() {
  const calls: { sql: string; params: any }[] = [];
  const client = new PGClient();
  // 覆盖 query：记录被执行的 SQL，模拟删掉 1 行。
  (client as any).query = async (sql: string, params: any) => {
    calls.push({ sql, params });
    return { rows: [], rowCount: 1 };
  };
  return { client, calls };
}

describe('deleteMulti 坏 where 输入拒绝执行', () => {
  let client: PGClient;
  let calls: { sql: string; params: any }[];

  beforeEach(() => {
    ({ client, calls } = makeClient());
  });

  it('where 缺失（没有 where 键）→ 抛错且不发任何 SQL', async () => {
    await expect(client.deleteMulti('victims', { params: [] })).rejects.toThrow(/where/i);
    expect(calls).toHaveLength(0);
  });

  it('where = null → 抛错且不发任何 SQL', async () => {
    await expect(client.deleteMulti('victims', { where: null })).rejects.toThrow(/where/i);
    expect(calls).toHaveLength(0);
  });

  it('where = "" 空字符串 → 抛错且不发任何 SQL', async () => {
    await expect(client.deleteMulti('victims', { where: '' })).rejects.toThrow(/where/i);
    expect(calls).toHaveLength(0);
  });

  it('where = "   " 纯空白 → 抛错且不发任何 SQL', async () => {
    await expect(client.deleteMulti('victims', { where: '   ' })).rejects.toThrow(/where/i);
    expect(calls).toHaveLength(0);
  });

  it('正向用例：合法 where 仍正常执行 DELETE', async () => {
    const ok = await client.deleteMulti('victims', { where: 'id = $1', params: [42] });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('delete from victims where id = $1');
    expect(calls[0].params).toEqual([42]);
  });
});
