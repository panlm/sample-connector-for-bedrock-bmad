import { describe, it, expect, vi, beforeEach } from 'vitest';

// —— 边界 mock：在 import 目标模块前 hoist 生效（照 test/bedrock_converse_inference.test.ts 范式），
//    隔离外部依赖、抓 ConverseCommand 构造入参（真实 SDK 请求体）。——
vi.mock('../src/config', () => ({ default: {} }));
vi.mock('../src/service/model', () => ({ default: {} }));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: vi.fn(), GetObjectCommand: vi.fn(), PutObjectCommand: vi.fn() }));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }));
vi.mock('../src/util/logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: vi.fn(function () {
        return {
            send: vi.fn().mockResolvedValue({
                output: { message: { content: [{ text: 'ok' }] } },
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                metrics: { latencyMs: 1 },
                $metadata: { requestId: 'req-1' },
            }),
        };
    }),
    ConverseCommand: vi.fn(),
    ConverseStreamCommand: vi.fn(),
}));

// 纯函数直测：familySupportsThinking 无 SDK 依赖，直接 import 断言（AD-1 决策表唯一事实源）。
import { familySupportsThinking } from '../src/util/inference_params';

import BedrockConverse from '../src/providers/bedrock_converse';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

// —— familySupportsThinking 门控（AC1/AD-5）：仅 anthropic 支持 thinking 形状字段 ——
describe('familySupportsThinking —— thinking 分家族门控（决策表放行集为唯一事实源）', () => {
    it('anthropic 支持 thinking', () => {
        expect(familySupportsThinking('anthropic')).toBe(true);
    });

    it('nova / llama / default 不支持 thinking（証伪：任一返回 true → 变红）', () => {
        expect(familySupportsThinking('nova')).toBe(false);
        expect(familySupportsThinking('llama')).toBe(false);
        expect(familySupportsThinking('default')).toBe(false);
    });

    it('未知家族名 → 不支持（保守）', () => {
        expect(familySupportsThinking('cohere')).toBe(false);
        expect(familySupportsThinking('')).toBe(false);
    });
});

// —— SDK 级 thinking 分家族矩阵（AC1/AC2/AC3/AC4/AC5）：驱动真实 complete()，抓 ConverseCommand 构造入参 ——
describe('bedrock_converse.toPayload —— thinking 分家族独立路径（SDK 请求体）', () => {
    async function capture(opts: {
        modelId: string;
        budget_tokens?: number;
        temperature?: number;
        top_p?: number;
        enableThinking?: boolean;
    }): Promise<any> {
        const provider = new BedrockConverse();
        provider.setModelData({
            config: { modelId: opts.modelId, regions: 'us-east-1', bearerToken: 'test-token' },
            price_in: 0,
            price_out: 0,
        });
        provider.setKeyData({ id: 1, month_fee: 0, month_quota: 1, balance: 0, total_fee: 0 });

        const chatRequest: any = {
            model: 'unit-test-model',
            model_id: opts.modelId,
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
        };
        // 开启 thinking 意图（Anthropic SDK 形状）。
        if (opts.enableThinking !== false) {
            chatRequest.thinking = { type: 'enabled', budget_tokens: opts.budget_tokens ?? 4096 };
        }
        if (opts.temperature !== undefined) chatRequest.temperature = opts.temperature;
        if (opts.top_p !== undefined) chatRequest.top_p = opts.top_p;

        const ctx: any = { performanceMode: true, status: 0, set: vi.fn(), logger: { error: vi.fn() } };
        await provider.complete(chatRequest, '', ctx);

        expect(ConverseCommand).toHaveBeenCalledTimes(1);
        return (ConverseCommand as any).mock.calls[0][0];
    }

    beforeEach(() => {
        (ConverseCommand as any).mockClear();
    });

    // —— 支持家族：Anthropic（legacy 代次，放行 temperature/topP，能观察 thinking 对 inferenceConfig 的独占）——
    it('Anthropic + thinking 开启：注入 thinking 结构，inferenceConfig 无 topP、temperature===1、maxTokens>budget_tokens（AC1/AC2/AC3）', async () => {
        const input = await capture({
            modelId: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
            budget_tokens: 4096,
            // 只给 top_p、不给 temperature：验证「二选一」裁剪此时不生效、不删 thinking 已定的 temperature（AC2）。
            top_p: 0.9,
        });
        // AC1/AC3：Anthropic 出现 thinking={type:"enabled",budget_tokens:N}
        expect(input.additionalModelRequestFields.thinking).toEqual({
            type: 'enabled',
            budget_tokens: 4096,
        });
        // AC2：inferenceConfig 无 topP、temperature===1
        expect(input.inferenceConfig).not.toHaveProperty('topP');
        expect(input.inferenceConfig.temperature).toBe(1);
        // AC2：maxTokens > budget_tokens（数值不变：现状 budget+1024）
        expect(input.inferenceConfig.maxTokens).toBeGreaterThan(4096);
    });

    it('Anthropic + thinking 开启 · budget<1024 → 抬到 1024，maxTokens>budget（数值不变）', async () => {
        const input = await capture({
            modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
            budget_tokens: 100,
        });
        expect(input.additionalModelRequestFields.thinking).toEqual({
            type: 'enabled',
            budget_tokens: 1024,
        });
        expect(input.inferenceConfig).not.toHaveProperty('topP');
        expect(input.inferenceConfig.temperature).toBe(1);
        expect(input.inferenceConfig.maxTokens).toBeGreaterThan(1024);
    });

    // —— 不支持家族：Nova。带 thinking 意图，最终请求体不含 Anthropic thinking 结构，且无 thinking 副作用（AC1/AC4）——
    it('Nova + thinking 意图：additionalModelRequestFields 无 thinking；inferenceConfig 保留 temp/topP、temperature 非 1（証伪：门控改坏对不支持家族也注入 → 变红）', async () => {
        const input = await capture({
            modelId: 'amazon.nova-pro-v1:0',
            budget_tokens: 4096,
            temperature: 0.4,
            top_p: 0.6,
        });
        // AC1：不含 Anthropic 形状 thinking 字段
        expect(input.additionalModelRequestFields).not.toHaveProperty('thinking');
        expect(input.additionalModelRequestFields).toEqual({});
        // AC4：thinking 副作用不得渗到不支持家族——temperature 保留调用方值、topP 保留（若门控被改坏，thinking 会把 temp 抬到 1、删 topP → 变红）。
        expect(input.inferenceConfig.temperature).toBe(0.4);
        expect(input.inferenceConfig.topP).toBe(0.6);
    });

    // —— 不支持家族：Llama。同上。——
    it('Llama + thinking 意图：无 thinking 结构；temperature 非 1、topP 保留（AC1/AC4）', async () => {
        const input = await capture({
            modelId: 'meta.llama3-70b-instruct-v1:0',
            budget_tokens: 4096,
            temperature: 0.5,
            top_p: 0.7,
        });
        expect(input.additionalModelRequestFields).not.toHaveProperty('thinking');
        expect(input.additionalModelRequestFields).toEqual({});
        expect(input.inferenceConfig.temperature).toBe(0.5);
        expect(input.inferenceConfig.topP).toBe(0.7);
    });
});
