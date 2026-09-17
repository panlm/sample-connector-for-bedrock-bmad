# auto-merge：流水线 PR 的自动合并机制

本文说明 `.github/workflows/auto-merge.yml` 如何自动合并流水线开出的 PR：它凭什么合、逐条门禁是什么、`Auto-merge-paths:` 声明怎么写，以及一个关键概念——**被拒绝不等于构建失败**。

面向对象：给这个仓库开 PR 的贡献者，以及后续维护流水线的人。所有内容以 `.github/workflows/auto-merge.yml` 的实际代码为准。

---

## 1. 为什么这套逻辑在 CI 里，而不在 agent 里

workflow 文件头的注释写明了设计意图（照抄自 `auto-merge.yml` 头部）：

> agents cannot edit `.github/` (blocked by the PreToolUse guardrail) and the runtime host's gh token has no `workflow` scope. So the merge policy is the one thing the pipeline provably cannot rewrite.

也就是说：合并策略被放在 CI 里，是因为这是流水线**证明自己改不动**的唯一一处。agent 改不了 `.github/`（被 PreToolUse 护栏拦），runtime 的 gh token 也没有 `workflow` scope。

> Fail-closed: every gate below must pass. A PR that does not declare the paths it owns is never auto-merged.

整套逻辑是 **fail-closed（默认拒绝）**：下面每一条门禁都必须通过；不声明自己拥有哪些路径的 PR 永远不会被自动合并。

> ⚠️ 你能**读** `.github/` 但不能**写**——写被护栏拒是预期行为，不是故障。

## 2. 触发方式：挂在 build 的 `workflow_run` 上

auto-merge 不由 push 或 PR 事件直接触发，而是挂在 `build` workflow 完成之后：

```yaml
on:
  workflow_run:
    workflows: [build]
    types: [completed]
```

且 job 有一道准入条件：

```yaml
if: github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'pull_request'
```

含义：**只有当那次 `build` 是由 pull_request 触发、并且成功结束时**，auto-merge 才会进入评估。build 没跑、build 失败、或 build 不是 pull_request 触发的，auto-merge 根本不会评估这个 PR。

## 3. 它怎么找到要合的 PR

`Resolve PR from the completed run` 步骤用刚结束那次 build 的 `head_sha` 去匹配 open PR：

```bash
n=$(gh pr list --repo "$GITHUB_REPOSITORY" --state open --json number,headRefOid \
      --jq "[.[]|select(.headRefOid==\"$SHA\")][0].number // empty")
if [ -z "$n" ]; then echo "no open PR at $SHA — nothing to do"; echo "skip=1" >>"$GITHUB_OUTPUT"; exit 0; fi
```

匹配不到对应 SHA 的 open PR 时，打印 `no open PR at $SHA — nothing to do`、设 `skip=1` 后空退。**这是"无事可做"的跳过，不是一次拒绝**（它不走下面的 `deny()`，也不计入门禁条数）。

## 4. 逐条门禁（共 10 条 deny 分支）

门禁在 `Gate and merge` 步骤内的一段 python 里判定。每一条不满足的门禁都调用同一个 `deny()`：

```python
def deny(msg):
    print(f"::notice::auto-merge declined for #{n}: {msg}")
    sys.exit(0)          # declining is not a build failure
```

所以每条拒绝的完整输出形态是 `::notice::auto-merge declined for #<PR号>: <msg>`。下面按代码里的 `# 1)`～`# 5)` 五组注释组织，共 **10 条 deny 分支**。每条给出：判定依据、触发拒绝的条件、拒绝时打出的 notice 原文（`<msg>` 段，照抄代码字符串，`{...}` 是会被实参替换的占位）。

判定所依据的字段来自：
```
gh pr view --json number,headRefName,baseRefName,labels,mergeable,mergeStateStatus,body,files,isCrossRepository
```

### `# 1)` 分支来源：只合流水线自己开的分支，绝不合 fork

| # | 触发拒绝的条件 | notice 原文（`<msg>`） |
|---|---|---|
| 1 | PR 来自 fork 仓库（`pr["isCrossRepository"]` 为真） | `cross-repository PR` |
| 2 | head 分支名不以 `agent/` 开头（`not pr["headRefName"].startswith("agent/")`） | `head {pr["headRefName"]} is not agent/*` |
| 3 | base 分支不是 `main`（`pr["baseRefName"] != "main"`） | `base is {pr["baseRefName"]}, not main` |

存在理由：fork 分支不给自动合并写权限；只有流水线约定的 `agent/*` 分支才自动合；只往 `main` 合。

### `# 2)` 显式 opt-in label

| # | 触发拒绝的条件 | notice 原文（`<msg>`） |
|---|---|---|
| 4 | PR 没有 `auto-merge` label（`"auto-merge" not in labels`） | `no auto-merge label` |

存在理由：必须显式打 `auto-merge` label 才会评估——显式 opt-in，没标就不动。

### `# 3)` 文本层面可合

| # | 触发拒绝的条件 | notice 原文（`<msg>`） |
|---|---|---|
| 5 | GitHub 判定 `pr["mergeable"] != "MERGEABLE"`（如 `CONFLICTING` 有冲突、`UNKNOWN` 还在计算） | `mergeable={pr["mergeable"]}` |
| 6 | `pr["mergeStateStatus"]` 属于 `DIRTY` / `BLOCKED` / `BEHIND` 之一 | `mergeStateStatus={pr["mergeStateStatus"]}` |

