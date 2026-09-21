import { describe, it, expect, vi } from 'vitest';

// 隔离外部依赖：不真正连 pg，只注入 fake pool 观察 deleteMulti 的行为。
// 本文件是 stage-3（tea）对 dev 回归测试（postgres_delete_multi.test.ts）的
// 覆盖扩展：dev 已覆盖 story 指定的四种坏输入（缺失 / null / "" / "   "）；
// 这里补测护栏 `typeof where !== "string"` 分支的其它非字符串类型，以及
// 更多空白变体和「conditions 整体缺失」等 dev 未显式覆盖的边界。
vi.mock('pg', () => ({ Pool: vi.fn() }));

import PGClient from '../src/util/postgres';

function clientWithSpyPool(rowCount = 1) {
  const client = new PGClient();
  const query = vi.fn(async (sql: string, _params: any) => ({ rows: [], rowCount }));
  client.pool = { query };
  return { client, query };
}

describe('deleteMulti — 护栏边界扩展（非字符串类型 / 空白变体 / conditions 缺失）', () => {
  // --- typeof where !== "string" 分支：非字符串类型都必须抛错，且不得触达 pool.query ---
  it('where 为数字 0 → 抛错（非字符串）', async () => {
    const { client, query } = clientWithSpyPool();
    await expect(client.deleteMulti('users', { where: 0 })).rejects.toThrow(/where/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('where 为布尔 false → 抛错（非字符串）', async () => {
    const { client, query } = clientWithSpyPool();
    await expect(client.deleteMulti('users', { where: false })).rejects.toThrow(/where/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('where 为对象 {} → 抛错（非字符串）', async () => {
    const { client, query } = clientWithSpyPool();
    await expect(client.deleteMulti('users', { where: {} })).rejects.toThrow(/where/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('where 为数组 [] → 抛错（typeof "object"，非字符串）', async () => {
    const { client, query } = clientWithSpyPool();
    await expect(client.deleteMulti('users', { where: [] })).rejects.toThrow(/where/i);
    expect(query).not.toHaveBeenCalled();
  });

  // --- trim() === "" 分支：其它空白变体（tab / 换行）也必须抛错 ---
  it('where 为 tab+换行 "\\t\\n" → 抛错（trim 后为空）', async () => {
    const { client, query } = clientWithSpyPool();
    await expect(client.deleteMulti('users', { where: '\t\n' })).rejects.toThrow(/where/i);
    expect(query).not.toHaveBeenCalled();
  });

  // --- conditions 整体缺失（line 204 的 `conditions = conditions || {}` 之后 where 为 undefined）---
  it('conditions 整体为 undefined → 抛错（不清空整表）', async () => {
    const { client, query } = clientWithSpyPool();
    // @ts-expect-error 故意传缺失的 conditions，验证护栏兜底
    await expect(client.deleteMulti('users')).rejects.toThrow(/where/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('conditions 为 null → 抛错（不清空整表）', async () => {
    const { client, query } = clientWithSpyPool();
    await expect(client.deleteMulti('users', null)).rejects.toThrow(/where/i);
    expect(query).not.toHaveBeenCalled();
  });

  // --- 正向：where 前后带空白但含实义 → 不被护栏堵住（trim 仅用于判空，不改写真实值）---
  it('正向：where 含前后空白但非空 "  id = $1  " → 正常执行，值原样进 SQL', async () => {
    const { client, query } = clientWithSpyPool(1);
    const result = await client.deleteMulti('users', { where: '  id = $1  ', params: [7] });
    expect(result).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('id = $1');
    expect(params).toEqual([7]);
  });
});
