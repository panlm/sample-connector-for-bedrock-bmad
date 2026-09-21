# bedrock-openai

将标准 OpenAI 形状的对话请求转发到 Amazon Bedrock 的 **OpenAI 兼容端点**（`/openai/v1/chat/completions`），出站用一枚**短时铸造的 bearer token** 鉴权（`Authorization: Bearer <token>`）。

## 这是什么 / 何时用它

本 provider 用官方 `openai` SDK 直连 Bedrock 的 OpenAI 兼容路径。与 [`bedrock-converse`](./bedrock-converse.md) 不同 —— 后者调用 AWS SDK 的 Converse API 并构造 `@aws-sdk/client-*` 服务客户端 —— `bedrock-openai` **在任何路径下都不构造 `@aws-sdk/client-*` 服务客户端**。每个请求都以携带 bearer token 的 OpenAI-SDK 调用出站。

当你想通过 OpenAI SDK / OpenAI 兼容生态直接打 Bedrock、或需要 OpenAI 形状的请求路径时，选 `bedrock-openai`。想要最广的 Bedrock 模型覆盖以及 Converse 专属特性（提示词缓存、按家族裁剪参数等）时，选 `bedrock-converse`。

> 本页的依据：`main`（`ccef68b`）上的 `src/providers/bedrock_openai.ts`、`src/util/bedrock_token.ts`、`src/util/bedrock_openai_endpoint.ts`。

## 模型行配置

Provider 从模型的 `config` 对象读取以下键（`bedrock_openai.ts:29-49`，region 解析见 `resolveRegion()` `29-41`）：

