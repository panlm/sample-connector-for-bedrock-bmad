import { describe, it, expect, vi } from 'vitest';

// —— 边界 mock：与 inference 测试一致，隔离外部依赖 ——
vi.mock('../src/config', () => ({ default: {} }));
vi.mock('../src/service/model', () => ({ default: {} }));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: vi.fn(), GetObjectCommand: vi.fn() }));
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: vi.fn(),
    ConverseCommand: vi.fn(),
    ConverseStreamCommand: vi.fn(),
}));
vi.mock('../src/util/logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { MessageConverter } from '../src/providers/bedrock_converse';

// 断言对象是 toPayload() 返回的真实请求体（inferenceConfig + additionalModelRequestFields）。
async function payload(req: any, config: any) {
    return new MessageConverter().toPayload(
        { messages: [{ role: 'user', content: 'hi' }], ...req },
        config
    );
}

const ANTHROPIC = 'anthropic.claude-3-5-sonnet-20240620-v1:0';

describe('支持家族 Anthropic 开 thinking (AC-1)', () => {
    it('写 thinking.enabled、budget>=1024、无 topP、temperature===1', async () => {
        const { inferenceConfig, additionalModelRequestFields } = await payload(
            { thinking: { type: 'enabled', budget_tokens: 2048 }, temperature: 0.3, top_p: 0.9 },
            { modelId: ANTHROPIC, maxTokens: 8192 }
        );
        expect(additionalModelRequestFields.thinking.type).toBe('enabled');
        expect(additionalModelRequestFields.thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
        expect(inferenceConfig.topP).toBeUndefined();
        expect(inferenceConfig.temperature).toBe(1);
    });

    it('budget < 1024 → 抬到下限 1024', async () => {
        const { additionalModelRequestFields } = await payload(
            { thinking: { type: 'enabled', budget_tokens: 100 } },
            { modelId: ANTHROPIC, maxTokens: 8192 }
        );
        expect(additionalModelRequestFields.thinking.budget_tokens).toBe(1024);
    });
});

describe('maxTokens 抬升 (AC-2)', () => {
    it('maxTokens <= thinkBudget → maxTokens === thinkBudget + 1024', async () => {
        const { inferenceConfig, additionalModelRequestFields } = await payload(
            { thinking: { type: 'enabled', budget_tokens: 4096 } },
            { modelId: ANTHROPIC, maxTokens: 2048 } // 2048 <= 4096
        );
        const budget = additionalModelRequestFields.thinking.budget_tokens;
        expect(budget).toBe(4096);
        expect(inferenceConfig.maxTokens).toBe(budget + 1024);
    });
});

describe('解析优先级 (AC-3)', () => {
    it('config.thinking=true 但 chatRequest.thinking.disabled → 不写 thinking', async () => {
        const { inferenceConfig, additionalModelRequestFields } = await payload(
            { thinking: { type: 'disabled' }, temperature: 0.5 },
            { modelId: ANTHROPIC, thinking: true, thinkBudget: 2048 }
        );
        expect(additionalModelRequestFields.thinking).toBeUndefined();
        // 未开 thinking → 采样按常规裁剪（给了 temperature → 保留 temperature，非强制 1）
        expect(inferenceConfig.temperature).toBe(0.5);
    });

    it('config.thinking=true 且 chatRequest 未指定 → 回落写 thinking', async () => {
        const { additionalModelRequestFields } = await payload(
            {},
            { modelId: ANTHROPIC, thinking: true, thinkBudget: 2048 }
        );
        expect(additionalModelRequestFields.thinking?.type).toBe('enabled');
        expect(additionalModelRequestFields.thinking.budget_tokens).toBe(2048);
    });
});

describe('不支持家族请求 thinking → 不误加 (AC-4)', () => {
    it('Nova + thinking.enabled → 无 thinking 键；采样保留常规放行集，不强制 temp=1', async () => {
        const { inferenceConfig, additionalModelRequestFields } = await payload(
            { thinking: { type: 'enabled', budget_tokens: 2048 }, temperature: 0.3, top_p: 0.9, stop: ['X'] },
            { modelId: 'amazon.nova-pro-v1:0', maxTokens: 8192 }
        );
        expect(additionalModelRequestFields.thinking).toBeUndefined();
        expect(inferenceConfig.temperature).toBe(0.3); // 非强制 1
        expect(inferenceConfig.topP).toBe(0.9);        // topP 未被删
        expect(inferenceConfig.stopSequences).toEqual(['X']);
    });

    it('Llama + thinking.enabled → 无 thinking 键；保留 temp/topP，无 stopSequences，不强制 temp=1', async () => {
        const { inferenceConfig, additionalModelRequestFields } = await payload(
            { thinking: { type: 'enabled', budget_tokens: 2048 }, temperature: 0.3, top_p: 0.9, stop: ['X'] },
            { modelId: 'meta.llama3-70b-instruct-v1:0', maxTokens: 8192 }
        );
        expect(additionalModelRequestFields.thinking).toBeUndefined();
        expect(inferenceConfig.temperature).toBe(0.3);
        expect(inferenceConfig.topP).toBe(0.9);
        expect(inferenceConfig.stopSequences).toBeUndefined();
    });
});

describe('opus-4 + thinking (固定顺序 + 互斥) (AC-1 边界)', () => {
    it('opus-4 开 thinking → 无 temperature/topP、写 thinking', async () => {
        const { inferenceConfig, additionalModelRequestFields } = await payload(
            { thinking: { type: 'enabled', budget_tokens: 2048 } },
            { modelId: 'anthropic.claude-opus-4-20250514-v1:0', maxTokens: 8192 }
        );
        expect(additionalModelRequestFields.thinking.type).toBe('enabled');
        expect(inferenceConfig.temperature).toBeUndefined(); // opus-4 放行集不含 temperature
        expect(inferenceConfig.topP).toBeUndefined();
    });
});
