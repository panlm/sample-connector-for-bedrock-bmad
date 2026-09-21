# auto-merge 常见拒绝原因 FAQ

自动合并 workflow 拒绝一个 PR 时，会在 Actions 日志里打一条 `::notice::`，形如：

```
::notice::auto-merge declined for #<PR号>: <原因>
```

**这不是构建失败** —— workflow 是成功退出的，只是决定「暂不合并」（机制见 [auto-merge.md](./auto-merge.md) 第 4 节）。拿着 notice 里**冒号后**的那段原因来查下表即可。

> 表里的 `#{n}`、`{value}`、`[...]`、`{name}={state}` 等是运行时会被真实值替换的**可变部分**，查表时按**关键片段**匹配，别逐字对。下表原因均逐字抄自 `.github/workflows/auto-merge.yml`。

---

## 拒绝原因对照表（覆盖全部 11 条 deny 分支）

| notice 原文片段（冒号后） | 含义 | 怎么改 |
|---|---|---|
| `cross-repository PR` | PR 来自 fork（D1，第 98 行） | 从本仓库内的 `agent/*` 分支开 PR，不要从 fork 开 |
| `head {headRefName} is not agent/*` | head 分支名不以 `agent/` 开头（D2，第 99 行） | 把分支重命名 / 重开为 `agent/...` 前缀 |
| `base is {baseRefName}, not main` | PR 的 base 不是 `main`（D3，第 100 行） | 把 PR 的目标分支改成 `main` |
| `no auto-merge label` | 缺 `auto-merge` 标签（D4，第 103 行） | 标签由评审阶段在 PASS 后授予；等评审，或（有权限时）`gh pr edit <n> --add-label auto-merge` |
| `mergeable={value}` | GitHub 认为 PR 不可干净合并，`value` 非 `MERGEABLE`（D5，第 105 行） | 通常是有冲突或 `mergeable` 还在计算（`UNKNOWN`，见下方等待说明）。解决冲突后重触发 |
| `mergeStateStatus={value}` | 合并状态不健康，`value` ∈ `DIRTY` / `BLOCKED` / `BEHIND`（D6，第 106–107 行） | `DIRTY`=有冲突，先 rebase/合并 main；`BEHIND`=落后于 base，先更新分支；`BLOCKED`=被分支保护规则挡住，补齐所缺的必需项 |
| `cannot read check status (rc={returncode}) — refusing to merge blind` | 读不到 check 状态（`gh pr checks` 返回非 0 或无输出），拒绝盲合（D7，第 111–112 行） | 稍后重试；确认 PR 上确实跑了 check，且 `gh` 有读取权限 |
| `checks not green: {name}={state}, ...` | head 上有 check 不在 `SUCCESS`/`SKIPPED`/`NEUTRAL`（D8，第 119–120 行） | 看 `{name}={state}` 指出的失败 check，修到全绿再重触发 |
| `no checks other than this one — refusing to merge unverified` | 排除 auto-merge 自身后，PR 上再无任何 check（D9，第 121 行） | PR 必须至少有一个其它 check（如 `build`）跑过验证，不能无 check 直合 |
| ``PR body has no usable `Auto-merge-paths:` declaration — found the marker but no paths after it`` | 找到了 `Auto-merge-paths:` 标记，但其后没有可用路径（D10a，第 156–159 行） | 在标记后补上逗号分隔的路径，例如 `Auto-merge-paths: docs/pipeline/auto-merge.md, docs/pipeline/auto-merge-faq.md` |
| ``PR body has no usable `Auto-merge-paths:` declaration — expected a line `Auto-merge-paths: <glob>, <glob>` `` | PR 正文里完全没有 `Auto-merge-paths:` 声明（D10b，第 156–159 行） | 在 PR 正文加一行（行首）`Auto-merge-paths: <glob>, <glob>`，覆盖所有改动文件 |
| `{N} of {M} file(s) outside declared ownership: [...]` | 有 `N` 个（共 `M` 个）改动文件落在声明的路径之外（D11，第 176–178 行；越界文件最多列 6 个，超出补 ` ...`） | 扩大 `Auto-merge-paths:` 使其覆盖 `[...]` 列出的文件，或把越界改动从本 PR 里移除。注意 `*` 不跨 `/`，递归要写 `**`（见 [auto-merge.md](./auto-merge.md) 第 3 节） |

---

## 不是拒绝、无需处理的 notice

| notice 原文片段 | 含义 | 怎么办 |
|---|---|---|
| `mergeable=UNKNOWN for #{n}, attempt {a}/6 — waiting for GitHub to compute it` | GitHub 还在异步计算 `mergeable`，作业在**等待**（第 87 行），最多轮询 6 次、每次隔 5 秒 | 通常无需处理，等它自己算出结果。若 6 次后仍 `UNKNOWN`，会以 D5（`mergeable=UNKNOWN`）fail-closed 拒绝，届时重触发即可 |
| `auto-merge gates passed for #{n}; {k} file(s) within {owns}` | **全部门禁通过**，PR 即将被 `--squash --delete-branch` 合并（第 179 行） | 无需处理，这是成功信号 |
