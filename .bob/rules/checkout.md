# Branch & Commit Conventions

## Branch naming

- Agent-initiated work: `agent/<short-id>-<topic>` (e.g. `agent/42-fix-auth`)
- Bob config / tooling: `bob/<topic>` (e.g. `bob/bob-factor`)
- Human feature work: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`
- Never commit directly to `main`.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <imperative summary>

[optional body — why, not what]
```

Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `ci`.
Keep the subject line ≤72 characters.

## Pull requests

- Open a PR to `main` for every change; title mirrors the commit type/scope.
- PR body must list files changed, the verification bar output, and any
  cost/token usage if a Bob run was involved.
- An independent reviewer (not the dispatching agent) must approve the exact
  head SHA before merge. The merge is performed by the authorized executor
  (human or a tightly bounded Bob Git task under standing delegation).
  The dispatching task stops after opening the PR; any later merge task must
  first verify the independent approval and the unchanged reviewed head.
- Merge via PR. Default to a merge commit (preserves the reviewed branch
  history); squash or rebase-merge is acceptable when the branch is a single
  logical change. Never push directly to `main`.
