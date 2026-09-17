// Pure, side-effect-free resolver + decision table for Bedrock Converse sampling params.
//
// Story 1.1 (BMAD-52): extract the inline sampling-parameter assembly that used to live in
// `BedrockConverse.toPayload()` into a data-driven decision table keyed by (family, generation).
// This module only knows about the Anthropic (`anthropic-claude`) family for now; everything else
// falls back to a deny-all safe default. It has NO I/O and performs NO network calls.
//
// Extension points for the sibling stories (all in this same file — "add a row / add a column"):
//   * Story 1.2 — add non-Anthropic families (amazon-nova, amazon-titan, meta-llama, ...):
//       1. teach `resolveModel()` to recognise their modelIds (line-level, not vendor-level);
//       2. register a `FamilyPolicy` in `FAMILY_POLICIES` for each.
//   * Story 1.3 — add per-family `thinking` support:
//       `buildAdditionalModelRequestFields()` currently injects `thinking` universally (migrated
//       as-is from the old inline behaviour). Split it per family inside the family policy there.

export type Confidence = 'CONFIRMED' | 'TENTATIVE';

/** Client sampling inputs + routing context handed to the resolver. */
export interface InferenceInput {
    modelId: string;
    // Client-supplied sampling params (all optional / may be absent).
    temperature?: number;   // chatRequest.temperature
    topP?: number;          // chatRequest.top_p
    stop?: any;             // chatRequest.stop (array of stop sequences, or absent)
    thinking?: boolean;     // resolved thinking flag (see toPayload)
    thinkBudget?: number;   // resolved thinking budget_tokens
    // maxTokens is resolved by the caller (config vs request caps) and always kept.
    maxTokens: number;
    config?: any;
}

/** Base Converse `inferenceConfig` — the ONLY four fields the base API accepts (fact A). */
export interface InferenceConfig {
    maxTokens: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
}

export interface InferenceOutput {
    inferenceConfig: InferenceConfig;
    // Omitted entirely when empty (AD-8). Members like `thinking` / `anthropic_beta` are assembled
    // by the decision table, they are NOT part of the inferenceConfig allow-set.
    additionalModelRequestFields?: Record<string, any>;
}

export interface ResolvedModel {
    /** Line-level family enumeration (e.g. `amazon-nova` != `amazon-titan`), never vendor-level. */
    family: string;
    /** Normalized generation descriptor, e.g. `opus-4`, `opus-5`, `sonnet-3-7`, `unknown`. */
    generation: string;
    /** TENTATIVE when the routing (or the rule it selects) still depends on an open question. */
    confidence: Confidence;
}

// ---------------------------------------------------------------------------
// Resolver: modelId -> { family, generation }
// ---------------------------------------------------------------------------

const RE_OPUS = /claude-opus-(\d+)/;

/**
 * Normalize an Anthropic Claude modelId into a `<line>-<generation>` descriptor.
 * Only the distinctions the decision table actually needs are encoded precisely
 * (opus major version for the deprecation rule); anything else is best-effort.
 */
function normalizeAnthropicGeneration(id: string): string {
    const opus = id.match(RE_OPUS);
    if (opus) {
        return `opus-${opus[1]}`;
    }
    const sonnet = id.match(/claude-(?:(\d+)-(\d+)-)?sonnet(?:-(\d+)(?:-(\d+))?)?/);
    if (sonnet) {
        if (sonnet[1] && sonnet[2]) return `sonnet-${sonnet[1]}-${sonnet[2]}`;
        if (sonnet[3] && sonnet[4]) return `sonnet-${sonnet[3]}-${sonnet[4]}`;
        if (sonnet[3]) return `sonnet-${sonnet[3]}`;
        return 'sonnet';
    }
    const haiku = id.match(/claude-(?:(\d+)-(\d+)-)?haiku(?:-(\d+)(?:-(\d+))?)?/);
    if (haiku) {
        if (haiku[1] && haiku[2]) return `haiku-${haiku[1]}-${haiku[2]}`;
        if (haiku[3] && haiku[4]) return `haiku-${haiku[3]}-${haiku[4]}`;
        if (haiku[3]) return `haiku-${haiku[3]}`;
        return 'haiku';
    }
    return 'claude';
}

/**
 * Route a modelId to a (family, generation). Unknown ids get a deny-all safe default and are
 * marked TENTATIVE — never throw, never fall back to a nearest-known family (AD-9).
 */
export function resolveModel(modelId: string): ResolvedModel {
    const id = (modelId || '').toLowerCase();
    // Bedrock Anthropic ids look like `anthropic.claude-...` / `us.anthropic.claude-...`.
    // Gate on the same `anthropic` substring the legacy inline code used, to stay byte-identical.
    if (id.includes('anthropic')) {
        return {
            family: 'anthropic-claude',
            generation: normalizeAnthropicGeneration(id),
            confidence: 'CONFIRMED',
        };
    }
    // Story 1.2 adds amazon-nova / amazon-titan / meta-llama / cohere / mistral rows here.
    return { family: 'unknown', generation: 'unknown', confidence: 'TENTATIVE' };
}

// ---------------------------------------------------------------------------
// Decision table
// ---------------------------------------------------------------------------

