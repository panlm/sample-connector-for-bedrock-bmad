# 流水线 PR 自动合并（auto-merge）

本文说明 `.github/workflows/auto-merge.yml` 如何自动合并流水线产出的 PR：它什么时候触发、
必须通过哪些门禁、`Auto-merge-paths:` 声明怎么写，以及为什么「被拒绝」不等于「构建失败」。

面向对象：向本仓库提交 `agent/*` 分支 PR 的贡献者（人或流水线 agent）。
排查某条具体拒绝原因请配合 [auto-merge-faq.md](./auto-merge-faq.md) 使用。

> 本文所有事实来自实读 `.github/workflows/auto-merge.yml`（119 行）。门禁共 **10 条**。

## 1. 什么时候触发

auto-merge 不是一个能手动跑的 workflow，也不监听 PR 事件本身。它挂在名为 `build` 的
workflow 的 `workflow_run` 事件上：

```yaml
on:
  workflow_run:
    workflows: [build]
    types: [completed]
```

也就是说：**每次 `build` 跑完（`completed`），auto-merge 才会被唤起一次。**

被唤起后，`merge` job 还有一道前置条件（job 级 `if`），两个条件必须同时满足才会进入评估：

```yaml
if: github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'pull_request'
```

- `build` 的结论必须是 `success` —— build 失败，auto-merge 整个 job 不跑。
- 触发 `build` 的原始事件必须是 `pull_request` —— 非 PR 触发（如 push 到分支）不评估。

进入 job 后，第一步用 `build` 那次运行的 `head_sha` 去所有 open PR 里匹配 `headRefOid`
找到对应 PR。**匹配不到就直接以成功退出**（打印 `no open PR at <SHA> — nothing to do`），
这属于前置短路，不是门禁，不会打 `declined` notice。

### mergeable 轮询（不是门禁，是等待）

GitHub 异步计算 PR 的 `mergeable` 字段，PR 刚开或 `main` 刚动时它会短暂为 `UNKNOWN`。
如果只读一次就按 `UNKNOWN` 判拒，一个本来没问题的 PR 会被永远搁置 —— 因为 auto-merge 只在
`workflow_run` 时触发，而那次触发已经发生，不会自己重试。所以代码轮询最多 6 次、每次 `sleep 5`，
期间打信息性 notice：

```
::notice::mergeable=UNKNOWN for #<PR号>, attempt <n>/6 — waiting for GitHub to compute it
```

**这条 notice 表示「在等 GitHub 算完」，不是拒绝，也不计入门禁总数。** 如果 6 次后 GitHub
仍未给出答案，才会走到门禁 #5 按 `mergeable=UNKNOWN` fail-closed 拒绝。

## 2. 十条门禁（逐条）

所有拒绝都由同一个 `deny()` 产生：

```python
def deny(msg):
    print(f"::notice::auto-merge declined for #{n}: {msg}")
    sys.exit(0)          # declining is not a build failure
```

因此**每条拒绝的完整 notice 都是** `::notice::auto-merge declined for #<PR号>: <msg>`，
下表「notice 片段」列即 `<msg>` 部分（尖括号 `<...>` 是运行时插入的实际值，不是字面文字）。
门禁按代码顺序 fail-closed 判定，任一条不过即拒。

| # | 门禁 | 判定条件 | notice 片段（`<msg>`） | 为什么存在 |
|---|---|---|---|---|
| 1 | 非跨仓库 | PR 来自 fork（`isCrossRepository` 为真） | `cross-repository PR` | 只自动合本仓库内的分支；fork 来的 PR 不受流水线所有权约束，不能盲信 |
| 2 | 分支名前缀 | 源分支名不以 `agent/` 开头 | `head <headRefName> is not agent/*` | 只自动合流水线产出的 `agent/*` 分支，人工分支不走自动合流 |
| 3 | 目标分支 | base 不是 `main` | `base is <baseRefName>, not main` | 只自动合入 `main`，防止误合到其他长期分支 |
| 4 | 显式 opt-in 标签 | PR 没有 `auto-merge` 标签 | `no auto-merge label` | 自动合并必须被显式授权；没有标签就是没被放行 |
| 5 | 可合并性 | `mergeable` 不是 `MERGEABLE` | `mergeable=<mergeable>` | GitHub 判定不可合（有冲突等），不能强合 |
| 6 | 合并状态 | `mergeStateStatus` 属于 `DIRTY`/`BLOCKED`/`BEHIND` | `mergeStateStatus=<mergeStateStatus>` | 脏（有冲突）、被阻塞（缺必需检查/审批）、落后（未跟上 main）都不能合 |
| 7 | 能读到检查状态 | 读 `gh pr checks` 失败或返回空 | `cannot read check status (rc=<returncode>) — refusing to merge blind` | 拿不到检查结果时拒绝「盲合」，宁可不合也不冒险 |
| 8 | 检查全绿 | 有检查的 `state` 不属于 `SUCCESS`/`SKIPPED`/`NEUTRAL` | `checks not green: <name>=<state>, …` | 必须所有检查通过（build、ci 及其他），失败/进行中的检查一律拦下 |
| 9 | 声明所有权 | PR 正文没有有效的 `Auto-merge-paths:` 声明 | `` PR body has no `Auto-merge-paths:` declaration `` | fail-closed：不声明自己改哪些文件的 PR，永远不自动合 |
| 10 | 不越界 | 有改动文件不匹配任何声明的 glob | `<X> of <Y> file(s) outside declared ownership: <stray[:6]> …` | 实际改动必须落在声明范围内；越界说明所有权边界被突破 |

