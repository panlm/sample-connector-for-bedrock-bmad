/**
 * inference_params —— bedrock-converse 采样参数「按 (家族, 代次) 裁剪」的唯一真相源。
 *
 * 设计不变量（来自架构 BMAD-212 ARCHITECTURE-SPINE AD-1..8）：
 *  - AD-1 表是唯一真相源；`buildInferenceParams` / `buildThinking` 为纯函数，不 mutate 入参、无副作用。
 *  - AD-2 家族/代次判定单一入口 `resolveModelClass`；代次用**数值匹配**，禁止用字符串 includes 判代次。
 *  - AD-3 `ALLOW_TABLE` 可枚举、键恒为 {anthropic, nova, llama, default}；每行含 placement + generationOverrides 槽 + 来源注释；新增家族 = 增一行。
 *  - AD-4 默认拒绝白名单；显式输入 = key 存在（`!== undefined`），**禁止 `|| 0.7` falsy 合并**（temperature:0 / top_p:0 是合法已给值）；不注入采样默认。
 *  - AD-5 落位由表声明：inferenceConfig 收 maxTokens/temperature/topP/stopSequences；AMF 收 Anthropic top_k、thinking；Nova topK 走 `additionalModelRequestFields.inferenceConfig.topK` 嵌套。
 *  - AD-6 thinking 独立 builder；支持性来自表元数据，禁止 modelId.includes。
 *  - AD-7 default = 只 maxTokens；三家外一切 modelId 落此。
 *  - AD-8 组合契约由 bedrock_converse.toPayload 执行：maxTokens 调 builder 前解析终态；固定序合并，buildThinking patch 后且覆盖；AMF 每 key 单一 producer。
 */

export type Family = 'anthropic' | 'nova' | 'llama' | 'default';

export interface Generation {
    major: number;
    minor: number;
}

export interface ModelClass {
    family: Family;
    generation: Generation;
}

/** builder 的规范化输出：最终请求体两大容器的 fragment。 */
export interface InferenceFragment {
    inferenceConfig: Record<string, any>;
    additionalModelRequestFields: Record<string, any>;
}

/** buildThinking 的输出：由组合方按 AD-8 固定序 patch 到 inference fragment 之上。 */
export interface ThinkingFragment {
    /** 该家族是否支持 thinking（来自表元数据，AD-6）。 */
    supported: boolean;
    /** patch 进 inferenceConfig 的键（如 temperature=1），覆盖家族裁剪结果。 */
    inferenceConfig: Record<string, any>;
    /** 是否删掉 inferenceConfig.topP（thinking 与 topP 互斥）。 */
    dropTopP: boolean;
    /** 是否删掉 additionalModelRequestFields.top_k（Anthropic 扩展推理禁改 top_k，同传 → 400，FR-6）。 */
    dropTopK: boolean;
    /** patch 进 additionalModelRequestFields 的键（thinking 块）。 */
    additionalModelRequestFields: Record<string, any>;
}

/** 客户端（OpenAI 风格）传入的采样参数，未经裁剪。 */
export interface ClientParams {
    /** maxTokens 已由调用方解析终态（AD-8①），恒放行。 */
    maxTokens: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    stop?: any;
}

type Placement = 'inferenceConfig' | 'amf' | 'amf.inferenceConfig';

/** 单个客户端参数 → Bedrock 目标键 + 落位。 */
interface ParamSpec {
    /** 目标对象里的键名（Bedrock 命名）。 */
    target: string;
    placement: Placement;
}

/** 代次级覆盖规则的结构槽（AD-3）。1.1 建槽，1.2 填 Anthropic 4.5 二选一。 */
interface GenerationOverride {
    /** 命中条件：数值代次匹配（AD-2），不得 modelId.includes。 */
    when: (g: Generation) => boolean;
    /** 互斥约束：这两个 inferenceConfig 键不能同时出现，保留 keep、裁掉另一个。 */
    mutuallyExclusive: [string, string];
    keep: string;
    /** 来源注释（供审阅追溯）。 */
    source: string;
}

