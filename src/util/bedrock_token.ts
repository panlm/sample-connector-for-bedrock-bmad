// 出站认证：按三档优先级铸/取 bearer，作 apiKey 注入并产出已认证的 OpenAI client。
// AD-2：走 OpenAI SDK，bearer 作 apiKey，全路径不构造任何 AWS SDK client。
// AD-5：凭证 per-client 传，禁 process.env（勿复制 bedrock_converse.ts:56）。
import OpenAI from "openai";
import { getToken, getTokenProvider } from "@aws/bedrock-token-generator";
import helper from "./helper";

// AD-8：铸出的 bearer 有效期 ≤ 12h。token-generator 上限即 12h（43200s）。
export const MAX_BEARER_TOKEN_TTL_SECONDS = 12 * 60 * 60; // 43200

export interface BedrockTokenConfig {
  // 显式 bearer（最高优先级）。
  bearerToken?: string;
  // 显式 AWS 凭证：单个 { accessKeyId, secretAccessKey, sessionToken? } 或其数组。
  credentials?: unknown;
  [key: string]: unknown;
}

// 三档优先级（AD-3）：显式 bearerToken > 显式 credentials > 默认凭证链。顺序不能反。
export async function mintBearerToken(
  config: BedrockTokenConfig,
  region: string
): Promise<string> {
  // 1) 显式 bearerToken：直接用作 apiKey，不再铸。
  if (config?.bearerToken) {
    return config.bearerToken;
  }

  // 2) 显式 credentials：用该凭证铸短期 bearer（≤12h）。
  if (config?.credentials) {
    let credentials: unknown = config.credentials;
    if (Array.isArray(credentials)) {
      // 复用 helper.selectCredentials 处理凭证数组选取。
      credentials = helper.selectCredentials(credentials, null);
    }
    return getToken({
      credentials: credentials as never,
      region,
      expiresInSeconds: MAX_BEARER_TOKEN_TTL_SECONDS,
    });
  }

  // 3) 默认凭证链：不传 credentials，token-generator 走默认 provider 铸 bearer。
  const provideToken = getTokenProvider({
    region,
    expiresInSeconds: MAX_BEARER_TOKEN_TTL_SECONDS,
  });
  return provideToken();
}

// AD-2/AD-4：bearer 作 apiKey 传进 new OpenAI({ apiKey, baseURL })，收敛 apiKey 注入。
export function buildOpenAIClient(bearerToken: string, baseURL: string): OpenAI {
  return new OpenAI({ apiKey: bearerToken, baseURL });
}

// 公共表面：铸 bearer + 注入 apiKey，产出已认证的 OpenAI client。
// 每次调用新建 client（AD-6：防多租户串号，凭证不跨租户复用）。
export async function createBedrockOpenAIClient(
  config: BedrockTokenConfig,
  baseURL: string,
  region: string
): Promise<OpenAI> {
  const bearerToken = await mintBearerToken(config, region);
  return buildOpenAIClient(bearerToken, baseURL);
}

export default { mintBearerToken, buildOpenAIClient, createBedrockOpenAIClient, MAX_BEARER_TOKEN_TTL_SECONDS };
