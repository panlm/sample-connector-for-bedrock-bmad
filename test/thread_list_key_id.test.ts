import { describe, it, expect } from 'vitest';

// —— 跨 key 隔离回归测试 ——
// 走真实 controller (`ThreadController`) + 真实 service (`service/thread`)，
// 只把最底层的 db 换成一个「忠实按 where/params 过滤」的内存假库。
// 这样 controller 是否给 service 传 key_id、service 是否据此拼出 key_id 过滤，
// 都会真实地反映在返回结果里 —— 缺少过滤 = 泄漏，测试即红。
import makeThreadController from '../src/controller/user/ThreadController';

// 两把 key（同一用户持有），各自 id
const KEY_A = 'key-a';
const KEY_B = 'key-b';

// 库里两条 thread：分别属于 A、B
const ROWS = [
    { id: 1, key_id: KEY_A, session_id: 's-a', prompt: 'hello A', completion: 'hi A', tokens_in: 1, tokens_out: 1, fee: 0 },
    { id: 2, key_id: KEY_B, session_id: 's-b', prompt: 'hello B', completion: 'hi B', tokens_in: 1, tokens_out: 1, fee: 0 },
];

// 忠实解释 service 拼出的 where/params 的内存假库。
// service 产出的 where 形如：`1=1 and key_id = $1 and session_id = $2 ...`
// 这里按 " and " 拆分，逐条 predicate 求值，$N 从 params 取值。
function matches(row: any, where: string, params: any[]): boolean {
    const parts = where.split(/\s+and\s+/i).map((p) => p.trim()).filter(Boolean);
    for (const part of parts) {
        if (part === '1=1') continue;
        let m = part.match(/^key_id\s*=\s*\$(\d+)$/i);
        if (m) { if (String(row.key_id) !== String(params[+m[1] - 1])) return false; continue; }
        m = part.match(/^session_id\s*=\s*\$(\d+)$/i);
        if (m) { if (String(row.session_id) !== String(params[+m[1] - 1])) return false; continue; }
        m = part.match(/prompt like \$(\d+)/i);
        if (m) {
            const needle = String(params[+m[1] - 1]).replace(/%/g, '');
            if (!String(row.prompt).includes(needle) && !String(row.completion).includes(needle)) return false;
            continue;
        }
        throw new Error('unhandled where clause in fake db: ' + part);
    }
    return true;
}

function makeDb() {
    return {
        list: async (_table: string, conditions: any) => {
            return ROWS.filter((r) => matches(r, conditions.where, conditions.params));
        },
        count: async (_table: string, conditions: any) => {
            return ROWS.filter((r) => matches(r, conditions.where, conditions.params)).length;
        },
    };
}

// 从 controller 抓出 /user/thread/list 的 handler
function getListHandler() {
    const handlers: Record<string, any> = {};
    const fakeRouter: any = { get: (path: string, fn: any) => { handlers[path] = fn; } };
    const controller = makeThreadController(fakeRouter);
    return { handler: handlers['/user/thread/list'], controller };
}

// 用某把 key 调 list，返回 controller 写进 ctx.body 的 data
async function listAs(keyId: string, query: any = {}) {
    const { handler, controller } = getListHandler();
    const ctx: any = { db: makeDb(), user: { id: keyId }, query: { ...query } };
    await handler.call(controller, ctx);
    return ctx.body.data;
}

describe('/user/thread/list — 跨 key 隔离', () => {
    it('正向：A key 能看到自己的 thread (id=1)', async () => {
        const data = await listAs(KEY_A);
        const ids = data.items.map((t: any) => t.id);
        expect(ids).toContain(1);
    });

    // —— 反向断言（本测试核心）——
    it('反向：A key 看不到 B key 的 thread (id=2)', async () => {
        const data = await listAs(KEY_A);
        const ids = data.items.map((t: any) => t.id);
        expect(ids).not.toContain(2);
        expect(ids).toEqual([1]);
    });

    it('反向：B key 看不到 A key 的 thread (id=1)', async () => {
        const data = await listAs(KEY_B);
        const ids = data.items.map((t: any) => t.id);
        expect(ids).not.toContain(1);
        expect(ids).toEqual([2]);
    });

    // 越权路径：A 主动传 ?key_id=B，也不能借此拿到 B 的 thread
    it('越权：A 传 ?key_id=<B> 仍拿不到 B 的 thread', async () => {
        const data = await listAs(KEY_A, { key_id: KEY_B });
        const ids = data.items.map((t: any) => t.id);
        expect(ids).not.toContain(2);
        expect(ids).toEqual([1]);
    });
});