interface FamilyPolicy {
    /**
     * Build the base `inferenceConfig` for this family. `maxTokens` is ALWAYS present; the family
     * decides which of temperature / topP / stopSequences it lets through (the "allow-set").
     */
    buildInferenceConfig(rm: ResolvedModel, input: InferenceInput): InferenceConfig;
    /**
     * Assemble `additionalModelRequestFields` members owned by this family (anthropic_beta, ...).
     * `thinking` is injected separately (universal) by the caller for Story 1.1.
     */
    buildAdditionalModelRequestFields?(rm: ResolvedModel, input: InferenceInput): Record<string, any>;
}

/** Is this Anthropic model on the opus-4.x / opus-5+ line that deprecated temperature & topP? */
function isDeprecatedOpus(rm: ResolvedModel): boolean {
    const m = rm.generation.match(/^opus-(\d+)$/);
    // TENTATIVE(OQ-4): the deprecation threshold (opus generation >= 4) is the currently-known
    // rule; a future opus line could change it. stage6 to confirm.
    return !!m && parseInt(m[1], 10) >= 4;
}

// anthropic_beta feature matchers — data-driven so new betas are one array entry.
// Matched against the raw (lowercased) modelId, in order, matching the legacy push order exactly.
const ANTHROPIC_BETA_MATCHERS: { match: string; features: string[] }[] = [
    { match: 'anthropic.claude-3-7-sonnet', features: ['output-128k-2025-02-19', 'token-efficient-tools-2025-02-19'] },
    { match: 'anthropic.claude-sonnet-4', features: ['context-1m-2025-08-07'] },
    { match: 'anthropic.claude-sonnet-4-5', features: ['context-management-2025-06-27'] },
];

function anthropicBetaFeatures(modelId: string): string[] {
    const id = (modelId || '').toLowerCase();
    const features: string[] = [];
    for (const m of ANTHROPIC_BETA_MATCHERS) {
        if (id.includes(m.match)) {
            features.push(...m.features);
        }
    }
    return features;
}

const anthropicClaudePolicy: FamilyPolicy = {
    buildInferenceConfig(rm, input) {
        const ic: InferenceConfig = { maxTokens: input.maxTokens };

        // Base sampling values with the legacy 0.7 defaults.
        let temperature = input.temperature || 0.7;
        const topP = input.topP || 0.7;
        let keepTemperature = true;
        let keepTopP = true;

        // thinking forces temperature=1 and drops topP (migrated from old inline behaviour).
        if (input.thinking) {
            keepTopP = false;
            temperature = 1;
        }

        if (isDeprecatedOpus(rm)) {
            // opus-4.x / opus-5: temperature and topP are both deprecated -> drop both.
            keepTemperature = false;
            keepTopP = false;
        } else {
            // Non-deprecated Anthropic: temperature and top_p cannot both be specified.
            // Decision uses the CLIENT-supplied values (not the defaulted ones), same as legacy.
            if (input.topP && !input.temperature) {
                keepTemperature = false;
            } else {
                keepTopP = false;
            }
        }

        if (keepTemperature) ic.temperature = temperature;
        if (keepTopP) ic.topP = topP;

        if (Array.isArray(input.stop)) {
            // TENTATIVE(OQ-5): stopSequences cap of 4 carried over from legacy behaviour.
            ic.stopSequences = input.stop.slice(0, 4);
        }
        return ic;
    },
    buildAdditionalModelRequestFields(rm, input) {
        // anthropic_beta is ALWAYS present for the Anthropic family (possibly an empty array),
        // preserving the legacy `additionalModelRequestFields["anthropic_beta"] = [...]` behaviour.
        return { anthropic_beta: anthropicBetaFeatures(input.modelId) };
    },
};

const FAMILY_POLICIES: Record<string, FamilyPolicy> = {
    'anthropic-claude': anthropicClaudePolicy,
    // Story 1.2: register non-Anthropic families here.
};

/**
 * Deny-all safe default for unknown / not-yet-modelled families (AD-9): keep only `maxTokens`,
 * drop every other sampling field. Anthropic-only story, so this is where non-Anthropic lands
 * until Story 1.2 adds their allow-set rows.
 */
const denyAllPolicy: FamilyPolicy = {
    buildInferenceConfig(_rm, input) {
        return { maxTokens: input.maxTokens };
    },
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Resolve the clipped `{ inferenceConfig, additionalModelRequestFields }` for a request.
 * Pure function: no I/O, no mutation of the input. Absent fields are omitted (never set to
 * `undefined`); `additionalModelRequestFields` is only returned when it has members (AD-8).
 */
export function resolveInferenceParams(input: InferenceInput): InferenceOutput {
    const rm = resolveModel(input.modelId);
    const policy = FAMILY_POLICIES[rm.family] || denyAllPolicy;

    const inferenceConfig = policy.buildInferenceConfig(rm, input);

    const additionalModelRequestFields: Record<string, any> = {};
    // thinking is injected universally for Story 1.1 (migrated as-is; Story 1.3 splits it per family).
    if (input.thinking) {
        additionalModelRequestFields.thinking = {
            type: 'enabled',
            budget_tokens: input.thinkBudget,
        };
    }
    if (policy.buildAdditionalModelRequestFields) {
        Object.assign(additionalModelRequestFields, policy.buildAdditionalModelRequestFields(rm, input));
    }

    const out: InferenceOutput = { inferenceConfig };
    if (Object.keys(additionalModelRequestFields).length > 0) {
        out.additionalModelRequestFields = additionalModelRequestFields;
    }
    return out;
}
