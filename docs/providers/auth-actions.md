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
| 裸 SigV4（AWS SDK 直连，SigV4 签名 Converse / Invoke 调用） | `bedrock:InvokeModel` / `bedrock:InvokeModelWithResponseStream`（Converse 路径） | 所有走 AWS SDK 的 provider：`bedrock-converse`、`bedrock-agent`、`bedrock-knowledge-base`、`bedrock-claude`、`bedrock-deepseek`、`bedrock-llama3`、`bedrock-mixtral`、`nova-canvas`、`painter`、`titan-embedings`、`continue-coder` |
| 静态 Bedrock API key（tier 1，直接传 `bearerToken`） | 本 provider **不铸 token、不消耗 IAM action**；铸这把静态 key 时用到的 action 在别处消耗，本页不下结论。 | `bedrock-openai`（显式传入 `bearerToken` 时） |

## 怎么排查 403 / 401

读报文里 `is not authorized to perform:` 后面的 **action 名**，直接对照上表定位是哪条出站路径缺权限：

- 后面是 `bedrock:CallWithBearerToken`（或 `bedrock-mantle:CallWithBearerToken`）→ 走的是 `bedrock-openai` 铸-bearer 路径（默认 tier 3），补这条 action 即可。
- 后面是 `bedrock:InvokeModel` / `...WithResponseStream` → 走的是 AWS SDK / SigV4 路径（`bedrock-converse` 等），别把它抄进 `bedrock-openai` 的授权里。

**Trap 提醒**：用 admin 凭证 + 裸 SigV4（如 `curl --aws-sigv4`）本地测**永远成功、永远不暴露**这个 403 —— 因为那条是 `InvokeModel` 路径，admin 本就有。`CallWithBearerToken` 的缺权限只在用 scoped role（如 EC2 instance role）铸 bearer 时才出现。

tier 2（显式 `credentials`）报的错**不作因果结论**：其所需 action 未实测，只提示「对照 action 名 + 保留未实测标注」。上游 Troubleshooting 里的 `401` / `403` / `404` 亦标「未实测（无代码分支，本轮未触发）」，此处引用时同样保留该定性。
