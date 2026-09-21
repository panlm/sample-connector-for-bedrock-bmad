import { describe, it, expect } from 'vitest';
import {
    DECISION_TABLE,
    DEFAULT_RULE,
    resolveInferencePolicy,
    applySamplingPolicy,
    resolveThinking,
} from '../src/util/inference_params';

// 直接对纯决策表引擎做单元断言 —— 现有 bedrock_converse_*.test.ts 只经 toPayload() 间接覆盖。
// 这一层锁住数据驱动表契约（FR-1）与「家族→thinking 支持性」映射（FR-7），
// 与 provider 拼装解耦，任何一行放行集/来源注释被改动都在这里先红。

describe('DECISION_TABLE 数据驱动契约 (FR-1)', () => {
    it('显式建行的家族含 anthropic / nova / llama', () => {
        const families = DECISION_TABLE.map((e) => e.family).sort();
        expect(families).toEqual(['anthropic', 'llama', 'nova']);
    });

    it('每个家族的每一代次行都带非空 source 注释', () => {
        for (const entry of DECISION_TABLE) {
            for (const gen of entry.generations) {
                expect(typeof gen.source).toBe('string');
                expect(gen.source.length).toBeGreaterThan(0);
            }
        }
    });

    it('DEFAULT_RULE 是保守最小集：放行集为空、thinking 不支持、来源标「未确认」', () => {
        expect(DEFAULT_RULE.allowed).toEqual([]);
        expect(DEFAULT_RULE.thinking.supported).toBe(false);
        expect(DEFAULT_RULE.source).toContain('未确认');
    });
});

describe('resolveInferencePolicy 家族/代次解析', () => {
    it('anthropic opus-4 代次 → 放行集只含 stopSequences，支持 thinking', () => {
        const rule = resolveInferencePolicy('anthropic.claude-opus-4-20250514-v1:0');
        expect(rule.allowed).toEqual(['stopSequences']);
        expect(rule.thinking.supported).toBe(true);
    });

    it('anthropic 兜底代次 (3-5-sonnet) → temperature/topP 互斥，支持 thinking', () => {
        const rule = resolveInferencePolicy('anthropic.claude-3-5-sonnet-20240620-v1:0');
        expect(rule.allowed).toContain('temperature');
        expect(rule.allowed).toContain('topP');
        expect(rule.mutuallyExclusive).toEqual(['temperature', 'topP']);
        expect(rule.thinking.supported).toBe(true);
    });

    it('nova → 放行 temperature/topP/stopSequences，不支持 thinking', () => {
        const rule = resolveInferencePolicy('amazon.nova-pro-v1:0');
        expect(rule.allowed).toEqual(['temperature', 'topP', 'stopSequences']);
        expect(rule.thinking.supported).toBe(false);
    });

    it('llama → 放行 temperature/topP（无 stopSequences），不支持 thinking', () => {
        const rule = resolveInferencePolicy('meta.llama3-70b-instruct-v1:0');
        expect(rule.allowed).toEqual(['temperature', 'topP']);
        expect(rule.allowed).not.toContain('stopSequences');
        expect(rule.thinking.supported).toBe(false);
    });

    it('未知家族 (cohere) → 退回 DEFAULT_RULE', () => {
        expect(resolveInferencePolicy('cohere.command-r-plus-v1:0')).toBe(DEFAULT_RULE);
    });

    it('空/缺失 modelId → 退回 DEFAULT_RULE（不抛异常）', () => {
        expect(resolveInferencePolicy('')).toBe(DEFAULT_RULE);
        expect(resolveInferencePolicy(undefined as any)).toBe(DEFAULT_RULE);
    });
});

describe('applySamplingPolicy 原地裁剪', () => {
    it('放行集外的采样参数被删除，maxTokens 从不触碰', () => {
        const cfg: any = { maxTokens: 2048, temperature: 0.3, topP: 0.9, stopSequences: ['X'] };
        applySamplingPolicy(cfg, { allowed: ['temperature'], thinking: { supported: false }, source: 't' }, {});
        expect(cfg.maxTokens).toBe(2048);
        expect(cfg.temperature).toBe(0.3);
        expect(cfg.topP).toBeUndefined();
        expect(cfg.stopSequences).toBeUndefined();
    });

    it('DEFAULT_RULE（空放行集）→ 全部采样参数被裁，仅 maxTokens 存活', () => {
        const cfg: any = { maxTokens: 2048, temperature: 0.3, topP: 0.9, stopSequences: ['X'] };
        applySamplingPolicy(cfg, DEFAULT_RULE, {});
        expect(Object.keys(cfg)).toEqual(['maxTokens']);
    });

    it('互斥：只给 top_p（无 temperature）→ 删 temperature 保留 topP', () => {
        const rule = resolveInferencePolicy('anthropic.claude-3-5-sonnet-20240620-v1:0');
        const cfg: any = { maxTokens: 2048, temperature: 0.7, topP: 0.9 };
        applySamplingPolicy(cfg, rule, { top_p: 0.9 });
        expect(cfg.temperature).toBeUndefined();
        expect(cfg.topP).toBe(0.9);
    });

    it('互斥：给了 temperature → 删 topP 保留 temperature', () => {
        const rule = resolveInferencePolicy('anthropic.claude-3-5-sonnet-20240620-v1:0');
        const cfg: any = { maxTokens: 2048, temperature: 0.3, topP: 0.9 };
        applySamplingPolicy(cfg, rule, { temperature: 0.3, top_p: 0.9 });
        expect(cfg.temperature).toBe(0.3);
        expect(cfg.topP).toBeUndefined();
    });
});

describe('resolveThinking 家族分流 (FR-7/FR-8)', () => {
    const anthropic = resolveInferencePolicy('anthropic.claude-3-5-sonnet-20240620-v1:0');
    const nova = resolveInferencePolicy('amazon.nova-pro-v1:0');

    it('支持家族 + enabled + budget<下限 → active，budget 抬到 1024、temperature 强制 1、删 topP', () => {
        const plan = resolveThinking(anthropic, { thinking: { type: 'enabled', budget_tokens: 100 } }, {});
        expect(plan.active).toBe(true);
        expect(plan.thinkBudget).toBe(1024);
        expect(plan.forceTemperature).toBe(1);
        expect(plan.dropTopP).toBe(true);
    });

    it('不支持家族 (nova) + enabled → active=false', () => {
        const plan = resolveThinking(nova, { thinking: { type: 'enabled', budget_tokens: 2048 } }, {});
        expect(plan.active).toBe(false);
    });

    it('chatRequest.disabled 覆盖 config.thinking=true → active=false', () => {
        const plan = resolveThinking(anthropic, { thinking: { type: 'disabled' } }, { thinking: true, thinkBudget: 2048 });
        expect(plan.active).toBe(false);
    });

    it('config.thinking 回落（chatRequest 未指定）→ active，budget 取 config.thinkBudget', () => {
        const plan = resolveThinking(anthropic, {}, { thinking: true, thinkBudget: 2048 });
        expect(plan.active).toBe(true);
        expect(plan.thinkBudget).toBe(2048);
    });
});
