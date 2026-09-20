# 自动合并被拒排查表（FAQ）

PR 没被自动合并？去 GitHub Actions 的 `auto-merge` 工作流看它打的 `::notice::`。每条拒绝都长这样：

```
::notice::auto-merge declined for #<PR号>: <原因>
```

拿着 `<原因>` 那段原文，在下表里查。**这不是构建失败**——工作流以成功退出（绿勾）并打这条 notice，只是没有合并。机制全貌见 [auto-merge.md](./auto-merge.md)。

> 下表「notice 原文片段」列与 `.github/workflows/auto-merge.yml` 里的字符串**逐字一致**。凡是 `<...>` 或 `[...]` 是运行时填进去的实际值（PR 的分支名、状态、文件列表等），其余字符照抄。表覆盖全部 **11 条 deny 分支**（第 10 条按正文里是否含 `Auto-merge-paths` 标记拆成两行，共 12 行）。

## 排查表

| # | notice 原文片段 | 含义 | 怎么改 |
|---|---|---|---|
| 1 | `cross-repository PR` | PR 来自 fork（跨仓库），流水线不自动合 fork | 从本仓库的分支重开 PR；fork 来的 PR 不走自动合，需人工处理 |
| 2 | `head <分支名> is not agent/*` | 头分支名不以 `agent/` 开头 | 把改动放到 `agent/*` 分支上重开 PR；只有流水线创建的 `agent/*` 分支自动合 |
| 3 | `base is <目标分支>, not main` | PR 的目标分支不是 `main` | 把 PR 的 base 改成 `main`；不自动合到其它目标分支 |
| 4 | `no auto-merge label` | PR 上没有 `auto-merge` 标签 | 等评审阶段通过后授予 `auto-merge` 标签——**别自己打**。打标签会重新触发评估 |
| 5 | `mergeable=<值>` | GitHub 判定不可干净合并（如 `mergeable=CONFLICTING`，即有冲突） | 解决冲突、rebase 到最新 `main`。若是 `mergeable=UNKNOWN`，那是 GitHub 还没算完，会自动轮询 6 次，通常无需操作 |
| 6 | `mergeStateStatus=<状态>` | 合并状态是 `DIRTY`（冲突）/ `BLOCKED`（被分支保护挡住）/ `BEHIND`（落后于 base）之一 | `DIRTY`→解决冲突；`BEHIND`→更新分支到最新 `main`；`BLOCKED`→补齐分支保护要求的条件（review / 必需 check 等） |
| 7 | `cannot read check status (rc=<返回码>) — refusing to merge blind` | 读不到 check 状态（`gh pr checks` 失败或无输出），fail-closed 拒绝盲合 | 一般是短暂问题：重新触发一次（如重打 `auto-merge` 标签或重跑 build）。持续出现请找维护者 |
| 8 | `checks not green: <check名>=<状态>, ...` | 头 commit 上有 check 不是 `SUCCESS`/`SKIPPED`/`NEUTRAL`（例如 `build=FAILURE`） | 修到列出的每个 check 都变绿；每一个 check（build + ci + 其它）都必须通过 |
| 9 | `no checks other than this one — refusing to merge unverified` | 除了本 job 自己以外没有任何 check，等于没验证过 | 确认 build / ci 等 check 确实在这个 PR 上跑起来了；没有验证不会合 |
| 10a | `` PR body has no usable `Auto-merge-paths:` declaration — found the marker but no paths after it `` | 正文里有 `Auto-merge-paths` 标记，但后面没写出可用路径 | 在标记后补上路径，如 `Auto-merge-paths: docs/pipeline/auto-merge.md` |
| 10b | `` PR body has no usable `Auto-merge-paths:` declaration — expected a line `Auto-merge-paths: <glob>, <glob>` `` | 正文里完全没有 `Auto-merge-paths:` 声明 | 在 PR 正文加一行纯文本：`Auto-merge-paths: <你改动的路径, 逗号分隔>` |
| 11 | `<N> of <M> file(s) outside declared ownership: [越界文件列表]` | 有文件不被 `Auto-merge-paths:` 声明的任何 glob 覆盖（越界，超过 6 个会在末尾追加 ` ...`） | 把 notice 列出的越界文件加进 `Auto-merge-paths:` 声明，或从本 PR 移除这些改动；每个改动文件都必须被声明覆盖 |

## 关于 `Auto-merge-paths:` 的写法要点

第 10、11 条都和这行声明有关。要点（详见 [auto-merge.md §5](./auto-merge.md)）：

- 一行纯文本，行首就是关键字，逗号分隔多个 glob：`Auto-merge-paths: docs/pipeline/auto-merge.md, docs/pipeline/auto-merge-faq.md`
- 声明必须覆盖 PR 改动的**每一个**文件，否则触发第 11 条。
- 单星 `*` **不跨目录**；要匹配子目录必须写 `**`（例如 `docs/**` 而非 `docs/*`）。

## 不是拒绝的 notice

看到下面这些不用查表——它们不是门禁拒绝：

- `mergeable=UNKNOWN for #<N>, attempt <i>/6 — waiting for GitHub to compute it` —— GitHub 还没算完可合并性，工作流在自动轮询等待（最多 6 次）。
- `auto-merge gates passed for #<N>; <k> file(s) within <owns>` —— 全部门禁通过，即将合并。