interface FamilyRow {
    /** 来源注释（AD-3：每行必须有来源）。查不到来源标 `// 未确认，保守最小集`。 */
    source: string;
    /** 白名单：客户端 key → 落位规格。表未列的 key 一律裁掉（默认拒绝，AD-4）。 */
    params: Record<string, ParamSpec>;
    /** 该家族是否支持 thinking（AD-6）。 */
    thinkingSupported: boolean;
    /** 代次级覆盖槽（AD-3）。空数组 = 无代次特例。 */
    generationOverrides: GenerationOverride[];
}

// ————————————————————————————————————————————————————————————————
// 放行表（ALLOW_TABLE）—— AD-3：键恒为 {anthropic, nova, llama, default}
// 取值照 PRD BMAD-210 §4 FR-3 表。
// ————————————————————————————————————————————————————————————————
export const ALLOW_TABLE: Record<Family, FamilyRow> = {
    // 来源：Anthropic Claude on Bedrock Converse —— 支持 temperature/topP/top_k/stopSequences；
    // top_k 走 additionalModelRequestFields（非顶层 inferenceConfig）。
    // 代次二选一：**全部 Anthropic** 家族在客户端同给 temperature+topP 时只留其一（保留 temperature、裁 topP），
    // 由 generationOverrides 声明。见下方 `when` 处对该 C 类硬约束偏离的完整论证。
    anthropic: {
        source: 'Anthropic on Bedrock Converse: maxTokens/temperature/topP/top_k(AMF)/stopSequences',
        params: {
            temperature: { target: 'temperature', placement: 'inferenceConfig' },
            top_p: { target: 'topP', placement: 'inferenceConfig' },
            top_k: { target: 'top_k', placement: 'amf' },
            stop: { target: 'stopSequences', placement: 'inferenceConfig' },
        },
        thinkingSupported: true,
        generationOverrides: [
            {
                // C 类硬约束偏离（stage6 回炉必修 2，reviewer 复审时独立复核）：
                //  · 原约束：PRD BMAD-210 FR-4 收窄为「仅 Claude 4.5 强制二选一」。
                //  · 为何不可满足：BMAD-201 缺陷 #2 明文要求 Opus5/Sonnet5（major≥5）同传 temp+topP 不得 400；
                //    PRD「不适用于更旧模型」只覆盖了“旧”方向，漏了 major≥5 这个“更新”方向；且 base 原本对**全部**
                //    Anthropic 二选一（"temperature and top_p cannot both be specified"），收窄到仅 4.5 既漏 Opus5 又回归了 opus-4。
                //  · 原意图（本 issue 核心 axiom）：采样拼装后不因多传而 400（少传不会错、多传才 400），并覆盖需求点名的 Opus5。
                //  · 修法（保守安全解）：对全部 Anthropic，客户端同给 temperature+topP 时统一保留 temperature、裁 topP。
                //    一刀同修 ①Opus5/Sonnet5（缺陷 #2）②恢复 opus-4/3.x 保护（修回归）③裁一参永不 400（本 issue 已接受此权衡）。
                when: () => true,
                mutuallyExclusive: ['temperature', 'topP'],
                keep: 'temperature',
                source: 'BMAD-201 缺陷 #2 + base 全 Anthropic 二选一 — 全部 Anthropic 同给 temperature/topP 时保留 temperature、裁 topP（stage6 回炉必修 2，C 类偏离）',
            },
        ],
    },
    // 来源：Amazon Nova on Bedrock Converse —— topK 走嵌套 additionalModelRequestFields.inferenceConfig.topK（AD-5 / AC-8）。
    nova: {
        source: 'Amazon Nova on Bedrock Converse: maxTokens/temperature/topP/topK(AMF.inferenceConfig 嵌套)/stopSequences',
        params: {
            temperature: { target: 'temperature', placement: 'inferenceConfig' },
            top_p: { target: 'topP', placement: 'inferenceConfig' },
            top_k: { target: 'topK', placement: 'amf.inferenceConfig' },
            stop: { target: 'stopSequences', placement: 'inferenceConfig' },
        },
        thinkingSupported: false,
        generationOverrides: [],
    },
    // 来源：Meta Llama on Bedrock Converse —— 只支持 maxTokens/temperature/topP，**不放行 top_k**。
    // stopSequences 未确认，保守最小集（默认裁剪，OQ-2；若后续拍板放行再增一行）。
    llama: {
        source: 'Meta Llama on Bedrock Converse: maxTokens/temperature/topP（不放行 top_k）',
        params: {
            temperature: { target: 'temperature', placement: 'inferenceConfig' },
            top_p: { target: 'topP', placement: 'inferenceConfig' },
            // stopSequences: 未确认，保守最小集 —— OQ-2 默认裁剪，不列入白名单。
        },
        thinkingSupported: false,
        generationOverrides: [],
    },
    // default（未知家族）：未确认，保守最小集 —— 只放行 maxTokens，其余一律裁掉（AD-7 / AC-6）。
    default: {
        source: '未确认，保守最小集 —— 未知家族只放行 maxTokens（AD-7）',
        params: {},
        thinkingSupported: false,
        generationOverrides: [],
    },
};

