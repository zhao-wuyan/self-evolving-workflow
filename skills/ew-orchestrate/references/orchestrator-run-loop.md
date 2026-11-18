# Evolve Session Execution and Recovery

Use the bundled `evolve` CLI (in this source checkout, run `node dist/workflow-cli.js`). Session/Run state, `boundary_contract`, `goals[]`, `amendments[]`, requests, and sealed artifact bytes share `.evolve/workflow.db`; working outputs live under the `run_dir` returned by the controller.

## Start and Dispatch

1. **Install & validate**: Run `evolve skill install` (`--scope project --yes` for project setup), **commit Skill packages to Git `HEAD`** so Runs bind cleanly (for **pre-Git bootstrap** in a directory without `.git` or `HEAD`, run `git init`, `evolve skill install --scope project --yes`, and create the initial commit with installed Skill packages before `evolve session create`), list docs via `evolve skill workflows`, and validate contracts via `evolve skill validate <command>`.
2. **Open Session & chain**:
   - Argument-free chain: `evolve session create "<objective>" --id <session> --actor <actor> [--definition-of-done "<text>"] [--boundary-contract '<json>'] [--goals '<json>'] [--auto] [--goal-mode] --chain "ew-analyze,ew-plan,ew-execute,ew-verify"`.
   - Step with args / retries / gates: `evolve session step add --session <session> --step-id <id> --command <command> [--arg "<val>" ...] [--retry-max <n>] [--goal-ref <id>] [--stage <name>] [--decision-ref <id>] [--after-step <id>] --actor <actor> --expected-orchestration-revision <revision>` (pass `-`-prefixed values as `--arg=VALUE`; pass `--actor <actor>`, `--participant` is optional and must match `--actor` if passed).
   - Standalone decision gate (`decision-only`): add `--decision-only --decision-ref <gate-id>` instead of `--command`.
3. **Dispatch Run**: `evolve run create --session <session> --actor <actor> --expected-orchestration-revision <revision>` — passes `session_id`, `run_id`, `run_dir`, `skill_ref`, `knowledge_profile` (`task`, `categories`, `wiki`, `memory_types` parsed from Skill frontmatter), bound `upstream` (primary + sibling attachments/evidence), `boundary_contract`, `goals`, and `gates` (Runtime expands `{intent}` and `{session}` in `task.args` automatically; do not pass undefined `--session` flags to step commands).
4. **Concurrency & idempotency**: Advance `--expected-orchestration-revision` (and `--expected-run-revision` for Run mutations) from each receipt; keep the same `--request-id` when retrying an uncertain call, and re-read `evolve session get` on `REVISION_CONFLICT`.

## Read and Execute

