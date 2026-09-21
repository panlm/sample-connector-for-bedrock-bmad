// Data-driven inference-parameter policy for Bedrock Converse.
//
// AD-1: the decision table below is DATA, not control flow. Adding a family = adding
//       a row here; toPayload() assembly code does not change.
// AD-2: resolveInferencePolicy(modelId) is the ONLY table lookup entry point.
// AD-3: applySamplingPolicy(...) is the ONLY owner of sampling-parameter pruning.
// AD-7: this module is pure — no SDK, no IO, no import of the provider. All family /
//       parameter knowledge lives here so the provider never re-introduces sampling
//       `modelId.includes(...)` chains.

// maxTokens is always kept and is NOT part of the allow-set (never pruned here).
export type SamplingParam = "temperature" | "topP" | "stopSequences";

// Thinking (extended reasoning) policy. Story 1.1 only needs the shape to exist;
// Story 1.2 consumes the `supported: true` fields. All thinking constraint values
// live here exactly once (AD-6) — no function hard-codes them elsewhere.
export type ThinkingPolicy =
    | { supported: false }
    | {
        supported: true;
        minBudget: number;
        forceTemperature: number;
        dropTopP: boolean;
        maxTokensBumpOnCollision: number;
        source: string;
    };

// One generation row within a family.
export interface GenerationRule {
    // Sub-string matcher(s) selecting this generation within its family. Omit for the
    // family's fallback generation row.
    idIncludes?: string[];
    // Sampling params this generation/family is known to accept.
    allowed: SamplingParam[];
    // Presence-guarded mutual exclusion (e.g. temperature vs topP): only acts when
    // both members are still present after allow-set pruning.
    mutuallyExclusive?: SamplingParam[];
    thinking: ThinkingPolicy;
    source: string;
}

export interface FamilyEntry {
    family: string;
    idIncludes: string[];
    generations: GenerationRule[];
}

// Anthropic thinking constraints — single source of truth (AD-6).
const ANTHROPIC_THINKING: ThinkingPolicy = {
    supported: true,
    minBudget: 1024,
    forceTemperature: 1,
    dropTopP: true,
    maxTokensBumpOnCollision: 1024,
    source: "Anthropic extended-thinking docs: budget_tokens>=1024, temperature must be 1, top_p unsupported",
};

// Conservative minimal set for unmatched families: only maxTokens survives.
export const DEFAULT_RULE: GenerationRule = {
    allowed: [], // 未确认，保守最小集
    thinking: { supported: false },
    source: "// 未确认，保守最小集",
};

export const DECISION_TABLE: FamilyEntry[] = [
    {
        family: "anthropic",
        idIncludes: ["anthropic", "claude"],
        generations: [
            {
                // opus-4 及更新代次弃用 temperature/topP。来源：bedrock_converse.ts 旧 892-895 + Anthropic 文档
                idIncludes: ["claude-opus-4"],
                allowed: ["stopSequences"],
                thinking: ANTHROPIC_THINKING,
                source: "code(old) 892-895 + Anthropic docs: opus-4 deprecates temperature/topP",
            },
            {
                // 兜底 Anthropic 代次：temperature 与 topP 二选一。来源：bedrock_converse.ts 旧 897-903 + Anthropic 文档
                allowed: ["temperature", "topP", "stopSequences"],
                mutuallyExclusive: ["temperature", "topP"],
                thinking: ANTHROPIC_THINKING,
                source: "code(old) 897-903 + Anthropic docs: temperature and top_p are mutually exclusive",
            },
        ],
    },
    {
        family: "nova",
        idIncludes: ["nova"],
        generations: [
            {
                // AWS 建议 temperature/topP 择一但同传不 400，故不设 mutuallyExclusive。
                // 来源：AWS Bedrock Amazon Nova inference-parameters 文档
                allowed: ["temperature", "topP", "stopSequences"],
                // Nova 扩展推理是 reasoningConfig/effort 枚举形，非 Anthropic budget_tokens 形 → 形状不匹配，保守 false
                thinking: { supported: false },
                source: "AWS Bedrock Amazon Nova docs: temperature/topP/stopSequences accepted; thinking shape mismatch",
            },
        ],
    },
    {
        family: "llama",
        idIncludes: ["llama"],
        generations: [
            {
                // Meta Llama 仅 temperature/top_p/max_gen_len，无 stopSequences、无扩展推理。
                // 来源：AWS Bedrock Meta Llama inference-parameters 文档
                allowed: ["temperature", "topP"],
                thinking: { supported: false },
                source: "AWS Bedrock Meta Llama docs: only temperature/top_p/max_gen_len; no stopSequences, no thinking",
            },
        ],
    },
];

