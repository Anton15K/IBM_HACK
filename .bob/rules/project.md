# Project: TeamWeave

TeamWeave is a collaborative AI-workflow builder — a React/TypeScript SPA (Vite + Zustand + React Flow) backed by a Fastify/SQLite server. Users design graphs of AI worker nodes, assign LLM executors, and trigger multi-step automated pipelines; a planner can auto-compose graphs from natural-language goals.

## Repo layout

```
src/            React frontend (components/, store.ts, types.ts, prompt.ts)
server/         Fastify API + SQLite scheduler (routes/, db.ts, executor.ts, runtime.ts)
bob-gateway/    Lightweight proxy used in IBM Bob Shell integration demos
landing/        Static landing page (index.html)
.bob/           Bob workspace config (rules, skills, mcp.json)
package.json    Scripts: dev, build, test:server, test:client, typecheck:server
```

## Verification bar

A task is **done** only when all four commands pass with zero errors:

```sh
npm run typecheck:server
npm run test:server
npm run test:client
npm run build
```

Never trust a self-report. Always show diff stats (`git diff --stat`) and the
terminal output of the four commands before declaring completion.
