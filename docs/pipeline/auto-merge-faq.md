# auto-merge 拒绝原因排查表（FAQ）

你的 PR 没被自动合并，日志里出现了一条

```
::notice::auto-merge declined for #<PR号>: <原因>
```

拿 `<原因>` 部分对照下表查改法。机制全貌见 [auto-merge.md](./auto-merge.md)。

> **先记住**：declined 是一条 `::notice::`，workflow 以成功退出 —— 它**不是构建失败**，
> 不会把任何 check 标红。它只表示「这个 PR 没达到自动合并条件」。

## 怎么用这张表

- 「notice 片段」列是拒绝原文里 `declined for #<n>: ` 之后的 `<msg>` 部分，照代码字符串原样抄。
- 尖括号 `<...>`（如 `<headRefName>`、`<state>`）是运行时填入的**实际值**，不是字面文字；
  查表时对着固定文字部分匹配即可。
- 覆盖 `auto-merge.yml` 里全部 **10 条** deny 分支，外加 1 条常被误当拒绝的等待型 notice。

## 十条拒绝原因

| # | notice 片段（`<msg>`） | 含义 | 怎么改 |
|---|---|---|---|
| 1 | `cross-repository PR` | PR 来自 fork（跨仓库） | 从本仓库内的 `agent/*` 分支开 PR，不要从 fork 提 |
| 2 | `head <headRefName> is not agent/*` | 源分支名不以 `agent/` 开头 | 把源分支改名为 `agent/...` 再重开 PR（`<headRefName>` 会是你的实际分支名） |
| 3 | `base is <baseRefName>, not main` | PR 目标分支不是 `main` | 把 PR 的 base 改为 `main` |
| 4 | `no auto-merge label` | PR 没有 `auto-merge` 标签 | 由放行方给 PR 加标签：`gh pr edit <PR号> --add-label auto-merge`（贡献者不自行添加，等评审放行） |
| 5 | `mergeable=<mergeable>` | GitHub 判定不可合（`<mergeable>` 常见为 `CONFLICTING` 或 `UNKNOWN`） | 解决冲突 / rebase 到最新 `main`，推上去等 GitHub 重算为 `MERGEABLE` |
| 6 | `mergeStateStatus=<mergeStateStatus>` | 合并状态异常 | `DIRTY` → 解冲突；`BEHIND` → 把分支更新到最新 `main`；`BLOCKED` → 补齐必需检查/审批 |
| 7 | `cannot read check status (rc=<returncode>) — refusing to merge blind` | 读不到检查状态，拒绝盲合 | 通常是瞬时问题；重新触发 `build` 重跑一次，或确认 checks 是否真的产出了状态。注意原文里是 em dash `—` |
| 8 | `checks not green: <name>=<state>, …` | 有检查未通过（非 `SUCCESS`/`SKIPPED`/`NEUTRAL`） | 修到列出的每个 `<name>` 都变绿；`<state>` 告诉你它当前是失败还是仍在跑 |
| 9 | `` PR body has no `Auto-merge-paths:` declaration `` | PR 正文缺少所有权声明 | 在 PR 正文加一行 `Auto-merge-paths: <逗号分隔的 glob>`，列出你改动的文件路径 |
| 10 | `<X> of <Y> file(s) outside declared ownership: <stray[:6]> …` | 有 `<X>` 个改动文件落在声明范围外（列出前 6 个） | 要么收窄改动到声明范围内，要么把这些越界文件的路径补进 `Auto-merge-paths:`。注意 `*` 不跨 `/`，要递归得写 `**` |

## 附：一条不是拒绝的 notice

| notice 片段 | 含义 | 怎么改 |
|---|---|---|
| `mergeable=UNKNOWN for #<PR号>, attempt <n>/6 — waiting for GitHub to compute it` | GitHub 还在异步计算 `mergeable`，workflow 正在轮询等待（最多 6 次） | **无需处理**，这是等待不是拒绝。若 6 次后仍 `UNKNOWN`，才会走到 #5 fail-closed 拒绝 |

## 关于第 4 条 `auto-merge` 标签

`auto-merge` 标签是显式放行开关，**由评审环节判定通过后添加**，贡献者不要自己打。
PR 达标后等放行方执行 `gh pr edit <PR号> --add-label auto-merge`；下一次 `build` 成功再触发
auto-merge 时才会评估合并。
