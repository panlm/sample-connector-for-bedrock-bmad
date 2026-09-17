import { describe, it, expect, vi, beforeEach } from 'vitest';

// —— 边界 mock：在 import 目标模块前 hoist 生效，隔离外部副作用 ——
// 关键缝（AD-6）：mock @aws-sdk/client-bedrock-runtime，让 Converse/ConverseStreamCommand
// 记录构造入参 input，测试断言直接打在真实 command input 上，而非纯函数返回值。
const captured: any[] = [];
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: vi.fn(() => ({ send: vi.fn().mockResolvedValue({}) })),
    ConverseCommand: vi.fn(function (input: any) { captured.push({ cmd: 'Converse', input }); }),
    ConverseStreamCommand: vi.fn(function (input: any) { captured.push({ cmd: 'ConverseStream', input }); }),
}));
vi.mock('../src/config', () => ({ default: {} }));
vi.mock('../src/service/model', () => ({ default: {} }));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
vi.mock('../src/util/logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import BedrockConverse from '../src/providers/bedrock_converse';

// 一个最小可用的 Converse 同步响应，供 completeSync 消费而不抛错。
const OK_RESPONSE = {
    output: { message: { content: [{ text: 'hi' }] } },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    metrics: { latencyMs: 1 },
};

// 驱动生产路径：toPayload -> new ConverseCommand(input) -> client.send。
// performanceMode 让 saveThread 直接返回，规避 DB 依赖。
async function runConverse(modelId: string, chatRequest: any) {
    const provider: any = new BedrockConverse();
    provider.modelData = { config: { modelId }, price_in: 0, price_out: 0 };
    provider.modelId = modelId;
    provider.client = { send: vi.fn().mockResolvedValue(OK_RESPONSE) };

    const ctx: any = { performanceMode: true, set: vi.fn(), status: 0 };
    const payload = await provider.chatMessageConverter.toPayload(chatRequest, provider.modelData.config);
    payload.modelId = modelId;
    await provider.completeSync(ctx, payload, chatRequest, 'sid');
    return captured[captured.length - 1].input;
}

function baseRequest(overrides: any = {}) {
    return {
        messages: [{ role: 'user', content: 'hello' }],
        ...overrides,
    };
}

describe('bedrock_converse inference params (Anthropic × 采样参数给/不给 × ≥2 代次)', () => {
    beforeEach(() => { captured.length = 0; });

    // —— claude-opus-5：Opus5 修复点（AC1.1-b）——
    it('opus-5 + 给采样参数 → temperature/topP 均被弃用，仅留 maxTokens（不再落旧 else 二选一）', async () => {
        const input = await runConverse('us.anthropic.claude-opus-5-20250101-v1:0',
            baseRequest({ temperature: 0.3, top_p: 0.9 }));
        const ic = input.inferenceConfig;
        expect(ic.maxTokens).toBeGreaterThan(0);
        expect('temperature' in ic).toBe(false);
        expect('topP' in ic).toBe(false);
        // anthropic 家族 amrf 恒带 anthropic_beta（此代次无 beta，空数组）。
        expect(input.additionalModelRequestFields.anthropic_beta).toEqual([]);
    });

    it('opus-5 + 不给采样参数 → 同样弃用 temperature/topP', async () => {
        const input = await runConverse('us.anthropic.claude-opus-5-20250101-v1:0', baseRequest());
        const ic = input.inferenceConfig;
        expect('temperature' in ic).toBe(false);
        expect('topP' in ic).toBe(false);
        expect(input.additionalModelRequestFields.anthropic_beta).toEqual([]);
    });

    // —— claude-opus-4.x：归一化代次应与 opus-5 命中同一弃用处理（AC1.1-b）——
    it('opus-4.1 + 给采样参数 → temperature/topP 均被弃用', async () => {
        const input = await runConverse('us.anthropic.claude-opus-4-1-20250805-v1:0',
            baseRequest({ temperature: 0.5, top_p: 0.8 }));
        const ic = input.inferenceConfig;
        expect('temperature' in ic).toBe(false);
        expect('topP' in ic).toBe(false);
    });

    it('opus-4.1 + 不给采样参数 → temperature/topP 均被弃用', async () => {
        const input = await runConverse('us.anthropic.claude-opus-4-1-20250805-v1:0', baseRequest());
        const ic = input.inferenceConfig;
        expect('temperature' in ic).toBe(false);
        expect('topP' in ic).toBe(false);
    });

    // —— 非弃用代次 claude-3-7-sonnet：保留二选一逻辑 + beta 注入（AC1.1-e）——
    it('3-7-sonnet + 只给 temperature → 保留 temperature、删除 topP，并注入 3-7 beta', async () => {
        const input = await runConverse('us.anthropic.claude-3-7-sonnet-20250219-v1:0',
            baseRequest({ temperature: 0.2 }));
        const ic = input.inferenceConfig;
        expect(ic.temperature).toBe(0.2);
        expect('topP' in ic).toBe(false);
        expect(input.additionalModelRequestFields.anthropic_beta).toEqual([
            'output-128k-2025-02-19', 'token-efficient-tools-2025-02-19',
        ]);
    });

    it('3-7-sonnet + 只给 top_p（无 temperature）→ 删除 temperature、保留 topP', async () => {
        const input = await runConverse('us.anthropic.claude-3-7-sonnet-20250219-v1:0',
            baseRequest({ top_p: 0.85 }));
        const ic = input.inferenceConfig;
        expect('temperature' in ic).toBe(false);
        expect(ic.topP).toBe(0.85);
    });

    it('3-7-sonnet + 不给采样参数 → 默认 temperature=0.7、删除 topP', async () => {
        const input = await runConverse('us.anthropic.claude-3-7-sonnet-20250219-v1:0', baseRequest());
        const ic = input.inferenceConfig;
        expect(ic.temperature).toBe(0.7);
        expect('topP' in ic).toBe(false);
    });

    // —— stopSequences 截断 + amrf 形状（AC1.1-d）——
    it('stop 数组 → stopSequences 截断到 4 个', async () => {
        const input = await runConverse('us.anthropic.claude-3-7-sonnet-20250219-v1:0',
            baseRequest({ stop: ['a', 'b', 'c', 'd', 'e'] }));
        expect(input.inferenceConfig.stopSequences).toEqual(['a', 'b', 'c', 'd']);
    });

    // —— thinking：universal 注入 + temperature=1 / 无 topP（现有 Anthropic 行为原样迁入）——
    it('thinking enabled → amrf.thinking 注入、temperature=1、无 topP', async () => {
        const input = await runConverse('us.anthropic.claude-3-7-sonnet-20250219-v1:0',
            baseRequest({ thinking: { type: 'enabled', budget_tokens: 2048 } }));
        const ic = input.inferenceConfig;
        expect(ic.temperature).toBe(1);
        expect('topP' in ic).toBe(false);
        expect(input.additionalModelRequestFields.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    });
});
