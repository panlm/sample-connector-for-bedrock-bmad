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
const NOVA = 'amazon.nova-pro-v1:0';
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

    // 回炉必修 1（FR-6）：Anthropic 扩展推理禁改 top_k，客户端同给 top_k 会同传 → 400。
    // thinking 开启时 top_k 必须从最终请求体删除。（dev 原有 thinking 用例从不传 top_k，是假绿）
    it('thinking + 客户端给 top_k → AMF.top_k 不存在、topP 不存在、temperature===1', async () => {
        const p = await payloadFor(ANTHROPIC, {
            thinking: { type: 'enabled', budget_tokens: 1500 },
            temperature: 0.3,
            top_p: 0.9,
            top_k: 40,
        });
        expect(p.additionalModelRequestFields.top_k).toBeUndefined();
        expect(p.additionalModelRequestFields.thinking).toBeDefined();
        expect(p.inferenceConfig.topP).toBeUndefined();
        expect(p.inferenceConfig.temperature).toBe(1);
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

    // 需求点名 llama/nova/default 三家不支持 thinking；补齐 nova 覆盖（回炉 minor）。
    it('nova 触发 thinking → 请求体不含 thinking，采样按放行表裁剪（topK 走嵌套）', async () => {
        const p = await payloadFor(NOVA, {
            thinking: { type: 'enabled', budget_tokens: 2000 },
            temperature: 0.3,
            top_p: 0.9,
            top_k: 40,
        });
        expect(p.additionalModelRequestFields.thinking).toBeUndefined();
        // 采样正常：temperature/topP 放行、未被 thinking 改写；Nova topK 走嵌套 inferenceConfig。
        expect(p.inferenceConfig.temperature).toBe(0.3);
        expect(p.inferenceConfig.topP).toBe(0.9);
        expect(p.additionalModelRequestFields.inferenceConfig.topK).toBe(40);
    });
});

// ————————————————————————————————————————————————————————————————
// 回炉必修（major，AD-8① 精化）：thinking 的 maxTokens 抬升必须在**家族支持 thinking 之后**才做。
// 不支持 thinking 的家族即便触发 thinking（budget 8000 > config.maxTokens 2048），也不得把 maxTokens
// 静默抬到 budget+1024=9024 突破配置上限——最终 maxTokens 必须 === config.maxTokens。
// 变异证据：把 toPayload 里的抬升改回旧的无条件版本（去掉 supportsThinking 门），下面断言即变红。
// ————————————————————————————————————————————————————————————————
describe('thinking maxTokens 抬升的家族门 (AD-8① 精化 / 回炉必修 major)', () => {
    it('llama + thinking(budget 8000, config.maxTokens 2048) → maxTokens 保持 2048、无 thinking 块', async () => {
        const p = await payloadFor(
            LLAMA,
            { thinking: { type: 'enabled', budget_tokens: 8000 } },
            { maxTokens: 2048 },
        );
        expect(p.inferenceConfig.maxTokens).toBe(2048);
        expect(p.additionalModelRequestFields.thinking).toBeUndefined();
    });

    it('default + thinking(budget 8000, config.maxTokens 2048) → maxTokens 保持 2048、无 thinking 块', async () => {
        const p = await payloadFor(
            UNKNOWN,
            { thinking: { type: 'enabled', budget_tokens: 8000 } },
            { maxTokens: 2048 },
        );
        expect(p.inferenceConfig.maxTokens).toBe(2048);
        expect(p.additionalModelRequestFields.thinking).toBeUndefined();
    });

    it('anthropic（支持家族）同场景 → 仍按 AD-8① 抬升 maxTokens > budget、下发 thinking', async () => {
        const p = await payloadFor(
            ANTHROPIC,
            { thinking: { type: 'enabled', budget_tokens: 8000 } },
            { maxTokens: 2048 },
        );
        // 支持家族：抬升仍生效（对照组，证明门只挡不支持家族、不误伤支持家族）。
        expect(p.inferenceConfig.maxTokens).toBeGreaterThan(8000);
        expect(p.additionalModelRequestFields.thinking).toBeDefined();
    });
});