> notice 逐字要点（排查时按这个匹配，别被示例值误导）：
> - #7 里 `—` 是 em dash（U+2014），不是普通连字符 `-`。
> - #9 里 `` `Auto-merge-paths:` `` 带反引号，冒号在反引号内。
> - #2/#3/#5/#6/#8/#10 含运行时插值（`<headRefName>` 等），固定文字之外的尖括号部分会被替成实际值。

## 3. `Auto-merge-paths:` 声明怎么写

门禁 #9 和 #10 依赖 PR 正文里的一行所有权声明。写法：**在 PR body 里加一行**，
以 `Auto-merge-paths:`（大小写不敏感）开头，冒号后跟逗号分隔的 glob 列表：

```
Auto-merge-paths: docs/pipeline/auto-merge.md, docs/pipeline/auto-merge-faq.md
```

（这正是本文所在 PR 使用的声明行 —— 只覆盖这两个新增文件。）

解析规则：workflow 逐行扫描 PR body，取以 `auto-merge-paths:` 开头的行，按第一个 `:` 切分，
右侧逗号分割、逐项去空白，得到「声明拥有的路径 glob 列表」。列表为空 → 门禁 #9 拒绝。

### glob 语义（关键：`*` 不跨目录）

声明里的 glob 按下表转成正则，整串锚定匹配（`\A…\Z`）：

| glob 片段 | 匹配 | 说明 |
|---|---|---|
| `**/` | 任意层级目录（可为空） | 跨目录前缀 |
| `**` | 任意字符（含 `/`） | 递归通配，**必须显式写** |
| `*` | 非 `/` 的任意字符 | **不跨目录分隔符** |
| `?` | 单个非 `/` 字符 | |
| 其他 | 字面量 | 原样匹配 |

**为什么 `*` 故意不跨 `/`**：否则 `src/*` 会静默匹配 `src/a/b/c.ts`，一条看起来很窄的声明
实际覆盖整棵子树，所有权就不再是可信的并发边界。要递归匹配必须显式写 `**`
（例如 `docs/pipeline/**`）。

这解决的问题是：多个 PR 并发改同一区域时，`Auto-merge-paths:` 是每个 PR 对「我只动这些文件」的
可验证承诺。workflow 把 PR 的全部改动文件（`changed`）逐个与声明的 glob 比对，任何不匹配的文件
进入 `stray`；`stray` 非空即门禁 #10 拒绝。这样越界改动无法搭着一条宽泛声明的便车被自动合入。

## 4. 被拒绝 ≠ 构建失败

这是最容易误解的一点：**auto-merge 拒绝一个 PR 时，workflow 是以「成功」退出的。**

代码里的体现：

- `deny()` 末尾是 `sys.exit(0)`（注释 `# declining is not a build failure`），Python 段以退出码 0 结束。
- 真正的合并动作只在所有门禁通过后写出信号文件 `/tmp/go` 才发生；被拒时不写该文件，shell 步骤正常结束。

所以拒绝只表现为一条 `::notice::auto-merge declined for #<n>: …` 注解 —— 它不是一个失败的 check，
不会把 `build` 或任何检查标红。看到 declined notice，意思是「这个 PR 没达到自动合并条件，
请按 notice 处理后重跑或转人工」，**不是「你的构建挂了」**。

拿着某条 declined notice 查具体改法，见 [auto-merge-faq.md](./auto-merge-faq.md)。
