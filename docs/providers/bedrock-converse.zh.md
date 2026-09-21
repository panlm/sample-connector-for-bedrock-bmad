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

## 按模型家族裁剪推理参数

在调用 Converse API 之前，Provider 会按模型的**家族与代次**裁剪采样参数（`temperature`、`topP`、`stopSequences`），不再对所有模型套用同一条 Anthropic 专用规则。家族不接受的参数会被静默丢弃，因此传入不支持的参数不会再触发 Bedrock 的校验报错。`maxTokens` 始终保留，永不裁剪。

| 家族（按 `modelId` 子串匹配） | temperature | topP | stopSequences | 说明 |
| --- | --- | --- | --- | --- |
| Anthropic `claude-opus-4` 及更新代次 | 丢弃 | 丢弃 | 保留 | opus-4 已弃用 `temperature`/`topP` |
| Anthropic（其它代次） | 保留\* | 保留\* | 保留 | `temperature` 与 `topP` 互斥 —— 见下 |
| Nova | 保留 | 保留 | 保留 | |
| Llama | 保留 | 保留 | **丢弃** | Llama 无 `stopSequences` |
| 其它 / 未匹配家族 | 丢弃 | 丢弃 | 丢弃 | 保守最小集 —— 只保留 `maxTokens` |

\* 对非 opus-4 的 Anthropic 模型，`temperature` 与 `topP` 不能同时传。当请求两者都带时：仅当请求提供了 `top_p` 且未提供 `temperature`，才保留 `topP`；否则保留 `temperature`、丢弃 `topP`。

`anthropic_beta` 特性头（如 `claude-3-7-sonnet` 的 128k 输出）保持不变，不属于采样参数裁剪的范围。

### 各家族的 thinking 行为

`thinking` 现在按家族走独立路径：

- **支持的家族（Anthropic）。** 开启 thinking 时——通过请求体 `thinking.type: "enabled"`，或配置 `thinking: true`——Provider 会加上 `thinking` 字段与 `budget_tokens`（最小 1024），强制 `temperature: 1`，并丢弃 `topP`。若 `maxTokens <= budget_tokens`，则把 `maxTokens` 抬到 `budget_tokens + 1024`。请求体的 `thinking` 优先于模型配置；即使配置为 `thinking: true`，`thinking.type: "disabled"` 也会关闭 thinking。
- **不支持的家族（Nova、Llama 及任何未匹配家族）。** 请求 thinking 不再产生副作用：不会加 `thinking` 字段，也**不会**把 `temperature`/`topP` 强制为 Anthropic 的 thinking 取值，请求按该家族正常的采样参数继续。

这修正了此前的行为缺陷：对非 Anthropic 模型开启 thinking 时会误加 `thinking` 字段并强制 `temperature=1` / 删除 `topP`，即便该模型并不支持这种形态的扩展推理。

## 输出结果

输出中增加了 reasoning_content 字段，与 deepseek 的输出保持一致。如下：

```json
data: {"id":"3","created":1740468210,"object":"text_completion","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":"你好"},"finish_reason":null,"logprobs":null}],"model":"sonnet37-think"}
...

```
