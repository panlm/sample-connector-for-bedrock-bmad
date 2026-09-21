# Claude 种子 `global.` 跨区 profile 判定报告（2026-09-21）

> 交付形态：**零改动（分支 A）**。本报告是 Epic 1（Story 1.1 + 1.2 合并卡，BMAD-396）的判定与核验产物。
> 结论先行：`src/scripts/patch-0.0.5.sql` 里 10 条 legacy Claude 种子行，**10/10 无 `global.` 跨区 inference profile**，迁移集为空 → 走**分支 A（零改动交付）**，不改任何 modelId、不新增 patch。

## 1. 背景与判定规则

- 承载 Claude 种子 modelId 的唯一文件是 `src/scripts/patch-0.0.5.sql`（10 条 Claude 行，行号 36/38/40/42/44/46/48/50/52/54）。`src/models_data.ts` 只是展示名注册表，`grep -nE modelId src/models_data.ts` 无命中。
- **AD-1（架构不变量）**：迁移集判定是唯一分支闸门。某条种子「是否应迁移到 `global.` profile」以 AWS Bedrock 控制面 API 的**实测存在性**为准，不靠 modelId 字符串规律推断。
- **AD-2（已拍板 2026-09-20）**：迁移集为空 = 终态零改动。不新增 `patch-0.0.42.sql`，不改 modelId / `install.ts` / `models_data.ts`。

## 2. 判定来源（可核验）

来源为 AWS Bedrock 控制面 API 实测，账户 `365869126441`，region `us-east-1`，抓取日期 **2026-09-21**（本卡承接 stage 1 / BMAD-372 判定表，并于本次交付时用同一 API 实地复核，结论一致）。

### 2.1 全部 `global.anthropic.*` SYSTEM_DEFINED profile

```
$ aws bedrock list-inference-profiles --type-equals SYSTEM_DEFINED --region us-east-1 \
    --query "inferenceProfileSummaries[?starts_with(inferenceProfileId, 'global.anthropic')].inferenceProfileId" --output json
[
    "global.anthropic.claude-sonnet-4-20250514-v1:0",
    "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "global.anthropic.claude-opus-4-5-20251101-v1:0",
    "global.anthropic.claude-opus-4-7",
    "global.anthropic.claude-opus-4-8",
    "global.anthropic.claude-fable-5",
    "global.anthropic.claude-sonnet-5",
    "global.anthropic.claude-opus-5",
    "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    "global.anthropic.claude-opus-4-6-v1",
    "global.anthropic.claude-fable-5-1",
    "global.anthropic.claude-sonnet-4-6"
]
```

**观察**：所有 `global.anthropic.*` profile 都是 Claude 4 / 4.5 / 5 / Fable 代次，**没有一个是 `claude-3` 代次**。

### 2.2 全部带 `claude-3` 的 SYSTEM_DEFINED profile

```
$ aws bedrock list-inference-profiles --type-equals SYSTEM_DEFINED --region us-east-1 \
    --query "inferenceProfileSummaries[?contains(inferenceProfileId, 'claude-3')].inferenceProfileId" --output json
[
    "us.anthropic.claude-3-sonnet-20240229-v1:0",
    "us.anthropic.claude-3-haiku-20240307-v1:0"
]
```

**观察**：带 `claude-3` 的 SYSTEM_DEFINED profile 只有两条 `us.` **区域**形式，**没有任何 `global.` 形式**。

### 2.3 逐种子探测其 `global.` 形式（`get-inference-profile`）

对 10 条种子对应的每个基础 modelId 探测其 `global.anthropic.*` 形式，全部返回 `ResourceNotFoundException`（实际查过的否定判断）：

```
$ aws bedrock get-inference-profile --inference-profile-identifier <id> --region us-east-1
global.anthropic.claude-3-7-sonnet-20250219-v1:0 -> ResourceNotFoundException (NO global profile)
global.anthropic.claude-3-5-sonnet-20241022-v2:0 -> ResourceNotFoundException (NO global profile)
global.anthropic.claude-3-5-sonnet-20240620-v1:0 -> ResourceNotFoundException (NO global profile)
global.anthropic.claude-3-5-haiku-20241022-v1:0 -> ResourceNotFoundException (NO global profile)
global.anthropic.claude-3-sonnet-20240229-v1:0  -> ResourceNotFoundException (NO global profile)
global.anthropic.claude-3-haiku-20240307-v1:0   -> ResourceNotFoundException (NO global profile)
global.anthropic.claude-3-opus-20240229-v1:0    -> ResourceNotFoundException (NO global profile)
```

