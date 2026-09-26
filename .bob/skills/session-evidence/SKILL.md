---
name: session-evidence
description: Capture a Bob session screenshot as evidence — naming convention, IDE path, timing, and storage in bob_sessions/.
---

# Skill: session-evidence

Capture one screenshot per task as verifiable evidence of Bob session consumption.

## When to capture
Take the screenshot immediately after a task completes (before starting the next
one) so the session summary is visible.

## What to capture

Navigate to the session summary view in IBM Bob Shell:

```
IDE → Tasks panel → select the completed task header → Session consumption summary
```

The screenshot must show:
- Task name / ID
- Token or cost consumption summary
- Session timestamp

## Naming convention

```
bob_sessions/<teamname>_task<NN>_<short-desc>.png
```

Examples:
```
bob_sessions/teamweave_task01_bob-factor.png
bob_sessions/teamweave_task02_fix-auth.png
```

- `<teamname>`: your team identifier (e.g. `teamweave`)
- `<NN>`: zero-padded sequential task number
- `<short-desc>`: 1-3 words, hyphen-separated, matching the branch topic

## Procedure

1. Complete the Bob task.
2. In IBM Bob Shell, open the Tasks panel and click the completed task header.
3. Wait for the session consumption summary to render.
4. Take a screenshot (macOS: `Cmd+Shift+4`, Windows: `Win+Shift+S`).
5. Save the file to `bob_sessions/` in the repo root using the naming convention above.
6. `git add bob_sessions/<filename>.png` and include it in the task commit.

## Notes
- One screenshot per task — do not batch multiple tasks into one image.
- If the Tasks panel is unavailable, capture the terminal output of `bob session list` as a fallback.
- `bob_sessions/` is committed to the repo so judges can audit evidence.