// AD-2: the ONLY table lookup entry point. Pure. Returns DEFAULT_RULE when no family matches.
export function resolveInferencePolicy(modelId: string): GenerationRule {
    const id = modelId || "";
    for (const entry of DECISION_TABLE) {
        const familyMatch = entry.idIncludes.some((frag) => id.includes(frag));
        if (!familyMatch) {
            continue;
        }
        // Prefer a generation row whose idIncludes matches; else the fallback row (no idIncludes).
        let fallback: GenerationRule | undefined;
        for (const gen of entry.generations) {
            if (!gen.idIncludes) {
                fallback = gen;
                continue;
            }
            if (gen.idIncludes.some((frag) => id.includes(frag))) {
                return gen;
            }
        }
        if (fallback) {
            return fallback;
        }
        // Family matched but no generation matched and no fallback — conservative.
        return DEFAULT_RULE;
    }
    return DEFAULT_RULE;
}

// AD-3: the ONLY owner of sampling-parameter pruning. Mutates `inferenceConfig` in place.
// Treats default-filled values and explicit client values identically. Never touches
// maxTokens, additionalModelRequestFields, or thinking.
export function applySamplingPolicy(
    inferenceConfig: any,
    rule: GenerationRule,
    chatRequest: ChatRequestLike
): void {
    const allSampling: SamplingParam[] = ["temperature", "topP", "stopSequences"];
    for (const param of allSampling) {
        if (!rule.allowed.includes(param)) {
            delete inferenceConfig[param];
        }
    }

    // Presence-guarded mutual exclusion: only act when both members still present.
    const me = rule.mutuallyExclusive;
    if (me && me.length === 2) {
        const [a, b] = me;
        if (inferenceConfig[a] !== undefined && inferenceConfig[b] !== undefined) {
            // Legacy semantics: client gave only top_p (and no temperature) → keep topP.
            if (chatRequest.top_p && !chatRequest.temperature) {
                delete inferenceConfig.temperature;
            } else {
                delete inferenceConfig.topP;
            }
        }
    }
}

// Minimal structural type — avoids importing the provider or entity layer (AD-7).
export interface ChatRequestLike {
    temperature?: number;
    top_p?: number;
    thinking?: { type?: string; budget_tokens?: number };
    [key: string]: any;
}

// Result of thinking resolution — everything the provider needs to land thinking.
// When inactive, no field other than `active` is meaningful.
export interface ThinkingPlan {
    active: boolean;
    thinkBudget?: number;
    forceTemperature?: number;
    dropTopP?: boolean;
    maxTokensBumpOnCollision?: number;
}

// AD-10: consumes the already-resolved `rule` (does NOT re-look-up the table). All
// constraint numbers are read from `rule.thinking` — nothing is hard-coded here (AC-5,
// single source of truth). Pure.
//
// thinkingRequested precedence (preserves legacy semantics):
//   chatRequest.thinking.type === "enabled"  → requested
//   chatRequest.thinking.type === "disabled" → not requested (overrides config)
//   otherwise                                 → fall back to config.thinking
// thinkingActive = thinkingRequested && rule.thinking.supported.
export function resolveThinking(
    rule: GenerationRule,
    chatRequest: ChatRequestLike,
    config: any
): ThinkingPlan {
    let requested = false;
    let requestedBudget: number | undefined;

    if (chatRequest.thinking?.type === 'enabled') {
        requested = true;
        requestedBudget = chatRequest.thinking.budget_tokens;
    } else if (chatRequest.thinking?.type === 'disabled') {
        requested = false;
    } else if (config && config.thinking) {
        requested = true;
        requestedBudget = config.thinkBudget;
    }

    const policy = rule.thinking;
    if (!requested || !policy.supported) {
        return { active: false };
    }

    // All numbers come from the policy (AD-6). No literals here.
    let thinkBudget = requestedBudget;
    if (!thinkBudget || thinkBudget < policy.minBudget) {
        thinkBudget = policy.minBudget;
    }

    return {
        active: true,
        thinkBudget,
        forceTemperature: policy.forceTemperature,
        dropTopP: policy.dropTopP,
        maxTokensBumpOnCollision: policy.maxTokensBumpOnCollision,
    };
}
