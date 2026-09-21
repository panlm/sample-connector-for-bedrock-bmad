import { describe, it, expect, vi } from 'vitest';

// —— 边界 mock：在 import provider 前 hoist 生效，隔离外部依赖、杜绝副作用 ——
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

// 断言对象是真实请求体：toPayload() 返回的 inferenceConfig（= 传给 ConverseCommand 的入参），
// 不是拼装过程里的内部中间变量。
async function payload(req: any, config: any) {
    return new MessageConverter().toPayload(
        { messages: [{ role: 'user', content: 'hi' }], ...req },
        config
    );
}

const ALL_PARAMS = { temperature: 0.3, top_p: 0.9, stop: ['STOP'] };

describe('applySamplingPolicy — Anthropic opus-4 代次 (AC-1)', () => {
    it('给 temperature+top_p → 无 temperature/topP，有 maxTokens', async () => {
        const { inferenceConfig } = await payload(
            { temperature: 0.3, top_p: 0.9 },
            { modelId: 'anthropic.claude-opus-4-20250514-v1:0' }
        );
        expect(inferenceConfig.temperature).toBeUndefined();
        expect(inferenceConfig.topP).toBeUndefined();
        expect(inferenceConfig.maxTokens).toBeDefined();
    });
});

describe('applySamplingPolicy — 其它 Anthropic 代次 (AC-2)', () => {
    it('只给 top_p（不给 temperature）→ 保留 topP、删 temperature', async () => {
        const { inferenceConfig } = await payload(
            { top_p: 0.9 },
            { modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0' }
        );
        expect(inferenceConfig.topP).toBeDefined();
        expect(inferenceConfig.temperature).toBeUndefined();
    });

    it('给 temperature → 保留 temperature、删 topP（3-7-sonnet）', async () => {
        const { inferenceConfig } = await payload(
            { temperature: 0.3, top_p: 0.9 },
            { modelId: 'anthropic.claude-3-7-sonnet-20250219-v1:0' }
        );
        expect(inferenceConfig.temperature).toBeDefined();
        expect(inferenceConfig.topP).toBeUndefined();
    });

    it('都不给 → 保留 temperature（默认）、删 topP；二者不同时出现', async () => {
        const { inferenceConfig } = await payload(
            {},
            { modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0' }
        );
        expect(inferenceConfig.temperature).toBeDefined();
        expect(inferenceConfig.topP).toBeUndefined();
        // 二选一：不同时出现
        expect(
            (inferenceConfig.temperature !== undefined) && (inferenceConfig.topP !== undefined)
        ).toBe(false);
    });
});

describe('Nova (AC-3)', () => {
    it('给参数 → 保留 temperature/topP/stopSequences', async () => {
        const { inferenceConfig } = await payload(ALL_PARAMS, { modelId: 'amazon.nova-pro-v1:0' });
        expect(inferenceConfig.temperature).toBeDefined();
        expect(inferenceConfig.topP).toBeDefined();
        expect(inferenceConfig.stopSequences).toEqual(['STOP']);
    });

    it('不给参数 → 仍有默认 temperature/topP（Nova 放行集含二者）', async () => {
        const { inferenceConfig } = await payload({}, { modelId: 'amazon.nova-pro-v1:0' });
        expect(inferenceConfig.temperature).toBeDefined();
        expect(inferenceConfig.topP).toBeDefined();
        expect(inferenceConfig.stopSequences).toBeUndefined();
    });
});

describe('Llama (AC-4)', () => {
    it('给参数 → 有 temperature/topP，但无 stopSequences', async () => {
        const { inferenceConfig } = await payload(ALL_PARAMS, { modelId: 'meta.llama3-70b-instruct-v1:0' });
        expect(inferenceConfig.temperature).toBeDefined();
        expect(inferenceConfig.topP).toBeDefined();
        expect(inferenceConfig.stopSequences).toBeUndefined();
    });

    it('不给参数 → 默认 temperature/topP，无 stopSequences', async () => {
        const { inferenceConfig } = await payload({}, { modelId: 'meta.llama3-70b-instruct-v1:0' });
        expect(inferenceConfig.temperature).toBeDefined();
        expect(inferenceConfig.topP).toBeDefined();
        expect(inferenceConfig.stopSequences).toBeUndefined();
    });
});

describe('未知家族 default (AC-5)', () => {
    it('cohere.command 给全参数 → inferenceConfig 只含 maxTokens', async () => {
        const { inferenceConfig } = await payload(ALL_PARAMS, { modelId: 'cohere.command-r-plus-v1:0' });
        expect(inferenceConfig.maxTokens).toBeDefined();
        expect(inferenceConfig.temperature).toBeUndefined();
        expect(inferenceConfig.topP).toBeUndefined();
        expect(inferenceConfig.stopSequences).toBeUndefined();
        expect(Object.keys(inferenceConfig)).toEqual(['maxTokens']);
    });

    it('mistral.large 不给参数 → 只含 maxTokens（默认 0.7 也被裁掉）', async () => {
        const { inferenceConfig } = await payload({}, { modelId: 'mistral.mistral-large-2402-v1:0' });
        expect(Object.keys(inferenceConfig)).toEqual(['maxTokens']);
        expect(inferenceConfig.temperature).toBeUndefined();
        expect(inferenceConfig.topP).toBeUndefined();
    });
});

describe('裁剪在默认填充之后 (AC-6)', () => {
    it('opus-4 不给参数 → 默认 0.7 的 temperature/topP 也不出现', async () => {
        const { inferenceConfig } = await payload({}, { modelId: 'anthropic.claude-opus-4-20250514-v1:0' });
        expect(inferenceConfig.temperature).toBeUndefined();
        expect(inferenceConfig.topP).toBeUndefined();
    });
});
