# TeamWeave

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

## Features (M1)

- **Infinite canvas** with dot-grid background, minimap, pan/zoom
- **Org tree sidebar** — Acme Corp → departments → teams, with mini-graph previews and click-to-pan
- **Team spaces** — large labeled container blocks on the canvas
- **Worker/Gate/Inbox nodes** with status colors, progress bars, priority badges, provider labels
- **Status colors**: draft=gray, ready=blue, running=blue pulse, done=green, rework=yellow, failed=red, needs_approval=yellow ring, blocked=gray-blue; critical priority overrides to red
- **Inspector panel** — edit name, status, priority, prompt, executor, context files, owners; view output
- **Mock executor** — Run Node button ticks progress 0→100 over ~4s then marks done
- **Gate nodes** — become `needs_approval`, show Approve / Request Changes buttons
- **Graph runner** — TopBar "Run Graph" button executes a topological DAG pass; independent nodes run in parallel (visually)
- **Templates drawer** — 4 built-in templates (Code Review, Write Tests, Fix Bug, Investigate); Save as Template from inspector
- **Export/Import JSON** — full project round-trip; Reset to seed data
- **localStorage persistence** — auto-saves on every change

## Screenshot

_Coming soon_

## Seed data

The app loads with **Acme Corp** pre-populated:
- **Security Team**: 4-node graph (Recon → Exploit Analysis → Security Review Gate → Write CVE Report), with Recon done and Exploit Analysis running
- **Backend Team**: 4-node graph (Investigate → Implement → Code Review Gate → Write Tests), with Investigate done and Implement in rework

## Roadmap

- **M2**: Real LLM executor connections (bob, openai, anthropic, google) — currently mocked
- **M3**: Collaboration (multi-user, presence, comments)
- **M4**: Persistent backend, auth, org management

## License

MIT
