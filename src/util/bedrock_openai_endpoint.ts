// Stateless helper: build the OpenAI-SDK baseURL for the Bedrock OpenAI-compatible
// endpoint from an already-resolved region and endpoint variant (AD-6).
// This util does NOT resolve the region source, read config, or touch credentials —
// the caller (bedrock-openai provider) resolves the region once per request and passes
// it in. Invariant: the region used to mint the token === the region in this baseURL.

export interface ResolveBedrockOpenAIBaseURLParams {
  // Optional endpoint form. "runtime" (default) or "mantle".
  variant?: string;
  // Already-resolved, required region (e.g. "us-east-1"). Never hard-coded here.
  region: string;
}

// OpenAI SDK convention: when baseURL is set to "https://host/openai/v1", the SDK
// appends "/chat/completions" to it. Bedrock's OpenAI-compatible path is
// "/openai/v1/chat/completions", so the baseURL carries the "/openai/v1" suffix.
const OPENAI_PATH_SUFFIX = "/openai/v1";

export function resolveBedrockOpenAIBaseURL(params: ResolveBedrockOpenAIBaseURLParams): string {
  const variant = params && params.variant;
  const region = params && params.region;

  // strictNullChecks is off — the missing path must be checked explicitly.
  if (!region) {
    throw new Error(
      "resolveBedrockOpenAIBaseURL requires a resolved 'region'. It must be provided by the caller."
    );
  }

  if (variant === "mantle") {
    return `https://bedrock-mantle.${region}.api.aws${OPENAI_PATH_SUFFIX}`;
  }

  // Default / unknown variant → the recommended runtime form.
  return `https://bedrock-runtime.${region}.amazonaws.com${OPENAI_PATH_SUFFIX}`;
}