> 说明：10 条种子行映射到 7 个不同的基础 modelId（`cr-` 前缀的行与其非 `cr-` 行共享同一底层 modelId，只是种子名不同 / `us.` 区域前缀不同）。7 个基础 modelId 的 `global.` 形式全部不存在，故 10 条种子行逐行判定「无 `global.` profile」。

## 3. 逐模型判定表（全部 10 条，一行不漏）

| # | 行号 | 种子名 | 现 modelId | 有 `global.` profile | 判定依据 |
|---|---|---|---|---|---|
| 1 | 36 | claude-3-7-sonnet | `anthropic.claude-3-7-sonnet-20250219-v1:0` | **否** | §2.3 `global.` 形式 ResourceNotFoundException；§2.2 无 claude-3 global |
| 2 | 38 | cr-claude-3-7-sonnet | `us.anthropic.claude-3-7-sonnet-20250219-v1:0` | **否** | 已是 `us.` 区域 profile；对应 `global.` 形式 ResourceNotFoundException（§2.3） |
| 3 | 40 | claude-3-5-sonnet-v2 | `anthropic.claude-3-5-sonnet-20241022-v2:0` | **否** | §2.3 ResourceNotFoundException |
| 4 | 42 | claude-3-5-sonnet | `anthropic.claude-3-5-sonnet-20240620-v1:0` | **否** | §2.3 ResourceNotFoundException |
| 5 | 44 | cr-claude-3-5-sonnet-v2 | `us.anthropic.claude-3-5-sonnet-20241022-v2:0` | **否** | 已是 `us.` 区域 profile；对应 `global.` 形式 ResourceNotFoundException（§2.3） |
| 6 | 46 | cr-claude-3-5-sonnet | `us.anthropic.claude-3-5-sonnet-20240620-v1:0` | **否** | 已是 `us.` 区域 profile；对应 `global.` 形式 ResourceNotFoundException（§2.3） |
| 7 | 48 | claude-3-5-haiku | `anthropic.claude-3-5-haiku-20241022-v1:0` | **否** | §2.3 ResourceNotFoundException |
| 8 | 50 | claude-3-sonnet | `anthropic.claude-3-sonnet-20240229-v1:0` | **否** | §2.2 仅存 `us.` 形式；§2.3 `global.` 形式 ResourceNotFoundException |
| 9 | 52 | claude-3-haiku | `anthropic.claude-3-haiku-20240307-v1:0` | **否** | §2.2 仅存 `us.` 形式；§2.3 `global.` 形式 ResourceNotFoundException |
| 10 | 54 | claude-3-opus | `anthropic.claude-3-opus-20240229-v1:0` | **否** | §2.3 ResourceNotFoundException |

## 4. 结论（FR2 / AD-1）

- **迁移集为空：0/10**。10 条 legacy Claude 种子行没有任何一条存在可迁移的 `global.` 跨区 inference profile。
- 据 AD-1，迁移集为空 → 本次走**分支 A（零改动交付）**。
- 据 AD-2，空集 = 终态零改动 → **不改任何 modelId、不新增 `patch-0.0.42.sql`、不改 `install.ts` / `models_data.ts`**。

## 5. 零改动基线核验（Story 1.2）

核验命令的原始输出见交付评论 / PR 正文。核验点：

- **AC-A1**：`git diff -- src/scripts/patch-0.0.5.sql` 对 10 条 Claude 种子行无输出（modelId 逐字节未变）。
- **AC-A2**：`test ! -e src/scripts/patch-0.0.42.sql` 成立（该文件不存在）。
- **AC-A3**：`git diff -- src/install.ts` 无实质改动。
- **AC-A4**：`git diff -- src/models_data.ts` 对 Claude 条目无输出（该文件不含 modelId）。
- **AC-G4 / NFR3**：`git diff` 新增行不含 `DELETE`；改动路径不含 `src/provider*` 与 `.github/`（唯一改动是新增本 `docs/` 报告）。
- **AC-G5 / NFR4**：`pnpm lint`、`pnpm test` 退出码均为 0。
- **AC-A6**：无迁移行 → 无「带防护更新」测试 = **达标而非缺测**，不为凑测试而新造 patch。

## 6. 范围与未决（AC-G2 / NFR1）

- 本次**不换任何模型代次**。换代次（如把 `claude-3-*` 升级到 Claude 4/4.5/5 代次并挂 `global.` profile）是**产品决策**，超出本卡范围，仅作 open question 记录，不改代码。
- open question（留给人类拍板）：是否要为已有 `global.` profile 的 Claude 4/4.5/5 代次新增种子行 / 或把部分 legacy 种子升级代次并采用 `global.` 跨区 profile。此为未来 Epic（分支 B），本卡不实施。
