# Bedrock 出站认证与 IAM action 对照

BRConnector 向 AWS Bedrock 发出站请求时用哪种认证、各自要什么 IAM action，本页做一张速查表。所有 action 取值均引自 `docs/providers/bedrock-openai.md` 的 IAM prerequisites 节，**上游标「未实测 / 推断」的格子本页原样保留、未升级为结论**。

## 引用：`bedrock-openai.md` 的 action 表（原文照抄）

> 引自 `docs/providers/bedrock-openai.md` 的「IAM prerequisites」节，Status 列一字未改：
>
> | Auth path | Trigger | Required IAM action | Status |
> | --- | --- | --- | --- |
> | Bearer call — observed default (`bedrock-runtime`) deployment | The one observed `/v1/chat/completions` request on the tested EC2 instance-role deployment | That single request required **both** `bedrock:CallWithBearerToken` (surfaced as `401`) **and** `bedrock-mantle:CallWithBearerToken` (surfaced as `403`); granting both made the same request succeed | **Verified** (this deployment) |
> | Bearer call — prefix attribution, `endpointFlavor: bedrock-runtime` | A bearer is sent to `https://bedrock-runtime.{region}.amazonaws.com/openai/v1` | Call action prefixed by the endpoint's service namespace → `bedrock:CallWithBearerToken` | **Inferred** (from service namespace; not independently tested per flavor) |
> | Bearer call — prefix attribution, `endpointFlavor: bedrock-mantle` | A bearer is sent to `https://bedrock-mantle.{region}.api.aws/openai/v1` | → `bedrock-mantle:CallWithBearerToken` | **Inferred** (from service namespace; not independently tested per flavor) |
> | Mint token — ③ default credential chain | The bearer-minting step from the default chain (e.g. an EC2 instance role) via `@aws/bedrock-token-generator` | Action(s) the minting step consumes (**not** `bedrock:InvokeModel`); the test exercised the resulting call, not the mint step | **Not verified** |
> | Mint token — ② static `credentials` | The bearer-minting step from an explicit `credentials` entry via the same `@aws/bedrock-token-generator` | Action(s) required to mint from static credentials (**not** `bedrock:InvokeModel`) | **Not verified** (no evidence this round) |
> | Raw SigV4 (this provider does **not** use it — shown for contrast only) | Direct SigV4-signed call to the Bedrock runtime API | Runtime-call action(s) (e.g. the `bedrock:InvokeModel*` family) | **Not verified** (and not on this provider's path) |
> | ① Explicit `bearerToken` (supplied, not minted) | An already-minted bearer is passed in directly | No AWS credentials and no minting at runtime; whatever identity minted that bearer needs the call action(s) above, but that happens outside BRConnector | **Not verified / N/A at runtime** |

## 三种出站认证方式对照

| 出站认证方式 | 需要的 IAM action | 哪些 provider 会走到它 |
| --- | --- | --- |
| 铸短期 bearer token（`bedrock-openai` 默认路径 ③） | 调用动作 `{service}:CallWithBearerToken`；观测部署上需**同时**授予 `bedrock:CallWithBearerToken` 与 `bedrock-mantle:CallWithBearerToken`（源自上表第 1 行「已验证，限该部署」；前缀归属源自第 2/3 行「**推断 Inferred**」）。铸 token 步骤本身的 action = **未实测**（上表第 4 行 Not verified，仅注明「非 `bedrock:InvokeModel`」）。 | `bedrock-openai`（默认凭证链路径 ③） |
| 裸 SigV4（走 AWS SDK 的 provider） | `bedrock:InvokeModel*` 家族 —— 上表第 6 行标为「**未实测·仅作对照，且不在本 provider 路径上**」，不得升级为结论。 | `bedrock-converse` 等所有走 AWS SDK / SigV4 的 provider |
| 静态 Bedrock API key（`bedrock-openai` 显式 `bearerToken` 路径 ①，及静态 `credentials` 铸造路径 ②） | 运行时不铸、不用 AWS 凭证，作为 OpenAI `apiKey` 送出仍按调用动作 `{service}:CallWithBearerToken` 评估；铸这把 key 的动作在 BRConnector 之外 —— 上表第 7 行标 **Not verified / N/A at runtime**、静态 `credentials` 现铸为第 5 行 **Not verified**，**两者均为未实测**。 | `bedrock-openai`（① 显式 `bearerToken` / ② 静态 `credentials`） |

## 怎么排查 403 / 401

看报文里 `is not authorized to perform:` 后面跟的 action 名，直接对照上面两张表定位缺权限的路径：

- `401` → 缺 `bedrock:CallWithBearerToken`；`403` → 缺 `bedrock-mantle:CallWithBearerToken`。观测部署上**两者都要授予**（上表第 1 行，已验证）。
- 报文里出现 `bedrock:InvokeModel*` 家族：那只属于（**未实测的**）裸 SigV4 对照行，**不在 `bedrock-openai` 的 bearer 路径上** —— 给 bearer 路径补 `InvokeModel` 不会消除它的 401/403。
- 报错指向铸 token 步骤：该步骤消耗的 action 本轮**未实测**，请对照 `@aws/bedrock-token-generator` 与 AWS 文档确认，勿凭调用动作反推。
