本页把 Bedrock 出站认证的三条路径和它们各自需要的 IAM action 汇到一处，方便对照排查权限报错。表里凡标「未实测」的格子均沿用上游标注，未升级成结论。

## 引自 `docs/providers/bedrock-openai.md` 的 action 表

> 引自 `docs/providers/bedrock-openai.md`（IAM prerequisites 一节，main@902904c）：
>
> | Auth tier | Client-side requirement | AWS-side IAM action |
> | --- | --- | --- |
> | `bearerToken` (tier 1) | 有效的预铸 Bedrock bearer token。 | 本 provider 不铸 token —— 铸它所需的 action 在别处消耗。 |
> | `credentials` (tier 2) | config 里传入的 AWS 凭证。 | **未实测** —— `@aws/bedrock-token-generator` 铸 bearer 所需 action 无法从本仓库读到；**勿假设为 `bedrock:InvokeModel`**。 |
> | default chain (tier 3) | 进程上的环境 AWS 凭证。 | **已实测（默认凭证链 + 铸 bearer token）**：授权对象是端点自身命名空间上的 `CallWithBearerToken`，**不是** `bedrock:InvokeModel` —— `endpointType: bedrock-runtime`（默认）→ **`bedrock:CallWithBearerToken`**；`endpointType: bedrock-mantle` → **`bedrock-mantle:CallWithBearerToken`**。 |

## 三种出站认证方式对照

| 出站认证方式 | 需要的 IAM action | 哪些 provider 会走到它 |
| --- | --- | --- |
| 铸短期 bearer token（`bedrock-openai` 默认路径 = tier 3 默认凭证链） | **已实测**：`bedrock:CallWithBearerToken`（`bedrock-runtime`）/ `bedrock-mantle:CallWithBearerToken`（`bedrock-mantle`）。tier 2（显式 `credentials`）走同一条铸-token 路径，但其铸 token 所需 action **未实测**，勿假设为 `InvokeModel`。 | `bedrock-openai` |
| 裸 SigV4（AWS SDK 直连，SigV4 签名调用），action 按 API 家族分列 | · Invoke 家族 → `bedrock:InvokeModel` / `bedrock:InvokeModelWithResponseStream`<br>· Agent 家族 → `bedrock:InvokeAgent`<br>· Knowledge Base 家族 → `bedrock:Retrieve` / `bedrock:RetrieveAndGenerate` | 所有走 Bedrock Runtime SigV4（Converse/Invoke）调用的 provider（`sagemaker-*` / `aws-executor` 走 `sagemaker:InvokeEndpoint`，不在此列）：<br>· Invoke：`bedrock-converse`、`bedrock-deepseek`、`nova-canvas`、`painter`、`titan-embeddings`、`continue-coder`<br>· Agent：`bedrock-agent`（`InvokeAgentCommand`）<br>· KB：`bedrock-knowledge-base`（`RetrieveCommand` / `RetrieveAndGenerateStreamCommand`） |
| 静态 Bedrock API key（tier 1，直接传 `bearerToken`） | 本 provider **不铸这把 key**；铸它所需的 action 在别处消耗，本页不下结论。**但用这把 key 发起调用时，运行期仍按端点命名空间上的 `CallWithBearerToken` 授权**（同 tier 3 口径）。 | `bedrock-openai`（显式传入 `bearerToken` 时） |

## 怎么排查 403 / 401

读报文里 `is not authorized to perform:` 后面的 **action 名**，直接对照上表定位是哪条出站路径缺权限：

- 后面是 `bedrock:CallWithBearerToken`（或 `bedrock-mantle:CallWithBearerToken`）→ 走的是 `bedrock-openai` 铸-bearer 路径（tier 3 默认链，或 tier 1 用 key 调用）。补权限时按 `endpointType` 选对命名空间前缀：`bedrock-runtime` → `bedrock:`，`bedrock-mantle` → `bedrock-mantle:`。
- 后面是 `bedrock:InvokeModel` / `...WithResponseStream`（或 `bedrock:InvokeAgent` / `bedrock:Retrieve` / `bedrock:RetrieveAndGenerate`）→ 走的是 AWS SDK / SigV4 路径（`bedrock-converse`、`bedrock-agent`、`bedrock-knowledge-base` 等），别把它抄进 `bedrock-openai` 的授权里。
- action 名对上了仍报 403 时查 **resource ARN 约束**：deny 也可能来自策略里模型 / agent / KB 的 ARN 未覆盖，而非 action 缺失。

**Trap 提醒**：用 admin 凭证 + 裸 SigV4（如 `curl --aws-sigv4`）本地测**永远成功、永远不暴露**这个 403 —— 因为那条是 `InvokeModel` 路径，admin 本就有。`CallWithBearerToken` 的缺权限只在用 scoped role（如 EC2 instance role）铸 bearer 时才出现。

tier 2（显式 `credentials`）报的错**不作因果结论**：其所需 action 未实测，只提示「对照 action 名 + 保留未实测标注」。上游 Troubleshooting 里的 `401` / `403` / `404` 亦标「未实测（无代码分支，本轮未触发）」，此处引用时同样保留该定性。
