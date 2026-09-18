# Auto-merge FAQ — decline reasons

Your PR was not merged and you want to know why. This page maps every decline
message from the `auto-merge` workflow to what it means and how to fix it. For
how the workflow works overall, see [Auto-merge](auto-merge.md).

## How to use this table

Every decline is logged in the `auto-merge` workflow run, in this exact shape:

```
::notice::auto-merge declined for #<n>: <reason>
```

Take the text **after the colon** — the `<reason>` — and look it up below. The
reason fragments are quoted verbatim from `.github/workflows/auto-merge.yml`.
Where a reason embeds a runtime value, it is shown with a `<placeholder>`; the
literal words around the placeholder are what appear in the log.

## Decline reasons

There are 10 gates, so there are 10 decline reasons. Each row is one gate.

| # | Notice reason (verbatim) | What it means | How to fix |
|---|--------------------------|---------------|------------|
| 1 | `cross-repository PR` | The PR comes from a fork (cross-repository). Fork PRs are never auto-merged. | Open the PR from a branch **inside this repository**, not from a fork. |
| 2 | `head <headRefName> is not agent/*` | The head branch name does not start with `agent/`. | Push your changes to a branch named `agent/...` and open the PR from it. Only pipeline-authored `agent/*` branches are eligible. |
| 3 | `base is <baseRefName>, not main` | The PR targets a base branch other than `main`. | Retarget the PR to `main` (`gh pr edit <n> --base main`). |
| 4 | `no auto-merge label` | The PR is not labelled `auto-merge`. | Add the label: `gh pr edit <n> --add-label auto-merge`. |
| 5 | `mergeable=<value>` | GitHub reports the PR is not cleanly mergeable — usually `mergeable=CONFLICTING` (a merge conflict). `mergeable=UNKNOWN` only reaches here after the 6-attempt poll never resolved. | Rebase/merge `main` into your branch and resolve conflicts, then push. If it says `UNKNOWN`, wait for GitHub to finish computing and re-run `build`. |
| 6 | `mergeStateStatus=<value>` | The merge state is `DIRTY` (conflict), `BLOCKED` (branch protection, e.g. a required review or check not satisfied), or `BEHIND` (branch is behind `main`). | For `BEHIND`, update the branch from `main`. For `DIRTY`, resolve conflicts. For `BLOCKED`, satisfy the branch-protection requirement (e.g. get the required approval). |
| 7 | `cannot read check status (rc=<code>) — refusing to merge blind` | The workflow could not read the PR's check status (`gh pr checks` failed or returned nothing). It fails closed rather than merge without knowing. | Usually transient. Re-run the `build` workflow so `auto-merge` re-evaluates; if it persists, check the `gh` call / token in the run logs. |
| 8 | `checks not green: <name>=<STATE>, ...` | At least one check run on the head is in a state other than `SUCCESS`, `SKIPPED`, or `NEUTRAL` (e.g. `FAILURE`, `PENDING`). The failing checks are listed by name and state. | Fix the named failing check and push. Every check on the head must be green. |
| 9 | ``PR body has no `Auto-merge-paths:` declaration`` | The PR body has no `Auto-merge-paths:` line, so ownership is undeclared. | Add a line to the PR body listing the paths you own, e.g. `Auto-merge-paths: docs/pipeline/auto-merge.md, docs/pipeline/auto-merge-faq.md`. See [declaring ownership](auto-merge.md#declaring-auto-merge-paths). |
| 10 | `<k> of <m> file(s) outside declared ownership: <list>` | `<k>` of the `<m>` changed files fall outside every glob you declared; up to 6 offending paths are listed (with `...` appended if there are more). | Either narrow the PR to only the files you declared, or widen the `Auto-merge-paths:` declaration to cover them. Remember `*` does not cross `/` — use `**` for a subtree. |

## Two notices that are **not** declines

These look similar but do not mean your PR was rejected — do not act on them as
if they were:

| Notice (verbatim) | What it means |
|-------------------|---------------|
| `mergeable=UNKNOWN for #<n>, attempt <a>/6 — waiting for GitHub to compute it` | The workflow is **waiting** while GitHub computes `mergeable`. Nothing is wrong; it polls up to 6 times. Only a final `mergeable=UNKNOWN` decline (reason #5) is a rejection. |
| `auto-merge gates passed for #<n>; <m> file(s) within <owns>` | **All gates passed.** The PR is about to be squash-merged. This is success, not a decline. |

## My PR was not merged but CI is green {#my-pr-was-not-merged-but-ci-is-green}

This is expected behaviour, not a bug. **A decline is not a build failure.** When
a gate fails, the workflow prints a `::notice::` and exits with code `0`, so the
`auto-merge` run shows as **successful** — there is no red check to point at. The
merge simply did not happen.

To find out why:

1. Open the **Actions** tab and find the most recent `auto-merge` workflow run
   for your PR's head commit.
2. Look in the log for the line `::notice::auto-merge declined for #<n>: <reason>`.
3. Look up `<reason>` in the [table above](#decline-reasons) and apply the fix.
4. Push a new commit (or re-run `build`) so `auto-merge` evaluates again.

See [Declining is not a build failure](auto-merge.md#declining-is-not-a-build-failure)
for the mechanism.

## See also

- [Auto-merge](auto-merge.md) — how the workflow is triggered and what each gate
  checks.
