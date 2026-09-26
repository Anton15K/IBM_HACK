---
name: verify-release
description: Run the full TeamWeave pre-release check — four verification commands, git-clean assertion, and dist size sanity — then output a PASS/FAIL table.
---

# Skill: verify-release

Run this skill before any PR merge or release tag to confirm nothing is broken.

## Procedure

1. **Type-check the server**
   ```sh
   npm run typecheck:server
   ```
   Expected: zero errors. Fail immediately on any TypeScript error.

2. **Server tests**
   ```sh
   npm run test:server
   ```
   Expected: all tests pass, zero failures.

3. **Client tests**
   ```sh
   npm run test:client
   ```
   Expected: all tests pass, zero failures.

4. **Production build**
   ```sh
   npm run build
   ```
   Expected: exits 0; `dist/` is populated.

5. **Git clean check**
   ```sh
   git status --short
   ```
   Expected: empty output (no uncommitted changes). If dirty, list untracked/modified files.

6. **Dist size sanity**
   ```sh
   du -sh dist/
   ```
   Expected: total < 5 MB. Flag if larger.

## Output format

Produce a Markdown table:

| Step | Command | Result |
|------|---------|--------|
| 1 | `typecheck:server` | ✅ PASS / ❌ FAIL |
| 2 | `test:server` | ✅ PASS / ❌ FAIL |
| 3 | `test:client` | ✅ PASS / ❌ FAIL |
| 4 | `build` | ✅ PASS / ❌ FAIL |
| 5 | git clean | ✅ PASS / ❌ FAIL |
| 6 | dist size | ✅ OK / ⚠️ LARGE |

**Overall: PASS only if every row is ✅.**
Paste the full terminal output after the table.
