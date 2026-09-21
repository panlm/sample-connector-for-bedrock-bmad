// inference_params.ts —— 数据驱动的采样参数放行/裁剪决策表（Story 1.1）
//
// 目标（AD-1）：把"哪个家族/代次放行哪些采样参数"抽成唯一事实源 `FAMILY_RULES`，
// 配一段与家族无关的白名单裁剪纯函数 `buildInferenceParams`。新增家族/代次只改一行数据。
//
// 现状根因（brownfield, src/providers/bedrock_converse.ts:807-916）：
//   - inferenceConfig 对所有模型无条件塞 {maxTokens, temperature||0.7, topP||0.7}（:867-871）——未裁剪。
//   - 唯一家族裁剪是内联 `config.modelId.includes("anthropic")`（:890），
//     代次判定 `isOpus4OrLater = includes("claude-opus-4")`（:892）——Opus 5 落空。
// 本模块用"有序 matcher + 解析式谓词（不用 includes）"替代，接入见 Story 1.2。

/** 模型 id 的结构化解析结果（供决策表谓词消费，避免 includes 子串匹配）。 */
export interface ParsedModelId {
    /** 原始 modelId（未改动） */
    raw: string;
    /** 供应商：anthropic / amazon / meta / ''（未识别） */
    provider: string;
    /** 去掉可选 region 前缀（us./eu./apac. 等）与供应商后的模型核心串，如 claude-opus-4-1-20250805-v1:0 */
    core: string;
}

/** resolveFamily 的返回：家族 + 代次。代次用于同一家族内区分放行策略（AD-9）。 */
export interface ResolvedFamily {
    family: string;
    generation: string;
}

/** 单个候选参数集合（裁剪前）。裁剪只看顶层键，不进嵌套（AD-2）。 */
export interface CandidateParams {
    inferenceConfig?: Record<string, unknown>;
    additionalModelRequestFields?: Record<string, unknown>;
}

/**
 * 决策表条目：一行 = 一个家族/代次的匹配谓词 + 两个放行集（均 string[]）。
 * `match` 是解析式谓词，吃 ParsedModelId、提模型名+版本号判断，不用 includes（AD-4）。
 */
export interface FamilyRule {
    family: string;
    generation: string;
    /** 有序 matcher：first-match-wins；解析式谓词，不用 includes（AD-4）。 */
    match: (m: ParsedModelId) => boolean;
    /** inferenceConfig 放行集：maxTokens/temperature/topP/stopSequences 的子集（AD-9）。 */
    inferenceConfigAllow: string[];
    /** additionalModelRequestFields 家族专属放行集（AD-9）。 */
    additionalModelRequestFieldsAllow: string[];
}

/**
 * 把 modelId 解析成结构化字段。支持可选 region 前缀（us./eu./apac./gov 等）。
 * 例：us.anthropic.claude-opus-4-1-20250805-v1:0 → {provider:'anthropic', core:'claude-opus-4-1-...'}
 */
export function parseModelId(modelId: string | null | undefined): ParsedModelId {
    const raw = typeof modelId === 'string' ? modelId : '';
    // 提供商及其后的核心串：(?:region.)? provider . core
    const m = raw.match(/(?:^|\.)(anthropic|amazon|meta)\.(.+)$/);
    if (m) {
        return { raw, provider: m[1], core: m[2] };
    }
    return { raw, provider: '', core: raw };
}

