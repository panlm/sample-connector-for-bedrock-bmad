# bedrock-openai

Amazon Bedrock via the OpenAI-compatible transport.

This provider talks to Amazon Bedrock's OpenAI-compatible surface (the
`/openai/v1` path) using the **OpenAI SDK**. A **bearer token** — either minted
(with a default and maximum lifetime of 12h) or supplied explicitly — is
resolved for outbound auth and passed as the OpenAI `apiKey`. It never
constructs an AWS SDK client and never writes `process.env`.

## When to use it (vs. `bedrock-converse`)

| | `bedrock-openai` | `bedrock-converse` |
| --- | --- | --- |
| Transport | OpenAI SDK against Bedrock's `/openai/v1` endpoint | AWS SDK Converse API |
| Outbound auth | Bearer token as the OpenAI `apiKey` | Two modes: ① `bearerToken` → written to `AWS_BEARER_TOKEN_BEDROCK` in `process.env`; ② `credentials`/AKSK → set as the AWS SDK client's `credentials` (SigV4 signing) |
| Writes `process.env` | **No** — the bearer only ever leaves as a return value | Only in the `bearerToken` mode (writes `AWS_BEARER_TOKEN_BEDROCK`); the AKSK/SigV4 mode sets the SDK client's `credentials` and does **not** write env |
| Silent SigV4 fallback | **No** — a bearer/auth failure is a hard failure | n/a |

Choose `bedrock-openai` when you want to reach Bedrock through the OpenAI
API shape (for tools and clients that already speak OpenAI), or when you
prefer bearer-token auth over ambient AWS credentials in `process.env`.
Choose `bedrock-converse` for the full Bedrock Converse feature set (prompt
caching, per-model inference parameters, etc.).

> Note: this provider does **not** fall back to SigV4. If the bearer is
> invalid or lacks permission, the request fails outright — it is not retried
> through an AWS SDK client.

## Model row configuration

Configure a model row with `provider: bedrock-openai`. Minimal config:

```json
{
  "model": "<bedrock-model-id served by the OpenAI-compatible endpoint>",
  "regions": ["us-east-1"]
}
```

`model` is used as the fallback `model_id` when the incoming request does not
carry one. `regions` accepts a single string or an array; with multiple
regions one is picked at random per call. A single string is **split on
commas** (e.g. `"us-east-1,us-west-2"`), so a comma-separated string is treated
as a multi-region list from which one region is chosen at random.

### Configuration keys

All key names are camelCase, matching the implementation exactly.

