# TeamWeave

TeamWeave connects team boards to coding projects. Each project graph contains tasks with prompts, model choices and dependencies. Agents work in a bound Git checkout, pass results to downstream tasks, and stop at human review gates.

The [public page](https://anton15k.github.io/IBM_HACK/) is separate from the local full-stack application. GitHub Pages does not host its backend or run agents.

## Run locally

Requires Node.js 24+, npm and Git. Install IBM Bob Shell only if you want to execute Bob tasks.

```sh
npm ci
# Terminal 1: allow only the directories containing projects agents may work on.
TEAMWEAVE_WORKSPACE_ROOTS=/absolute/path/to/projects npm run dev:server
# Terminal 2
npm run dev
```

Open http://localhost:5173/IBM_HACK/ and register an organization. Use **Manage** to add departments, teams and members. Open a team, choose **New Project**, and enter an existing Git directory, its checked-out branch and a ref such as `HEAD` or a commit SHA.

The backend listens on `127.0.0.1:7142`; SQLite stores users, roles, projects and execution history in `.data/teamweave.db`. The browser uses authenticated API requests; project data and API credentials are not persisted in browser localStorage.

## Models and execution

| Choice | Configuration | Behavior |
|---|---|---|
| Mock | None | Explicit simulation; no files changed or model calls |
| Bob Shell | `BOB_API_KEY` or `~/.bob/api_key`; optional `BOB_BIN` | Runs Bob in the bound Git workspace with per-task coin and turn caps |
| API model | An organization administrator adds a connection in **Backend** | OpenAI-compatible chat completions with bounded file tools and token limits |

API connections accept a label, base URL, model name and write-only API key. For OpenRouter use `https://openrouter.ai/api/v1` and a namespaced model slug such as `z-ai/glm-5.3-flash`. For z.ai use `https://api.z.ai/api/paas/v4` and an available model such as `glm-4.7-flash`. For an OpenAI-compatible endpoint, include its API path, for example `https://api.openai.com/v1`. Compatibility varies by model; native Anthropic and Google endpoints are not implemented in this runtime.

Credentials are encrypted on the server. Back up the private `.teamweave_model_key` file alongside the database; losing it makes saved credentials unreadable. Do not commit either file. Outbound model hosts must appear in `TEAMWEAVE_MODEL_HOSTS` (comma-separated; defaults: `api.z.ai,api.openai.com,openrouter.ai`); HTTPS is required and redirects are rejected.

For a local OpenAI-compatible server such as LM Studio, explicitly allow its exact base URL before starting the backend:

```sh
TEAMWEAVE_LOCAL_MODEL_URLS=http://192.168.1.76:1234/v1 npm run dev:server
```

Enter that same base URL, the model ID from the server, and its API token in **Backend**. HTTP is accepted only for explicitly listed loopback or private IP endpoints; different ports and API paths require their own entries (comma-separated). Existing HTTPS host restrictions still apply. This opt-in sends the token and task context over unencrypted local HTTP, so use it only on a trusted network.

- **AI plan** generates a small proposed graph. Review it and click **Apply plan** to create draft nodes. Applying does not execute tasks; a stale proposal must be regenerated.
- Each worker chooses a provider and, for API models, a connection. **Run pending tasks** respects dependencies and review gates; a node can also be run individually.
- API `report` tasks can list/read files. API `patch` tasks can also write files and run the fixed `node --test` command. Other test frameworks and arbitrary shell commands are not exposed by this API executor.
- API runs use at most 32 model rounds, up to 65,536 output tokens per request (default 1,024; individual models may impose lower limits), and a ten-minute execution deadline. Displayed API token usage is separate from Bobcoins. Missing provider usage is not treated as zero.
- `report` and `patch` are supported outputs. Automatic commits and pull requests are not implemented.

The local runner executes project test code as the backend's operating-system user. Use trusted local projects; this is not a container sandbox for untrusted tenant code. API file tools reject traversal, symlinks and sensitive paths, and test subprocesses receive a restricted environment.

## Graphs are bound to projects

Explicit project creation requires `workspace.path`, `workspace.branch` and `workspace.ref`. This release uses an existing directory; it does not create folders or silently switch branches. Automatically created empty boards remain editable drafts until a workspace is configured for real execution.

Before a real run, the server checks that the canonical Git worktree lies under the configured roots and that its current branch and commit match the requested binding. Nodes inherit the graph binding and may explicitly override it. Jobs sharing a worktree execute serially; separate worktrees can run independently.

Each attempt records the node definition and prompt, upstream results, Git commit, dirty state, tracked diff and hashes of untracked files before and after execution. Unexpected changes from the graph checkpoint block further execution. Snapshots provide provenance; they are not a complete backup of untracked file contents.

## Team workflow

- Organization → departments → teams, with separate boards and parent navigation.
- Administrator, editor and viewer access with inherited team roles and organization isolation.
- Prompt refinements, comments, file references, owners, priority and reusable node templates.
- Human approval gates, bounded rework, cancellation and persisted attempt history.
- Cross-team handoffs create an inbox item with the source attempt and output; the receiving team chooses how to act on it.
- Existing project export remains available. Execution status comes from the backend rather than a simulated progress timer.

## Development

React, TypeScript, React Flow and Zustand form the frontend; Fastify and SQLite provide the API and scheduler. IBM Bob Shell contributed implementation of frontend and backend components; integration, corrections and validation were reviewed separately.

```sh
npm run typecheck:server
npm run test:server
npm run test:client
npm run build
```

Tests use local Git fixtures and fake provider responses rather than paid model calls. A production build generates frontend assets; it does not deploy the backend.

Optional configuration: `TEAMWEAVE_DB` selects another database; `PORT` changes the backend port. For a separate development instance, set `TEAMWEAVE_API_TARGET` on Vite and `TEAMWEAVE_FRONTEND_ORIGIN` on the backend to matching local addresses. Defaults remain ports 5173 and 7142.

MIT license.

## Bob integration

The `.bob/` directory is a Bob 2.0 workspace package: `mcp.json` registers the
`filesystem` and `memory` MCP servers at workspace scope (loaded automatically
by Bob Shell), and `rules/` + `skills/` contain project conventions and reusable
task procedures loaded by reference in task prompts. See [`.bob/README.md`](.bob/README.md)
for the full artifact table and usage examples.

Try it: `bob mcp list`

API file writes accept up to 256 KiB per file. Reads and tool output remain bounded to 64 KiB. Existing tasks keep their configured iteration and token limits; adjust them in the inspector for larger tasks. Provider context/output limits still apply.


### Prepare a repository from the browser

An organization admin can open **Browse…** in the workspace editor, choose a
configured server directory, and select **New folder** or **Clone repository**.
Folder creation makes a plain directory; it does not initialize Git. Clone accepts
public HTTPS repositories on GitHub, GitLab and Bitbucket, creates a new directory,
and fills in the checked-out branch. Click **Apply workspace**, then **Create
Project** when creating a project. Private repositories and SSH authentication are
not supported by this flow; an existing server checkout can still be selected.

The server operator must configure `TEAMWEAVE_WORKSPACE_ROOTS` to an existing
parent directory first. Paths stay inside those roots and existing targets are
never overwritten. Clones use a shallow single-branch checkout, do not initialize
submodules, disable credential helpers/redirects/hooks, and time out after 90
seconds. A failed clone removes only its newly created target. Workspace roots
remain shared host resources for trusted organizations; this is not a sandbox
for untrusted public tenants.
