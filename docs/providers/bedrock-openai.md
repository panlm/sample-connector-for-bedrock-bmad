# bedrock-openai

Call Amazon Bedrock's **OpenAI-compatible** endpoint using the OpenAI SDK wire format.

## What it is and when to use it

`bedrock-openai` sends chat requests to Bedrock's OpenAI-compatible endpoint
(`https://<host>/openai/v1/chat/completions`) using the OpenAI SDK message format. The provider
only **orchestrates** two internal modules — endpoint resolution and outbound authentication — and
then forwards the chat request. It never constructs an AWS SDK client and never touches
`process.env`.

Use it when you already speak the OpenAI chat-completions wire format and want to hit Bedrock
directly without rewriting your payloads.

**Difference from `bedrock-converse`:** `bedrock-converse` calls the AWS SDK Converse API and signs
each call with SigV4. `bedrock-openai` does not sign requests with SigV4 at all — it mints (or
accepts) a short-lived **bearer token**, passes it to the OpenAI SDK as the API key, and lets the
SDK send `Authorization: Bearer <token>` to the OpenAI-compatible endpoint. The two providers use
**different authorization paths** — see [IAM prerequisites](#iam-prerequisites) below.

> Behaviour on this page is written against the implementation on `main`
> (`src/providers/bedrock_openai.ts`, `src/util/bedrock_token.ts`,
> `src/util/bedrock_openai_endpoint.ts`), not against a spec.

## Model row configuration

Set `provider` to `bedrock-openai` and put the rest under `config`. The keys the provider actually
reads:

| Key | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `model` | string | N | (from request) | Written into the request as `model_id` **only when the incoming request has no `model_id`**. If the request already carries a model id, that wins. |
| `region` | string | N | — | Target region. Takes precedence over `regions`. |
| `regions` | string or string[] | N | `us-east-1` | Used only when `region` is absent. A comma-separated string is split on `,`; when more than one region is given, one is chosen at random per call. When neither `region` nor `regions` is set, it falls back to `config.bedrock.region`, and finally to `us-east-1`. |
| `endpointType` | `bedrock-runtime` \| `bedrock-mantle` | N | `bedrock-runtime` | Selects the endpoint host shape — see [Endpoint types](#endpoint-types). |
| `bearerToken` | string | N | — | Explicit bearer token. Highest-priority auth — see [Outbound authentication](#outbound-authentication). |
| `credentials` | object or object[] | N | — | Explicit AWS credentials used to mint a bearer token. See [Outbound authentication](#outbound-authentication). |

Configuration example:

```json
{
  "provider": "bedrock-openai",
  "config": {
    "model": "openai.gpt-oss-20b-1:0",
    "region": "us-west-2",
    "endpointType": "bedrock-runtime"
  }
}
```

> The `us-east-1` default is not hard-coded in this provider; it is the fallback inside
> `helper.selectRandomRegion` when no region is configured. Request-level parameters such as
> `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `tools`, and `tool_choice` are
> read from the incoming chat request, not from `config`. Streaming is supported and follows the
> request's `stream` flag.

## Outbound authentication

The provider resolves exactly one of three authentication tiers, in a **fixed priority order**.
Whichever tier applies produces a bearer token that is injected as the OpenAI SDK API key
(`new OpenAI({ apiKey, baseURL })`). A fresh client is built **per request** and is never cached.

| Priority | Config | What happens |
| --- | --- | --- |
| 1 (highest) | `bearerToken` set | The value is used directly as the API key. **No token is minted.** |
| 2 | `credentials` set | A short-lived bearer is minted from those credentials. `credentials` may be a single `{ accessKeyId, secretAccessKey, sessionToken? }` object or an array; an array is narrowed to one entry (random pick when more than one). |
| 3 (default) | neither set | The default credential provider chain mints the bearer. |

For tiers 2 and 3, the token is minted via `@aws/bedrock-token-generator`
(`getToken` / `getTokenProvider`) with `expiresInSeconds` capped at **12 hours (43200s)** — the
generator's own maximum.

Tier 2 (explicit `credentials`) example:

```json
{
  "provider": "bedrock-openai",
  "config": {
    "model": "openai.gpt-oss-20b-1:0",
    "region": "us-west-2",
    "credentials": [
      { "accessKeyId": "AKIA...", "secretAccessKey": "..." }
    ]
  }
}
```

Tier 1 (explicit `bearerToken`) example:

```json
{
  "provider": "bedrock-openai",
  "config": {
    "model": "openai.gpt-oss-20b-1:0",
    "region": "us-west-2",
    "bearerToken": "<pre-minted-bedrock-bearer-token>"
  }
}
```

Tier 3 is the default: omit both `bearerToken` and `credentials`, and the token is minted from the
process's default credential chain.

## Endpoint types

`endpointType` selects the host shape. The region is resolved once and reused for both the base URL
and the minted token, so the base URL host and the token region never diverge.

| `endpointType` | Base URL | Notes |
| --- | --- | --- |
| `bedrock-runtime` (default) | `https://bedrock-runtime.<region>.amazonaws.com/openai/v1` | Used whenever `endpointType` is unset **or** set to any value other than `bedrock-mantle`. |
| `bedrock-mantle` | `https://bedrock-mantle.<region>.api.aws/openai/v1` | Selected only when `endpointType` is exactly `bedrock-mantle`. |

The OpenAI SDK appends `/chat/completions` to the base URL.

> **Only the exact string `bedrock-mantle` selects the mantle host.** Any other value — including a
> typo — silently falls back to `bedrock-runtime`; the provider does not raise an "unknown
> endpointType" error. If you point at the wrong host, check the spelling of `endpointType` first.

## IAM prerequisites

⚠️ This is the easiest part of this provider to get wrong. The authorization path here is **not the
same** as `bedrock-converse`'s.

**What the code establishes:** this provider never issues a bare SigV4-signed request and never
calls the Bedrock runtime AWS SDK client. It always obtains a bearer token first and hands it to the
OpenAI SDK as the API key. When `bearerToken` is not supplied, the token is minted through
`@aws/bedrock-token-generator` (`getToken` / `getTokenProvider`). So the `bedrock:InvokeModel`
action that a SigV4 Converse call needs is on the **`bedrock-converse` path, not this one** — do not
copy it into this provider's IAM table by analogy.

**Why the action is `CallWithBearerToken`, not `InvokeModel`.** These are two *different*
authorization paths, and which one Bedrock checks depends on how the request is signed — not on
which model you call:

- **Bare SigV4 Converse call** (what `bedrock-converse` does): the request is signed with SigV4
  credentials, and Bedrock authorizes it against `bedrock:InvokeModel` /
  `bedrock:InvokeModelWithResponseStream`.
- **Minted-bearer-token call** (what this provider does): the credential chain is used first to
  *mint* a short-lived bearer token, and the actual model call carries that token instead of a
  SigV4 signature. Bedrock authorizes such a call against **`CallWithBearerToken`** on the
  endpoint's own namespace — `bedrock:CallWithBearerToken` for `bedrock-runtime`,
  `bedrock-mantle:CallWithBearerToken` for `bedrock-mantle`. `bedrock:InvokeModel` is neither
  requested nor sufficient on this path.

This is why granting only the "usual" Bedrock actions (`bedrock:InvokeModel`,
`bedrock:InvokeModelWithResponseStream`, `bedrock:ListFoundationModels`) to a deployment's role
still produces a `403` / `401` on `CallWithBearerToken` — adding `CallWithBearerToken` makes the
same request succeed immediately.

**What is not tested:** the concrete AWS IAM action that the token-minting path
(`@aws/bedrock-token-generator`) requires **when a static `credentials` block is supplied (tier 2)**.
That package is not vendored in this repository and is not installed in `node_modules`, so there is
no in-repo code from which to read the exact AWS API it calls or the action name it needs on that
path. It is left as **Not verified** until someone confirms it against the dependency source or AWS
documentation with a real, permission-scoped credential. The **default credential chain (tier 3)**
path is no longer unverified: a real deployment has confirmed its call action is
`CallWithBearerToken` (see the table and the trap note below).

| Auth tier | Client-side requirement | AWS-side IAM action |
| --- | --- | --- |
| `bearerToken` (tier 1) | A valid, pre-minted Bedrock bearer token. | None minted by this provider — whatever action was needed to produce the token was spent elsewhere. |
| `credentials` (tier 2) | AWS credentials passed in config. | **Not verified** — the action required by `@aws/bedrock-token-generator` to mint a bearer is not readable from this repo. Do **not** assume `bedrock:InvokeModel`. |
| default chain (tier 3) | Ambient AWS credentials on the process. | **Verified (default credential chain + minted bearer token).** The call is authorized against `CallWithBearerToken` on the endpoint's own namespace — **not** `bedrock:InvokeModel`: `endpointType: bedrock-runtime` (default) → **`bedrock:CallWithBearerToken`**; `endpointType: bedrock-mantle` → **`bedrock-mantle:CallWithBearerToken`**. |

> A note the code makes obvious, and a real deployment confirmed: testing this locally with an admin
> credential and a **bare SigV4** call (e.g. `curl --aws-sigv4`) will always succeed and will
> **never** surface the missing-permission `403` / `401` — that path is authorized against
> `bedrock:InvokeModel`, which admin credentials already have. The `CallWithBearerToken` requirement
> only appears once you deploy with a scoped role (e.g. an EC2 instance role) and let the provider
> mint a bearer token. Confirm the IAM action with a scoped credential and a real minted-token call,
> not by inference or local admin testing.

## Troubleshooting

The three source files contain **no custom error branches or `try`/`catch`** — errors are thrown
directly by the OpenAI SDK or by `@aws/bedrock-token-generator`. Only the items below have a code
basis; the rest are marked as not verified.

**Code-backed**

- **`endpointType` typo → wrong host, no error.** Only `bedrock-mantle` selects the mantle host;
  every other value (including misspellings) silently resolves to `bedrock-runtime`. If requests
  reach the wrong endpoint, verify the `endpointType` spelling and the resolved base URL host.
- **Region mismatch between base URL and token is prevented by design.** The region is resolved once
  and passed to both the base URL builder and the token minter, so a multi-region random selection
  cannot leave the base URL and the token pointing at different regions.

**Not verified (no code branch; not exercised this round)**

- `401` (invalid/expired bearer token), `403` (insufficient IAM permission — tied to the IAM section
  above and invisible when testing with an admin credential), and `404` (region/endpoint does not
  expose the OpenAI-compatible path) are upstream HTTP errors passed through from the OpenAI SDK.
  There is no corresponding branch in this repository and they were not exercised in this round, so
  they are left as **Not verified** pending a real downstream call.
