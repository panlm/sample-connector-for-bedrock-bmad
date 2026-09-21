# bedrock-openai

Forwards standard OpenAI-shaped chat requests to Amazon Bedrock's **OpenAI-compatible endpoint** (`/openai/v1/chat/completions`), authenticated with a freshly minted, short-lived **bearer token** (`Authorization: Bearer <token>`).

## What it is / when to use it

This provider uses the official `openai` SDK to talk directly to Bedrock's OpenAI-compatible path. Unlike [`bedrock-converse`](./bedrock-converse.md) — which calls the AWS SDK's Converse API and constructs `@aws-sdk/client-*` service clients — `bedrock-openai` **never constructs any `@aws-sdk/client-*` service client**. Every request goes out as an OpenAI-SDK call carrying a bearer token.

Choose `bedrock-openai` when you want to reach Bedrock through the OpenAI SDK / OpenAI-compatible tooling, or when an OpenAI-shaped request path is required. Choose `bedrock-converse` for the broadest Bedrock model coverage and Converse-specific features (prompt caching, per-family parameter pruning, etc.).

> Source of truth for this page: `src/providers/bedrock_openai.ts`, `src/util/bedrock_token.ts`, `src/util/bedrock_openai_endpoint.ts` on `main` (`ccef68b`).

## Model row configuration

The provider reads the following keys from the model's `config` object (`bedrock_openai.ts:29-49`, region resolution at `resolveRegion()` `29-41`):

