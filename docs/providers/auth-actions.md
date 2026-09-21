# Bedrock 出站认证与 IAM action 对照

本页把三种出站认证方式对应到各自需要的 IAM action，帮你按 403 / 401 报文快速定位缺哪条权限。

## 引用：`bedrock-openai` 的实测 action 表

以下 action 表**原样引自** `docs/providers/bedrock-openai.md`（main，commit `9ac1c1d`），不得改动其结论；`Mint token` 行的 `Untested` 逐字保留：

> | Item | Required IAM action | Status |
> | --- | --- | --- |
> | Mint token via `getToken()` / `getTokenProvider()` (P2 / P3) | *(action name)* | **Untested** |
> | Call `/openai/v1/chat/completions` (`bedrock-runtime` host) | `bedrock:CallWithBearerToken` | **Measured** |
> | Call `/openai/v1/chat/completions` (`bedrock-mantle` host) | `bedrock-mantle:CallWithBearerToken` | **Measured** |

## 三种出站认证方式对照

| 出站认证方式 | 需要的 IAM action | 哪些 provider 会走到它 |
|---|---|---|
| 铸短期 bearer token（P2/P3，`bedrock-openai` 默认路径） | 调用时：`bedrock:CallWithBearerToken`（`bedrock-runtime` 主机）/ `bedrock-mantle:CallWithBearerToken`（`bedrock-mantle` 主机）（**已实测**）；铸 token 这一步本身 **未实测** | `bedrock-openai` |
| 裸 SigV4（走 AWS SDK 的 provider） | `bedrock:InvokeModel` / `InvokeModelWithResponseStream`（上游标为「裸 SigV4 的授权 action」，但本轮**未对这些 provider 实测** → **未实测**） | `bedrock-converse` 等所有构造 `@aws-sdk/client-*` 的 provider |
| 静态 Bedrock API key（P1，`bearerToken` 逐字透传） | 调用时同 bearer token 路径（`CallWithBearerToken`）；这把 key 如何获取/铸由 operator 带外提供，本仓无法判定 → **未实测** | `bedrock-openai`（P1 分支） |

## 怎么排查 403 / 401

看报文里 `is not authorized to perform:` 后面的 action 名，直接对照上表定位缺权限的路径：

- `bedrock:CallWithBearerToken` / `bedrock-mantle:CallWithBearerToken` → 走的是**铸短期 bearer token** 调用路径（`bedrock-openai`），给对应主机前缀的 action 补权限。
- `bedrock:InvokeModel` / `InvokeModelWithResponseStream` → 走的是**裸 SigV4** 路径（AWS SDK provider）。此归属上游**未实测**，按需最小权限验证。

上游实测报文样例：

```
403 ... is not authorized to perform: bedrock-mantle:CallWithBearerToken on resource: *
401 ... is not authorized to perform: bedrock:CallWithBearerToken on resource: *
```

> 注意：least-privilege 角色才会暴露缺权限；用 admin 凭证本地测不出（引自上游 `bedrock-openai.md` 的 ⚠️ 提示）。