存在理由：不合有文本冲突的 PR；不合脏的（`DIRTY`）、被分支保护挡住的（`BLOCKED`）、落后 base 的（`BEHIND`）PR。

### `# 4)` head 上每个 check run 必须绿

| # | 触发拒绝的条件 | notice 原文（`<msg>`） |
|---|---|---|
| 7 | `gh pr checks` 拉不到状态（返回码非 0，或 stdout 为空） | `cannot read check status (rc={out.returncode}) — refusing to merge blind` |
| 8 | head 上任一 check run 的 state 不在 `SUCCESS` / `SKIPPED` / `NEUTRAL` 里 | `checks not green: ` 后接 `{name}={state}` 列表（多个用 `, ` 连接） |

存在理由：读不到 check 状态就不盲合（fail-closed）；任一 check 不绿就拒，并把不绿的 `名字=状态` 逐个列出。这里覆盖 build 及其它所有 check run。

### `# 5)` fail-closed 路径所有权

| # | 触发拒绝的条件 | notice 原文（`<msg>`） |
|---|---|---|
| 9 | PR 正文没有 `Auto-merge-paths:` 声明行（解析后 `owns` 为空） | `` PR body has no `Auto-merge-paths:` declaration `` |
| 10 | 有改动文件落在声明的 glob 之外（`stray` 非空） | `{len(stray)} of {len(changed)} file(s) outside declared ownership: {stray[:6]}`（越界文件超过 6 个时结尾追加 ` ...`） |

存在理由：见下一节。这是并发改同一批文件时的所有权边界。

## 5. `Auto-merge-paths:` 声明：怎么写、解决什么问题

### 怎么写

在 PR 正文里写一行，冒号后是逗号分隔的 glob 列表：

```
Auto-merge-paths: docs/pipeline/auto-merge.md, docs/pipeline/auto-merge-faq.md
```

解析依据（代码）：

```python
for line in (pr.get("body") or "").splitlines():
    if line.strip().lower().startswith("auto-merge-paths:"):
        owns = [p.strip() for p in line.split(":",1)[1].split(",") if p.strip()]
```

- 前缀 `auto-merge-paths:` **大小写不敏感**（`line.strip().lower().startswith(...)`）。
- 冒号后按逗号分隔，逐项去空白（`line.split(":",1)[1].split(",")`）。

### 解决什么问题

这是 **fail-closed 的所有权边界**：一个 PR 必须声明它拥有哪些文件路径；任何改动文件越界即拒（门禁 9、10）。当多个流水线 PR 可能并发改同一批文件时，这条声明就是每个 PR 的所有权边界——你只对你声明的路径负责，改到别人的路径就拒绝合并。

### glob 语义（关键、容易踩坑）

匹配用 `_glob_re()` 把 glob 编译成正则，**整段用 `\A...\Z` 全匹配**（锚定首尾）。规则（照代码）：

| glob 片段 | 转成的正则 | 效果 |
|---|---|---|
| `**/` | `(?:.*/)?` | 递归目录（可零层） |
| `**` | `.*` | 任意（含跨目录） |
| `*` | `[^/]*` | **不跨目录分隔符 `/`** |
| `?` | `[^/]` | 单个非 `/` 字符 |

代码注释（照抄）已经点明这个坑：

> `*` must NOT cross a directory separator, otherwise a declaration that reads as narrow (`src/*`) silently matches `src/a/b/c.ts` and the ownership gate stops being a concurrency boundary at all. `**` is the explicit opt-in for recursion.

推论示例（依据上表 glob 规则推导，非实跑输出）：

- 声明 `docs/pipeline/*.md` → 匹配 `docs/pipeline/auto-merge.md`，但**不**匹配 `docs/pipeline/sub/x.md`（`*` 不跨 `/`）。
- 想递归匹配子目录必须**显式**写 `**`，如 `docs/pipeline/**`。

## 6. 被拒 ≠ 构建失败

这是最需要记住的一点。`deny()` 里：

```python
print(f"::notice::auto-merge declined for #{n}: {msg}")
sys.exit(0)          # declining is not a build failure
```

- 拒绝走的是 `::notice::`，**不是** `::error::`。
- 拒绝时 `sys.exit(0)`——**workflow 以成功退出**。

所以：当你看到 `auto-merge declined for #N: ...`，含义是"这个 PR 这次**没有被自动合并**"，**不是**"CI 挂了"。auto-merge 这个 workflow 本身仍然是绿的。要弄清为什么没合，拿 notice 原文去查 [auto-merge-faq.md](auto-merge-faq.md)。

## 7. 门禁全过之后做什么

所有门禁通过后，打一条成功 notice（非拒绝）并写信号文件：

```python
print(f"::notice::auto-merge gates passed for #{n}; {len(changed)} file(s) within {owns}")
open("/tmp/go","w").write("go")
```

shell 侧据此执行合并：

```bash
if [ -f /tmp/go ]; then
  gh pr merge "$N" --repo "$GITHUB_REPOSITORY" --squash --delete-branch
  echo "merged #$N"
fi
```

即：**squash 合并 + 删除源分支**（`--squash --delete-branch`）。

## 附：deny 分支条数

本仓库 `auto-merge.yml` 当前共 **10 条 deny 分支**（第 4 节表格逐条列出）。`Resolve PR` 步骤里 `no open PR ... nothing to do` 是跳过、不是拒绝，不计入这 10 条。
