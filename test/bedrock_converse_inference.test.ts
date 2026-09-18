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
import { ALLOW_TABLE } from '../src/util/inference_params';

// 断言的对象是**最终请求体形状**：toPayload 返回对象的 inferenceConfig / additionalModelRequestFields，
// 不是内部中间变量（父 issue 踩过的坑的直接对策）。
async function payloadFor(modelId: string, extra: Record<string, any> = {}) {
    const provider = new BedrockConverse();
    const chatRequest: any = {
        model: modelId,
        messages: [{ role: 'user', content: 'hello' }],
        ...extra,
    };
    const config: any = { modelId, maxTokens: 2048 };
    return provider.chatMessageConverter.toPayload(chatRequest, config);
}

// 各家族代表 modelId
const M = {
    anthropicNew: 'anthropic.claude-sonnet-4-5-20250929-v1:0', // gen 4.5
    anthropicOld: 'us.anthropic.claude-3-5-sonnet-20240620-v1:0', // gen 3.5
    anthropicOpus4: 'anthropic.claude-opus-4-20250514-v1:0', // gen 4.0
    anthropicOpus5: 'anthropic.claude-opus-5-20260101-v1:0', // gen 5.0（缺陷 #2 点名）
    anthropicSonnet5: 'anthropic.claude-sonnet-5-20260101-v1:0', // gen 5.0（缺陷 #2 点名）
    nova: 'amazon.nova-pro-v1:0',
    llama: 'meta.llama3-70b-instruct-v1:0',
    unknown: 'cohere.command-r-plus-v1:0', // → default
};

// 客户端「给了」采样参数的一组值
const GIVEN = { temperature: 0.3, top_p: 0.9, top_k: 40, stop: ['STOP', 'END'] };

describe('ALLOW_TABLE 结构 (AC-3)', () => {
    it('键集合恰为四家族 {anthropic, nova, llama, default}', () => {
        expect(Object.keys(ALLOW_TABLE).sort()).toEqual(['anthropic', 'default', 'llama', 'nova']);
    });
});

describe('矩阵：default / 未知家族 (AC-6)', () => {
    it('给了全部采样参数 → inferenceConfig 只含 maxTokens，其余全裁', async () => {
        const p = await payloadFor(M.unknown, GIVEN);
        expect(Object.keys(p.inferenceConfig)).toEqual(['maxTokens']);
        expect(p.inferenceConfig.temperature).toBeUndefined();
        expect(p.inferenceConfig.topP).toBeUndefined();
        expect(p.inferenceConfig.stopSequences).toBeUndefined();
        expect(p.additionalModelRequestFields.top_k).toBeUndefined();
        expect(p.additionalModelRequestFields.inferenceConfig).toBeUndefined();
    });
    it('完全不给 → 仍只含 maxTokens，不注入默认', async () => {
        const p = await payloadFor(M.unknown);
        expect(Object.keys(p.inferenceConfig)).toEqual(['maxTokens']);
    });
});

describe('矩阵：llama (AC-7)', () => {
    it('给了全部 → 不含 top_k；stopSequences 默认裁剪；temperature/topP 放行', async () => {
        const p = await payloadFor(M.llama, GIVEN);
        expect(p.additionalModelRequestFields.top_k).toBeUndefined();
        expect(p.additionalModelRequestFields.inferenceConfig).toBeUndefined();
        expect(p.inferenceConfig.stopSequences).toBeUndefined();
        expect(p.inferenceConfig.temperature).toBe(0.3);
        expect(p.inferenceConfig.topP).toBe(0.9);
    });
    it('不给 → 不注入 temperature/topP 默认 (AC-10)', async () => {
        const p = await payloadFor(M.llama);
        expect(p.inferenceConfig.temperature).toBeUndefined();
        expect(p.inferenceConfig.topP).toBeUndefined();
        expect(Object.keys(p.inferenceConfig)).toEqual(['maxTokens']);
    });
});

describe('矩阵：nova (AC-8)', () => {
    it('给了全部 → topK 落嵌套 additionalModelRequestFields.inferenceConfig.topK，非顶层 inferenceConfig.topK', async () => {
        const p = await payloadFor(M.nova, GIVEN);
        expect(p.additionalModelRequestFields.inferenceConfig.topK).toBe(40);
        expect(p.inferenceConfig.topK).toBeUndefined();
        expect(p.inferenceConfig.temperature).toBe(0.3);
        expect(p.inferenceConfig.topP).toBe(0.9);
        expect(p.inferenceConfig.stopSequences).toEqual(['STOP', 'END']);
    });
    it('不给 → 不注入采样默认 (AC-10)', async () => {
        const p = await payloadFor(M.nova);
        expect(p.inferenceConfig.temperature).toBeUndefined();
        expect(p.inferenceConfig.topP).toBeUndefined();
        expect(p.additionalModelRequestFields.inferenceConfig).toBeUndefined();
    });
});

