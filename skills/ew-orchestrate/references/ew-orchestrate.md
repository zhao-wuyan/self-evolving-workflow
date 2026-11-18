# Evolve chain catalog

Match the intent to the smallest Evolve chain that can produce and verify the requested result. Confirm the boundary, completion criteria, and required handoffs before opening the Session. The execution guide owns dispatch and recovery.

## Exact-Match Short-Circuits

- **`status` / `状态` / `dashboard`** -> **Read-only short-circuit (no chain creation, routes directly to `END`)**: run `evolve session get --session <id>` (or `evolve session list --status open`), present the result, and stop for user input without inferring or launching a chain.
- **`continue` / `next` / `go` / `继续` / `下一步`** -> Run `evolve session list --status open`:
  - **1 compatible open Session** (an open Session whose `objective`, `boundary_contract`, and pending/active chain cover the request without topic mismatch) -> resume it (`S_CONTINUE` / `nextAction`).
  - **>1 open Sessions** -> ask the user which `session_id` to continue (`S_FALLBACK`); never select by historical memory similarity.
  - **0 open Sessions (Cold-start fallback)**: check `.git` (`HEAD`), `.evolve/`, `wiki/`, and `.codegraph/`:
    - If not yet a Git repository with a committed `HEAD` (**pre-Git bootstrap**), run `git init`, `evolve skill install --scope project --yes`, and commit Skill packages to `HEAD` before opening an `ew-init` Session;
    - If Git exists but `.evolve/` / `wiki/` / `.codegraph/` are uninitialized, route to `ew-init`;
    - If a bound `current-roadmap` / `current-blueprint` exists, propose the first pending Session/spec scope;
    - Otherwise route through `ew-analyze` / `ew-plan` or ask what to build (`S_FALLBACK`).

## Semantic Intent -> Route Matrix

