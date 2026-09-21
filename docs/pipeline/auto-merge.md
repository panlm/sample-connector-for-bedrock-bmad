# 流水线 PR 自动合并（auto-merge）

本仓库的 `.github/workflows/auto-merge.yml` 会在**全部门禁通过**时，自动合并流水线自己开的 PR。
这份文档说明它**凭什么合、逐条门禁为什么存在、`Auto-merge-paths:` 怎么写**，以及一个最容易被误解的点：**被拒不是构建失败**。

> 门禁的定义只能由 CI 持有，不能由被它管的 agent 改：agent 改不了 `.github/`（`PreToolUse` 护栏拦），运行时 host 的 `gh` token 也没有 `workflow` scope。所以这套合并策略是流水线**唯一改不动**的东西。本文只读 `auto-merge.yml` 后转述，不改它。

配套的排查表见 [常见拒绝原因 FAQ](./auto-merge-faq.md)。

---

## 1. 什么时候会评估（触发方式）

workflow 有两个入口（`auto-merge.yml` 第 12–27 行）：

- **`workflow_run`（第 25–27 行）** —— 挂在名为 `build` 的 workflow 上，`build` 每次**跑完**（`completed`）就触发一次。真正评估合并的入口是它，但作业条件（下节）要求 `build` 的结论是 `success` 且原始事件是 `pull_request`，所以**只有 build 成功的 PR 才会被评估**。
- **`pull_request_target: types: [labeled]`（第 23–24 行）** —— 给 PR 打标签也会触发。这是**必需的第二入口**，不是锦上添花：`auto-merge` 标签由评审阶段授予，而评审按构造在 build **之后**才完成。如果只有 `workflow_run` 一个入口，门禁总是在标签存在**之前**就评估、以「no auto-merge label」退出、且之后无人重评 —— 结果什么都合不了（第 13–17 行注释记录了这个死锁）。

> 为什么用 `pull_request_target` 而不是 `pull_request`：前者从 **base 分支**取 workflow 定义，因此能作用于已经开着的 PR。这里安全，是因为本作业**从不 checkout PR 代码**，只读 PR 元数据并调用 merge API（第 19–22 行注释）。

### 作业条件

作业 `merge` 只在下面之一成立时才运行（`jobs.merge.if`，第 37–41 行）：

- `github.event_name == 'pull_request_target' && github.event.label.name == 'auto-merge'`，或
- `github.event_name == 'workflow_run' && workflow_run.conclusion == 'success' && workflow_run.event == 'pull_request'`

即：**单靠打标签不会合并任何东西**，它只是「把问题再问一遍」；两个入口最终都要过下面全部门禁。

评估开始后，作业先解析出「当前在评估哪个 PR」（第 44–61 行）。`workflow_run` 入口按 head SHA 查开着的 PR，查不到就打印一行普通日志 `no open PR at $SHA — nothing to do` 并跳过（第 60 行，**这不是 deny、也不是失败**）。随后有一段**轮询**（第 81–89 行）：GitHub 异步计算 `mergeable`，PR 刚开时会短暂为 `UNKNOWN`，作业最多轮询 6 次、每次 `sleep 5s`，其间打 `::notice::`（见 FAQ 的等待说明）。轮询是为了避免「一个全绿的 PR 因为读到一次 `UNKNOWN` 就被永久搁置」。

---

## 2. 逐条门禁及为什么存在

真正的门禁都在脚本内（第 90–181 行），共 **11 条 deny 分支**。它们全部走同一个 `deny()` 函数（第 94–96 行）：打一条 `::notice::auto-merge declined for #{n}: {原因}` 后 **`sys.exit(0)`** —— 关于「成功退出」的含义见第 4 节。

按职责分四组：

### 分支归属（D1–D3）—— 只合流水线自开的分支

| # | 行号 | 检查什么 | 为什么存在 |
|---|---|---|---|
| D1 | 98 | `isCrossRepository` 为真则拒 | 只合仓库内分支，**绝不合 fork** |
| D2 | 99 | head 分支名不以 `agent/` 开头则拒 | 只合 agent 分支 |
| D3 | 100 | base 不是 `main` 则拒 | 只并入 `main` |

### 显式 opt-in 标签（D4）

| # | 行号 | 检查什么 | 为什么存在 |
|---|---|---|---|
| D4 | 103 | labels 里没有 `auto-merge` 则拒 | 合并是**显式选择**，标签由评审阶段授予；没有它绝不合 |

### 可合并性（D5–D6）—— 文本层面必须能干净合并

