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

// 断言的是**最终请求体形状**（toPayload 返回对象），不是内部布尔/中间变量（AC-14）。
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

const ANTHROPIC = 'anthropic.claude-sonnet-4-5-20250929-v1:0';
const LLAMA = 'meta.llama3-70b-instruct-v1:0';
const UNKNOWN = 'cohere.command-r-plus-v1:0';

describe('thinking：支持家族 anthropic (AC-12 基础/精化 / AC-14)', () => {
    it('开启 thinking → thinking 存在、topP 不存在、temperature===1', async () => {
        const p = await payloadFor(ANTHROPIC, {
            thinking: { type: 'enabled', budget_tokens: 1500 },
            temperature: 0.3,
            top_p: 0.9,
        });
        expect(p.additionalModelRequestFields.thinking).toBeDefined();
        expect(p.additionalModelRequestFields.thinking.type).toBe('enabled');
        expect(p.inferenceConfig.topP).toBeUndefined();
        expect(p.inferenceConfig.temperature).toBe(1);
    });

    it('budget_tokens >= 1024 且 < maxTokens (AC-12 精化)', async () => {
        const p = await payloadFor(ANTHROPIC, { thinking: { type: 'enabled', budget_tokens: 1500 } });
        const budget = p.additionalModelRequestFields.thinking.budget_tokens;
        expect(budget).toBeGreaterThanOrEqual(1024);
        expect(budget).toBeLessThan(p.inferenceConfig.maxTokens);
    });

    it('budget < 1024 → 兜底抬到 1024，且仍 < maxTokens', async () => {
        const p = await payloadFor(ANTHROPIC, { thinking: { type: 'enabled', budget_tokens: 100 } });
        const budget = p.additionalModelRequestFields.thinking.budget_tokens;
        expect(budget).toBe(1024);
        expect(budget).toBeLessThan(p.inferenceConfig.maxTokens);
    });

    it('budget >= maxTokens → maxTokens 抬升，保持 budget < maxTokens (AD-8①)', async () => {
        const p = await payloadFor(ANTHROPIC, { thinking: { type: 'enabled', budget_tokens: 4000 } });
        const budget = p.additionalModelRequestFields.thinking.budget_tokens;
        expect(budget).toBe(4000);
        expect(p.inferenceConfig.maxTokens).toBeGreaterThan(budget);
    });
});

describe('thinking：不支持家族 (AC-13)', () => {
    it('llama 触发 thinking → 请求体不含 thinking，采样按放行表正常裁剪', async () => {
        const p = await payloadFor(LLAMA, {
            thinking: { type: 'enabled', budget_tokens: 2000 },
            temperature: 0.3,
            top_p: 0.9,
        });
        expect(p.additionalModelRequestFields.thinking).toBeUndefined();
        // 采样正常：temperature/topP 放行、topP 未被 thinking 删、temperature 未被设 1
        expect(p.inferenceConfig.temperature).toBe(0.3);
        expect(p.inferenceConfig.topP).toBe(0.9);
    });

    it('default 触发 thinking → 请求体不含 thinking，inferenceConfig 只剩 maxTokens', async () => {
        const p = await payloadFor(UNKNOWN, { thinking: { type: 'enabled', budget_tokens: 2000 } });
        expect(p.additionalModelRequestFields.thinking).toBeUndefined();
        expect(Object.keys(p.inferenceConfig)).toEqual(['maxTokens']);
    });
});
