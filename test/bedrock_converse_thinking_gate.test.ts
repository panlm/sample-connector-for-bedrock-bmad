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
// tea 门禁补测：既有 thinking 套件对 "topP 被 thinking 裁掉" 的断言只用了 claude-sonnet-4-5，
// 而 4.5 的 generationOverride（temperature/topP 二选一）本身就会删 topP —— 于是把
// buildThinking.dropTopP 改坏（true→false）时既有用例仍全绿（变异幸存）。
// 本文件用**不触发 4.5 二选一**的支持家族代次（claude-3-7-sonnet，gen 3.7），
// 让 thinking 的 dropTopP 成为删 topP 的唯一原因，把该裁剪断言真正钉住。
// ————————————————————————————————————————————————————————————————
const ANTHROPIC_37 = 'anthropic.claude-3-7-sonnet-20250219-v1:0'; // gen 3.7 —— 不触发 4.5 二选一

describe('thinking 门禁：topP 由 thinking 独立裁剪（非 4.5 代次，隔离 generationOverride）', () => {
    it('无 thinking 时前提成立：3.7 代次两参都放行（override 不触发）→ temperature+topP 都在', async () => {
        const p = await payloadFor(ANTHROPIC_37, { temperature: 0.3, top_p: 0.9 });
        // 这一步锁死"隔离前提"：若某天 3.7 也被卷进二选一，此断言会先红，提醒补测失效。
        expect(p.inferenceConfig.temperature).toBe(0.3);
        expect(p.inferenceConfig.topP).toBe(0.9);
    });

    it('开启 thinking → topP 被删（唯一原因是 dropTopP）、temperature 被覆盖为 1、thinking 块下发', async () => {
        const p = await payloadFor(ANTHROPIC_37, {
            temperature: 0.3,
            top_p: 0.9,
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
