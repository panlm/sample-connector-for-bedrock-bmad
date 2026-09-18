# Auto-merge for pipeline-authored PRs

This page explains how the `auto-merge` workflow decides whether to merge a
pull request without a human in the loop. It is for anyone opening PRs from
the pipeline (agents and the humans who supervise them) who needs to know
*what will be checked*, *what to declare*, and *how to read the outcome*.

One-line summary: **when the `build` workflow succeeds on a pull request, the
`auto-merge` workflow re-checks the PR against a fixed list of gates; if every
gate passes it squash-merges the PR, and if any gate fails it declines with a
`::notice::` and exits successfully — declining is not a build failure.**

The source of truth is `.github/workflows/auto-merge.yml`. This document
describes that file; it does not change it. (Agents cannot edit `.github/` —
the merge policy is deliberately the one thing the pipeline cannot rewrite.)

## When it runs

The workflow is triggered by the completion of another workflow, not directly
by a push or a PR event:

```yaml
on:
  workflow_run:
    workflows: [build]
    types: [completed]
```

The `merge` job then only evaluates the gates when **two** conditions hold:

```yaml
if: github.event.workflow_run.conclusion == 'success'
    && github.event.workflow_run.event == 'pull_request'
```

- `conclusion == 'success'` — the `build` run must have **succeeded**. A red
  build never reaches the gates at all.
- `event == 'pull_request'` — that build must have been triggered by a pull
  request (not by a push to a branch, a tag, a schedule, etc.).

Once it starts, the job first finds the open PR whose head commit matches the
build's `head_sha`:

```bash
n=$(gh pr list --repo "$GITHUB_REPOSITORY" --state open --json number,headRefOid \
      --jq "[.[]|select(.headRefOid==\"$SHA\")][0].number // empty")
```

If no open PR is found at that SHA, the job prints `no open PR at <sha> —
nothing to do` and exits without doing anything.

## The gates

Every gate below must pass. Each failed gate calls a small helper that prints a
GitHub Actions notice and exits with code **0**:

```python
def deny(msg):
    print(f"::notice::auto-merge declined for #{n}: {msg}")
    sys.exit(0)          # declining is not a build failure
```

So every decline shows up in the Actions log as:

```
::notice::auto-merge declined for #<n>: <reason>
```

