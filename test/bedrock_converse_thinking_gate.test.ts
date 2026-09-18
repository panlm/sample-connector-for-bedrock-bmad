import { describe, it, expect, vi } from 'vitest';

// —— 边界 mock：在 import 目标模块前 hoist 生效，隔离外部依赖、杜绝副作用 ——
vi.mock('../src/config', () => ({ default: {} }));
vi.mock('../src/service/model', () => ({ default: {} }));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: vi.fn(), GetObjectCommand: vi.fn(), PutObjectCommand: vi.fn() }));
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: vi.fn(),
    ConverseCommand: vi.fn(),
    ConverseStreamCommand: vi.fn(),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }));
vi.mock('../src/util/logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import BedrockConverse from '../src/providers/bedrock_converse';

// 断言的是**最终请求体形状**（toPayload 返回对象），不是内部中间变量。
async function payloadFor(modelId: string, extra: Record<string, any> = {}, config: Record<string, any> = {}) {
    const provider = new BedrockConverse();
    const chatRequest: any = {
        model: modelId,
        messages: [{ role: 'user', content: 'hello' }],
        ...extra,
    };
    const cfg: any = { modelId, maxTokens: 2048, ...config };
    return provider.chatMessageConverter.toPayload(chatRequest, cfg);
}

// ————————————————————————————————————————————————————————————————
// tea 门禁补测（折叠自 PR #17，PR #16 单 PR 承载）：
// 既有 thinking 套件对 "topP 被 thinking 裁掉" 的断言若同给 temperature+topP，就会被
// Anthropic 的 generationOverride（temperature/topP 二选一，本次回炉必修 2 已扩为全 Anthropic）
// 一起删 topP —— 于是把 buildThinking.dropTopP 改坏（true→false）时用例仍全绿（变异幸存）。
//
// 隔离手法：**只给 top_p、不给 temperature**。二选一需要两者同时出现才触发，只给一个不触发，
// 于是 thinking 的 dropTopP 成为删 topP 的唯一原因，把该裁剪断言真正钉住。
// ————————————————————————————————————————————————————————————————
const ANTHROPIC_37 = 'anthropic.claude-3-7-sonnet-20250219-v1:0'; // 支持 thinking 的 Anthropic 代次

describe('thinking 门禁：topP 由 thinking 独立裁剪（只给 topP 隔离二选一）', () => {
    it('无 thinking 时前提成立：只给 topP（不给 temperature）→ 二选一不触发，topP 保留', async () => {
        const p = await payloadFor(ANTHROPIC_37, { top_p: 0.9 });
        // 锁死"隔离前提"：只给一个参数时二选一必不触发，topP 应原样保留。
        expect(p.inferenceConfig.topP).toBe(0.9);
        expect(p.inferenceConfig.temperature).toBeUndefined();
    });

    it('开启 thinking → topP 被删（唯一原因是 dropTopP）、temperature 被覆盖为 1、thinking 块下发', async () => {
        const p = await payloadFor(ANTHROPIC_37, {
            top_p: 0.9, // 只给 topP，不给 temperature → 二选一不触发
            thinking: { type: 'enabled', budget_tokens: 1500 },
        });
        expect(p.inferenceConfig.topP).toBeUndefined();       // dropTopP=false 会让这里变红
        expect(p.inferenceConfig.temperature).toBe(1);
        expect(p.additionalModelRequestFields.thinking).toBeDefined();
        expect(p.additionalModelRequestFields.thinking.type).toBe('enabled');
    });
});

// ————————————————————————————————————————————————————————————————
// tea 门禁补测：stop → stopSequences 的 slice(0,4) 截断是被保留下来的既有裁剪行为，
// 但既有矩阵只验了 2 项 stop 的透传，没有钉住"超过 4 项被截断"。补一条。
// ————————————————————————————————————————————————————————————————
describe('stopSequences 门禁：超过 4 项截断到前 4（保留既有行为）', () => {
    it('anthropic 给 5 个 stop → stopSequences 只留前 4', async () => {
        const p = await payloadFor(ANTHROPIC_37, { stop: ['a', 'b', 'c', 'd', 'e'] });
        expect(p.inferenceConfig.stopSequences).toEqual(['a', 'b', 'c', 'd']);
    });
});
