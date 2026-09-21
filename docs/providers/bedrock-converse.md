# bedrock-converse

> Since Docker image version 0.0.6

Amazon Bedrock LLM Unified Interface.

Sends messages to the specified Amazon Bedrock model. `Converse` provides a consistent interface that works with all models that support messages. This allows you to write code once and use it with different models. If a model has unique inference parameters, you can also pass those unique parameters to the model.

## Configuration

Invoke model via Amazon Bedrock Converse API. You can config all supported models with this provider.

[This page](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html) explains how to use Bedrock Converse API, and what features it supports.

**Prompt Caching**
[This page](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html) shows the supported models and usage.
Please note that the total number of prompt caches should not exceed the limit described in the documentation. Among them: system counts as one, tools counts as one, messagePositions counts as multiple, and the sum of these should not exceed the limit.

It is recommended to use this provider to support Bedrock's large language models.

| Key     | Type      | Required     | Default value | Description |
| ------------- | -------| ------------- | ------------- | ------------- |
| modelId  | string   | Y    |  |   Model id or ARN, See [Bedrock doc](https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html)  |
| baseModelId  | string   | N    |  |   Source model id when using an inference profile ARN. This would be the model referenced from the infererence profile |
| regions  | string[] or string   | N     | ["us-east-1"] |   If you have applied and specified multiple regions, then a region will be randomly selected for the call. This feature can effectively alleviate performance bottlenecks.  |
| maxTokens  |  number   | N     | 1024 | The default maximum number of tokens, corresponding to the max_tokens parameter in the standard API. If not specified in the API request, this value will be used.   |
| thinking  |  boolean   | N     | false | Whether to enable the reason/think functionality  |
| thinkBudget  |  number   | N     | 1024 | When thinking is enabled, the maximum number of tokens allowed for the reasoning part |
| promptCache.fields  |  string[]   | N     |  | Where to enable prompt caching, supports three strings: "system", "messages", "tools" |
| promptCache.messagePositions  |  int[]   | N     |  | In multi-turn conversations, you can specify the loading positions for messages caching |

The configuration example:

```json
{
  "modelId": "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
  "regions": [
    "us-east-1"
  ],
  "thinking": true,
  "maxTokens": 32000,
  "promptCache": {
    "fields": [
      "system",
      "messages",
      "tools"
    ],
    "messagePositions": [
      0,
      1
    ]
  },
  "thinkBudget": 2000
}
```

## Sampling parameters by model family

Sampling parameters (`temperature`, `topP`, `stopSequences`) are no longer sent
unconditionally to every model. Because different Bedrock model families and
generations accept different parameter sets — and rejecting an unsupported one
returns a 400 — the request body is now trimmed against a per-family allow-list
before it is sent.

Only these families are recognized; every other model falls through to a
conservative `default` branch:

| Family | `inferenceConfig` kept | Notes |
| ------ | ---------------------- | ----- |
| Anthropic (Claude Opus 4 and later, including Opus 5) | `maxTokens`, `stopSequences` | For this generation both `temperature` and `topP` are dropped by the allow-list — neither is sent. |
| Anthropic (other Claude generations, e.g. Claude 3.x / 3.7 Sonnet / Sonnet 4) | `maxTokens`, `temperature`, `topP`, `stopSequences` | `temperature` and `topP` cannot be sent together. By default `temperature` is kept and `topP` is dropped; `topP` is kept only when the request sets `top_p` but not `temperature`. |
| Amazon Nova | `maxTokens`, `temperature`, `topP`, `stopSequences` | |
| Meta Llama | `maxTokens`, `temperature`, `topP` | `stopSequences` is not sent (not confirmed supported). |
| **default** (any other family) | `maxTokens` only | All other sampling parameters are dropped. |

**`thinking` is Anthropic-only.** It is now gated by model family: even if `thinking`
is set to `true` in the configuration, it only takes effect for Anthropic models.
Nova, Llama, and any `default`-branch model ignore it entirely (no `thinking` field
and no thinking-related sampling side effects are sent).

**Known limitations**

- The `default` branch keeps `maxTokens` only. Families that do support sampling
  parameters but are outside the recognized set (for example Amazon Titan, Mistral,
  Cohere, AI21, DeepSeek) now receive only `maxTokens`; any `temperature` / `topP` /
  `stopSequences` you configure for them is dropped rather than rejected. This is a
  deliberate safe default (dropping a parameter is harmless; sending an unsupported
  one is a 400), but it is a behavior change from previous versions, which passed
  those parameters through for non-Anthropic models.
- Family detection keys on a **dot-separated `provider.` segment** in the model id
  (`anthropic.`, `amazon.`, `meta.`). The provider may sit at the very start of the
  id or be preceded by any dot-separated prefix — a region such as `us.` is only one
  example, not the only allowed prefix.
- Because detection keys on that dot-separated `provider.` segment, an
  inference-profile **ARN** — whose id embeds one, e.g.
  `arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-1-20250805-v1:0`
  — **is** recognized by family (Anthropic here) and gets the full family handling,
  including `thinking`. Only ARNs that do **not** contain a dot-separated `provider.`
  segment — foundation-model / provisioned-model / custom-model ARNs, where the
  provider name is preceded by `/` rather than `.` (e.g.
  `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0`)
  — fall through to the `default` branch, so their sampling parameters are trimmed to
  `maxTokens` and `thinking` is disabled even when the underlying model is a Claude
  model. If you need family-specific handling, use a plain `provider.model` id or an
  inference-profile ARN rather than a foundation-model / custom-model ARN.
- The per-family allow-lists reserve additional family-specific fields (`top_k` for
  Anthropic, `topK` for Nova) for future use, but the connector does not currently
  populate `additionalModelRequestFields` with them — only `thinking` and
  `anthropic_beta` are sent there today. Configuring `top_k` / `topK` therefore has no
  observable effect yet.

## Output Results

The output adds a reasoning_content field, consistent with deepseek's output. As follows:

```json
data: {"id":"3","created":1740468210,"object":"text_completion","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":"hello"},"finish_reason":null,"logprobs":null}],"model":"sonnet37-think"}
...

```