There are **10** gates. This count matches the number of `deny(...)` calls in
`auto-merge.yml` exactly — see the [count table](#gate-count) below. They are
evaluated top to bottom; the first one that fails stops evaluation.

| # | Gate | Declines when | Why it exists |
|---|------|---------------|---------------|
| 1 | Not a fork | The PR is cross-repository (`isCrossRepository`) — it comes from a fork | Only merge branches the pipeline authored inside this repo, **never** a fork. A fork PR could contain anything. |
| 2 | Head is `agent/*` | The head branch name does not start with `agent/` | Only pipeline-authored branches are eligible; the pipeline always names its branches `agent/...`. |
| 3 | Base is `main` | The PR targets a base branch other than `main` | Auto-merge only ever writes to `main`. |
| 4 | `auto-merge` label | The PR does not carry the `auto-merge` label | Explicit opt-in. A PR is only eligible if someone deliberately labelled it. |
| 5 | Mergeable | GitHub reports `mergeable` is anything other than `MERGEABLE` (e.g. `CONFLICTING`) | The PR must be textually clean — no merge conflicts. |
| 6 | Merge state | `mergeStateStatus` is `DIRTY`, `BLOCKED`, or `BEHIND` | Refuse when there is a conflict (`DIRTY`), a branch-protection block (`BLOCKED`), or the branch is behind its base (`BEHIND`). |
| 7 | Checks readable | `gh pr checks` fails or returns no output | **Fail-closed:** if the check status cannot be read, refuse rather than merge blind. |
| 8 | Checks green | Any check run on the head is in a state other than `SUCCESS`, `SKIPPED`, or `NEUTRAL` | Every check run on the head (build, ci, and anything else) must be green before merging. |
| 9 | Ownership declared | The PR body has no `Auto-merge-paths:` line | **Fail-closed path ownership:** a PR that does not declare the paths it owns is never auto-merged. |
| 10 | Files within ownership | Some changed file falls outside every declared glob | Makes the declaration a real concurrency boundary — a PR may only touch files it declared. |

For the exact notice text each gate prints (useful when reading a log), see the
companion [auto-merge FAQ](auto-merge-faq.md).

### Gate count {#gate-count}

The acceptance anchor for this document: the number of gates listed here must
equal the number of executable `deny(...)` calls in `auto-merge.yml`.

| Source | Count |
|--------|-------|
| Gates listed in this document | **10** |
| Executable `deny(...)` calls in `auto-merge.yml` (lines 70, 71, 72, 75, 77, 79, 84, 86, 92, 110) | **10** |

(The `def deny(msg):` definition on line 66 is the helper, not a gate, and is
not counted.)

## Declaring `Auto-merge-paths:`

Gate 9 requires your PR body to contain a line declaring which paths the PR is
allowed to change. Gate 10 then enforces it. Write a single line anywhere in
the PR body:

```
Auto-merge-paths: docs/pipeline/auto-merge.md, docs/pipeline/auto-merge-faq.md
```

How it is parsed:

- The workflow scans the PR body line by line for one that (case-insensitively)
  starts with `auto-merge-paths:`.
- Everything after the first colon is split on commas; each piece is trimmed.
  The result is the list of globs the PR owns.
- If that list is empty, gate 9 declines.

Then every changed file must match **at least one** declared glob, or gate 10
declines with the offending files.

### Glob syntax — `*` does not cross `/`

The globs are deliberately **path-aware**:

| Pattern | Matches | Notes |
|---------|---------|-------|
| `*` | any run of characters **within one path segment** | does **not** cross a `/` |
| `?` | exactly one character within a segment | |
| `**` | any characters, including `/` | the explicit opt-in for recursion |
| `**/` | zero or more leading directory segments | e.g. `docs/**/*.md` |

This is the important subtlety: `src/*` matches `src/a.ts` but **not**
`src/a/b/c.ts`. If `*` crossed directory separators, a declaration that reads as
narrow (`src/*`) would silently match everything under `src/`, and the ownership
gate would stop being a concurrency boundary. To own a subtree, write `**`
explicitly — e.g. `docs/pipeline/**`.

**What this solves:** when several PRs run concurrently, the ownership
declaration is the boundary that keeps two PRs from silently editing the same
file. Declare exactly what you touch, no wider.

## The `mergeable=UNKNOWN` wait

GitHub computes a PR's `mergeable` field asynchronously. Right after a PR opens
(or after `main` moves), it is `UNKNOWN` for a few seconds. Gate 5 would decline
on `UNKNOWN`, and because auto-merge only fires on `workflow_run` — an event that
has *already happened* — nothing would ever retry, stranding a perfectly good
PR forever.

To avoid that, the workflow polls up to 6 times (sleeping 5 seconds between
attempts) for GitHub to commit to an answer, printing a notice each time it
waits. If it never resolves, it still fails closed at gate 5. This is a **wait**,
not a decline.

## Declining is not a build failure

This is the single most important thing to understand when reading a result.

When any gate fails, `deny()` prints a `::notice::` and calls `sys.exit(0)`. The
Python block runs under `python3 - <<'PY'`, so exiting 0 makes the step
**succeed**. The actual merge only happens when *all* gates pass: the script
writes a `/tmp/go` signal as its last line, and only then does the shell run
`gh pr merge`:

```bash
if [ -f /tmp/go ]; then
  gh pr merge "$N" --repo "$GITHUB_REPOSITORY" --squash --delete-branch
fi
```

So a declined PR produces a **successful workflow run plus one `::notice::`** —
not a failing check. It is *not* the same thing as a red `build` or `ci`. If your
PR was not merged but its checks are green, the reason is a decline notice in the
`auto-merge` run's log, not a failure. See the
[FAQ](auto-merge-faq.md#my-pr-was-not-merged-but-ci-is-green) for how to find it.

## Opening a PR that can auto-merge

Two things are required on every PR you want auto-merged:

1. **Declare ownership** — put an `Auto-merge-paths:` line in the PR body listing
   exactly the files/globs the PR changes (gates 9 and 10). For example, this
   documentation PR declares:

   ```
   Auto-merge-paths: docs/pipeline/auto-merge.md, docs/pipeline/auto-merge-faq.md
   ```

2. **Add the label** — apply the `auto-merge` label (gate 4):

   ```bash
   gh pr edit <n> --add-label auto-merge
   ```

The remaining gates (fork, `agent/*` head, `main` base, mergeable, checks green)
are satisfied by the normal pipeline flow: a pipeline branch that is up to date
with `main` and whose `build`/`ci` checks are green.

## See also

- [Auto-merge FAQ — decline reasons](auto-merge-faq.md) — look up any decline
  `::notice::` and how to fix it.
