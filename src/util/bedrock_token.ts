// Mint short-lived Bedrock bearer tokens and resolve the outbound authentication
// priority for the bedrock-openai provider.
//
// Architecture contracts (must hold):
// - AD-2: never construct any `@aws-sdk/client-*` service client (no SigV4 fallback surface).
// - AD-3: the token is passed per-client, NEVER via `process.env`. (Counter-example:
//   `src/providers/bedrock_converse.ts:56` writes `process.env.AWS_BEARER_TOKEN_BEDROCK`.)
// - AD-4: mint on demand, no cache, no refresh scheduler; default 43200s, hard cap 43200s.
// - AD-5: single source of the auth priority — P1 bearerToken (as-is, no mint) >
//   P2 credentials (mint with them) > P3 default credential chain (mint).
import { getToken, getTokenProvider } from "@aws/bedrock-token-generator";

// 12 hours in seconds. Hard upper bound enforced by the token generator too, but we
// clamp locally so the provider never hands the generator an out-of-range value (AD-4).
const MAX_EXPIRES_IN_SECONDS = 43200;

// Static AWS credentials (AKSK, optional session token). Matches the shape the token
// generator accepts (`AwsCredentialIdentity`).
export interface BedrockCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface MintBedrockBearerTokenParams {
  // P2 path when present; P3 (default chain) when absent.
  credentials?: BedrockCredentials;
  // Already-resolved, required region.
  region: string;
  // Optional expiry; defaulted and clamped to MAX_EXPIRES_IN_SECONDS.
  expiresInSeconds?: number;
}

export interface ResolveBedrockBearerParams {
  // P1 path when present: used verbatim as the apiKey, no minting.
  bearerToken?: string;
  credentials?: BedrockCredentials;
  region: string;
  expiresInSeconds?: number;
}

// Clamp the requested expiry into (0, MAX]. Missing/invalid → default (MAX). This keeps
// the ≤12h invariant (AC-4) in a single place; the generator would otherwise throw on >MAX.
function clampExpiresInSeconds(expiresInSeconds?: number): number {
  if (expiresInSeconds === undefined || expiresInSeconds === null) {
    return MAX_EXPIRES_IN_SECONDS;
  }
  if (expiresInSeconds <= 0 || expiresInSeconds > MAX_EXPIRES_IN_SECONDS) {
    return MAX_EXPIRES_IN_SECONDS;
  }
  return expiresInSeconds;
}

// Mint a fresh bearer token per request (no caching). With explicit credentials → P2;
// without → P3 default credential chain via the generator's own default providers.
export async function mintBedrockBearerToken(
  params: MintBedrockBearerTokenParams
): Promise<string> {
  const region = params && params.region;
  if (!region) {
    throw new Error("mintBedrockBearerToken requires a resolved 'region'.");
  }
  const expiresInSeconds = clampExpiresInSeconds(params.expiresInSeconds);

  if (params.credentials) {
    // P2 — mint with the supplied static credentials.
    return getToken({
      credentials: params.credentials,
      region,
      expiresInSeconds,
    });
  }

  // P3 — default credential chain. getTokenProvider() resolves credentials from the
  // AWS default provider chain internally; the credential-provider lives behind this
  // boundary and is not an `@aws-sdk/client-*` service client (AL-1 / AD-2).
  const provideToken = getTokenProvider({ region, expiresInSeconds });
  return provideToken();
}

// Single source of the outbound auth priority (AD-5). The provider calls this once per
// request to obtain the value it passes as `new OpenAI({ apiKey })`.
export async function resolveBedrockBearer(params: ResolveBedrockBearerParams): Promise<string> {
  // P1 — explicit bearer token: use verbatim, do NOT mint.
  if (params.bearerToken) {
    return params.bearerToken;
  }
  // P2 (credentials present) / P3 (default chain) — mint.
  return mintBedrockBearerToken({
    credentials: params.credentials,
    region: params.region,
    expiresInSeconds: params.expiresInSeconds,
  });
}
