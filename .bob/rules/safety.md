# Safety & Spend Discipline

## Provider calls

- Use the **Mock provider** for demos, tests, and exploratory work. Paid Bob
  runs are reserved for deliberate, pre-authorized execution (e.g. a one-off
  real-run rehearsal specified in the task itself); never route test traffic
  to paid model APIs.
- Every `bob run` or task invocation must include an explicit `--max-cost` cap,
  denominated in **Bobcoins** (not USD). Default cap for this repo:
  **0.50 Bobcoins** per task unless the task spec states otherwise.
- Batch tool calls; do not fragment work into many small requests.

## Secrets handling

- API keys belong in `~/.bob/api_key` or server environment variables only.
- Never commit keys, tokens, or credentials to source code, config files, or
  browser-accessible locations.
- `.gitignore` must cover `.env`, `*.key`, and `*.secret` — verify before commit.

## Personal data

- Do not include real personal data (names, emails, IPs) in seed content, test
  fixtures, or demo graphs.
- Use clearly synthetic data (`user@example.com`, `Alice`, `Team-A`).

## Code & config changes

- Do not modify `server/`, `src/`, or `bob-gateway/` as part of a Bob-config task.
- All Bob-config changes are in `.bob/` and `README.md` only.