/**
 * 家族 + 代次判定的唯一入口（AD-2）。
 * 代次用数值匹配，修复旧 `isOpus4OrLater = modelId.includes("claude-opus-4")` 漏掉 opus-5 / sonnet-4-5 的坑。
 */
export function resolveModelClass(modelId: string): ModelClass {
    const id = (modelId || '').toLowerCase();

    let family: Family = 'default';
    if (id.includes('anthropic') || id.includes('claude')) {
        family = 'anthropic';
    } else if (id.includes('nova')) {
        family = 'nova';
    } else if (id.includes('llama')) {
        family = 'llama';
    }

    let generation: Generation = { major: 0, minor: 0 };
    if (family === 'anthropic') {
        generation = parseAnthropicGeneration(id);
    }

    return { family, generation };
}

/**
 * 从 Anthropic modelId 数值提取代次。两种命名并存：
 *  - 旧命名 `claude-<major>[-<minor>]-<name>`  例：claude-3-5-sonnet → 3.5、claude-3-haiku → 3.0
 *  - 新命名 `claude-<name>-<major>[-<minor>]`  例：claude-sonnet-4-5 → 4.5、claude-opus-4 → 4.0、claude-opus-4-1 → 4.1
 * major/minor 限 1-2 位并用 `(?!\d)` 排除后缀日期（如 -20250514）被误当代次。
 */
function parseAnthropicGeneration(id: string): Generation {
    // 旧命名优先（name 在数字之后，锚点清晰）。
    let m = id.match(/claude-(\d{1,2})(?:-(\d{1,2}))?-(?:sonnet|opus|haiku)/);
    if (m) {
        return { major: parseInt(m[1], 10), minor: m[2] ? parseInt(m[2], 10) : 0 };
    }
    // 新命名（name 在前，数字在后；用 (?!\d) 挡住随后的日期段）。
    m = id.match(/(?:sonnet|opus|haiku)-(\d{1,2})(?:-(\d{1,2})(?!\d))?/);
    if (m) {
        return { major: parseInt(m[1], 10), minor: m[2] ? parseInt(m[2], 10) : 0 };
    }
    return { major: 0, minor: 0 };
}

/**
 * 纯函数 builder：按放行表把客户端采样参数裁剪并落位（AD-1/4/5）。
 * 默认拒绝：先收客户端显式输入（key 存在即 `!== undefined`，禁止 `||` falsy 合并），再用表白名单过滤，表未列 = 删。
 * 系统不注入采样默认（temperature/topP 默认注入已彻底移除）。maxTokens 恒放行（已由调用方解析终态）。
 */
export function buildInferenceParams(modelClass: ModelClass, clientParams: ClientParams): InferenceFragment {
    const row = ALLOW_TABLE[modelClass.family];
    const inferenceConfig: Record<string, any> = {};
    const additionalModelRequestFields: Record<string, any> = {};

    // maxTokens 恒放行（AD-8①：调用方已解析终态）。
    inferenceConfig.maxTokens = clientParams.maxTokens;

    // 收客户端显式输入 —— key 存在（!== undefined）才算给了；禁止 falsy 合并。
    const explicit: Record<string, any> = {};
    if (clientParams.temperature !== undefined) explicit.temperature = clientParams.temperature;
    if (clientParams.top_p !== undefined) explicit.top_p = clientParams.top_p;
    if (clientParams.top_k !== undefined) explicit.top_k = clientParams.top_k;
    if (clientParams.stop !== undefined) explicit.stop = clientParams.stop;

    // 表白名单过滤 + 落位。表未列的 key 直接丢弃。
    for (const clientKey of Object.keys(explicit)) {
        const spec = row.params[clientKey];
        if (!spec) continue; // 默认拒绝：表未列即裁剪
        const value = normalizeValue(clientKey, explicit[clientKey]);
        if (value === undefined) continue; // 规范化后无效（如 stop 非数组）
        place(inferenceConfig, additionalModelRequestFields, spec, value);
    }

    // 代次级覆盖（AD-3 结构槽；1.2 填 Anthropic 4.5 二选一）。
    for (const ov of row.generationOverrides) {
        if (!ov.when(modelClass.generation)) continue;
        const [a, b] = ov.mutuallyExclusive;
        if (inferenceConfig[a] !== undefined && inferenceConfig[b] !== undefined) {
            const drop = ov.keep === a ? b : a;
            delete inferenceConfig[drop];
        }
    }

    return { inferenceConfig, additionalModelRequestFields };
}

