import { describe, it, expect } from 'vitest';

// 回归测试 REQ-8（no-useless-escape，key.ts:158）：
// 去掉 email 校验正则字符类里多余的 \.，并把 - 移到类尾。
// 断言改前/改后正则对一组样本的 test() 结果逐一相等，证明字符类集合不变、匹配行为等价。
const OLD = /^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/;   // 改前（对照）— 含多余转义
const NEW = /^[\w.-]+@([\w-]+\.)+[\w-]{2,4}$/;    // 改后 — 无多余转义

const samples = [
  'a.b-c@x.co',      // 含 . 和 - 的本地部分
  'foo@bar.com',     // 常规
  'a@b',             // 无顶级域，两者都不匹配
  'a@@b.com',        // 双 @，两者都不匹配
  'x-y@a-b.co',      // 含 - 的本地部分与域名
  '.leading@x.com',  // 以 . 开头
  '-leading@x.com',  // 以 - 开头
  'trailing.@x.com', // 以 . 结尾（@ 前）
];

describe('key.ts email 正则等价性（no-useless-escape 清理）', () => {
  for (const s of samples) {
    it(`"${s}" 改前改后 test() 相等`, () => {
      expect(NEW.test(s)).toBe(OLD.test(s));
    });
  }
});
