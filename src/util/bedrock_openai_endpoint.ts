// Bedrock OpenAI-compatible endpoint util.
// Story 1.1: resolve region (reuse helper.selectRandomRegion) + pick one of two
// endpoint flavors, and produce a baseURL string for `new OpenAI({ baseURL })`.
// AD-2: util is one-directional and does NOT import any provider.
import helper from './helper';

// AD-8: the two supported Bedrock OpenAI-compatible endpoint flavors.
export const BEDROCK_OPENAI_FLAVOR_RUNTIME = 'bedrock-runtime';
export const BEDROCK_OPENAI_FLAVOR_MANTLE = 'bedrock-mantle';

// OQ-1: per AWS Bedrock docs the OpenAI-compatible surface is served over
// https at the `/openai/v1` path suffix.
const OPENAI_PATH_SUFFIX = '/openai/v1';

/**
 * Build the baseURL host for a given resolved region + flavor.
 * - default (bedrock-runtime): `bedrock-runtime.{region}.amazonaws.com`
 * - mantle (bedrock-mantle):   `bedrock-mantle.{region}.api.aws`
 */
export function bedrockOpenAIEndpointHost(region: string, flavor?: string): string {
  if (flavor === BEDROCK_OPENAI_FLAVOR_MANTLE) {
    return `bedrock-mantle.${region}.api.aws`;
  }
  return `bedrock-runtime.${region}.amazonaws.com`;
}

/**
 * Build the OpenAI-compatible baseURL to feed to `new OpenAI({ baseURL })`.
 *
 * @param config - runtime config (from modelData.config): reads `regions` and
 *                 `endpointFlavor`.
 * @param region - optional pre-resolved region. When supplied (the provider
 *                 resolves region ONCE and passes the SAME value here and to the
 *                 token util — MR-1 fix), the endpoint and the minted bearer are
 *                 guaranteed to share a region; a region-scoped bearer would
 *                 otherwise mismatch the endpoint's region and yield intermittent
 *                 403s under a multi-region config. When omitted, region is
 *                 resolved internally via `helper.selectRandomRegion` (AD-7); no
 *                 hardcoded region literal is used as the sole source.
 */
export default function buildBedrockOpenAIEndpoint(config: any, region?: string): string {
  const resolvedRegion = region ?? helper.selectRandomRegion(config && config.regions);
  const host = bedrockOpenAIEndpointHost(resolvedRegion, config && config.endpointFlavor);
  return `https://${host}${OPENAI_PATH_SUFFIX}`;
}