| Intent | Exact Route | Prerequisites & Thresholds |
| --- | --- | --- |
| Read-only Q&A, factual lookup, status check, or standalone task in a non-Evolve project | `END` (no Session) | Zero repository mutations, or project has not opted into Evolve Session/Run orchestration |
| Small bounded edit + direct verification (1 concern, <=2 files) | `ew-companion` | Evolve-managed workspace (or explicit `/ew-orchestrate`); no downstream typed artifact or gate |
| Initialize or onboard project (greenfield / brownfield / legacy) | `ew-init` → `ew-roadmap` or `ew-blueprint` | Skip interactive Q&A when `--from` supplies `upstream-context` |
| Explore open alternatives or compare approaches | `ew-brainstorm` | Proposes continuation only when durable artifacts are needed |
| Pressure-test an idea/proposal against codebase reality | `ew-grill` | Grounded Socratic branches; runs before `ew-brainstorm` / `ew-plan` |
| Formal multi-phase spec package (Brief -> PRD -> Arch -> Epics) | `ew-blueprint` | Pure spec outputs; feeds `ew-roadmap` or `ew-plan` |
| Decompose multi-release requirements into a Session DAG | `ew-roadmap` | Only split >1 Session when hard runtime coupling holds |
| Investigate codebase or analyze existing plan (`-q`, macro, `--gaps`) | `ew-analyze` | Pass `-q` for fast decision extraction; `--gaps` for backlog gaps |
| Plan or revise an implementation (`--gaps`, `--tdd`, `--revise`) | `ew-plan` | Produces `current-plan`; use `--gaps` after failed review/verify/debug/test |
| Execute an existing confirmed `current-plan` | `ew-execute` | Requires bound `current-plan` (if missing, run `ew-plan` first or `ew-companion`) |
| Implement or refactor with known scope (`>2` files) | `ew-analyze -q` (if impact unclear) → `ew-plan` → `ew-execute` → `ew-verify` → `ew-review` | Omit `ew-analyze -q` when scope and patterns are already settled |
| Independently verify requirement & wiring coverage | `ew-verify` | **Requires bound `current-plan` + `current-execution`** (`required: true`) |
| Run conversational UAT, `--smoke`, or `--frontend-verify` browser check | `ew-test` | Behavioral acceptance + UAT; consumes verification, execution, or review |
| Generate and converge layered automated tests (`L0->L3`) | `ew-auto-test` | Suites missing or low coverage; distinct from UAT/browser acceptance |
| Audit diff, file/dir, or `current-execution` across 4 quality dimensions | `ew-review` | Works standalone (`HEAD`/`staged`/path) OR inside a Session after `ew-execute` |
| Diagnose broken behavior inside an orchestration chain (`<= 2` modules) | `ew-debug` → `ew-plan --gaps` → `ew-execute` → `ew-verify` | Single bounded root-cause isolation (`latest-debug` / `latest-fix-directions`); `>= 3` modules escalate via `S_DECOMPOSE` |
| Heavyweight multi-iteration audit, bug-hunt, or security campaign | `ew-odyssey --mode <debug\|improve\|planex\|review\|security\|defensive\|ui>` (`ew-odyssey-<mode>`) | **Explicit user `/ew-odyssey` invocation only** (`disable-model-invocation: true`); multi-iteration loop across subsystems/campaigns |
| Post-execution four-lens retrospective | `ew-retrospective` | Consumes sealed execution/verification/review artifacts |
| UI design, rebuild, single-pass audit, or finish polish | `ew-impeccable` | Auto-routable for UI work. Terminal polish/refinement commands finish directly; `shape` outputs a conversational design brief feeding `ew-plan` → `ew-execute` → `ew-test --frontend-verify` (multi-iteration UI campaigns require explicit `/ew-odyssey --mode ui`) |
| Explore and score competing hypotheses/paths in parallel | `ew-swarm` | **Explicit user `/ew-swarm` invocation only** (`disable-model-invocation: true`); multi-ant ACO exploration |
| Analyze & fix a tracked issue (from user's tracker ID/context) | `ew-analyze --gaps` → `ew-plan --gaps` → `ew-execute` → `ew-verify` | Keep issue reference in tasks; update tracker only with user authorization |
| Knowledge Gate lookup inside an active Run | `evolve search "<query>" --mode context` / `evolve kb get <id>` with CLI `--reads` | Keep Run evidence bound inside `{run_dir}`; do not spawn `ew-knowledge` |
| Post-seal closeout harvesting, Wiki publish/audit, memory sync, legacy `.workflow/` import | `ew-knowledge` (`evolve skill workflows show ew-knowledge`) | Run after `session complete` or on standalone knowledge requests |
| Modify Skill packages / Harness behavior (`skills/<id>/SKILL.md`) | `workflow-evolve` | **Explicit user `/workflow-evolve` invocation only** (`disable-model-invocation: true`); never auto-invoked during task execution |
| Rebuild code index / install Skills / Git worktree | `evolve code build` / `evolve skill install` / `git worktree` | Direct CLI or authorized repo operations |

## Validation & Continuation Rules

1. Follow [Run loop and recovery](orchestrator-run-loop.md) for `evolve skill validate <command>` and Git `HEAD` preflight before building chains (`ew-knowledge` runs with `session-mode: none`).
2. Pass concrete step arguments cleanly (Runtime supplies `session_id` in every Run packet and expands `{intent}` / positional `{session}` in `run.task.args`; do not invent `--session` flags on step skills); use target scope, issue, or Session IDs instead of legacy milestone/phase numbering.
3. Under `--goal <goal>`, map `<goal>` to `Session.objective` and derive `--definition-of-done`, `--boundary-contract`, and `--goals` JSON on `evolve session create` (see [planning.md](planning.md) and [auto-policy.md](auto-policy.md)), carrying `--goal-ref` and `--decision-only --decision-ref <gate>` checkpoints where coordinator verdicts are required.
