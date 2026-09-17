# auto-merge FAQ：拒绝原因排查表

PR 没被自动合并时，auto-merge workflow 会在日志里打一条 `::notice::` 通知，完整形态是：

```
::notice::auto-merge declined for #<PR号>: <原因>
```

拿 `<原因>` 部分来查下表：每行给出**notice 原文片段（照抄代码字符串）**、含义、怎么改。机制细节见 [auto-merge.md](auto-merge.md)。

> ⚠️ **被拒不是构建失败。** 所有 `auto-merge declined ...` 都走 `::notice::`，且 workflow `sys.exit(0)` 以**成功**退出（依据 `auto-merge.yml` 里 `deny()` 的 `# declining is not a build failure`）。看到拒绝通知说明"这次没合"，不代表"CI 挂了"。

下表 10 行对应 `auto-merge.yml` 的 10 条 deny 分支，最后 1 行是成功态（非拒绝）供对照。原文中 `{...}` 是会被实参替换的占位。

| notice 原文片段（照抄） | 含义 | 怎么改 |
|---|---|---|
| `cross-repository PR` | 这是从 fork 仓库来的 PR，自动合并只处理本仓库分支。 | 从本仓库的 `agent/*` 分支开 PR，不要从 fork 开。 |
| `head {pr["headRefName"]} is not agent/*` | PR 的源分支名没有以 `agent/` 开头。 | 用流水线约定的 `agent/...` 分支名重开 PR（或改名后重开）。 |
| `base is {pr["baseRefName"]}, not main` | PR 的目标分支不是 `main`。 | 把 PR 的 base 改成 `main`。 |
| `no auto-merge label` | PR 没有打 `auto-merge` label。 | `gh pr edit <n> --add-label auto-merge`。 |
| `mergeable={pr["mergeable"]}` | GitHub 判定该 PR 不可合，`mergeable` 不是 `MERGEABLE`（如 `CONFLICTING` 有冲突、`UNKNOWN` 还在计算）。 | `CONFLICTING`：rebase 或合入最新 `main` 解冲突；`UNKNOWN`：稍等 GitHub 算完，再触发一次 build 重新评估。 |
| `mergeStateStatus={pr["mergeStateStatus"]}` | 合并状态是 `DIRTY` / `BLOCKED` / `BEHIND` 之一（脏 / 被分支保护或必需检查挡住 / 落后 base）。 | `BEHIND`：把分支更新到最新 `main`；`BLOCKED`：补齐分支保护要求的检查或评审；`DIRTY`：解冲突。 |
| `cannot read check status (rc={out.returncode}) — refusing to merge blind` | `gh pr checks` 拉不到 check 状态（返回码非 0 或输出为空），拒绝盲合。 | 通常是瞬时或权限问题：重跑一次 build 触发重新评估；若持续失败，找维护者查 token/权限。 |
| `checks not green: {name}={state}, ...` | head 上有 check run 不在 `SUCCESS` / `SKIPPED` / `NEUTRAL` 中（如某个 `=FAILURE`）；notice 里列出所有不绿的 `名字=状态`。 | 修掉列出来的那个失败检查（lint / test / build 等），推新提交让它变绿。 |
| `` PR body has no `Auto-merge-paths:` declaration `` | PR 正文里缺少 `Auto-merge-paths:` 声明行。 | 在 PR 正文加一行 `Auto-merge-paths: <逗号分隔的 glob>`，声明本 PR 拥有哪些路径。 |
| `{len(stray)} of {len(changed)} file(s) outside declared ownership: {stray[:6]}` | 有 `stray` 个改动文件落在声明的 glob 之外（列出前 6 个，越界超 6 个时结尾追加 ` ...`）。 | 要么把越界文件从这个 PR 里拆走，要么把它们纳入 `Auto-merge-paths:`（注意 `*` 不跨 `/`，递归要写 `**`——见 [auto-merge.md](auto-merge.md) 第 5 节）。 |
| `auto-merge gates passed for #{n}; {len(changed)} file(s) within {owns}`（**成功态，非拒绝**） | 全部门禁通过，即将 squash 合并并删除源分支。 | 无需处理——说明已经合了。 |