/**
 * stop → stopSequences：截断前 4 项。
 * 接受两种 OpenAI 合法形态：字符串（`stop:"END"` → `["END"]`）与数组；空数组 / 非法值 → undefined（不下发）。
 */
function normalizeValue(clientKey: string, value: any): any {
    if (clientKey === 'stop') {
        if (typeof value === 'string') return [value];
        if (Array.isArray(value)) return value.length > 0 ? value.slice(0, 4) : undefined;
        return undefined;
    }
    return value;
}

function place(
    inferenceConfig: Record<string, any>,
    amf: Record<string, any>,
    spec: ParamSpec,
    value: any,
): void {
    if (spec.placement === 'inferenceConfig') {
        inferenceConfig[spec.target] = value;
    } else if (spec.placement === 'amf') {
        amf[spec.target] = value;
    } else if (spec.placement === 'amf.inferenceConfig') {
        // Nova topK 嵌套（AD-5 / AC-8）。
        if (!amf.inferenceConfig) amf.inferenceConfig = {};
        amf.inferenceConfig[spec.target] = value;
    }
}

/**
 * thinking 独立 builder（AD-6）。支持性来自表元数据，禁止 modelId.includes。
 * 不支持家族 → supported=false，组合方不下发 thinking 且不动采样（AC-13）。
 * 支持家族 → 下发 thinking 块、inferenceConfig.temperature=1、删 topP、删 AMF.top_k（AC-12 基础 / FR-6）。
 *
 * budget 约束（FR-6 / AC-12）：`budget_tokens >= 1024`（本 builder 兜底下限）；
 * `budget_tokens < maxTokens` 由 AD-8① 的 maxTokens 终态解析保证（调用方在 maxTokens<=budget 时抬升 maxTokens=budget+1024）。
 *
 * OQ-1 风险：`thinking.type` 保持 `"enabled"`。已知该值在 Claude 4.7+/Opus5/Sonnet5 上可能返回 400，
 * 但按 OQ-1 默认**保持现状不静默改**（是否迁 adaptive 属范围外产品决策）。
 */
export function buildThinking(
    modelClass: ModelClass,
    thinking: { enabled: boolean; budget?: number },
    maxTokens: number,
): ThinkingFragment {
    const empty: ThinkingFragment = {
        supported: false,
        inferenceConfig: {},
        dropTopP: false,
        dropTopK: false,
        additionalModelRequestFields: {},
    };

    const row = ALLOW_TABLE[modelClass.family];
    if (!row.thinkingSupported) return empty; // 不支持家族：不下发 thinking（AC-13）
    if (!thinking || !thinking.enabled) return empty;

    let budget = thinking.budget;
    if (!budget || budget < 1024) {
        budget = 1024; // 下限 budget_tokens >= 1024
    }
    // maxTokens 已由调用方保证 > budget（AD-8①）；此处不再重复抬升，仅防御性引用。
    void maxTokens;

    return {
        supported: true,
        inferenceConfig: { temperature: 1 },
        dropTopP: true,
        // FR-6：Anthropic 扩展推理禁改 top_k，若客户端给了 top_k 会同传 → 400，故 thinking 开启时必删。
        dropTopK: true,
        additionalModelRequestFields: {
            thinking: {
                type: 'enabled', // OQ-1：保持现状；Claude 4.7+/Opus5/Sonnet5 可能 400，评审知悉。
                budget_tokens: budget,
            },
        },
    };
}
