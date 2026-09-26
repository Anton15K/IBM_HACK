---
name: bobcoin-discipline
description: How to scope a Bob task so it stays focused, cost-bounded, and auditable — one mission, explicit deliverables, --max-cost cap, batch over fragment, personal verification, ledger note.
---

# Skill: bobcoin-discipline

Apply this skill when defining or reviewing a Bob task to ensure spend and scope are controlled.

## Procedure

### 1. One mission
State a single, unambiguous objective. If the request has two independent goals,
split it into two tasks. Avoid "also" and "while you're at it."

### 2. Explicit deliverables + acceptance list
Write the deliverables as a numbered list before starting:
- Exact files to create or modify.
- Acceptance criteria (e.g. "typecheck passes", "test X is green", "screenshot shows Y").
No deliverable = no task.

### 3. Set `--max-cost` cap
Every `bob run` call must include `--max-cost <amount>`.
Default for this repo: **$0.50**. Document the cap in the task description.
If the task might cost more, get explicit approval and state the revised cap.

### 4. Batch, don't fragment
Group all file writes, searches, and tool calls into the minimum number of
round-trips. Never open a new task to do what a single tool call can handle.

### 5. Verify personally
After the task completes, run the verification bar yourself:
```sh
npm run typecheck:server && npm run test:server && npm run test:client && npm run build
```
Do not accept the agent's self-report. Check the diff (`git diff --stat`).

### 6. Ledger note
After closing the task, record in the PR body or a comment:
- Actual cost / tokens used.
- Whether the cap was respected.
- Any deviation from planned deliverables and why.
