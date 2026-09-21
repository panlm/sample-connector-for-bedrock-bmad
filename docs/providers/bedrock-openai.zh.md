# bedrock-openai

通过 OpenAI 兼容传输层调用 Amazon Bedrock。

本 provider 使用 **OpenAI SDK** 访问 Amazon Bedrock 的 OpenAI 兼容端点（`/openai/v1`
路径）。它会解析出一个短期 **bearer token** 用于出站认证，并作为 OpenAI 的 `apiKey`
传入。它**从不**构造 AWS SDK client，**从不**写 `process.env`。

## 何时使用它（对比 `bedrock-converse`）

| | `bedrock-openai` | `bedrock-converse` |
| --- | --- | --- |
| 传输层 | OpenAI SDK，打到 Bedrock 的 `/openai/v1` 端点 | AWS SDK Converse API |
| 出站认证 | bearer token 作 OpenAI `apiKey` | AWS SigV4（会把 `AWS_BEARER_TOKEN_BEDROCK` 写进 `process.env`） |
| 是否写 `process.env` | **否** —— bearer 只作为返回值离开 | 是 |
| 是否静默回退 SigV4 | **否** —— bearer/认证失败即硬失败 | 不适用 |

当你希望以 OpenAI API 形态访问 Bedrock（面向已经使用 OpenAI 接口的工具和客户端），
或倾向用 bearer token 认证而非依赖 `process.env` 里的环境 AWS 凭证时，选
`bedrock-openai`。需要完整的 Bedrock Converse 特性（提示词缓存、按模型的推理参数等）
时，选 `bedrock-converse`。

> 注意：本 provider **不会**回退到 SigV4。若 bearer 无效或权限不足，请求直接失败 ——
> 不会再通过 AWS SDK client 重试。

## 模型行配置

用 `provider: bedrock-openai` 配置一个模型行。最小配置：

```json
{
  "model": "<OpenAI 兼容端点提供的 bedrock 模型 id>",
  "regions": ["us-east-1"]
}
```

当传入请求未携带 `model_id` 时，`model` 会作为兜底的 `model_id`。`regions` 接受单个
字符串或数组；配置多个 region 时，每次调用随机选一个。

### 配置项

所有键名为 camelCase，与实现完全一致。

