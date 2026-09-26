---
name: session-evidence
description: Preserve genuine IBM Bob IDE task-summary screenshots in bob_sessions/.
---

# Session evidence

After a meaningful task completes, open that exact task in IBM Bob IDE and
show its task-detail completion summary. Capture the real view with the task
name or ID and the displayed usage/cost information. Record the capture time
and corresponding commit in the evidence index. Do not invent missing fields.

Save an unaltered PNG as `bob_sessions/<team>_task<NN>_<description>.png`.
Review it for secrets before adding that specific file to the task commit.
The directory is intended to hold committed submission evidence.

IBM Bob Shell is a separate CLI. Its terminal output is not the IDE task-summary
view. If the exact task or summary is unavailable in the IDE, mark its screenshot
PENDING and retain the real task ID for later verification. Do not substitute
terminal output, a reconstructed summary, or an assumed equivalent screenshot.

Follow any active user pause on IDE access or captures; keep evidence PENDING
until access is authorized. Existing screenshots must reflect actual sessions.
