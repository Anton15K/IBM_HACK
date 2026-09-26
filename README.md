# TeamWeave

## Demo

**Live demo:** https://anton15k.github.io/IBM_HACK/

Local dev: `npm run dev` · Production build: `npm run build`

> **Note:** Bob Gateway features require a locally running gateway (`npm run gateway`). The hosted demo uses simulated/mock executors.


> **Miro for orchestrating AI-agent teams** — an infinite-canvas B2B web application where your organization's departments and teams each get a dedicated "space" on the canvas. Inside each space, you build directed graphs of agent-worker nodes: Inbox nodes that ingest research, Worker nodes that execute tasks, and Gate nodes that pause the flow for human review. Teams can run graphs with a single click, watch nodes execute in topological order (with gates pausing for approval), and inspect every node's prompt, context, executor config, and output in the right-side inspector panel.

## Stack

| Layer | Tech |
|---|---|
| UI framework | React 18 + TypeScript (strict) |
| Canvas | [@xyflow/react](https://reactflow.dev/) (React Flow v12) |
| State | [zustand](https://github.com/pmndrs/zustand) + localStorage persistence |
| Styling | Tailwind CSS v3 (custom dark design tokens) |
| Build | Vite 6 |

## How to run

```bash
npm install
npm run dev       # starts dev server at http://localhost:5173
npm run build     # production build (zero TS errors)
```

## Features (M1 — canvas + runner)

- **Infinite canvas** with dot-grid background, minimap, pan/zoom
- **Org tree sidebar** — Acme Corp → departments → teams, with mini-graph previews and click-to-pan
- **Team spaces** — large labeled container blocks on the canvas
- **Worker/Gate/Inbox nodes** with status colors, progress bars, priority badges, provider labels
- **Status colors**: draft=gray, ready=blue, running=blue pulse, done=green, rework=yellow, failed=red, needs_approval=yellow ring, blocked=gray-blue; critical priority overrides to red
- **Inspector panel** — edit name, status, priority, prompt, executor, context files, owners; view output
- **Gate nodes** — become `needs_approval`, show Approve / Request Changes buttons
- **Graph runner** — TopBar "Run Graph" button executes a topological DAG pass; independent nodes run in parallel (visually)
- **Templates drawer** — 4 built-in templates (Code Review, Write Tests, Fix Bug, Investigate); Save as Template from inspector
- **Export/Import JSON** — full project round-trip; Reset to seed data
- **localStorage persistence** — auto-saved on every change

## Features (M2 — executors + cross-team + replay + settings)

### Executors

Real LLM executor layer behind a clean `Executor` interface (`src/executors/`):

| Provider | What's needed | Default model |
|---|---|---|
| `mock` | Nothing — always available | mock-v1 |
| `openai` | OpenAI API key in Settings | gpt-4o-mini |
| `anthropic` | Anthropic API key in Settings | claude-sonnet-4-5 |
| `google` | Google AI API key in Settings | gemini-2.0-flash |
| `bob` | Bob Gateway running locally | bob-4 |

**How prompt assembly works:**  
`assemblePrompt(node, graphContext, incoming)` in `src/executors/registry.ts` builds a structured prompt:
1. `## Project Context` — goal, repo, conventions from the graph's `GraphContext`
2. `## Task` — the node's `prompt.task`
3. `## Context Files` — listed file/glob entries from `node.context.files`
4. `## Extra Context` — `node.context.extra`
5. `## Inputs from Upstream Nodes` — for each enabled input edge, the upstream node's summary, results, commands, and artifacts
6. `## Refinements` — all `prompt.refinements` entries
7. JSON instruction appended to all real LLM calls: asks for `{summary, results, commands, artifacts}` JSON

View the assembled prompt for any node with the **"View assembled prompt"** button in the Inspector → Prompt section.

**How to set API keys:**  
Click the ⚙ icon in the top bar → Settings. Paste keys into the masked fields. Click **Save & Close**.  
Keys are stored in `localStorage` under the key `teamweave-keys` and are **never included in exported project JSON**.  
Use the **Test** button next to each provider to verify connectivity.

**Bob Gateway note:**
The `bob` executor POSTs to `http://localhost:7142/execute` (configurable in Settings). If the gateway is not running, nodes fall back to the built-in simulator with a `[Simulated]` prefix in the summary.

### Bob Gateway (optional, for live Bob runs)

The gateway lets Bob-provider nodes execute tasks through the real IBM Bob Shell CLI
instead of the simulator.

```bash
# 1. Install IBM Bob Shell and add your API key to ~/.bob/api_key
# 2. Start the gateway (no npm install needed — zero dependencies):
node bob-gateway/server.js          # or: npm run gateway
# 3. In TeamWeave Settings, confirm Bob Gateway URL = http://localhost:7142
```

See [`bob-gateway/README.md`](bob-gateway/README.md) for full setup, security notes,
and troubleshooting.

### Cross-Team Send ("Send to Team")

- **Right-click** any node card on the canvas → "📤 Send to Team…"
- Or open a node in the **Inspector** → footer button "📤 Send to Team…"
- A modal lets you pick the target team, add an optional message, and choose whether to escalate priority to **critical**
- Creates an `inbox` node in the target team's graph with:
  - Name: `From <source team>: <node name>`
  - Status: `draft`
  - `inboxMeta` embedded: `sourceNodeId`, `sourceTeamId`, message
  - The original task + message in `prompt.task`
- A toast notification confirms the send: `✓ Sent to <team>`
- Inbox nodes show a **📥 icon** + **"from: <team>"** badge on the card
- Inspector shows the **"⚙ Convert to Worker"** button on inbox nodes (clears inputs/meta, sets type → worker)

### Session Replay

Every executor run appends a `HistoryEntry` to `node.history`:
```ts
{ ts, provider, model, status: 'done'|'failed', summary, durationMs }
```

The Inspector **HISTORY** section (shown when history is non-empty) lists all runs newest-first. Each row shows provider, duration, and a **▶ Replay** button. The replay modal:
- Animates a progress bar to 100% over ~2s
- Shows the final summary from the recorded run
- Is **read-only** — does not change node status

### Other M2 improvements

- Output section in Inspector uses red/green styling based on actual success/failure
- Assembled prompt viewer modal with copy button
- Zustand store version bumped to 2 with migration for `history: []` default on legacy nodes
- `npm run build` green, zero new dependencies

## Screenshot

_Coming soon_

## Seed data

The app loads with **Acme Corp** pre-populated:
- **Security Team**: 4-node graph (Recon → Exploit Analysis → Security Review Gate → Write CVE Report), with Recon done and Exploit Analysis running
- **Backend Team**: 4-node graph (Investigate → Implement → Code Review Gate → Write Tests), with Investigate done and Implement in rework

## Manual testing checklist

### Keyless (mock)
1. Reset to seed data → click "Run Graph" on Backend Team → all nodes should complete via mock executor
2. Right-click a node → "Send to Team…" → pick Security Team → inbox node appears there
3. Double-click the inbox node → Inspector shows 📥 icon + "cross-team" badge → click "⚙ Convert to Worker"
4. Run a worker node manually → wait for done → Inspector HISTORY shows one entry → click ▶ Replay → progress bar animates → summary appears

### With OpenAI key
1. ⚙ Settings → paste OpenAI key → Save & Close
2. Pick any worker node → set Provider = openai → click ▶ Run Node
3. Node should animate, call the API, fill real output + summary
4. HISTORY shows one entry with provider=openai and real duration

### Assembled prompt
1. Any worker node with upstream inputs → Inspector → "View assembled prompt" → shows full multi-section prompt

## Roadmap

- [x] **M1**: Canvas, spaces, nodes, mock runner, templates, persistence
- [x] **M2**: Real LLM executors (OpenAI/Anthropic/Google/Bob), cross-team send, session replay, settings with BYO keys
- [x] **M3**: Bob Gateway — local bridge between TeamWeave UI and `bob run` CLI (`bob-gateway/server.js`)
- [ ] **M4**: Collaboration (multi-user, presence, comments)
- [ ] **M5**: Persistent backend, auth, org management

## License

MIT