describe('矩阵：anthropic 新代次 sonnet-4-5 (AC-5 / AC-9 / AC-10)', () => {
    it('同给 temperature+topP → 4.5 二选一只剩其一（默认保留 temperature，裁 topP）', async () => {
        const p = await payloadFor(M.anthropicNew, GIVEN);
        expect(p.inferenceConfig.temperature).toBe(0.3);
        expect(p.inferenceConfig.topP).toBeUndefined();
        // top_k 放行到 AMF 顶层（Anthropic）
        expect(p.additionalModelRequestFields.top_k).toBe(40);
        expect(p.inferenceConfig.stopSequences).toEqual(['STOP', 'END']);
    });
    it('不给 → 不注入 temperature/topP 默认', async () => {
        const p = await payloadFor(M.anthropicNew);
        expect(p.inferenceConfig.temperature).toBeUndefined();
        expect(p.inferenceConfig.topP).toBeUndefined();
    });
    it('只给 topP（不给 temperature）→ 二选一不触发（只有一个），topP 保留', async () => {
        const p = await payloadFor(M.anthropicNew, { top_p: 0.9 });
        expect(p.inferenceConfig.topP).toBe(0.9);
        expect(p.inferenceConfig.temperature).toBeUndefined();
    });
});

// 回炉必修 2：二选一改为**全部 Anthropic**统一（保留 temperature、裁 topP）。
// 同修 Opus5/Sonnet5（缺陷 #2 点名，major≥5）+ 恢复 opus-4/3.x 的 base 保护（修回归）。
describe('矩阵：anthropic 全代次统一二选一 (AC-9 / 缺陷 #2 / 回炉必修 2)', () => {
    it('opus-5 同给 temperature+topP → 只剩其一（保留 temperature）', async () => {
        const p = await payloadFor(M.anthropicOpus5, GIVEN);
        expect(p.inferenceConfig.temperature).toBe(0.3);
        expect(p.inferenceConfig.topP).toBeUndefined();
    });
    it('sonnet-5 同给 temperature+topP → 只剩其一（保留 temperature）', async () => {
        const p = await payloadFor(M.anthropicSonnet5, GIVEN);
        expect(p.inferenceConfig.temperature).toBe(0.3);
        expect(p.inferenceConfig.topP).toBeUndefined();
    });
    it('opus-4 同给 temperature+topP → 只剩其一（恢复 base 保护，修回归）', async () => {
        const p = await payloadFor(M.anthropicOpus4, GIVEN);
        expect(p.inferenceConfig.temperature).toBe(0.3);
        expect(p.inferenceConfig.topP).toBeUndefined();
    });
    it('claude-3-5-sonnet 旧代次同给 → 也二选一（预期行为变更：base 本就对全 Anthropic 二选一）', async () => {
        const p = await payloadFor(M.anthropicOld, GIVEN);
        expect(p.inferenceConfig.temperature).toBe(0.3);
        expect(p.inferenceConfig.topP).toBeUndefined();
    });
    it('只给 topP（不给 temperature）→ 二选一不触发，topP 保留', async () => {
        const p = await payloadFor(M.anthropicOld, { top_p: 0.9 });
        expect(p.inferenceConfig.topP).toBe(0.9);
        expect(p.inferenceConfig.temperature).toBeUndefined();
    });
    // 矩阵补格（回炉次要）：旧代次 ×「不给参数」——补齐与新代次两格的对称性 (AC-5 / AC-10)。
    it('旧代次完全不给 → 不注入 temperature/topP 默认，inferenceConfig 只含 maxTokens', async () => {
        const p = await payloadFor(M.anthropicOld);
        expect(p.inferenceConfig.temperature).toBeUndefined();
        expect(p.inferenceConfig.topP).toBeUndefined();
        expect(Object.keys(p.inferenceConfig)).toEqual(['maxTokens']);
    });
});

describe('AD-4：禁 falsy 合并，temperature:0 是合法已给值', () => {
    it('llama temperature:0 → 保留 0，不被当默认丢弃', async () => {
        const p = await payloadFor(M.llama, { temperature: 0 });
        expect(p.inferenceConfig.temperature).toBe(0);
    });
});
