# .bob — TeamWeave Bob Workspace Package

This directory makes Bob 2.0 structurally visible in the TeamWeave repository.
It contains MCP server configuration, project rules, and reusable task skills.

---

## Artifacts

| Artifact | What it does | How Bob uses it | How to try it |
|---|---|---|---|
| `mcp.json` | Registers two stdio MCP servers (`filesystem`, `memory`) at workspace scope | Loaded automatically by Bob Shell when the workspace is open; tools become available in every session | `bob mcp list` |
| `rules/project.md` | Describes TeamWeave, repo layout, and the four-command verification bar | Reference in a task prompt: `rules: .bob/rules/project.md` | Open the file; include it in any task |
| `rules/safety.md` | Spend discipline, secrets policy, Mock-provider requirement | Reference in a task prompt: `rules: .bob/rules/safety.md` | Open the file; include it in any task |
| `rules/checkout.md` | Branch naming, conventional commits, PR + review gate | Reference in a task prompt: `rules: .bob/rules/checkout.md` | Open the file; include it in any task |
| `skills/verify-release/SKILL.md` | Full pre-release check with PASS/FAIL table | Load via `skill: .bob/skills/verify-release/SKILL.md` in a task | Run the skill at end of any PR |
| `skills/bobcoin-discipline/SKILL.md` | How to scope a Bob task: mission, deliverables, cost cap, ledger | Load via `skill: .bob/skills/bobcoin-discipline/SKILL.md` | Apply before starting any non-trivial task |
| `skills/session-evidence/SKILL.md` | Screenshot capture procedure for bob_sessions/ evidence | Load via `skill: .bob/skills/session-evidence/SKILL.md` | Capture after every completed task |

---

## Honest framing

**`mcp.json`** is the only file Bob Shell loads *automatically* — it wires up
the `filesystem` and `memory` MCP servers whenever Bob opens this workspace.

**Rules and skills** are *loaded by reference* in task prompts. Bob does not
auto-inject them; you (or the agent) must explicitly name them. Example:

```
Task: fix the auth token expiry bug
rules: .bob/rules/project.md, .bob/rules/safety.md
skill: .bob/skills/bobcoin-discipline/SKILL.md
--max-cost 0.50
```

---

## MCP servers

| Name | Command | Purpose |
|---|---|---|
| `filesystem` | `npx -y @modelcontextprotocol/server-filesystem .` | Repo-scoped file read/write tools |
| `memory` | `npx -y @modelcontextprotocol/server-memory` | Cross-session knowledge graph |

Verify they are registered: `bob mcp list`

No API keys. No secrets. No machine-specific paths. Both servers require only
Node.js (already needed to run the project).