| 键 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | string | 否 | — | 模型 id。请求未带 `model_id` 时作为兜底。 |
| `regions` | string \| string[] | 否 | `us-east-1` | 单个 region 或列表。列表时每次调用随机选一个。回落顺序为 `config.bedrock.region`，再到 `us-east-1`。 |
| `endpointFlavor` | `bedrock-runtime` \| `bedrock-mantle` | 否 | `bedrock-runtime` | 选择端点主机，见 [端点形态（endpointFlavor）](#端点形态endpointflavor)。 |
| `bearerToken` | string | 否 | — | 显式 bearer token，原样使用（不铸造）。优先级最高。 |
| `credentials` | object[] | 否 | — | AWS 凭证对象数组（`{ accessKeyId, secretAccessKey }`），用于铸造 bearer。见 [出站认证方式](#出站认证方式)。 |
| `excludeAccessKeyId` | string | 否 | — | 设置后，在选取前排除 `accessKeyId` 与之匹配的凭证。 |
| `tokenExpiresInSeconds` | number | 否 | `43200`（12 小时） | 铸造 bearer 时请求的 TTL。上限 43200（12 小时），超出静默截断。 |

> ⚠️ 配置键是 `endpointFlavor`，**不是** `endpointType`。键名拼错会被静默忽略，端点回落到
> 默认值（`bedrock-runtime`）。

### 推理参数

请求未指定时，`temperature` 和 `top_p` 均默认为 `1.0`。`max_tokens`、
`max_completion_tokens`、`tools`、`tool_choice` 在存在时透传。流式响应会在 delta 中带出
`reasoning_content` 字段（与其它 provider 的流式输出一致）。

## 出站认证方式

bearer token 在单一决策点解析，三条路径互斥，按优先级从高到低：

**① 显式 `bearerToken`（优先级最高）。** 该值直接作为 OpenAI `apiKey` 使用 —— 不铸造。

```json
{
  "bearerToken": "<你的 bearer token>",
  "regions": ["us-east-1"]
}
```

**② 显式 `credentials`（铸造）。** 从数组中选取一份凭证（遵守 `excludeAccessKeyId`），
并通过 `@aws/bedrock-token-generator`（`^1.1.0`）用它铸造 bearer。

```json
{
  "credentials": [
    { "accessKeyId": "AKIA...", "secretAccessKey": "..." },
    { "accessKeyId": "AKIA...", "secretAccessKey": "..." }
  ],
  "regions": ["us-east-1"]
}
```

**③ 默认凭证链（铸造）。** 既未设 `bearerToken` 也未设 `credentials` 时，通过默认 AWS
凭证提供链铸造 bearer。

```json
{
  "regions": ["us-east-1"]
}
```

说明：

- **Token TTL** 上限为 12 小时（43200 秒）。通过 `tokenExpiresInSeconds` 请求更大的值会被
  静默截断为 43200；未设或非正数则取 43200。
- bearer **只作为返回值**离开 —— 从不写入 `process.env`（尤其不会写
  `AWS_BEARER_TOKEN_BEDROCK`）。
- client 缓存键包含 bearer，因此在相同 `baseURL` 上更换 bearer 会强制新建 OpenAI client
  （防跨租户复用）。

## 端点形态（endpointFlavor）

`endpointFlavor` 选择端点主机。两种形态都以 `https` 在 `/openai/v1` 路径后缀上提供服务：

| `endpointFlavor` | baseURL |
| --- | --- |
| `bedrock-runtime`（默认） | `https://bedrock-runtime.{region}.amazonaws.com/openai/v1` |
| `bedrock-mantle` | `https://bedrock-mantle.{region}.api.aws/openai/v1` |

默认逻辑**不是**白名单校验：任何非 `bedrock-mantle` 的值 —— 包括未设该字段或拼写错误 ——
都会解析为 `bedrock-runtime` 主机。

## IAM 前提

> ⚠️ **本轮未对所需 IAM action 做实测，因此下表一律标注「未实测」。** **铸造 token** 路径
> 所需的 action 与裸 SigV4 Bedrock 调用**不是同一个**。本 provider 不构造 AWS SDK client、
> 从不调用 `InvokeModel`；token 通过第三方库 `@aws/bedrock-token-generator` 铸造，而仓库测试
> 对该库和所有 AWS SDK client 全部 mock。因此仓库内没有真实授权 action 的证据。**不要**从
> 「Bedrock 调用一般需要 `InvokeModel`」推断此处所需 action —— 此处填错的后果是：照本文档配置
> 权限的人必然 403，而且用管理员凭证在本机测试时永远复现不出来。

| 认证路径 | 触发条件 | 所需 IAM action | 状态 |
| --- | --- | --- | --- |
| 铸造 token（② `credentials` / ③ 默认链） | 由 AWS 凭证经 `@aws/bedrock-token-generator` 铸造 bearer | 铸造 bearer 所需的 action（**不是** `bedrock:InvokeModel`） | **未实测** |
| 裸 SigV4（本 provider **不涉及**，仅作对照） | 直接对 Bedrock 运行时 API 发起 SigV4 签名调用 | 运行时调用 action（如 `bedrock:InvokeModel*` 家族） | **未实测**（且不在本 provider 路径上） |
| bearer 打到 OpenAI 兼容端点做推理 | ①②③ 任一取得 bearer 后发起请求 | bearer 需承载的调用权限 | **未实测** |
| ① 显式 `bearerToken` | 传入一个已铸好的 bearer | 运行时不涉及 AWS 凭证；铸造该 bearer 发生在 BRConnector 之外 | **未实测 / 运行时不适用** |

要定这些条目，请对照 `@aws/bedrock-token-generator` 1.1.0 与 AWS Bedrock API Key / bearer
文档核实铸造 action，或保留「未实测」标注。不要靠推断填入。

## 常见报错与排查

此处只列有代码机制支撑的失败模式。

- **多 region 配置下的间歇性 403。** region-scoped 的 bearer 必须与端点的 region 一致。
  provider 只解析**一次** region，并把同一个值同时喂给端点工具和 token 工具，因此此问题已被规避；
  绕过该保证（解析两次 region）会重新引入分裂，导致间歇性 403。
- **401/403 且不回退。** bearer/认证失败即硬失败 —— 没有静默的 SigV4 重试。请直接排查
  bearer 及其 IAM 权限。
- **请求打到了非预期端点。** 检查 `endpointFlavor`。拼写错误，或用错了键名（`endpointType`），
  会被静默忽略，请求发往默认的 `bedrock-runtime` 主机。
- **token 有效期短于请求值。** `tokenExpiresInSeconds` 超过 43200 会被静默截断为 12 小时。
- **更换 bearer 后 client 未复用。** 这是设计使然：client 缓存键包含 bearer，因此在相同
  `baseURL` 上使用新 bearer 会重建 client（防跨租户复用）。

> 上述各情形具体的报错文案和 HTTP 响应体在本轮未采集，故有意省略而非编造。