// —— 有序决策表（唯一事实源，AD-1/AD-7/AD-9）——
// 每行放行集带来源注释；查不到的逐字标 `// 未确认，保守最小集`。
export const FAMILY_RULES: FamilyRule[] = [
    {
        // Anthropic Opus 第 4 代及以后（claude-opus-4 / claude-opus-4-1 / claude-opus-5 …）。
        // 解析式谓词：提取 opus 后的主版本号，>=4 命中 —— 修掉现状 includes("claude-opus-4") 对 Opus 5 落空的 bug（AD-4）。
        family: 'anthropic',
        generation: 'opus-v4plus-temp-topp-deprecated',
        match: (m) => {
            if (m.provider !== 'anthropic') return false;
            const opus = m.core.match(/^claude-opus-(\d+)/);
            return !!opus && Number(opus[1]) >= 4;
        },
        // 来源：现有代码 bedrock_converse.ts:892-894 —— opus-4 及以后弃用 temperature/topP 同传，两者都删。
        inferenceConfigAllow: ['maxTokens', 'stopSequences'],
        // anthropic_beta / thinking 来源：现有代码 bedrock_converse.ts:884,911；top_k 来源：Anthropic Messages API 采样参数经 additionalModelRequestFields 透传（父卡已确认按表放行）。
        additionalModelRequestFieldsAllow: ['anthropic_beta', 'thinking', 'top_k'],
    },
    {
        // Anthropic 其余代次（claude-3-x / claude-3-7-sonnet / claude-sonnet-4-x / claude-opus-3 …）——不弃用旧代次。
        family: 'anthropic',
        generation: 'legacy',
        match: (m) => m.provider === 'anthropic' && /^claude-/.test(m.core),
        // 来源：现有代码 bedrock_converse.ts:867-903 —— 保留 temperature/topP（同传冲突二选一在接入层解决，Story 1.2）。
        inferenceConfigAllow: ['maxTokens', 'temperature', 'topP', 'stopSequences'],
        // 同上（Anthropic 家族专属 + 操作字段）。
        additionalModelRequestFieldsAllow: ['anthropic_beta', 'thinking', 'top_k'],
    },
    {
        // Amazon Nova（amazon.nova-pro / nova-lite / nova-micro …）。
        family: 'nova',
        generation: 'default',
        match: (m) => m.provider === 'amazon' && /^nova-/.test(m.core),
        // 来源：AWS Bedrock Converse inferenceConfig 通用键（Nova 支持 temperature/topP/stopSequences）。
        inferenceConfigAllow: ['maxTokens', 'temperature', 'topP', 'stopSequences'],
        // topK 来源：Amazon Nova 采样参数经 additionalModelRequestFields 透传（父卡已确认按表放行）。
        additionalModelRequestFieldsAllow: ['topK'],
    },
    {
        // Meta Llama（meta.llama3-8b / meta.llama3-70b …）。
        family: 'llama',
        generation: 'default',
        match: (m) => m.provider === 'meta' && /^llama/.test(m.core),
        // 来源：BMAD-323 —— Llama 原生无 stop，Converse 是否静默丢弃无权威明示 → 不放行 stopSequences（查不到=保守）。
        inferenceConfigAllow: ['maxTokens', 'temperature', 'topP'],
        // 未确认，保守最小集
        additionalModelRequestFieldsAllow: [],
    },
    {
        // 兜底 default（AD-7 保守最小集）：任何未识别模型都命中此行。
        family: 'default',
        generation: 'default',
        match: () => true,
        // 来源：父卡指定（AD-7）—— 只放 maxTokens。
        inferenceConfigAllow: ['maxTokens'],
        // 未确认，保守最小集
        additionalModelRequestFieldsAllow: [],
    },
];

/** 有序 first-match-wins，返回命中的决策行（default 兜底必命中）。 */
export function resolveRule(modelId: string | null | undefined): FamilyRule {
    const parsed = parseModelId(modelId);
    for (const rule of FAMILY_RULES) {
        if (rule.match(parsed)) return rule;
    }
    // FAMILY_RULES 末行 match 恒真，理论到不了这里；保守兜底同样返回最小集。
    return FAMILY_RULES[FAMILY_RULES.length - 1];
}

/** 家族 + 代次识别（AD-9/FR-2/FR-5）。 */
export function resolveFamily(modelId: string | null | undefined): ResolvedFamily {
    const rule = resolveRule(modelId);
    return { family: rule.family, generation: rule.generation };
}

/**
 * thinking 分家族门控（AD-5/FR-7）：thinking 是 Anthropic 形状字段
 * `{type:"enabled",budget_tokens:N}`，只应在支持它的家族出现。
 * 以决策表放行集为唯一事实源（AD-1）：某家族任一代次的 `additionalModelRequestFieldsAllow`
 * 含 `thinking` 即视为支持。这样新增/调整支持家族只改决策表一行数据，接入层无需再动。
 */
export function familySupportsThinking(family: string): boolean {
    return FAMILY_RULES.some(
        (rule) => rule.family === family && rule.additionalModelRequestFieldsAllow.includes('thinking'),
    );
}

/** 白名单裁剪：只保留放行集内的顶层键，其余一律删除（无论给没给）。不进嵌套（AD-2）。 */
function pruneByWhitelist(
    obj: Record<string, unknown> | undefined,
    allow: string[],
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!obj) return out;
    for (const key of allow) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            out[key] = obj[key];
        }
    }
    return out;
}

/**
 * 裁剪纯函数（AD-2/AD-8/FR-3/FR-4）：先拿候选，再按该模型所属决策行的放行集，
 * 白名单删除放行集外每个顶层键。default 结果 inferenceConfig 仅含 maxTokens、
 * additionalModelRequestFields 不含家族专属采样参数。可直接 import 直测。
 */
export function buildInferenceParams(
    modelId: string | null | undefined,
    candidate: CandidateParams,
): { inferenceConfig: Record<string, unknown>; additionalModelRequestFields: Record<string, unknown> } {
    const rule = resolveRule(modelId);
    return {
        inferenceConfig: pruneByWhitelist(candidate.inferenceConfig, rule.inferenceConfigAllow),
        additionalModelRequestFields: pruneByWhitelist(
            candidate.additionalModelRequestFields,
            rule.additionalModelRequestFieldsAllow,
        ),
    };
}
