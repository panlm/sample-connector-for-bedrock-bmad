import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 回归测试 BMAD-197 Story 1.2（lint:ui warning 棘轮）+ Story 1.1（lint 收窄后端）。
// 棘轮的阈值与 lint 范围都是 package.json 里的声明式配置——它们被人为改动
// （拿掉 --max-warnings、把 355 取整、让 lint 扫进 src-frontend）时不会让 eslint
// 立刻报错，而是悄悄放宽门禁。本测试把这两处配置钉成断言，任何放宽都会红。
// 说明：这些断言守护的是「门禁配置形态」，真正的相对判定（355→356 使 lint:ui 失败）
// 由 tea 在 CI/本地跑 `pnpm lint:ui` 实测证明，见本 issue 交付评论。
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { scripts: Record<string, string> };

describe('lint 门禁配置（package.json scripts）', () => {
  it('AC-2.1 lint:ui 显式含 --max-warnings 355（恰为实测基线，未取整）', () => {
    const s = pkg.scripts['lint:ui'];
    expect(s).toBeDefined();
    expect(s).toMatch(/--max-warnings\s+355\b/);
    // 未被取整为 350/360/400 等
    expect(s).not.toMatch(/--max-warnings\s+(?:350|360|400)\b/);
  });

  it('AC-2.1 lint:ui 阈值精确为 355（提取数值比对，防止漂移）', () => {
    const m = pkg.scripts['lint:ui'].match(/--max-warnings\s+(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(355);
  });

  it('lint:ui 仍只扫前端 src-frontend', () => {
    expect(pkg.scripts['lint:ui']).toMatch(/\bsrc-frontend\b/);
  });

  it('Story 1.1 lint 范围写死为后端 src/**/*.ts，不扫进前端 src-frontend', () => {
    const s = pkg.scripts['lint'];
    expect(s).toBeDefined();
    expect(s).toMatch(/src\/\*\*\/\*\.ts/);
    expect(s).not.toMatch(/\bsrc-frontend\b/);
  });
});
