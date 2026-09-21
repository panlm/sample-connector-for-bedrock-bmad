import { describe, it, expect, vi, beforeEach } from 'vitest';

// —— 边界 mock：在 import 目标模块前 hoist 生效（照 test/nova_canvas.test.ts 范式），隔离外部依赖、抓 SDK 构造调用 ——
vi.mock('../src/config', () => ({ default: {} }));
vi.mock('../src/service/model', () => ({ default: {} }));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: vi.fn(), GetObjectCommand: vi.fn(), PutObjectCommand: vi.fn() }));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }));
vi.mock('../src/util/logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
// BedrockRuntimeClient.send 返回固定响应；ConverseCommand/ConverseStreamCommand 为 vi.fn，用于抓构造入参（AC5）。
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
    // 用普通函数（非箭头）以便 `new BedrockRuntimeClient(...)` 可构造；返回带 send 的 stub 实例。
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

// 纯函数直测（照 test/nova_canvas.test.ts 范式）：inference_params 无 SDK 依赖，直接 import 断言返回值。
import {
    parseModelId,
    resolveFamily,
    buildInferenceParams,
    FAMILY_RULES,
} from '../src/util/inference_params';

import BedrockConverse from '../src/providers/bedrock_converse';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

describe('parseModelId', () => {
    it('剥离 region 前缀，提取 provider 与 core', () => {
        expect(parseModelId('us.anthropic.claude-opus-4-1-20250805-v1:0')).toEqual({
            raw: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
            provider: 'anthropic',
            core: 'claude-opus-4-1-20250805-v1:0',
        });
    });

    it('无 region 前缀同样解析', () => {
        expect(parseModelId('amazon.nova-pro-v1:0')).toEqual({
            raw: 'amazon.nova-pro-v1:0',
            provider: 'amazon',
            core: 'nova-pro-v1:0',
        });
    });

    it('未识别 provider → provider 为空、core 为原串', () => {
        expect(parseModelId('some.unknown.model')).toEqual({
            raw: 'some.unknown.model',
            provider: '',
            core: 'some.unknown.model',
        });
    });

    it('null/undefined → 空串安全解析', () => {
        expect(parseModelId(null)).toEqual({ raw: '', provider: '', core: '' });
        expect(parseModelId(undefined)).toEqual({ raw: '', provider: '', core: '' });
    });
});

describe('resolveFamily —— 有序 matcher + 解析式谓词（不用 includes）', () => {
    // AC2：区分 Anthropic ≥2 代次；弃用代次必须命中 claude-opus-5（证伪：代次退回只认 claude-opus-4 → 此用例红）。
    it('claude-opus-5 命中弃用代次（temp/topP deprecated）', () => {
        const r = resolveFamily('us.anthropic.claude-opus-5-20260101-v1:0');
        expect(r.family).toBe('anthropic');
        expect(r.generation).toBe('opus-v4plus-temp-topp-deprecated');
    });

    it('claude-opus-4 与 claude-opus-4-1 同样命中弃用代次', () => {
        expect(resolveFamily('anthropic.claude-opus-4-20250514-v1:0').generation).toBe(
            'opus-v4plus-temp-topp-deprecated',
        );
        expect(resolveFamily('anthropic.claude-opus-4-1-20250805-v1:0').generation).toBe(
            'opus-v4plus-temp-topp-deprecated',
        );
    });

    it('claude-3-7-sonnet 命中不弃用旧代次 legacy', () => {
        const r = resolveFamily('us.anthropic.claude-3-7-sonnet-20250219-v1:0');
        expect(r.family).toBe('anthropic');
        expect(r.generation).toBe('legacy');
    });

    it('claude-opus-3 主版本 <4 命中 legacy（版本号解析而非子串）', () => {
        expect(resolveFamily('anthropic.claude-opus-3-20240229-v1:0').generation).toBe('legacy');
    });

    it('amazon.nova-pro → nova', () => {
        expect(resolveFamily('amazon.nova-pro-v1:0')).toEqual({ family: 'nova', generation: 'default' });
    });

    it('meta.llama3-70b → llama', () => {
        expect(resolveFamily('meta.llama3-70b-instruct-v1:0')).toEqual({
            family: 'llama',
            generation: 'default',
        });
    });

    it('未识别模型 → default 兜底', () => {
        expect(resolveFamily('cohere.command-r-v1:0')).toEqual({ family: 'default', generation: 'default' });
        expect(resolveFamily('')).toEqual({ family: 'default', generation: 'default' });
    });
});

describe('buildInferenceParams —— 白名单裁剪（删放行集外顶层键，无论给没给）', () => {
    // 完整候选：故意塞满所有采样键 + 家族专属键，验证裁剪。
    const fullCandidate = () => ({
        inferenceConfig: {
            maxTokens: 2048,
            temperature: 0.7,
            topP: 0.7,
            stopSequences: ['x'],
        },
        additionalModelRequestFields: {
            thinking: { type: 'enabled', budget_tokens: 1024 },
            anthropic_beta: ['context-1m-2025-08-07'],
            top_k: 40,
            topK: 40,
        },
    });

    // AC3 + 证伪：default 结果 inferenceConfig 仅含 maxTokens（放行集加 temperature → 此用例红）。
    it('default：inferenceConfig 仅保留 maxTokens、additionalModelRequestFields 清空', () => {
        const out = buildInferenceParams('cohere.command-r-v1:0', fullCandidate());
        expect(out.inferenceConfig).toEqual({ maxTokens: 2048 });
        expect(out.additionalModelRequestFields).toEqual({});
    });

    it('anthropic 弃用代次（opus-5）：删 temperature/topP，保留 maxTokens/stopSequences 及家族专属键', () => {
        const out = buildInferenceParams('us.anthropic.claude-opus-5-20260101-v1:0', fullCandidate());
        expect(out.inferenceConfig).toEqual({ maxTokens: 2048, stopSequences: ['x'] });
        expect(out.additionalModelRequestFields).toEqual({
            thinking: { type: 'enabled', budget_tokens: 1024 },
            anthropic_beta: ['context-1m-2025-08-07'],
            top_k: 40,
        });
        // topK（Nova 专属）不属于 Anthropic 放行集 → 被删。
        expect(out.additionalModelRequestFields).not.toHaveProperty('topK');
    });

    it('anthropic legacy：保留 temperature/topP', () => {
        const out = buildInferenceParams('us.anthropic.claude-3-7-sonnet-20250219-v1:0', fullCandidate());
        expect(out.inferenceConfig).toEqual({
            maxTokens: 2048,
            temperature: 0.7,
            topP: 0.7,
            stopSequences: ['x'],
        });
    });

    it('llama：不放行 stopSequences（BMAD-323），家族专属键清空', () => {
        const out = buildInferenceParams('meta.llama3-70b-instruct-v1:0', fullCandidate());
        expect(out.inferenceConfig).toEqual({ maxTokens: 2048, temperature: 0.7, topP: 0.7 });
        expect(out.inferenceConfig).not.toHaveProperty('stopSequences');
        expect(out.additionalModelRequestFields).toEqual({});
    });

    it('nova：保留通用采样键 + 家族专属 topK', () => {
        const out = buildInferenceParams('amazon.nova-pro-v1:0', fullCandidate());
        expect(out.inferenceConfig).toEqual({
            maxTokens: 2048,
            temperature: 0.7,
            topP: 0.7,
            stopSequences: ['x'],
        });
        expect(out.additionalModelRequestFields).toEqual({ topK: 40 });
    });

    it('白名单裁剪按顶层键、不进嵌套：保留键的嵌套值原样透传', () => {
        const out = buildInferenceParams('us.anthropic.claude-opus-5-20260101-v1:0', {
            additionalModelRequestFields: { thinking: { type: 'enabled', budget_tokens: 2048 } },
        });
        expect(out.additionalModelRequestFields.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    });

    it('候选缺失的键不会凭空出现（无论给没给都只按放行集保留已有键）', () => {
        const out = buildInferenceParams('amazon.nova-pro-v1:0', { inferenceConfig: { maxTokens: 100 } });
        expect(out.inferenceConfig).toEqual({ maxTokens: 100 });
        expect(out.additionalModelRequestFields).toEqual({});
    });
});

describe('FAMILY_RULES —— 数据结构不变量（AD-9）', () => {
    it('扁平有序数组，末行为 default 兜底且 match 恒真', () => {
        expect(Array.isArray(FAMILY_RULES)).toBe(true);
        const last = FAMILY_RULES[FAMILY_RULES.length - 1];
        expect(last.family).toBe('default');
        expect(last.match({ raw: 'anything', provider: '', core: 'anything' })).toBe(true);
    });

    it('每行两个放行集均为 string[]', () => {
        for (const rule of FAMILY_RULES) {
            expect(Array.isArray(rule.inferenceConfigAllow)).toBe(true);
            expect(rule.inferenceConfigAllow.every((k) => typeof k === 'string')).toBe(true);
            expect(Array.isArray(rule.additionalModelRequestFieldsAllow)).toBe(true);
            expect(rule.additionalModelRequestFieldsAllow.every((k) => typeof k === 'string')).toBe(true);
        }
    });

    it('default 行的 inferenceConfig 放行集只含 maxTokens', () => {
        const def = FAMILY_RULES.find((r) => r.family === 'default');
        expect(def?.inferenceConfigAllow).toEqual(['maxTokens']);
    });
});

// —— SDK 级裁剪矩阵（AC3/AC4/AC5）：驱动真实 BedrockConverse.complete，抓 ConverseCommand 构造入参断言 ——
// 断言对象是 `new ConverseCommand(input)` 的 input（真实 SDK 请求体），非内部中间变量。
// 每个用例可"改坏→变红"：Nova 退透传 / default 放 temp / 代次退 opus-4 / 家族判定改回 config.modelId。
describe('bedrock_converse.toPayload 接入决策表 —— SDK 请求体裁剪矩阵', () => {
    // 驱动 complete() 非流式路径 → completeSync → new ConverseCommand(input)。performanceMode 跳过 DB 落库。
    async function capture(opts: {
        modelId: string;
        configModelId?: string;
        temperature?: number;
        top_p?: number;
        stop?: string[];
    }): Promise<any> {
        const provider = new BedrockConverse();
        provider.setModelData({
            // config.modelId 与 chatRequest.model_id 可不同（验 AD-3 同源判定）。
            config: { modelId: opts.configModelId ?? opts.modelId, regions: 'us-east-1', bearerToken: 'test-token' },
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
        if (opts.temperature !== undefined) chatRequest.temperature = opts.temperature;
        if (opts.top_p !== undefined) chatRequest.top_p = opts.top_p;
        if (opts.stop !== undefined) chatRequest.stop = opts.stop;

        const ctx: any = { performanceMode: true, status: 0, set: vi.fn(), logger: { error: vi.fn() } };
        await provider.complete(chatRequest, '', ctx);

        expect(ConverseCommand).toHaveBeenCalledTimes(1);
        return (ConverseCommand as any).mock.calls[0][0];
    }

    beforeEach(() => {
        (ConverseCommand as any).mockClear();
    });

    // —— Anthropic 弃用代次（Opus 5，新增覆盖）——
    it('Anthropic 弃用代次 opus-5 · 给 temp+topP+stop → 二者都不在（白名单删），保留 maxTokens/stopSequences', async () => {
        const input = await capture({
            modelId: 'us.anthropic.claude-opus-5-20260101-v1:0',
            temperature: 0.5,
            top_p: 0.9,
            stop: ['STOP'],
        });
        expect(input.inferenceConfig).not.toHaveProperty('temperature');
        expect(input.inferenceConfig).not.toHaveProperty('topP');
        expect(input.inferenceConfig.maxTokens).toBeDefined();
        expect(input.inferenceConfig.stopSequences).toEqual(['STOP']);
        // AC2：anthropic_beta 保留不被裁（opus-5 无 sonnet 特性 → 空数组）。
        expect(input.additionalModelRequestFields).toHaveProperty('anthropic_beta');
    });

    it('Anthropic 弃用代次 opus-5 · 没给 → inferenceConfig 仅 maxTokens（默认 temp/topP 也被裁）', async () => {
        const input = await capture({ modelId: 'us.anthropic.claude-opus-5-20260101-v1:0' });
        expect(input.inferenceConfig).toEqual({ maxTokens: expect.any(Number) });
    });

    // —— Anthropic 旧代次（Opus 4.x，回归）——
    it('Anthropic opus-4.x · 给 temp+topP → 二者都不在（回归：弃用代次删 temp/topP）', async () => {
        const input = await capture({
            modelId: 'anthropic.claude-opus-4-1-20250805-v1:0',
            temperature: 0.3,
            top_p: 0.8,
        });
        expect(input.inferenceConfig).not.toHaveProperty('temperature');
        expect(input.inferenceConfig).not.toHaveProperty('topP');
        expect(input.inferenceConfig.maxTokens).toBeDefined();
    });

    it('Anthropic opus-4.x · 没给 → inferenceConfig 仅 maxTokens', async () => {
        const input = await capture({ modelId: 'anthropic.claude-opus-4-20250514-v1:0' });
        expect(input.inferenceConfig).toEqual({ maxTokens: expect.any(Number) });
    });

    // —— Nova ——
    it('Nova · 给 temp+topP+stop → 通用采样键保留、无 anthropic_beta/thinking 透传', async () => {
        const input = await capture({
            modelId: 'amazon.nova-pro-v1:0',
            temperature: 0.4,
            top_p: 0.6,
            stop: ['END'],
        });
        expect(input.inferenceConfig).toEqual({
            maxTokens: expect.any(Number),
            temperature: 0.4,
            topP: 0.6,
            stopSequences: ['END'],
        });
        // 非 Anthropic：anthropic_beta 不应出现（証伪：家族判定退回或漏裁 → 变红）。
        expect(input.additionalModelRequestFields).not.toHaveProperty('anthropic_beta');
        expect(input.additionalModelRequestFields).toEqual({});
    });

    it('Nova · 没给 → 保留默认 temp/topP（Nova 放行），additionalModelRequestFields 为空', async () => {
        const input = await capture({ modelId: 'amazon.nova-lite-v1:0' });
        expect(input.inferenceConfig).toHaveProperty('temperature');
        expect(input.inferenceConfig).toHaveProperty('topP');
        expect(input.additionalModelRequestFields).toEqual({});
    });

    // —— Llama ——
    it('Llama · 给 temp+topP+stop → 保留 temp/topP，stopSequences 被裁（Llama 不放行）', async () => {
        const input = await capture({
            modelId: 'meta.llama3-70b-instruct-v1:0',
            temperature: 0.5,
            top_p: 0.7,
            stop: ['X'],
        });
        expect(input.inferenceConfig).toHaveProperty('temperature');
        expect(input.inferenceConfig).toHaveProperty('topP');
        expect(input.inferenceConfig).not.toHaveProperty('stopSequences');
        expect(input.additionalModelRequestFields).toEqual({});
    });

    it('Llama · 没给 → inferenceConfig 无 stopSequences，无家族专属键', async () => {
        const input = await capture({ modelId: 'meta.llama3-8b-instruct-v1:0' });
        expect(input.inferenceConfig).not.toHaveProperty('stopSequences');
        expect(input.additionalModelRequestFields).toEqual({});
    });

    // —— 未知家族 → default 兜底 ——
    it('未知家族 · 给 temp+topP+stop → inferenceConfig 仅 maxTokens（証伪：default 放 temp 即变红）', async () => {
        const input = await capture({
            modelId: 'cohere.command-r-v1:0',
            temperature: 0.9,
            top_p: 0.9,
            stop: ['Z'],
        });
        expect(input.inferenceConfig).toEqual({ maxTokens: expect.any(Number) });
        expect(input.additionalModelRequestFields).toEqual({});
    });

    it('未知家族 · 没给 → inferenceConfig 仅 maxTokens', async () => {
        const input = await capture({ modelId: 'cohere.command-r-v1:0' });
        expect(input.inferenceConfig).toEqual({ maxTokens: expect.any(Number) });
    });

    // —— AD-3 同源 modelId：家族判定用 chatRequest.model_id（发出 id），而非 config.modelId ——
    it('同源判定：config.modelId=opus(会删 temp/topP) 但 model_id=Nova → 按 Nova 保留 temp/topP，且发出 id 同为 Nova', async () => {
        const input = await capture({
            configModelId: 'anthropic.claude-opus-4-1-20250805-v1:0',
            modelId: 'amazon.nova-pro-v1:0',
            temperature: 0.4,
            top_p: 0.6,
        });
        // 发出 id 与判定同源（AD-3）。
        expect(input.modelId).toBe('amazon.nova-pro-v1:0');
        // 按 Nova 家族保留（証伪：若按 config.modelId=opus 判定，temp/topP 会被删 → 变红）。
        expect(input.inferenceConfig.temperature).toBe(0.4);
        expect(input.inferenceConfig.topP).toBe(0.6);
    });
});
