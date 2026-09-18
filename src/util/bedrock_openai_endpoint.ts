// endpoint 选择与 region 解析（bedrock-openai provider）
// 纯函数式：只吐 baseURL / region，不铸 token、不构造 client、不碰凭证（AD-4）。
import helper from "./helper";

// 两种 endpoint 形态（AD-9）。默认 bedrock-runtime。
export type EndpointType = "bedrock-runtime" | "bedrock-mantle";

export interface BedrockOpenAIEndpointConfig {
  // 形态开关（Open Question 1：本模块选定 key 名 endpointType，并在测试固定）。
  endpointType?: EndpointType;
  region?: string;
  regions?: string | string[];
  [key: string]: unknown;
}

// OpenAI 兼容路径段：Bedrock 的 OpenAI-compatible endpoint 形如
// https://bedrock-runtime.<region>.amazonaws.com/openai/v1
// OpenAI SDK 会在其后自行追加 /chat/completions。
export const OPENAI_COMPAT_PATH = "/openai/v1";

// region 解析复用 helper.selectRandomRegion（AD-7）：配置 region/regions 优先，
// 否则回落到 config.bedrock.region || "us-east-1"。绝不在此硬编码 region。
export function resolveRegion(config: BedrockOpenAIEndpointConfig = {}): string {
  const regions = config.region ?? config.regions;
  return helper.selectRandomRegion(regions);
}

// 用解析出的 region 拼 baseURL。region 由调用方一次解析后传入，
// 避免多 region 随机场景下 baseURL 与 token 的 region 不一致。
export function buildBaseURL(
  region: string,
  config: BedrockOpenAIEndpointConfig = {}
): string {
  const endpointType: EndpointType =
    config.endpointType === "bedrock-mantle" ? "bedrock-mantle" : "bedrock-runtime";

  const host =
    endpointType === "bedrock-mantle"
      ? `bedrock-mantle.${region}.api.aws`
      : `bedrock-runtime.${region}.amazonaws.com`;

  return `https://${host}${OPENAI_COMPAT_PATH}`;
}

// 便捷入口：解析 region 后直接拼 baseURL。
export function resolveBaseURL(config: BedrockOpenAIEndpointConfig = {}): string {
  return buildBaseURL(resolveRegion(config), config);
}

export default { resolveRegion, buildBaseURL, resolveBaseURL, OPENAI_COMPAT_PATH };
