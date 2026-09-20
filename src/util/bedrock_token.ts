// Bedrock bearer-token util.
// Story 1.2: resolve a short-lived bearer for outbound Bedrock auth along three
// authentication paths. This util is the single decision point (AD-3).
//
// Hard invariants:
// - AD-2: does NOT import any provider (one-directional util dependency).
// - AD-4: NEVER writes process.env (esp. AWS_BEARER_TOKEN_BEDROCK). The bearer
//         only leaves as a return value → new OpenAI({ apiKey }).
// - AD-5: NEVER constructs any AWS SDK client and never sets authSchemePreference,
//         so there is no silent SigV4 fallback.
import { getToken, getTokenProvider } from '@aws/bedrock-token-generator';
import helper from './helper';

// The library caps token lifetime at 12h; keep our requested TTL within it.
export const MAX_TOKEN_EXPIRES_IN_SECONDS = 43200; // 12h

function resolveExpiresInSeconds(config: any): number {
  const requested = config && config.tokenExpiresInSeconds;
  if (typeof requested === 'number' && requested > 0) {
    return Math.min(requested, MAX_TOKEN_EXPIRES_IN_SECONDS);
  }
  return MAX_TOKEN_EXPIRES_IN_SECONDS;
}

/**
 * Resolve a bearer token for the Bedrock OpenAI-compatible transport.
 *
 * Priority (AD-3, the single decision point):
 *   ① explicit `config.bearerToken`  → returned as-is, NOT minted.
 *   ② explicit `config.credentials`  → mint with those credentials.
 *   ③ default credential chain       → mint via the default provider.
 *
 * @returns the bearer string; it is only ever returned, never written to env.
 */
export default async function resolveBearerToken(config: any): Promise<string> {
  // ① explicit bearerToken — highest priority, use directly (do not mint).
  if (config && config.bearerToken) {
    return config.bearerToken;
  }

  // Region is only needed for minting; reuse helper (AD-7), never hardcode.
  const region = helper.selectRandomRegion(config && config.regions);
  const expiresInSeconds = resolveExpiresInSeconds(config);

  // ② explicit credentials — mint with them.
  const credentials = helper.selectCredentials(
    config && config.credentials,
    config && config.excludeAccessKeyId
  );
  if (credentials) {
    return getToken({ credentials, region, expiresInSeconds });
  }

  // ③ default credential chain — mint via the default token provider.
  const provideToken = getTokenProvider({ region, expiresInSeconds });
  return provideToken();
}
