import { describe, it, expect } from 'vitest';

// 纯函数直测（照 test/nova_canvas.test.ts 范式）：inference_params 无 SDK 依赖，直接 import 断言返回值。
import {
    parseModelId,
    resolveFamily,
    buildInferenceParams,
    FAMILY_RULES,
} from '../src/util/inference_params';

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