| # | 行号 | 检查什么 | 为什么存在 |
|---|---|---|---|
| D5 | 105 | `mergeable != "MERGEABLE"` 则拒 | 存在冲突等原因、GitHub 认为不可合并则拒 |
| D6 | 106–107 | `mergeStateStatus` ∈ {`DIRTY`, `BLOCKED`, `BEHIND`} 则拒 | 合并状态不健康（有冲突 / 被保护规则挡住 / 落后于 base）则拒 |

### check 必须全绿（D7–D9）

| # | 行号 | 检查什么 | 为什么存在 |
|---|---|---|---|
| D7 | 111–112 | `gh pr checks` 返回码非 0 或无输出则拒 | 读不到 check 状态就**拒绝盲合** |
| D8 | 119–120 | 排除自身后，head 上有任何 check 不在 {`SUCCESS`, `SKIPPED`, `NEUTRAL`} 则拒 | 所有 check 必须为绿。本作业自己的 check 已按 `SELF_CHECK` 排除（第 117–118 行），否则会死锁在自己的 `IN_PROGRESS` 上 |
| D9 | 121 | 排除自身后再无其它 check 则拒 | 没有任何其它 check = 未经验证，拒绝合并 |

### 路径归属（D10–D11）—— fail-closed 的所有权边界

| # | 行号 | 检查什么 | 为什么存在 |
|---|---|---|---|
| D10 | 156–159 | 解析不到可用的 `Auto-merge-paths:` 声明则拒 | PR **必须声明**它拥有哪些路径；声明缺失就 fail-closed |
| D11 | 176–178 | 有改动文件落在声明的 glob 之外则拒 | 声明必须**覆盖每个改动文件**，这是并发改同一文件时的所有权边界 |

> **门禁计数：11 条 deny 分支（D1–D11）。** 其中 D10 依「是否找到标记」有两种文案，所以 declined 类 notice 原文共 **12 条**。逐字原文见 [FAQ](./auto-merge-faq.md)。

全部 11 条通过后，作业打一条成功 notice 并写入 `/tmp/go`（第 179–180 行），最外层 shell 见到 `/tmp/go` 才执行 `--squash --delete-branch` 的合并（第 182–185 行）。

---

## 3. `Auto-merge-paths:` 怎么写，解决什么

### 它解决什么

多个 PR 可能**并发改同一个文件**。`Auto-merge-paths:` 是每个 PR 的**所有权声明**：PR 在正文里声明「我只碰这些路径」，门禁 D11 再校验实际改动文件是否都落在声明的 glob 内。任何越界文件都会让整个 PR 被拒 —— 这样自动合并就不会在作者没预期的文件上落笔。

### 怎么写

在 **PR 正文**里写一行（行首）：

```
Auto-merge-paths: docs/pipeline/auto-merge.md, docs/pipeline/auto-merge-faq.md
```

- 冒号后是**逗号分隔**的一组路径 / glob。
- 解析是**故意宽松**的（第 122–159 行）：容忍反引号包裹、`#`/`>`/`*`/`-` 等行首装饰、甚至 `### Auto-merge-paths` 标题形式后跟一行路径列表（run-4 曾有 PR 因这类装饰卡住，故放宽）。放宽**解析**不会误批任何东西 —— 解析出的路径仍要在 D11 覆盖每个改动文件，否则照拒。

### glob 语义（第 160–172 行）

| 写法 | 匹配 | 说明 |
|---|---|---|
| `*` | 不跨目录分隔符 | `src/*` 匹配 `src/a.ts`，**不**匹配 `src/a/b.ts` |
| `?` | 单个非 `/` 字符 | |
| `**/` | 递归目录前缀 | `docs/**/x.md` 跨任意层级 |
| `**` | 递归任意字符 | `docs/**` 是显式的递归 opt-in |

> `*` 不跨 `/` 是刻意的：否则一条看起来很窄的声明（`src/*`）会悄悄匹配 `src/a/b/c.ts`，所有权门禁就不再是并发边界了。要递归请显式写 `**`。

---

## 4. 被拒 ≠ 构建失败

这是最容易误解的一点，单独讲清：

**每一条 deny 都走 `deny()`（第 94–96 行）：打一条 `::notice::` 后 `sys.exit(0)`，也就是 workflow「成功退出」。** 代码里那行注释写得很直白：`# declining is not a build failure`。

所以：

- 你在 Actions 里看到 auto-merge 作业是**绿的（成功）**，但 PR **没有被合并** —— 这是**正常**状态，不是故障，不是「构建失败」，不是红叉。
- 真正的原因在作业日志的 `::notice::auto-merge declined for #<PR号>: ...` 那一行里。拿着这条 notice 去 [FAQ](./auto-merge-faq.md) 查表即可。

**请不要**把「被拒」描述成「构建失败 / 作业失败 / 报错」—— 它是 workflow 主动、成功地做出的一个「暂不合并」的决定。