| Key | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `region` / `regions` | string / string[] | **Yes** | *(none)* | Single source of truth for the region — fed to BOTH the baseURL and the token mint. When `regions` is an array, the **first** element is used. Missing → error (see below). |
| `model` | string | No | *(none)* | Fallback model id. Used only when the incoming request carries no `model_id`. |
| `endpointVariant` | string | No | `runtime` | Endpoint form: `runtime` or `mantle` (see [Endpoint variant](#endpoint-variant)). |
| `bearerToken` | string | No | *(none)* | **P1** auth — used verbatim, no token minting (see [Outbound authentication](#outbound-authentication)). |
| `credentials` | object | No | *(none)* | **P2** auth — static AWS credentials `{ accessKeyId, secretAccessKey, sessionToken? }` used to mint a token. |
| `expiresInSeconds` | number | No | `43200` | Minted-token lifetime in seconds. Values outside `(0, 43200]` are clamped to `43200`. |

Unlike `bedrock-converse` (which defaults `regions` to `["us-east-1"]`), **`bedrock-openai` has no region default** — a missing `region`/`regions` throws (`bedrock_openai.ts:35-39`):

```
You must specify the parameter 'region' (or 'regions') in the backend model configuration.
```

Minimal configuration example:

```json
{
  "provider": "bedrock-openai",
  "config": {
    "region": "us-east-1",
    "model": "openai.gpt-oss-20b-1:0"
  }
}
```

## Outbound authentication

There are three ways to authenticate outbound requests. They share a single priority resolver, `resolveBedrockBearer()` (`bedrock_token.ts:83-94`), evaluated in order **P1 > P2 > P3**:

| Priority | Trigger (`config` field) | Behavior | Source |
| --- | --- | --- | --- |
| **P1** | `bearerToken` present | Used **verbatim** as the OpenAI `apiKey`. **No token is minted.** | `bedrock_token.ts:84-87` |
| **P2** | `credentials` present (no `bearerToken`) | Mints a token with those static credentials via `getToken()`. | `bedrock_token.ts:65-72` |
| **P3** | neither present | Mints a token from the AWS **default credential chain** via `getTokenProvider()`. | `bedrock_token.ts:74-79` |

The resolved value is passed straight into `new OpenAI({ baseURL, apiKey })` (`bedrock_openai.ts:53-64`).

Behavioral facts worth knowing when configuring auth:

- **Tokens are minted per request — no cache, no refresh scheduler.** Each request mints (or reuses the verbatim P1 token) fresh (`bedrock_token.ts:8, 54`).
- **The token is never written to `process.env`.** It is passed per-client only (`bedrock_token.ts:6-7`). (For contrast, `bedrock-converse` does write `process.env.AWS_BEARER_TOKEN_BEDROCK`.)
- **The OpenAI client is a per-request, function-local `const`** — it is never stored on the provider instance, so one tenant's bearer cannot leak into another tenant's request (`bedrock_openai.ts:60-64`).

### P1 — explicit `bearerToken`

```json
{
  "provider": "bedrock-openai",
  "config": {
    "region": "us-east-1",
    "bearerToken": "<your-bedrock-bearer-token>"
  }
}
```

### P2 — explicit static credentials

```json
{
  "provider": "bedrock-openai",
  "config": {
    "region": "us-east-1",
    "credentials": {
      "accessKeyId": "AKIA...",
      "secretAccessKey": "...",
      "sessionToken": "..."
    },
    "expiresInSeconds": 3600
  }
}
```

`sessionToken` is optional (`bedrock_token.ts:19-23`). `expiresInSeconds` is optional and clamped as described above.

### P3 — AWS default credential chain

```json
{
  "provider": "bedrock-openai",
  "config": {
    "region": "us-east-1"
  }
}
```

With neither `bearerToken` nor `credentials` set, the token is minted from the AWS default credential chain (environment, shared config/credentials files, container/instance roles, etc.), resolved internally by the token generator.

## Endpoint variant

`endpointVariant` selects the Bedrock host the baseURL points at (`bedrock_openai_endpoint.ts:19-35`):

| `endpointVariant` | baseURL | Source |
| --- | --- | --- |
| unset / `runtime` / any unknown value (**default branch**) | `https://bedrock-runtime.{region}.amazonaws.com/openai/v1` | `bedrock_openai_endpoint.ts:34-35` |
| `mantle` | `https://bedrock-mantle.{region}.api.aws/openai/v1` | `bedrock_openai_endpoint.ts:30-31` |

- **The default is `runtime`.** Any unrecognized value silently falls back to `runtime` (no error).
- The `/openai/v1` path suffix is fixed; the OpenAI SDK appends `/chat/completions` (`bedrock_openai_endpoint.ts:14-17`).
- `{region}` is the region resolved once from config, so the token region always matches the baseURL region.

## IAM prerequisites

> ⚠️ **This section deliberately does not assert IAM action names.** Getting them wrong means anyone who configures permissions from this doc will hit `403`, and — critically — **the failure will not reproduce when testing locally with administrator credentials.**

What the code lets us confirm:

- The provider **constructs no `@aws-sdk/client-*` service client on any auth path**, so there is **no bare SigV4 call path** (`bedrock_token.ts:5`; asserted by `test/bedrock_token.test.ts:181-194`). All three auth paths go out as `Authorization: Bearer <token>`.
- **P1 (`bearerToken`):** the token is supplied out-of-band by the operator. This codebase does not issue it, so the permissions required to obtain it depend entirely on how and where the operator mints it — not determinable from this repo.
- **P2 / P3:** the token is minted by `@aws/bedrock-token-generator` — `getToken()` (P2, static credentials) / `getTokenProvider()` (P3, default chain) (`bedrock_token.ts:11, 65-79`). The **identity** used to mint is determinable from the code; the **IAM action names** required are not — no `bedrock:` / `InvokeModel` / `GetBearerToken`-style action string appears anywhere in the provider's code path.

| Item | Required IAM action | Status |
| --- | --- | --- |
| Mint token via `getToken()` / `getTokenProvider()` (P2 / P3) | *(action name)* | **Untested** |
| Call `/openai/v1/chat/completions` (`bedrock-runtime` host) | *(action name)* | **Untested** |
| Call `/openai/v1/chat/completions` (`bedrock-mantle` host) | *(action name)* | **Untested** |

**"Untested" is a firm statement, not a placeholder to be filled by inference.** The token-minting path and a bare SigV4 path do **not** use the same authorization action, and there is no bare SigV4 path here to reason from. Do **not** substitute `bedrock:InvokeModel` (or any action inferred from "Bedrock calls generally need X"). To resolve these, an engineer must test P2/P3 minting plus one `chat/completions` call **under a least-privilege IAM role** and record the action that is actually denied/allowed.

## Request / response behavior

- Sampling parameters forwarded upstream (`bedrock_openai.ts:88-98, 126-135`): `temperature` (default `1.0`), `top_p` (default `1.0`), `max_tokens`, `max_completion_tokens`, and optional `tools` / `tool_choice` (forwarded only when present).
- When the request omits `model_id` and the config sets `model`, the request's `model_id` is filled from config (`bedrock_openai.ts:66-68`).
- Streaming responses expose `reasoning_content` in the delta, consistent with other providers (`bedrock_openai.ts:102-103`).

## Troubleshooting

| Symptom | Likely cause | Source |
| --- | --- | --- |
| `You must specify the parameter 'region' (or 'regions')...` | No `region`/`regions` set. There is no default. | `bedrock_openai.ts:35-39` |
| `mintBedrockBearerToken requires a resolved 'region'.` | Region resolved to empty when minting. | `bedrock_token.ts:60-61` |
| `resolveBedrockOpenAIBaseURL requires a resolved 'region'...` | Region resolved to empty when building the baseURL. | `bedrock_openai_endpoint.ts:24-27` |
| `401` / `403` on requests | Authentication/authorization failure — see [Outbound authentication](#outbound-authentication) and [IAM prerequisites](#iam-prerequisites). **Note: insufficient permissions will not reproduce when testing with administrator credentials.** | — |
| `expiresInSeconds` seems ignored for large/zero values | Values outside `(0, 43200]` are silently clamped to `43200`. This is behavior, not an error. | `bedrock_token.ts:42-52` |
