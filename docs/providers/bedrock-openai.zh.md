# bedrock-openai

用 OpenAI SDK 的报文格式调用 Amazon Bedrock 的 **OpenAI 兼容** endpoint。

## 这是什么、什么时候用它

`bedrock-openai` 用 OpenAI SDK 的消息格式，把 chat 请求发往 Bedrock 的 OpenAI 兼容 endpoint
（`https://<host>/openai/v1/chat/completions`）。这个 provider 只做**编排**：串起两个内部模块
—— endpoint 解析与出站认证 —— 然后转发 chat 请求。它**不构造任何 AWS SDK client**，也**不碰**
`process.env`。

适用场景：你的客户端已经在用 OpenAI chat-completions 报文格式，想直连 Bedrock 而不改写这些报文。

**与 `bedrock-converse` 的区别：** `bedrock-converse` 走 AWS SDK 的 Converse API，每次调用都用
SigV4 签名。`bedrock-openai` **完全不做 SigV4 签名** —— 它先铸出（或直接接收）一个短期
**bearer token**，把它当作 API key 交给 OpenAI SDK，由 SDK 向 OpenAI 兼容 endpoint 发送
`Authorization: Bearer <token>`。两个 provider 走的是**不同的授权路径** —— 见下方
[IAM 前提](#iam-前提)。

> 本页行为按 `main` 上的实现（`src/providers/bedrock_openai.ts`、`src/util/bedrock_token.ts`、
> `src/util/bedrock_openai_endpoint.ts`）落笔，不按需求描述写。

## 模型行配置

把 `provider` 设为 `bedrock-openai`，其余放进 `config`。provider 实际读取的字段：

| Key | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | string | N | （取自请求） | **仅当传入请求没有 `model_id` 时**，才被写进请求作为 `model_id`。请求已带 model id 时以请求为准。 |
| `region` | string | N | — | 目标 region。优先级高于 `regions`。 |
| `regions` | string 或 string[] | N | `us-east-1` | 仅当 `region` 缺失时使用。逗号分隔的字符串会按 `,` 拆分；给了多个 region 时，每次调用随机选一个。`region` 和 `regions` 都没配时，回落到 `config.bedrock.region`，最后回落到 `us-east-1`。 |
| `endpointType` | `bedrock-runtime` \| `bedrock-mantle` | N | `bedrock-runtime` | 选择 endpoint host 形态 —— 见 [Endpoint 类型](#endpoint-类型)。 |
| `bearerToken` | string | N | — | 显式 bearer token。优先级最高的认证方式 —— 见 [出站认证](#出站认证)。 |
| `credentials` | object 或 object[] | N | — | 用来铸 bearer token 的显式 AWS 凭证。见 [出站认证](#出站认证)。 |

配置示例：

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

> `us-east-1` 默认值不是这个 provider 写死的，而是 `helper.selectRandomRegion` 在没有配置任何
> region 时的回落。诸如 `temperature`、`top_p`、`max_tokens`、`max_completion_tokens`、`tools`、
> `tool_choice` 等请求级参数取自传入的 chat 请求，而非 `config`。支持流式输出，跟随请求的
> `stream` 标志。

## 出站认证

provider 会在三档认证中**按固定优先级**命中恰好一档。命中的那一档产出一个 bearer token，作为
OpenAI SDK 的 API key 注入（`new OpenAI({ apiKey, baseURL })`）。client **每请求新建**，从不缓存。

| 优先级 | 配置 | 行为 |
| --- | --- | --- |
| 1（最高） | 配了 `bearerToken` | 该值直接用作 API key。**不再铸 token。** |
| 2 | 配了 `credentials` | 用这些凭证铸一个短期 bearer。`credentials` 可以是单个 `{ accessKeyId, secretAccessKey, sessionToken? }` 对象，也可以是数组；数组会被收敛为一个（多于一个时随机选）。 |
| 3（默认） | 两者都没配 | 由默认凭证提供链铸 bearer。 |

对第 2、3 档，token 通过 `@aws/bedrock-token-generator`（`getToken` / `getTokenProvider`）铸出，
`expiresInSeconds` 上限为 **12 小时（43200 秒）** —— 即该生成器自身的最大值。

第 2 档（显式 `credentials`）示例：

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

第 1 档（显式 `bearerToken`）示例：

```json
{
  "provider": "bedrock-openai",
  "config": {
    "model": "openai.gpt-oss-20b-1:0",
    "region": "us-west-2",
    "bearerToken": "<预先铸好的-bedrock-bearer-token>"
  }
}
```

第 3 档是默认：`bearerToken` 和 `credentials` 都不配，token 就从进程的默认凭证链铸出。

## Endpoint 类型

`endpointType` 选择 host 形态。region 只解析一次，同时用于 base URL 与所铸 token，因此 base URL
的 host 与 token 的 region 永不错配。

| `endpointType` | Base URL | 说明 |
| --- | --- | --- |
| `bedrock-runtime`（默认） | `https://bedrock-runtime.<region>.amazonaws.com/openai/v1` | 当 `endpointType` 未设置**或**设为除 `bedrock-mantle` 以外的任意值时使用。 |
| `bedrock-mantle` | `https://bedrock-mantle.<region>.api.aws/openai/v1` | 仅当 `endpointType` 恰好为 `bedrock-mantle` 时选用。 |

OpenAI SDK 会在 base URL 之后自行追加 `/chat/completions`。

> **只有精确字符串 `bedrock-mantle` 才会选到 mantle host。** 其他任何值 —— 包括拼错 —— 都会静默
> 回落到 `bedrock-runtime`；provider 不会抛「未知 endpointType」错误。如果连到了错误的 host，先检查
> `endpointType` 的拼写。

## IAM 前提

⚠️ 这是本 provider 最容易写错的地方。这里的授权路径与 `bedrock-converse` **不是同一个**。

**代码能确定的：** 本 provider 从不发出裸 SigV4 签名请求，也从不调用 Bedrock runtime 的 AWS SDK
client。它总是先拿到一个 bearer token，再把它作为 API key 交给 OpenAI SDK。未提供 `bearerToken`
时，token 通过 `@aws/bedrock-token-generator`（`getToken` / `getTokenProvider`）铸出。因此 SigV4
Converse 调用所需的 `bedrock:InvokeModel` action 是 **`bedrock-converse` 路径上的，不是本路径上的**
—— 不要凭类比把它抄进本 provider 的 IAM 表。

**未实测的：** 铸 token 路径（`@aws/bedrock-token-generator`）实际需要的具体 AWS IAM action。该依赖
包未在本仓库 vendored，`node_modules` 里也未安装，因此仓库内没有可读的代码来确定它调用的确切 AWS
API 或所需的 action 名。在有人用真实的、按权限收窄的凭证对着依赖源码或 AWS 官方文档核实之前，一律标
为 **未实测**。

| 认证档 | 客户端侧需要 | AWS 侧 IAM action |
| --- | --- | --- |
| `bearerToken`（第 1 档） | 一个有效的、预先铸好的 Bedrock bearer token。 | 本 provider 不铸 token —— 铸它所需的 action 已在别处付出。 |
| `credentials`（第 2 档） | 配置里传入的 AWS 凭证。 | **未实测** —— `@aws/bedrock-token-generator` 铸 bearer 所需的 action 无法从本仓库读出。**不要**假设是 `bedrock:InvokeModel`。 |
| 默认凭证链（第 3 档） | 进程上的环境 AWS 凭证。 | **未实测** —— 同第 2 档。 |

> 代码已经点明的一点：本机用管理员凭证测试永远会成功，**永远不会**暴露缺权限的 `403`。铸 token
> 路径的 IAM action 必须用收窄权限的凭证核实，不能靠推断。

## 常见报错与排查

三个源文件里**没有任何自定义 error 分支或 `try`/`catch`** —— 错误由 OpenAI SDK 或
`@aws/bedrock-token-generator` 直接抛出。因此只有下面的条目有代码依据；其余标为未实测。

**有代码依据**

- **`endpointType` 拼错 → 连到错误 host，且不报错。** 只有 `bedrock-mantle` 会选到 mantle host；
  其他任何值（包括拼写错误）都会静默解析到 `bedrock-runtime`。若请求打到了错误的 endpoint，检查
  `endpointType` 的拼写以及解析出的 base URL host。
- **base URL 与 token 的 region 错配已被设计规避。** region 只解析一次，同时传给 base URL 构造器与
  token 铸造器，因此多 region 随机选取不会让 base URL 与 token 指向不同 region。

**未实测（无代码分支；本轮未跑）**

- `401`（bearer token 无效/过期）、`403`（IAM 权限不足 —— 与上面的 IAM 一节强绑，用管理员凭证测试
  时不可见）、`404`（region/endpoint 未暴露 OpenAI 兼容路径）都是 OpenAI SDK 透传的上游 HTTP 错误。
  本仓库没有对应分支，本轮也未实跑，因此在真实下游调用验证之前一律标为 **未实测**。
