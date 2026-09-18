# Auto-merge for pipeline-authored PRs

This page explains the `auto-merge` workflow (`.github/workflows/auto-merge.yml`): when it
runs, every gate a PR must clear, and how the ownership declaration works. It is written for
contributors (human or agent) whose PRs are meant to merge automatically.

## What it is and when it runs

Auto-merge is a GitHub Actions workflow that squash-merges a PR **only after every gate below
passes**. It does not run on `pull_request` directly. It is triggered by the completion of the
`build` workflow:

```yaml
on:
  workflow_run:
    workflows: [build]
    types: [completed]
```

The merge job then guards on two conditions before it evaluates anything:

```yaml
if: github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'pull_request'
```

So auto-merge only evaluates a PR when **the `build` workflow finished with `conclusion == success`
*and* the run it reacted to originated from a `pull_request` event**. If `build` failed, or the
run came from any other event, the merge job is skipped entirely.

Because the workflow reacts to `workflow_run` (not to pushes or comments), it fires **once per
build completion**. There is no periodic retry loop watching your PR — re-triggering evaluation
means causing `build` to run again (e.g. by pushing a new commit).

## Why the merge policy lives in CI, not in the agent

From the workflow header:

> Agents cannot edit `.github/` (blocked by the PreToolUse guardrail) and the runtime host's
> `gh` token has no `workflow` scope. So the merge policy is the one thing the pipeline provably
> cannot rewrite.

The design is **fail-closed**: every gate must pass, and a PR that does not declare the paths it
owns is never auto-merged.

## Evaluation flow

1. **Resolve the PR** — the workflow looks up the open PR whose head commit equals the completed
   run's `head_sha`. If no open PR matches that SHA, it prints `no open PR at $SHA — nothing to do`
   (a plain log line, not a decline) and exits without merging.
2. **Wait for `mergeable`** — GitHub computes `mergeable` asynchronously, so a freshly opened PR
   reads `UNKNOWN` for a few seconds. The workflow polls up to **6 times, sleeping 5s between
   attempts**, printing a `mergeable=UNKNOWN … waiting` notice each time. This avoids permanently
   stranding a good PR just because GitHub had not finished computing its state.
3. **Run the gates** — the ten gates below, in order. The first one that fails declines and stops.
4. **Merge** — if all gates pass, the PR is squash-merged and its branch deleted.

## The gates (10 in total)

Auto-merge has **10 decline branches**. Each one, if hit, prints a `::notice::` and exits the
workflow with success (see "A decline is not a build failure" below), so only the *first* failing
gate's message appears.

| # | Gate (what must be true to pass) | Why it exists |
|---|---|---|
| 1 | The PR is **not** cross-repository (not from a fork) | Only branches opened by this repository's own pipeline are trusted; fork PRs are never auto-merged. |
| 2 | The head branch name starts with `agent/` | Only pipeline-agent branches follow the `agent/*` naming convention. |
| 3 | The base branch is `main` | Auto-merge only integrates into `main`. |
| 4 | The PR carries the `auto-merge` label | Explicit opt-in: a PR is only evaluated once the label is added by hand. |
| 5 | GitHub reports `mergeable == MERGEABLE` | A PR with conflicts (or one GitHub still cannot judge after polling) is not merged. |
| 6 | `mergeStateStatus` is **not** `DIRTY`, `BLOCKED`, or `BEHIND` | A dirty branch, a branch blocked by protection rules, or one behind `main` is not merged. |
| 7 | The check status is readable (`gh pr checks` returns cleanly with output) | If the workflow cannot read check status, it refuses to merge blind (fail-closed). |
| 8 | Every check run on the head is green — `state` in `SUCCESS`, `SKIPPED`, or `NEUTRAL` | Every check (build + ci + anything else) on the head must be green. |
| 9 | The PR body declares an `Auto-merge-paths:` line | Fail-closed ownership: a PR that does not declare what it owns is never auto-merged. |
| 10 | Every changed file matches at least one declared path glob | Touching files outside the declared ownership is not merged — ownership is the concurrency boundary. |

The count matters: **the documentation lists 10 gates and the workflow has 10 decline branches** —
they are the same list, verified against the current `auto-merge.yml` on `main`.

## The `Auto-merge-paths:` ownership declaration

Gates 9 and 10 enforce a path-ownership contract you declare in the **PR body**.

**How to write it.** Put one line in the PR body that begins with `auto-merge-paths:`
(case-insensitive — the workflow lowercases and strips the line before matching). After the colon,
list comma-separated globs:

```
Auto-merge-paths: docs/pipeline/auto-merge.md, docs/pipeline/auto-merge-faq.md
```

An empty declaration (the line is present but lists no paths) is treated as no declaration and
declines at gate 9.

**Glob semantics.** Each glob is anchored and matched against the whole path. Crucially, `*` does
**not** cross a directory separator:

| Token | Matches |
|---|---|
| `*` | any run of characters except `/` |
| `?` | a single character except `/` |
| `**/` | any number of leading directories (including none) |
| `**` | anything, including `/` — the explicit opt-in for recursion |

**Why the boundary is strict.** From the workflow comments: if `*` crossed directory separators, a
declaration that reads as narrow (`src/*`) would silently match `src/a/b/c.ts`, and the ownership
gate would stop being a concurrency boundary at all. `**` is the explicit opt-in for recursion.

**What it solves.** When multiple pipeline PRs are in flight at once, the ownership declaration is
the boundary that keeps them from silently overwriting each other's files. Every changed file must
fall inside a declared glob; any stray file declines at gate 10.

## A decline is not a build failure

This is the single most important thing to understand when a PR does not merge.

When a gate fails, the workflow prints a `::notice::` and calls `sys.exit(0)` — a **success** exit
code. The code comment says it plainly: `# declining is not a build failure`. A decline therefore:

- does **not** show up as a failed check on your PR,
- does **not** turn the Actions run red,
- leaves the PR open, unmerged, with a `::notice::` line in the run log.

To find out *why* a PR was not merged, open the completed auto-merge run in the Actions tab and
read the notice, which always has the form:

```
::notice::auto-merge declined for #{n}: {msg}
```

The `{msg}` part is your lookup key. See **[auto-merge-faq.md](auto-merge-faq.md)** for a table
that maps each message to its meaning and fix.

## What happens when all gates pass

When every gate passes, the workflow prints a passing notice and merges:

```
::notice::auto-merge gates passed for #{n}; {k} file(s) within {owns}
```

then runs `gh pr merge <n> --squash --delete-branch` — a **squash merge** that also deletes the
head branch.

## Contributor checklist

To make a PR eligible for auto-merge, ensure all of the following (each maps to a gate above):

- [ ] The branch is pushed to this repository (not a fork) — *gate 1*
- [ ] The branch name starts with `agent/` — *gate 2*
- [ ] The PR base is `main` — *gate 3*
- [ ] The `auto-merge` label is added (`gh pr edit <n> --add-label auto-merge`) — *gate 4*
- [ ] The PR has no conflicts and is up to date with `main` — *gates 5, 6*
- [ ] All checks are green — *gates 7, 8*
- [ ] The PR body has an `Auto-merge-paths:` line covering every changed file, and nothing else — *gates 9, 10*
