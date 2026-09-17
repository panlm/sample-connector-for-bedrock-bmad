import { describe, it, expect, vi, beforeEach } from 'vitest';

// —— 边界 mock：在 import 目标模块前 hoist 生效，隔离外部副作用 ——
// 关键缝（AD-6）：mock @aws-sdk/client-bedrock-runtime，让 Converse/ConverseStreamCommand
// 记录构造入参 input，断言直接打在真实 command input 上（不是内部变量）。
// 独立测试文件（AC1.3-e）：只测 thinking 分家族门控，与 1.1/1.2 的 inference 测试文件不共享状态。
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
import { resolveThinkingPolicy } from '../src/util/inference_params';

// 一个最小可用的 Converse 同步响应，供 completeSync 消费而不抛错。
const OK_RESPONSE = {
    output: { message: { content: [{ text: 'hi' }] } },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    metrics: { latencyMs: 1 },
};

// 驱动生产路径：toPayload -> new ConverseCommand(input) -> client.send，返回捕获到的 input。
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

// 代表性 modelId：Anthropic 支持 thinking；amazon-nova 走 unknown/deny-all，thinking 不支持。
const ANTHROPIC_ID = 'us.anthropic.claude-3-7-sonnet-20250219-v1:0';
const UNSUPPORTED_ID = 'us.amazon.nova-pro-v1:0';

describe('bedrock_converse thinking 分家族独立门控（AD-5/6/7）', () => {
    beforeEach(() => { captured.length = 0; });

    // —— AC1.3-b：支持家族(Anthropic) × 客户端启用 → 注入 thinking + inferenceConfig 约束 ——
    it('Anthropic 支持家族 + 客户端 enabled → 注入 amrf.thinking，删 topP、temperature=1、maxTokens>budget', async () => {
        const budget = 2048;
        const input = await runConverse(ANTHROPIC_ID,
            baseRequest({ thinking: { type: 'enabled', budget_tokens: budget } }));

        // 形状从决策表按家族读取（参数化，非硬编码）——证明形状是声明式数据、家族自持（AC1.3-d）。
        const tp = resolveThinkingPolicy(ANTHROPIC_ID);
        expect(tp.supported).toBe(true);
        expect(input.additionalModelRequestFields[tp.enabledFieldName!]).toEqual({
            ...tp.enabledFieldShape,
            budget_tokens: budget,
        });
        // 具体断言：Anthropic 形状 { type:"enabled", budget_tokens:N }。
        expect(input.additionalModelRequestFields.thinking).toEqual({ type: 'enabled', budget_tokens: budget });

        const ic = input.inferenceConfig;
        expect(ic.temperature).toBe(1);         // 约束 temperature=1
        expect('topP' in ic).toBe(false);        // 约束删 topP
        expect(ic.maxTokens).toBeGreaterThan(budget); // budget_tokens≥1024 且 maxTokens>budget
    });

    // —— AC1.3-c：约束优先级高于「客户端提供 + 放行集」——
    it('Anthropic + 客户端只给 top_p（放行集本会保留 topP）+ 启用 thinking → 仍删 topP、temperature=1', async () => {
        const input = await runConverse(ANTHROPIC_ID,
            baseRequest({ top_p: 0.85, thinking: { type: 'enabled', budget_tokens: 1500 } }));
        const ic = input.inferenceConfig;
        // 若无优先级，放行集会保留客户端 topP=0.85；thinking 约束必须覆盖它。
        expect('topP' in ic).toBe(false);
        expect(ic.temperature).toBe(1);
        expect(input.additionalModelRequestFields.thinking).toEqual({ type: 'enabled', budget_tokens: 1500 });
    });

    // —— AC1.3-a：不支持家族门控 —— 即便客户端 enabled，也无 thinking 字段、采样不被 thinking 改动 ——
    it('不支持家族(amazon-nova) + 客户端 enabled → 无 amrf.thinking，且未因 thinking 强改 temperature', async () => {
        const tp = resolveThinkingPolicy(UNSUPPORTED_ID);
        expect(tp.supported).toBe(false); // 决策表默认安全值（TENTATIVE OQ-2）

        const withThinking = await runConverse(UNSUPPORTED_ID,
            baseRequest({ top_p: 0.85, thinking: { type: 'enabled', budget_tokens: 4096 } }));

        // 不得注入 thinking（去掉门控、回到「对所有家族注入」会让本行变红）。
        const amrf = withThinking.additionalModelRequestFields;
        expect(amrf === undefined || !('thinking' in amrf)).toBe(true);
        // 不得因 thinking 把 temperature 强改为 1（Anthropic 约束不许串到本家族，AD-7）。
        expect(withThinking.inferenceConfig.temperature).not.toBe(1);
    });

    // —— AC1.3-a 强化：采样走该家族普通裁剪路径 —— 启用/不启用 thinking，inferenceConfig 完全一致 ——
    it('不支持家族：启用 thinking 前后 inferenceConfig 与 amrf 完全一致（thinking 未触碰采样）', async () => {
        // max_tokens 给足，绕开 toPayload 对 thinking 的 budget/maxTokens 抬升（那是保留的客户端解析语义，
        // 与家族门控无关），把对比聚焦在「thinking 是否触碰采样/amrf」。
        const withThinking = await runConverse(UNSUPPORTED_ID,
            baseRequest({ max_tokens: 10000, top_p: 0.85, thinking: { type: 'enabled', budget_tokens: 4096 } }));
        captured.length = 0;
        const noThinking = await runConverse(UNSUPPORTED_ID,
            baseRequest({ max_tokens: 10000, top_p: 0.85 }));

        expect(withThinking.inferenceConfig).toEqual(noThinking.inferenceConfig);
        expect(withThinking.additionalModelRequestFields).toEqual(noThinking.additionalModelRequestFields);
    });
});
