# Bob Gateway

A tiny local Node.js HTTP server that bridges the **TeamWeave UI** to the
[IBM Bob Shell CLI](https://ibm.biz/bob-shell) (`bob run`). It lets "Bob-provider"
nodes on the canvas execute real AI tasks via the local Bob agent instead of the
built-in simulator.

## What it does

| Endpoint | Method | Description |
|---|---|---|
| `/health` | `GET` | Returns `{ ok, bob, apiKey }` — bob version + whether an API key is found |
| `/test` | `POST` | Runs a trivial `bob ask "Reply with OK"` to verify end-to-end connectivity |
| `/execute` | `POST` | Runs `bob run --mode agent` with the assembled prompt from a TeamWeave node |

### `/execute` request body

Sent by `src/executors/bob.ts`:

```json
{
  "prompt": "<assembled prompt text>",
  "model": "bob-4",
  "graphContext": { ... },
  "skills": [],
  "tools": [],
  "maxIterations": 30
}
```

The `prompt` field contains the fully-assembled task prompt built by
`src/executors/registry.ts`. The gateway writes it to `TASK.md` in a fresh temp
workspace and passes `"Read TASK.md in the workspace and complete the task it describes.
Report results."` to `bob run` so Bob reads the full context from the file.

### `/execute` response body

Plain JSON (matches `RunOutput` in `src/executors/types.ts`):

```json
{
  "summary": "First 400 chars of bob's last_message",
  "results": ["Bullet/numbered list items extracted from last_message"],
  "commands": ["Lines from ```bash blocks in last_message"],
  "artifacts": ["file.md", "output.json"]
}
```

## How to run

**Prerequisites:**
- Node.js ≥ 18 (built-in `http`, `fs`, `os`, `child_process` — no npm install needed)
- IBM Bob Shell CLI installed: `~/.local/bin/bob` (v2.0.5+)
- API key in `~/.bob/api_key` **or** `BOB_API_KEY` in your environment

```bash
node bob-gateway/server.js
```

The server binds to `127.0.0.1:7142`. You can also use the npm script from the repo root:

```bash
npm run gateway
```

Then open TeamWeave at `http://localhost:5173`, go to **⚙ Settings**, and confirm
the Bob Gateway URL is set to `http://localhost:7142`. Set a worker node's provider
to **bob** and click ▶ Run Node.

## Security note

The gateway binds to **`127.0.0.1` only** and is intentionally localhost-only.
It is not designed to be exposed to the network. Do not put it behind a reverse
proxy that accepts external traffic — it executes code via the Bob CLI with your
API key and full filesystem access.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/health` returns `ok: false` | Check that `~/.local/bin/bob` exists and is executable |
| `apiKey: false` | Create `~/.bob/api_key` or set `BOB_API_KEY` env var |
| Node falls back to simulation | Gateway not running; start with `npm run gateway` |
| Timeout after 10 min | The task is too large; break it into smaller nodes |
