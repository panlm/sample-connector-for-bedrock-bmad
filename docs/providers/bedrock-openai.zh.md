# bedrock-openai

通过 OpenAI 兼容传输层调用 Amazon Bedrock。

本 provider 使用 **OpenAI SDK** 访问 Amazon Bedrock 的 OpenAI 兼容端点（`/openai/v1`
路径）。它会解析出一个 **bearer token**（铸造得来，默认与上限均为 12 小时；或显式传入）
用于出站认证，并作为 OpenAI 的 `apiKey` 传入。它**从不**构造 AWS SDK client，**从不**写
`process.env`。

## 何时使用它（对比 `bedrock-converse`）

| | `bedrock-openai` | `bedrock-converse` |
| --- | --- | --- |
| 传输层 | OpenAI SDK，打到 Bedrock 的 `/openai/v1` 端点 | AWS SDK Converse API |
| 出站认证 | bearer token 作 OpenAI `apiKey` | 两种模式：① `bearerToken` → 写入 `process.env` 的 `AWS_BEARER_TOKEN_BEDROCK`；② `credentials`/AKSK → 设为 AWS SDK client 的 `credentials`（SigV4 签名） |
| 是否写 `process.env` | **否** —— bearer 只作为返回值离开 | 仅 `bearerToken` 模式写（`AWS_BEARER_TOKEN_BEDROCK`）；AKSK/SigV4 模式设 SDK client 的 `credentials`，**不**写 env |
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
字符串或数组；配置多个 region 时，每次调用随机选一个。单个字符串会**按逗号切分**
（如 `"us-east-1,us-west-2"`），因此逗号分隔的字符串会被当作多 region 列表、随机选一个。

### 配置项

所有键名为 camelCase，与实现完全一致。