- **Skill reads**: Open entry with `evolve run read skill <run> --session <session>`, and package-relative `.md` links (relative to `<from>` and resolving inside the active Skill package root without escaping past the package root; note `steps/<name>` is an independent package root, so read cross-package docs via `evolve skill workflows show <id>`) with `evolve run read skill <run> <destination> --from <source> --session <session>`.
- **Artifacts**: Read bound inputs via `evolve run read artifact <run> <alias-or-id> --session <session>` (`--scope <JSON>` for `session-priors`). JSON artifacts MUST carry `_meta: { kind, schema, role, alias? }` and Markdown artifacts matching YAML frontmatter; NEVER append raw Markdown into `.json` files.
- **Knowledge Gate inside a Run** (choose one receipt source per Run):
  - **Bound priors**: Open `session-priors` via `evolve run read artifact <run> session-priors --session <session> --scope '<json>'` ONLY when its recorded `lookup_scopes` covers the current scope.
  - **CLI lookup**: `evolve search "<topic>" --mode context --session <session> --reads "<run_dir>/knowledge-reads.json"`, then inspect exact IDs via `evolve kb get <id> --reads "<run_dir>/knowledge-reads.json" --from-search <search-id>` (`search --mode context` automatically prioritizes working memories matching the active running Run's `search_profile.memory` types when `--session` is passed, and automatically refreshes stale `.evolve/index.db` if `wiki/` changed; `--session` identifies this Run context, while `--memory-session` filters historical episodic records). For steps declaring `outputs/priors.json`, Runtime snapshots CLI-read Wiki entries cleanly at `run complete` too.
  - **In-flight memory recording**: When a Run confirms a non-obvious root cause, workaround, or recurring pitfall, record it immediately via `evolve kb add --kind episodic "<lesson>" --type verified_fix|error --scene <step> --session <session>` alongside `report.md` closeout staging (`ew-knowledge` governs formal Wiki promotion after `session complete`).

## Verify, Continue and Recover

- **Seal Run & `report.md` Verdict Mapping**: `evolve run complete <run> --session <session> --actor <actor> --expected-orchestration-revision <rev> --expected-run-revision <rev> --summary "<observed result>" --gate <id>... [--verdict done|done_with_concerns]`. Run `evolve run check` first to preflight gates, outputs, and `report.md` `next` commands. Map `report.md` frontmatter `verdict` to Evolve lifecycle commands as follows:
  - `verdict: ready` -> `evolve run complete ... --verdict done`
  - `verdict: ready_with_concerns` (or `verdict: blocked` on an inspection/verification step such as `ew-review` / `ew-verify` / `ew-test` whose findings artifact is sealed for downstream `--gaps` or decision routing) -> `evolve run complete ... --verdict done_with_concerns` (downstream `consumes[]` slots expecting those findings must declare `accepts_negative_evidence: true`)
  - `verdict: blocked` (when exit gates/required outputs cannot be satisfied or human intervention is needed before completion) or `verdict: failed` (execution errored / retry needed) -> do **not** call `run complete`; use `evolve run transition <run> blocked|failed ... --reason "<why>"` (or `evolve run cancel`) so recovery/retry can proceed.
- **Follow `continuation.action` & `authority`**:
  - When `continuation.authority === "automatic"` (`--auto`), keep executing satisfiable actions (`next` / `decide` / `complete`) in the same turn rather than stopping between steps (unless hit by a user gate, drift/confidence halt, retry limit, or unrecoverable failure).
  - `execute` -> inspect/resume active Run via `evolve run get` + `evolve run check`.
  - `recover` -> handle `blocked` Run via `evolve run transition` (or `cancel`) before retrying.
  - `decide` -> `evolve run decide <decision-id> --session <session> --actor <actor> --expected-orchestration-revision <rev> --verdict proceed|fix|escalate [--confidence <0-100>] [--target-step <step-id>] [--evidence <ref>] --summary "<evidence>"` (`--confidence` is required in `--auto`/`--goal` coordinator decisions; `--target-step` reopens the target step through the gate when `verdict=fix`; after `verdict=escalate`, the decision stays active until user clarification/confirmation, then unblock via optional `session step add` + re-issuing `evolve run decide <decision-id> --verdict proceed|fix ...`).
  - `next` -> allocate next pending step via `evolve run create` (if `Retry limit exceeded`, stop retrying, escalate to the user, or `session step delete` + insert a new remediation step).
  - `complete` -> `evolve session complete --session <session> --actor <actor> --expected-orchestration-revision <rev>`, then inspect its `closeout_command` and `evolve_reminder` / `evolve_signals`: hand off closeout review/harvesting to standalone `ew-knowledge` (`evolve skill workflows show ew-knowledge`). Never auto-invoke `workflow-evolve` during task execution; only mention `/workflow-evolve` once at session closeout if `evolve_reminder` points to an actual Skill/harness defect rather than ordinary coding friction.
- **Crash / Stuck-Run Recovery**: Read `evolve session list --status open [--query <text>]`, `evolve session get --session <session>`, `evolve run get <run> --session <session>`, and `evolve run check <run> --session <session>`. Use `evolve run transition <run> running|blocked|failed --session <session> --actor <actor> --expected-orchestration-revision <rev> --expected-run-revision <run_rev> --reason "<why>"` (or `evolve run cancel ...`) with current fences before allocating a retry via `evolve run create`.

## Host Adapter Mapping

Shared workflow documents describe capabilities neutrally; resolve them to the active host runtime as follows:

| Capability | Antigravity | Codex | Claude | OMP |
| --- | --- | --- | --- | --- |
| Parallel / subagent execution (always join or cancel before advancing) | `invoke_subagent` / `swarm` / `run_workflow` | `spawn_agent` (`agent_type`) / `wait_agent` | Host subagent / `Agent` (`subagent_type`) | Native `task` (`context` + `tasks[]`) or eval `agent()`; results auto-deliver, join/cancel at barriers, never poll |
| Structured user prompt & confirmation | `ask_question` | `request_user_input` | Host interactive prompt | `ask` |
| Web search / external docs | `search_web` | Host web search tool | Host web search tool | Host web search tool |
| Browser acceptance / rendering check | `browser` subagent / Chrome DevTools / Playwright | Playwright / headless browser CLI | Playwright / browser MCP | Host browser tools / Playwright |

### Installed Step Agent Roster & Degradation

`evolve skill install` provisions host-native agent definitions under `.claude/agents/<name>.md`, `.codex/agents/<name>.toml` (`name` uses underscores, e.g., `workflow_planner`), and `.agents/agents/<name>.md` (or `agents/<name>.md`). When the active host supports named subagent types, select from the mapping below; if an agent definition is unavailable on disk, supply the same role constraints inline in the subagent prompt:

| Step | Recommended `agent_type` (`codex` snake_case) | Primary Role |
| --- | --- | --- |
| `ew-init` | `workflow-codebase-mapper` (`workflow_codebase_mapper`) | Parallel brownfield mapping (`stack`, `architecture`, `conventions`, `pitfalls`) |
| `ew-brainstorm` | `workflow-analyzer` (`workflow_analyzer`) / `cli-explore-agent` | Optional codebase grounding & bounded option trade-off check |
| `ew-grill` | `cli-explore-agent` (`cli_explore_agent`) | Read-only codebase grounding & terminology discovery |
| `ew-blueprint` | `cli-explore-agent`, `workflow-external-researcher`, `workflow-research-synthesizer`, `workflow-integration-checker` | Discovery grounding, external research synthesis, and P6 interface readiness |
| `ew-roadmap` | `cli-explore-agent`, `workflow-roadmapper` | Boundary exploration & Session DAG decomposition/review |
| `ew-analyze` | `cli-explore-agent`, `workflow-external-researcher`, `workflow-research-synthesizer`, `workflow-analyzer` | L1–L3 code anchors, research handoff, and multi-perspective scoring |
| `ew-plan` | `cli-explore-agent`, `workflow-planner`, `workflow-collab-planner`, `workflow-plan-checker` | Exploration, single/`2+1` task decomposition, and 3-round plan validation |
| `ew-execute` | `workflow-executor` (`workflow_executor`) | Wave-parallel atomic task implementation & convergence check |
| `ew-verify` | `workflow-verifier`, `workflow-integration-checker` | Goal-backward 3-layer verification & cross-module integration audit |
| `ew-test` | `workflow-nyquist-auditor` (`workflow_nyquist_auditor`) | Coverage & test-plan gap audit (plus `browser` subagent for `--frontend-verify`) |
| `ew-auto-test` | `workflow-nyquist-auditor`, `workflow-debugger` | Layered L0–L3 test authoring & read-only failure diagnosis |
| `ew-review` | `workflow-reviewer` (`workflow_reviewer`) | Single-dimension read-only audit (`correctness`/`security`/`performance`/`architecture`) |
| `ew-debug` | `workflow-debugger` (`workflow_debugger`) | Isolated hypothesis investigation & 3-strike root-cause diagnosis |
| `ew-retrospective` | `workflow-analyzer` (`workflow_analyzer`) | Parallel 4-lens read-only retrospective (`technical`/`process`/`quality`/`decision`) |
| `ew-companion` | `workflow-executor` (`workflow_executor`) | Optional scoped subagent for bounded single-concern execution |
