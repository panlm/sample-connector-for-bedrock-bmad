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

## 采样参数（按家族的放行表）

采样参数不再注入硬编码默认值。连接器现在改由数据表（`src/util/inference_params.ts`）驱动，**只**向每个模型家族下发它所接受的参数。你没传的参数就不会被下发到 Bedrock —— 连接器不再替你编造 `temperature`/`topP` 默认值（唯一例外是 thinking 路径，它会强制 `temperature=1`）。

| 家族 | `temperature` | `topP`（`top_p`） | `top_k` | `stopSequences`（`stop`） | thinking |
| --- | --- | --- | --- | --- | --- |
| Anthropic (Claude) | ✅ inferenceConfig | ✅ inferenceConfig | ✅ additionalModelRequestFields | ✅（前 4 条） | ✅ |
| Amazon Nova | ✅ inferenceConfig | ✅ inferenceConfig | ✅ `additionalModelRequestFields.inferenceConfig.topK`（嵌套） | ✅（前 4 条） | ❌ |
| Meta Llama | ✅ inferenceConfig | ✅ inferenceConfig | ❌ 裁剪 | ❌ 保守裁剪（未确认） | ❌ |
| default（其他任意家族） | ❌ | ❌ | ❌ | ❌ | ❌ —— 只放行 `maxTokens` |

说明：

- **保守/未确认行：** `default`（未知家族）只放行 `maxTokens`；Meta Llama 的 `stopSequences` 默认裁剪。这两处在表中标注为「未确认，保守最小集」，后续核实后只需增一行即可放行。
- **Anthropic Claude 4.5**（Sonnet 4.5 / Haiku 4.5）：若同时给了 `temperature` 与 `top_p`，只保留其一（保留 `temperature`、裁掉 `topP`），以避免 Bedrock 400。更旧的 Claude 代次则两者都放行。
- **thinking 风险：** 连接器保持 `thinking.type: "enabled"`。已知该值在 Claude 4.7+/Opus 5/Sonnet 5 上会返回 400，此处按现状保留、不静默修改。

## 输出结果

输出中增加了 reasoning_content 字段，与 deepseek 的输出保持一致。如下：

```json
data: {"id":"3","created":1740468210,"object":"text_completion","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":"你好"},"finish_reason":null,"logprobs":null}],"model":"sonnet37-think"}
...

```