| 键 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | string | 否 | — | 模型 id。请求未带 `model_id` 时作为兜底。 |
| `regions` | string \| string[] | 否 | `config.bedrock.region`，否则 `us-east-1` | 单个 region 或列表。字符串会按逗号切分并当作列表；列表时每次调用随机选一个。未设时，首选默认是 `config.bedrock.region`，`us-east-1` 仅为末级兜底。 |
| `endpointFlavor` | `bedrock-runtime` \| `bedrock-mantle` | 否 | `bedrock-runtime` | 选择端点主机，见 [端点形态（endpointFlavor）](#端点形态endpointflavor)。 |
| `bearerToken` | string | 否 | — | 显式 bearer token，原样使用（不铸造）。优先级最高。 |
| `credentials` | object[] | 否 | — | AWS 凭证对象数组（`{ accessKeyId, secretAccessKey }`），用于铸造 bearer。见 [出站认证方式](#出站认证方式)。 |
| `excludeAccessKeyId` | string | 否 | — | 设置后，在选取前排除 `accessKeyId` 与之匹配的凭证。 |
| `tokenExpiresInSeconds` | number | 否 | `43200`（12 小时） | 铸造 bearer 时请求的 TTL。上限 43200（12 小时），超出静默截断。仅对铸造路径（② 与 ③）生效；对显式 `bearerToken`（①）无效。 |

> ⚠️ 配置键是 `endpointFlavor`，**不是** `endpointType`。键名拼错会被静默忽略，端点回落到
> 默认值（`bedrock-runtime`）。

### 推理参数

请求省略**或传入 falsy 值**时，`temperature` 和 `top_p` 回落为 `1.0`。代码用的是
`chatRequest.temperature || 1.0`（及 `chatRequest.top_p || 1.0`）的 falsy 合并 —— 因此显式
传 `temperature: 0` 会被当作 falsy 并**静默改成 `1.0`**。故本 provider 无法表达
`temperature: 0` 或 `top_p: 0`。`max_tokens`、`max_completion_tokens`、`tools`、`tool_choice`
在存在时透传。流式响应会在 delta 中带出 `reasoning_content` 字段（与其它 provider 的流式输出一致）。

## 出站认证方式

bearer token 在单一决策点解析，三条路径互斥，按优先级从高到低：

**① 显式 `bearerToken`（优先级最高）。** 该值直接作为 OpenAI `apiKey` 使用 —— 不铸造。
判断是 truthy 检查，因此 falsy 值（如空字符串 `""`）会被忽略，解析回落到铸造（路径 ② 或 ③）。

```json
{
  "bearerToken": "<你的 bearer token>",
  "regions": ["us-east-1"]
}
```

**② 显式 `credentials`（铸造）。** 从数组中选取一份凭证（遵守 `excludeAccessKeyId`），
并通过 `@aws/bedrock-token-generator`（`^1.1.0`）用它铸造 bearer。

> ⚠️ 若数组为空、不是数组，或被 `excludeAccessKeyId` 全部过滤掉，凭证选取会返回空，解析
> 随即**静默回落到默认凭证链（路径 ③）** —— 不报错。因此配错的 `credentials` 块不会硬失败，
> 而是 fail-open 到环境里的 AWS 凭证。

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

> ✅ **运行时 bearer 调用权限已实测确认 —— 但要注意这份证据的适用范围。** 我们实际观测到的唯一一次
> 部署 —— 一个**默认 `bedrock-runtime` 部署**、从默认凭证链（EC2 instance role）认证 —— 中，
> **同一个** `/v1/chat/completions` 请求**同时**需要授予 `bedrock:CallWithBearerToken`（报为 `401`）
> **和** `bedrock-mantle:CallWithBearerToken`（报为 `403`）；**两条都补上**之后同一请求才成功。
> 所以并没有证据表明 `bedrock-runtime` 部署只需 `bedrock:CallWithBearerToken` —— 观测到的这一例
> 连 `bedrock-mantle:` 那条也要。无论哪条，action 都是 `{service}:CallWithBearerToken`，
> **不是**裸 SigV4 的 `bedrock:InvokeModel`。
>
> **为什么走 `CallWithBearerToken` 而非 `InvokeModel`。** 本 provider 从不构造 AWS SDK client、
> 从不调用 `InvokeModel`。它经第三方库 `@aws/bedrock-token-generator` 从凭证链铸造一枚短期 bearer，
> 作为 OpenAI 的 `apiKey` 打到 `/openai/v1` 端点。**用 bearer token 授权调用时，授权走
> `CallWithBearerToken` 这条 action，而不是 SigV4 那条 `InvokeModel`。**「Bedrock 调用需要
> `InvokeModel`」只对**裸 SigV4** 成立，不适用于本 provider 的路径。按 `endpointFlavor` 划分的
> service 前缀映射（`bedrock-runtime` → `bedrock:`、`bedrock-mantle` → `bedrock-mantle:`）是由端点
> 各自的 service namespace **推断**得来，并未逐 flavor 独立实测。另外，上面的观测只证明了**调用**这条
> action；**铸造** bearer 那一步本身消耗的 IAM action 在本次测试中未被单独隔离，故在下表中保留「未实测」。
>
> ⚠️ **本机用管理员凭证裸 SigV4 测不出这个错误。** 用管理员身份在本机 `curl --aws-sigv4` 走的是
> 裸 SigV4 路径，在这条路径上管理员身份的**授权**总会通过（请求仍可能因 region、model id、quota 等
> 其它原因非 `200`）。正因为授权在这条路径上从不失败，缺失的 `CallWithBearerToken` 权限在本机就看不出来。
> 只有真部署、从默认凭证链铸造（如 EC2 instance role，即文档推荐的生产形态）时，才会暴露
> `CallWithBearerToken` 的失败。一个只授予 `bedrock:InvokeModel` /
> `bedrock:InvokeModelWithResponseStream` 的 instance role ——一个很自然的猜测——**并不够**。
>
> 两个凭证来源的**铸造** action（② 静态 `credentials`、③ 默认链）以及传入 bearer 的情形
> （① 显式 `bearerToken`）**本轮仍未实测**，保持相应标注。**不要**由上面的运行时调用结论推断它们。

| 认证路径 | 触发条件 | 所需 IAM action | 状态 |
| --- | --- | --- | --- |
| bearer 调用 —— 观测到的默认（`bedrock-runtime`）部署 | 在被测 EC2 instance-role 部署上观测到的那一次 `/v1/chat/completions` 请求 | 该单个请求**同时**需要 `bedrock:CallWithBearerToken`（报为 `401`）**与** `bedrock-mantle:CallWithBearerToken`（报为 `403`）；两条都授予后同一请求才成功 | **已实测**（限此部署） |
| bearer 调用 —— 前缀归因，`endpointFlavor: bedrock-runtime` | bearer 打到 `https://bedrock-runtime.{region}.amazonaws.com/openai/v1` | 调用 action 的前缀取自端点 service namespace → `bedrock:CallWithBearerToken` | **推断**（由 service namespace 推得，未逐 flavor 独立实测） |
| bearer 调用 —— 前缀归因，`endpointFlavor: bedrock-mantle` | bearer 打到 `https://bedrock-mantle.{region}.api.aws/openai/v1` | → `bedrock-mantle:CallWithBearerToken` | **推断**（由 service namespace 推得，未逐 flavor 独立实测） |
| 铸造 token —— ③ 默认凭证链 | 由默认链（如 EC2 instance role）经 `@aws/bedrock-token-generator` 铸造 bearer 的那一步 | 铸造步骤消耗的 action（**不是** `bedrock:InvokeModel`）；本次测试实测的是随后的调用，而非铸造步骤 | **未实测** |
| 铸造 token —— ② 静态 `credentials` | 由显式 `credentials` 条目经同一 `@aws/bedrock-token-generator` 铸造 bearer 的那一步 | 从静态凭证铸造所需的 action（**不是** `bedrock:InvokeModel`） | **未实测**（本轮无证据） |
| 裸 SigV4（本 provider **不涉及**，仅作对照） | 直接对 Bedrock 运行时 API 发起 SigV4 签名调用 | 运行时调用 action（如 `bedrock:InvokeModel*` 家族） | **未实测**（且不在本 provider 路径上） |
| ① 显式 `bearerToken`（传入，非铸造） | 直接传入一个已铸好的 bearer | 运行时不涉及 AWS 凭证、也不铸造；铸造该 bearer 的身份需具备上面的调用 action，但那发生在 BRConnector 之外 | **未实测 / 运行时不适用** |

运行时 **bearer 调用** action 对观测到的这次部署已定案（`{service}:CallWithBearerToken`，**不是**
`bedrock:InvokeModel`）；在那次部署上，同一请求需要 `bedrock:` 与 `bedrock-mantle:` 两个前缀。剩下的
**推断**与**未实测**条目 —— 按 `endpointFlavor` 的前缀归因、从静态 `credentials` 铸造所需的 action、
默认链背后的铸造步骤，以及 ① 显式 `bearerToken` 那格 —— 本轮没有独立实测证据；在依赖它们之前，请对照
`@aws/bedrock-token-generator` 1.1.0 与 AWS Bedrock API Key / bearer 文档核实，或保留原标注。不要靠推断填入。

## 常见报错与排查

此处只列有代码机制支撑的失败模式。

- **多 region 配置下的间歇性 403。** region-scoped 的 bearer 必须与端点的 region 一致。
  provider 只解析**一次** region，并把同一个值同时喂给端点工具和 token 工具，因此此问题已被规避；
  绕过该保证（解析两次 region）会重新引入分裂，导致间歇性 403。
- **401/403 且不回退。** bearer/认证失败即硬失败 —— 没有静默的 SigV4 重试。请直接排查
  bearer 及其 IAM 权限。在观测到的 `bedrock-runtime` 部署上，同一请求**同时**报了
  `401 ... not authorized to perform: bedrock:CallWithBearerToken` **和**
  `403 ... not authorized to perform: bedrock-mantle:CallWithBearerToken`；两条
  `{service}:CallWithBearerToken` action 都得授予 —— **不是** `bedrock:InvokeModel`。
  见 [IAM 前提](#iam-前提)。
- **请求打到了非预期端点。** 检查 `endpointFlavor`。拼写错误，或用错了键名（`endpointType`），
  会被静默忽略，请求发往默认的 `bedrock-runtime` 主机。
- **token 有效期短于请求值。** `tokenExpiresInSeconds` 超过 43200 会被静默截断为 12 小时。
- **更换 bearer 后 client 未复用。** 这是设计使然：client 缓存键包含 bearer，因此在相同
  `baseURL` 上使用新 bearer 会重建 client（防跨租户复用）。

> 上述各情形具体的报错文案和 HTTP 响应体在本轮未采集，故有意省略而非编造。