| 键 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `region` / `regions` | string / string[] | **是** | *（无）* | region 的单一真源 —— 同时喂给 baseURL 与铸 token。`regions` 为数组时取**第 0 个**元素。缺失则抛错（见下）。 |
| `model` | string | 否 | *（无）* | 回退模型 id。仅当传入请求没带 `model_id` 时使用。 |
| `endpointVariant` | string | 否 | `runtime` | 端点形态：`runtime` 或 `mantle`（见[端点变体](#端点变体)）。 |
| `bearerToken` | string | 否 | *（无）* | **P1** 认证 —— 原样使用，不铸 token（见[出站认证](#出站认证)）。 |
| `credentials` | object | 否 | *（无）* | **P2** 认证 —— 静态 AWS 凭证 `{ accessKeyId, secretAccessKey, sessionToken? }`，用来铸 token。 |
| `expiresInSeconds` | number | 否 | `43200` | 铸出 token 的有效期（秒）。落在 `(0, 43200]` 之外的值一律夹到 `43200`。 |

不同于 `bedrock-converse`（`regions` 默认 `["us-east-1"]`），**`bedrock-openai` 没有 region 默认值** —— 缺失 `region`/`regions` 会抛错（`bedrock_openai.ts:35-39`）：

```
You must specify the parameter 'region' (or 'regions') in the backend model configuration.
```

最小配置示例：

```json
{
  "provider": "bedrock-openai",
  "config": {
    "region": "us-east-1",
    "model": "openai.gpt-oss-20b-1:0"
  }
}
```

## 出站认证

出站请求有三种认证方式，共用同一个优先级解析器 `resolveBedrockBearer()`（`bedrock_token.ts:83-94`），按 **P1 > P2 > P3** 的顺序判定：

| 优先级 | 触发条件（`config` 字段） | 行为 | 依据 |
| --- | --- | --- | --- |
| **P1** | 存在 `bearerToken` | **原样**当作 OpenAI 的 `apiKey`。**不铸 token。** | `bedrock_token.ts:84-87` |
| **P2** | 存在 `credentials`（且无 `bearerToken`） | 用该静态凭证经 `getToken()` 铸 token。 | `bedrock_token.ts:65-72` |
| **P3** | 两者都不配 | 走 AWS **默认凭证链**经 `getTokenProvider()` 铸 token。 | `bedrock_token.ts:74-79` |

解析出的值直接传入 `new OpenAI({ baseURL, apiKey })`（`bedrock_openai.ts:53-64`）。

配置认证时值得知道的行为事实：

- **token 每请求铸造 —— 不缓存、无刷新调度。** 每个请求都现铸（或直接复用 P1 的原样 token）（`bedrock_token.ts:8, 54`）。
- **token 绝不写入 `process.env`。** 只按 client 逐个传入（`bedrock_token.ts:6-7`）。（作为对比，`bedrock-converse` 会写 `process.env.AWS_BEARER_TOKEN_BEDROCK`。）
- **OpenAI client 是每请求、函数局部的 `const`** —— 从不挂到 provider 实例上，因此一个租户的 bearer 不会串到另一个租户的请求里（`bedrock_openai.ts:60-64`）。

### P1 —— 显式 `bearerToken`

```json
{
  "provider": "bedrock-openai",
  "config": {
    "region": "us-east-1",
    "bearerToken": "<你的-bedrock-bearer-token>"
  }
}
```

### P2 —— 显式静态凭证

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

`sessionToken` 可选（`bedrock_token.ts:19-23`）。`expiresInSeconds` 可选，并按上文规则夹取。

### P3 —— AWS 默认凭证链

```json
{
  "provider": "bedrock-openai",
  "config": {
    "region": "us-east-1"
  }
}
```

既不配 `bearerToken` 也不配 `credentials` 时，token 从 AWS 默认凭证链（环境变量、共享 config/credentials 文件、容器/实例角色等）铸造，由 token generator 内部解析。

## 端点变体

`endpointVariant` 决定 baseURL 指向哪个 Bedrock host（`bedrock_openai_endpoint.ts:19-35`）：

| `endpointVariant` | baseURL | 依据 |
| --- | --- | --- |
| 未设 / `runtime` / 任何未知值（**默认分支**） | `https://bedrock-runtime.{region}.amazonaws.com/openai/v1` | `bedrock_openai_endpoint.ts:34-35` |
| `mantle` | `https://bedrock-mantle.{region}.api.aws/openai/v1` | `bedrock_openai_endpoint.ts:30-31` |

- **默认值是 `runtime`。** 任何无法识别的取值都会静默回落到 `runtime`（不报错）。
- `/openai/v1` 路径后缀固定；OpenAI SDK 会再拼上 `/chat/completions`（`bedrock_openai_endpoint.ts:14-17`）。
- `{region}` 是从 config 解析一次得到的 region，因此 token 的 region 与 baseURL 的 region 始终一致。

## IAM 前提

> ⚠️ **下面的 IAM action 名来自最小权限 IAM 角色下的实测 —— 不是推断。** 陷阱在于：**在本机用管理员凭证测试时这个失败永远复现不出来** —— 管理员身份被放行所有 action，权限缺失只有在真部署、以受限角色（例如 EC2 instance role）运行时才暴露。

代码能确认的：

- 本 provider **在任何认证路径下都不构造 `@aws-sdk/client-*` 服务客户端**，因此**没有裸 SigV4 调用路径**（`bedrock_token.ts:5`；由 `test/bedrock_token.test.ts:181-194` 断言）。三条认证路径最终都以 `Authorization: Bearer <token>` 出站。
- **P1（`bearerToken`）：** token 由使用者带外提供。本代码不签发它，因此获取它所需的权限完全取决于使用者用什么身份、在哪里铸 —— 本仓库无从判断。
- **P2 / P3：** token 由 `@aws/bedrock-token-generator` 铸造 —— `getToken()`（P2，静态凭证）/ `getTokenProvider()`（P3，默认链）（`bedrock_token.ts:11, 65-79`）。铸 token 用的**身份**从代码可确认；所需的 **IAM action 名**不可确认 —— provider 代码路径里没有任何 `bedrock:` / `InvokeModel` / `GetBearerToken` 之类的 action 字符串。

| 项 | 所需 IAM action | 状态 |
| --- | --- | --- |
| 经 `getToken()` / `getTokenProvider()` 铸 token（P2 / P3） | *（action 名）* | **未实测** |
| 调用 `/openai/v1/chat/completions`（`bedrock-runtime` host） | `bedrock:CallWithBearerToken` | **实测** |
| 调用 `/openai/v1/chat/completions`（`bedrock-mantle` host） | `bedrock-mantle:CallWithBearerToken` | **实测** |

**为什么调用需要 `CallWithBearerToken` 而不是 `InvokeModel`。** 上表两个 `调用` 行是实测的，不是推断。在一个只持有 `bedrock:InvokeModel` / `InvokeModelWithResponseStream` / `ListFoundationModels`（没有 `CallWithBearerToken`）的 EC2 instance role 下，一次 `/openai/v1/chat/completions` 请求被拒，报文如下（观察）：

```
403 ... is not authorized to perform: bedrock-mantle:CallWithBearerToken on resource: *
401 ... is not authorized to perform: bedrock:CallWithBearerToken on resource: *
```

补上 `bedrock:CallWithBearerToken` + `bedrock-mantle:CallWithBearerToken` 后，同一请求立刻成功（观察）。原因（据代码推断）：本 provider 从凭证链**本地**铸出短期 bearer token（`bedrock_token.ts:56-99`，经 `@aws/bedrock-token-generator` —— `package.json:27`），全程不构造任何 `@aws-sdk/client-*` 客户端，因此**没有裸 SigV4 请求路径**。`bedrock:InvokeModel` 是**裸 SigV4** 调用的授权 action；而以 `Authorization: Bearer <token>` 出站的请求，授权走的是 `CallWithBearerToken`，并按 host 加前缀 —— `bedrock-runtime` → `bedrock:CallWithBearerToken`，`bedrock-mantle` → `bedrock-mantle:CallWithBearerToken`。

**铸 token 本身不消耗单独的 action —— 授权发生在调用阶段。** 在同一次最小权限测试里，角色没有 `CallWithBearerToken`，但 token 仍然成功铸出，只有**调用**被拒（观察）。这与「铸 token 是本地 presign、不打任何 AWS API」相符（据代码推断，`bedrock_token.ts:56-99`）。因此 **铸 token** 那一行保持 **未实测**：本轮只覆盖了 P3（默认凭证链 / instance role），没有任何证据表明铸 token 步骤需要它自己的 action，更没有任何证据覆盖静态 `credentials`（P2）铸 token 路径 —— 所以这里不断言任何 mint 阶段的 action。**不要**从「Bedrock 调用一般需要 X」推断一个出来。

## 请求 / 响应行为

- 转发给上游的采样参数（`bedrock_openai.ts:88-98, 126-135`）：`temperature`（默认 `1.0`）、`top_p`（默认 `1.0`）、`max_tokens`、`max_completion_tokens`，以及可选的 `tools` / `tool_choice`（仅在存在时转发）。
- 当请求未带 `model_id` 且 config 设了 `model` 时，请求的 `model_id` 会从 config 回填（`bedrock_openai.ts:66-68`）。
- 流式响应在 delta 里透出 `reasoning_content`，与其它 provider 一致（`bedrock_openai.ts:102-103`）。

## 常见报错与排查

| 现象 | 可能原因 | 依据 |
| --- | --- | --- |
| `You must specify the parameter 'region' (or 'regions')...` | 没配 `region`/`regions`。没有默认值。 | `bedrock_openai.ts:35-39` |
| `mintBedrockBearerToken requires a resolved 'region'.` | 铸 token 时 region 解析为空。 | `bedrock_token.ts:60-61` |
| `resolveBedrockOpenAIBaseURL requires a resolved 'region'...` | 构建 baseURL 时 region 解析为空。 | `bedrock_openai_endpoint.ts:24-27` |
| 请求返回 `401` / `403` | 认证/授权失败 —— 见[出站认证](#出站认证)与 [IAM 前提](#iam-前提)。**注意：权限不足在用管理员凭证测试时复现不出来。** | — |
| `expiresInSeconds` 对超大/为零的值像是被忽略 | 落在 `(0, 43200]` 之外的值会被静默夹到 `43200`。这是行为，不是报错。 | `bedrock_token.ts:42-52` |
