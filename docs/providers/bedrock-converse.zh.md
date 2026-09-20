# bedrock-converse

> Since Docker image version 0.0.6

Amazon Bedrock LLM 统一调用。

将消息发送到指定的 Amazon Bedrock 模型。Converse提供了一个与支持消息的所有模型兼容的统一接口。这允许您只编写一次代码,并将其用于不同的模型。如果某个模型具有独特的推理参数,您也可以将这些独特的参数传递给该模型。

## 参数配置

通过亚马逊Bedrock Converse API调用模型。您可以使用此提供程序配置所有支持的模型。

[这个网址](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html) 解释了如何使用 Bedrock Converse API 以及他支持的特性。

**提示词缓存**

[这个网址](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html) 可以看到支持模型和用法。
请注意，总的提示缓存数量不要超出文档中的描述。其中：system 算一个，tools 算一个，messagePositions 的算多个，这些总和不要超出限制。

建议使用这个 Provider 来支持 Bedrock 的大语言模型。

| Key     | Type      | Required     | Default value | Description |
| ------------- | -------| ------------- | ------------- | ------------- |
| modelId  | string   | Y    |  |   Model id, [点这里查看列表](https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html)  |
| regions  | string[] or string   | N     | ["us-east-1"] |   如果您已经申请并指定了多个地区,那么将会随机选择一个地区进行调用。这个功能可以有效缓解性能瓶颈。  |
| maxTokens  |  number   | N     | 1024 | 默认最大 tokens 数量，对应标准 API 的 max_tokens 参数。 如果 API 请求中不指定，则使用此值。  |
| thinking  |  boolen   | N     | false | 是否开启 reason/think 功能  |
| thinkBudget  |  number   | N     | 1024 | 在开启 thinking 的情况下，推理部分允许的最大 tokens 数量 |
| promptCache.fields  |  string[]   | N     |  | 在什么位置开启提示词缓存，支持三个字符串："system", "messages", "tools"|
| promptCache.messagePositions  |  int[]   | N     |  |多轮对话中，可以指定 messages 缓存的加载位置 |
| maxRetries  |  number   | N     |  | 当访问 bedrock 出错的时候，会持续尝试，如果存在多组 aksk，则会排除当前的 key 再尝试 |
| credentials  |  object[]   | N     |  | 多组 AKSK 的配置，具体参见下面的配置 |

bedrock-converse 的配置示例如下：

```json
{
  {
  "modelId": "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
  "regions": [
    "us-east-1"
  ],
  "thinking": false,
  "maxTokens": 32000,
  "maxRetries": 3,
  "credentials": [
    {
      "accessKeyId": "a0",
      "secretAccessKey": "xxx"
    },
    {
      "accessKeyId": "a1",
      "secretAccessKey": "bbb"
    },
    {
      "accessKeyId": "a2",
      "secretAccessKey": "bbb"
    },
    {
      "accessKeyId": "a3",
      "secretAccessKey": "bbb"
    },
    {
      "accessKeyId": "a4",
      "secretAccessKey": "bbb"
    }
  ],
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
}
```

## 采样参数按模型家族裁剪

采样参数（`temperature`、`topP`、`stopSequences`，以及 `top_k` / `topK` 等家族专属字段）
不再无条件发给所有模型。Bedrock 上不同模型家族、不同代次接受的参数集不一样，多传一个不支持的
会返回 400 —— 因此在发送前，请求体会按**家族放行表**做白名单裁剪。

只识别以下家族，其余模型一律走保守的 `default` 分支：

| 家族 | 保留的 `inferenceConfig` 键 | 说明 |
| ---- | --------------------------- | ---- |
| Anthropic（Claude Opus 4 及以后，含 Opus 5） | `maxTokens`、`stopSequences` | 不再发送 `temperature` / `topP` —— 该代次已弃用两者同传。 |
| Anthropic（其余 Claude 代次，如 Claude 3.x / 3.7 Sonnet / Sonnet 4） | `maxTokens`、`temperature`、`topP`、`stopSequences` | `temperature` 与 `topP` 不能同传，会自动二选一保留其一。 |
| Amazon Nova | `maxTokens`、`temperature`、`topP`、`stopSequences` | |
| Meta Llama | `maxTokens`、`temperature`、`topP` | 不发送 `stopSequences`（未确认是否支持）。 |
| **default**（其他任何家族） | 仅 `maxTokens` | 其余采样参数一律裁掉。 |

**`thinking` 仅 Anthropic 生效。** 现在按家族门控：即便配置里把 `thinking` 设为 `true`，
也只对 Anthropic 模型生效。Nova、Llama 以及走 `default` 分支的模型会完全忽略它（不发送
`thinking` 字段，也不产生任何 thinking 相关的采样副作用）。

**已知限制**

- `default` 分支只保留 `maxTokens`。那些本身支持采样参数、但不在识别范围内的家族
  （例如 Amazon Titan、Mistral、Cohere、AI21、DeepSeek）现在只会收到 `maxTokens`；
  你为它们配置的 `temperature` / `topP` / `stopSequences` 会被裁掉而不是被拒。
  这是有意为之的安全默认（少传一个参数无害，多传一个不支持的会 400），但相对旧版本是
  **行为变化** —— 旧版本对非 Anthropic 模型是透传这些参数的。
- 家族判定读取模型 id 的供应商前缀（如 `anthropic.`、`amazon.`、`meta.`，可带 `us.` 等
  区域前缀）。用 inference-profile / custom-model **ARN**（不含 `provider.` 段）引用的模型
  会落到 `default` 分支，因此即便底层是 Claude 模型，其采样参数也会被裁剪、`thinking` 也会
  被关闭。如果使用 ARN 又需要按家族处理，请改用 `provider.model` 形式的普通 model id 配置。

## 输出结果

输出中增加了 reasoning_content 字段，与 deepseek 的输出保持一致。如下：

```json
data: {"id":"3","created":1740468210,"object":"text_completion","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":"你好"},"finish_reason":null,"logprobs":null}],"model":"sonnet37-think"}
...

```
