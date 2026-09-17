import { describe, it, expect, vi } from 'vitest';

// —— 边界 mock：在 import 目标模块前 hoist 生效，隔离外部依赖、杜绝副作用 ——
vi.mock('../src/config', () => ({ default: {} }));
vi.mock('../src/service/model', () => ({ default: {} }));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: vi.fn(), GetObjectCommand: vi.fn(), PutObjectCommand: vi.fn() }));
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({ BedrockRuntimeClient: vi.fn(), InvokeModelCommand: vi.fn() }));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }));
vi.mock('../src/util/logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import NovaCanvas from '../src/providers/nova_canvas';

// 回归测试 REQ-1/2（no-unsafe-optional-chaining，nova_canvas.ts）：
// 原代码 `const { content } = choiceContent?.message;` 在 choices 无匹配项时，
// choiceContent 为 undefined，?.message 短路为 undefined，再解构会抛 TypeError。
// 改后用安全可选链，缺失路径应返回 undefined 而不抛错。
describe('NovaCanvas.selectChoiceOutputs', () => {
  it('无匹配 choice（空数组）→ 不抛错，content/tool_calls 为 undefined', () => {
    let out: any;
    expect(() => { out = NovaCanvas.selectChoiceOutputs([]); }).not.toThrow();
    expect(out.content).toBeUndefined();
    expect(out.tool_calls).toBeUndefined();
  });

  it('choice 存在但无 message.content/tool_calls → 不抛错，均为 undefined', () => {
    let out: any;
    expect(() => { out = NovaCanvas.selectChoiceOutputs([{}, { message: {} }]); }).not.toThrow();
    expect(out.content).toBeUndefined();
    expect(out.tool_calls).toBeUndefined();
  });

  it('存在匹配 choice → 取到与原写法相同的属性值', () => {
    const choices = [
      { message: { content: 'hello' } },
      { message: { tool_calls: [{ function: { name: 'paint' } }] } },
    ];
    const out = NovaCanvas.selectChoiceOutputs(choices);
    expect(out.content).toBe('hello');
    expect(out.tool_calls).toEqual([{ function: { name: 'paint' } }]);
  });
});