| Key | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `model` | string | N | — | Model id. Used as the fallback `model_id` when the request omits one. |
| `regions` | string \| string[] | N | `config.bedrock.region`, else `us-east-1` | Single region or list. A string is split on commas and treated as a list; with a list, one region is chosen at random per call. When unset, the primary default is `config.bedrock.region`; `us-east-1` is only the last-resort fallback. |
| `endpointFlavor` | `bedrock-runtime` \| `bedrock-mantle` | N | `bedrock-runtime` | Selects the endpoint host. See [Endpoint flavor](#endpoint-flavor). |
| `bearerToken` | string | N | — | An explicit bearer token, used as-is (no minting). Highest priority. |
| `credentials` | object[] | N | — | AWS credential objects (`{ accessKeyId, secretAccessKey }`) used to mint a bearer. See [Outbound authentication](#outbound-authentication). |
| `excludeAccessKeyId` | string | N | — | When set, credentials whose `accessKeyId` matches are excluded before selection. |
| `tokenExpiresInSeconds` | number | N | `43200` (12h) | Requested bearer TTL when minting. Capped at 43200 (12h); a larger value is silently clamped. Applies only to the minting paths (② and ③); it has no effect on an explicit `bearerToken` (①). |

> ⚠️ The config key is `endpointFlavor`, **not** `endpointType`. A misspelled
> key is silently ignored and the endpoint falls back to the default
> (`bedrock-runtime`).

### Inference parameters

`temperature` and `top_p` fall back to `1.0` when the request omits them **or
passes a falsy value**. The code uses `chatRequest.temperature || 1.0` (and
`chatRequest.top_p || 1.0`), a falsy-coalesce — so an explicit `0` is treated as
falsy and **silently replaced with `1.0`**. This provider therefore cannot send
`temperature: 0` or `top_p: 0`.
`max_tokens`, `max_completion_tokens`, `tools`, and `tool_choice` are passed
through when present. Streaming responses surface a `reasoning_content` field
in the delta (consistent with the other providers' streaming output).

## Outbound authentication

The bearer token is resolved at a single decision point, with three mutually
exclusive paths in priority order:

**① Explicit `bearerToken` (highest priority).** The value is used directly as
the OpenAI `apiKey` — nothing is minted. The check is a truthy test, so a falsy
value (e.g. an empty string `""`) is ignored and resolution falls through to
minting (path ② or ③).

```json
{
  "bearerToken": "<your-bearer-token>",
  "regions": ["us-east-1"]
}
```

**② Explicit `credentials` (minted).** One credential is selected from the
array (respecting `excludeAccessKeyId`) and a bearer is minted from it via
`@aws/bedrock-token-generator` (`^1.1.0`).

> ⚠️ If the array is empty, not an array, or every entry is filtered out by
> `excludeAccessKeyId`, credential selection returns nothing and the resolver
> **silently falls back to the default credential chain (path ③)** — no error
> is raised. A misconfigured `credentials` block therefore fails open to the
> ambient AWS credentials rather than failing loudly.

```json
{
  "credentials": [
    { "accessKeyId": "AKIA...", "secretAccessKey": "..." },
    { "accessKeyId": "AKIA...", "secretAccessKey": "..." }
  ],
  "regions": ["us-east-1"]
}
```

**③ Default credential chain (minted).** With neither `bearerToken` nor
`credentials` set, a bearer is minted through the default AWS credential
provider chain.

```json
{
  "regions": ["us-east-1"]
}
```

Notes:

- **Token TTL** is capped at 12h (43200s). Requesting more via
  `tokenExpiresInSeconds` is silently clamped to 43200; an unset or
  non-positive value uses 43200.
- The bearer is **only ever returned** — it is never written to
  `process.env` (in particular, never `AWS_BEARER_TOKEN_BEDROCK`).
- The client cache key includes the bearer, so changing the bearer on the
  same `baseURL` forces a new OpenAI client (a cross-tenant reuse guard).

## Endpoint flavor

`endpointFlavor` selects the endpoint host. Both flavors serve over `https`
at the `/openai/v1` path suffix:

| `endpointFlavor` | baseURL |
| --- | --- |
| `bedrock-runtime` (default) | `https://bedrock-runtime.{region}.amazonaws.com/openai/v1` |
| `bedrock-mantle` | `https://bedrock-mantle.{region}.api.aws/openai/v1` |

The default is **not** a whitelist check: any value other than
`bedrock-mantle` — including an unset field or a typo — resolves to the
`bedrock-runtime` host.

## IAM prerequisites

> ✅ **The runtime bearer-call permission is empirically verified — mind the
> scope of that evidence.** On the one deployment we observed — a **default
> `bedrock-runtime` deployment** authenticating from the default credential
> chain (an EC2 instance role) — a **single** `/v1/chat/completions` request
> required **both** `bedrock:CallWithBearerToken` (surfaced as `401`) **and**
> `bedrock-mantle:CallWithBearerToken` (surfaced as `403`) to be granted; only
> after adding **both** did the same request succeed. So a `bedrock-runtime`
> deployment is **not** shown to need only `bedrock:CallWithBearerToken` — the
> observed case needed the `bedrock-mantle:` action too. Either way the action
> is `{service}:CallWithBearerToken`, **not** the SigV4 `bedrock:InvokeModel`.
>
> **Why `CallWithBearerToken`, not `InvokeModel`.** This provider never
> constructs an AWS SDK client and never calls `InvokeModel`. It mints a
> short-lived bearer from the credential chain via the third-party
> `@aws/bedrock-token-generator` library and sends it as the OpenAI `apiKey` to
> the `/openai/v1` endpoint. **When a request is authorized with a bearer token,
> authorization is evaluated against the `CallWithBearerToken` action, not the
> SigV4 `InvokeModel` action.** "Bedrock calls need `InvokeModel`" is true only
> for **raw SigV4** and does not apply on this provider's path. The per-`endpointFlavor`
> prefix mapping (`bedrock-runtime` → `bedrock:`, `bedrock-mantle` →
> `bedrock-mantle:`) is **inferred** from each endpoint's own service namespace —
> it was not independently tested per flavor. Note the observation above proves
> the **call** action only; the IAM action consumed by the bearer-**minting**
> step itself was not isolated in this test and is left "not verified" below.
>
> ⚠️ **This error does not reproduce locally with admin credentials.** Testing
> with an admin identity via `curl --aws-sigv4` exercises the raw SigV4 path,
> on which an admin's **authorization** always passes (the request can still be
> non-`200` for other reasons — region, model id, quota). Because authorization
> never fails on that path, a missing `CallWithBearerToken` permission is
> invisible on a local box. Only a real deployment that mints from the default
> credential chain (e.g. an EC2 instance role, the recommended production shape)
> surfaces the `CallWithBearerToken` failure. An instance role scoped to
> `bedrock:InvokeModel` / `bedrock:InvokeModelWithResponseStream` — a natural
> guess — is **not** enough.
>
> The bearer-minting action for both credential sources (② static `credentials`,
> ③ default chain) and the supplied-bearer case (① explicit `bearerToken`) are
> **still not empirically verified in this round** and remain marked
> accordingly. **Do not** infer them from the runtime call result above.

| Auth path | Trigger | Required IAM action | Status |
| --- | --- | --- | --- |
| Bearer call — observed default (`bedrock-runtime`) deployment | The one observed `/v1/chat/completions` request on the tested EC2 instance-role deployment | That single request required **both** `bedrock:CallWithBearerToken` (surfaced as `401`) **and** `bedrock-mantle:CallWithBearerToken` (surfaced as `403`); granting both made the same request succeed | **Verified** (this deployment) |
| Bearer call — prefix attribution, `endpointFlavor: bedrock-runtime` | A bearer is sent to `https://bedrock-runtime.{region}.amazonaws.com/openai/v1` | Call action prefixed by the endpoint's service namespace → `bedrock:CallWithBearerToken` | **Inferred** (from service namespace; not independently tested per flavor) |
| Bearer call — prefix attribution, `endpointFlavor: bedrock-mantle` | A bearer is sent to `https://bedrock-mantle.{region}.api.aws/openai/v1` | → `bedrock-mantle:CallWithBearerToken` | **Inferred** (from service namespace; not independently tested per flavor) |
| Mint token — ③ default credential chain | The bearer-minting step from the default chain (e.g. an EC2 instance role) via `@aws/bedrock-token-generator` | Action(s) the minting step consumes (**not** `bedrock:InvokeModel`); the test exercised the resulting call, not the mint step | **Not verified** |
| Mint token — ② static `credentials` | The bearer-minting step from an explicit `credentials` entry via the same `@aws/bedrock-token-generator` | Action(s) required to mint from static credentials (**not** `bedrock:InvokeModel`) | **Not verified** (no evidence this round) |
| Raw SigV4 (this provider does **not** use it — shown for contrast only) | Direct SigV4-signed call to the Bedrock runtime API | Runtime-call action(s) (e.g. the `bedrock:InvokeModel*` family) | **Not verified** (and not on this provider's path) |
| ① Explicit `bearerToken` (supplied, not minted) | An already-minted bearer is passed in directly | No AWS credentials and no minting at runtime; whatever identity minted that bearer needs the call action(s) above, but that happens outside BRConnector | **Not verified / N/A at runtime** |

The runtime **bearer-call** action is settled for the observed deployment
(`{service}:CallWithBearerToken`, **not** `bedrock:InvokeModel`); on that
deployment both `bedrock:` and `bedrock-mantle:` prefixes were required on one
request. The remaining **Inferred** and **Not verified** entries — the
per-`endpointFlavor` prefix attribution, the action to mint from static
`credentials`, the mint step behind the default chain, and the ① explicit
`bearerToken` case — have no independent empirical evidence this round; verify
them against `@aws/bedrock-token-generator` 1.1.0 and the AWS Bedrock API-key /
bearer documentation before relying on them, or keep them marked as-is. Do not
fill them in by inference.

## Troubleshooting

Only failure modes with a mechanism in the code are listed here.

- **Intermittent 403 under a multi-region config.** A region-scoped bearer
  must match the endpoint's region. The provider resolves the region **once**
  and feeds the same value to both the endpoint and the token util, so this is
  handled; bypassing that guarantee (resolving region twice) reintroduces the
  split and yields intermittent 403s.
- **401/403 with no fallback.** A bearer/auth failure is a hard failure —
  there is no silent SigV4 retry. Investigate the bearer and its IAM
  permissions directly. On the observed `bedrock-runtime` deployment the same
  request surfaced **both** a `401 ... not authorized to perform:
  bedrock:CallWithBearerToken` **and** a `403 ... not authorized to perform:
  bedrock-mantle:CallWithBearerToken`; both `{service}:CallWithBearerToken`
  actions had to be granted — **not** `bedrock:InvokeModel`. See
  [IAM prerequisites](#iam-prerequisites).
- **Requests hitting the wrong endpoint.** Check `endpointFlavor`. A typo, or
  the wrong key name (`endpointType`), is silently ignored and the request
  goes to the default `bedrock-runtime` host.
- **Token lifetime shorter than requested.** `tokenExpiresInSeconds` above
  43200 is silently clamped to 12h.
- **A client is not reused after changing the bearer.** By design: the client
  cache key includes the bearer, so a new bearer on the same `baseURL` rebuilds
  the client (cross-tenant reuse guard).

> Specific error strings and HTTP response bodies for the cases above have not
> been captured in this round and are intentionally omitted rather than
> invented.
