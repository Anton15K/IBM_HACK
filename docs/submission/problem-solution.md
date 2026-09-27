# Problem and solution

## Problem

Coding agents often work in isolated chats. When several people and teams depend on their outputs, it becomes difficult to see who owns each task, which dependencies are ready, what an agent actually changed, and where human approval is needed. Copying answers between chats loses execution context and makes failed runs difficult to diagnose.

## Solution

TeamWeave gives engineering teams a shared visual workspace for agent tasks. Organizations contain departments and teams; each team has project boards bound to Git repositories on the server. Administrators can select an existing checkout, initialize a new repository, or clone a supported public HTTPS repository from the interface.

Workers form directed dependency graphs. Each node holds instructions, an assigned owner, a provider choice, and a project context. Successful upstream outputs become structured inputs to downstream tasks. Human review gates pause dependent work for approval or rework. Cross-team handoffs create inbox items carrying source context for the receiving team.

The backend records individual execution attempts with their prompts, results, initiator where available, and before/after Git workspace information. A shared run monitor shows active work, dependencies, review waits, stopping tasks, and recent history. Tasks targeting the same checkout serialize execution; separate worktrees can run concurrently. Members use administrator-created accounts with editor or viewer access.

Users can configure API models for planning and execution, choose the optional IBM Bob Shell worker, or explore a clearly labeled Mock workflow. Model credentials remain on the server.

## Prototype scope

The prototype uses a React interface and a Fastify/SQLite backend. Team members share state through polling, not live cursors or character-level collaborative editing. Simultaneous edits to the same field use the last saved value. Execution is intended for trusted projects: it is not a sandbox for untrusted public tenants. File changes are not held back until gate approval, and cancellation does not roll them back.

GitHub Pages hosts the project overview and setup instructions. The complete application requires its backend; it is not deployed as a public multi-tenant service.
