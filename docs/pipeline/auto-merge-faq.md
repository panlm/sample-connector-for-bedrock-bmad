# Auto-merge FAQ: why was my PR declined?

Use this page when a PR did not auto-merge. See **[auto-merge.md](auto-merge.md)** for how the
workflow works.

## First: a decline is not a build failure

When auto-merge declines a PR it prints a `::notice::` and exits **successfully** (`sys.exit(0)`,
commented `# declining is not a build failure` in `.github/workflows/auto-merge.yml`). Your PR
stays open and unmerged; the Actions run does **not** go red. To find the reason, open the
completed auto-merge run in the **Actions** tab and read its notice. Every decline has the form:

```
::notice::auto-merge declined for #{n}: {msg}
```

The `{msg}` part is the lookup key. Match it against the table below.

## Decline reasons

Each row's key is copied verbatim from the workflow. Where a message contains a value the workflow
fills in at runtime (a branch name, a status, a file list), that variable part is shown in
`{braces}`.

| Notice message (`{msg}`, verbatim) | What it means | How to fix |
|---|---|---|
| `cross-repository PR` | The PR comes from a fork. | Re-open the PR from a branch in this repository, not a fork. |
| `head {headRefName} is not agent/*` | The head branch name does not start with `agent/` (e.g. `head feature/foo is not agent/*`). | Use a branch named `agent/<name>/<id>`. |
| `base is {baseRefName}, not main` | The PR targets a branch other than `main` (e.g. `base is dev, not main`). | Change the PR base to `main`. |
| `no auto-merge label` | The `auto-merge` label is not on the PR. | Add it: `gh pr edit <n> --add-label auto-merge`. |
| `mergeable={value}` | GitHub does not consider the PR mergeable (e.g. `mergeable=CONFLICTING`; also `mergeable=UNKNOWN` if it never resolved). | Rebase / resolve conflicts. For `UNKNOWN`, let GitHub finish computing; pushing a commit re-runs `build`, which re-triggers evaluation. |
| `mergeStateStatus={value}` | The merge state is `DIRTY`, `BLOCKED`, or `BEHIND` (e.g. `mergeStateStatus=BEHIND`). | `BEHIND` → update the branch from `main`; `BLOCKED` → check branch protection / required checks; `DIRTY` → resolve conflicts. |
| `cannot read check status (rc={rc}) — refusing to merge blind` | The workflow could not read check status (e.g. `cannot read check status (rc=1) — refusing to merge blind`). | Re-trigger `build` later; investigate `gh` / permissions. This is fail-closed behavior, not a bug. |
| `checks not green: {name}={state}, ...` | At least one check run is not green (e.g. `checks not green: ci=FAILURE`). | Fix the named check until its state is `SUCCESS`, `SKIPPED`, or `NEUTRAL`. |
| ``PR body has no `Auto-merge-paths:` declaration`` | The PR body has no line starting with `auto-merge-paths:` (or it lists no paths). | Add a line to the PR body: `Auto-merge-paths: <glob>, <glob>`. |
| `{k} of {m} file(s) outside declared ownership: {stray}` | Some changed files match no declared glob (e.g. `2 of 5 file(s) outside declared ownership: ['src/x.ts', 'README.md']`; the list is truncated to 6 entries with a trailing ` ...`). | Remove the stray files from the PR, or add their paths to `Auto-merge-paths:`. |

## Notices that are *not* declines

These appear in auto-merge logs but do **not** mean your PR was rejected — do not treat them as
decline reasons:

| Log line (verbatim) | What it means |
|---|---|
| `::notice::mergeable=UNKNOWN for #$N, attempt $attempt/6 — waiting for GitHub to compute it` | The workflow is polling (up to 6 times, 5s apart) while GitHub computes `mergeable`. This is a wait, not a decline. |
| `no open PR at $SHA — nothing to do` | No open PR matched the completed run's head commit, so there was nothing to evaluate. A plain log line, not a `::notice::` decline. |

## Notice on success

When all gates pass, the workflow prints (before squash-merging and deleting the branch):

```
::notice::auto-merge gates passed for #{n}; {k} file(s) within {owns}
```
