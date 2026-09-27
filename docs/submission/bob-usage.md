# IBM Bob Usage Statement

We used IBM Bob to build TeamWeave, a shared canvas for coding-agent workflows with human review and traceable execution.

Bob contributed the initial React canvas, worker nodes, executor integration, seed workflow, deployment configuration, and project rules and skills. On another team account, Bob contributed the backend foundation, Git workspace binding, local execution adapter, API-provider integration, node placement contracts, and canvas controls. The repository includes genuine Bob task-session summaries captured from Bob IDE.

Direct IDE work included canvas editing and a later interface-clarity pass. Some sessions reached their cost limits before completing their scope. We retained useful changes, reviewed the resulting diffs, and finished corrections separately. We do not claim that every final line was written by Bob.

Each development task had an explicit workspace, a bounded scope, acceptance checks, and a cost cap. We inspected changes and ran focused tests, type checks, builds, and browser workflows. Repository history distinguishes implementation from later integration and repair. Some Git publication and merge operations were performed through Bob sessions; those operations alone do not imply Bob authorship of the code being committed.

After the available Bob allowance was exhausted, remaining fixes and features, including member onboarding and the shared run monitor, were completed directly by the team. These changes are not attributed to Bob.

The product also supports Bob Shell as an optional worker executor with timeout, turn, and Bobcoin limits. Separate OpenAI-compatible API connections support planning and worker execution; Mock is an explicitly labeled simulation. IBM watsonx.ai and watsonx Orchestrate are not used in this version.

The repository's `bob_sessions/` directory contains genuine task-summary screenshots, task IDs, and available cost records. `bob_report.md` explains evidence coverage and limitations. Session costs are cumulative task amounts, not account balances or a claimed percentage of Bob-written code.
