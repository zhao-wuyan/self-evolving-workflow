---
name: ew-orchestrate
description: Route, initialize, brainstorm, grill, blueprint, roadmap, analyze, plan, execute, verify, test, debug, review, retrospect and recover work over one canonical Session/Run chain
argument-hint: <intent> [--goal <goal>] [--auto] [--resume <session-id>] [-y] [-c] [--amend]
session-mode: run
contract:
  discovery: self-described
  consumes: []
  produces: []
version: 0.7.1
---

<deferred_reading>
- [Chain catalog](references/ew-orchestrate.md) — initial intent classification, cold-start fallback, and step thresholds.
- [Planning and chain creation](references/planning.md) — Session chain creation, readonly status short-circuit, and decomposition.
- [Automatic & goal policy](references/auto-policy.md) — `--auto` and `--goal` long-chain stage mapping, decision gates, and retry guards.
- [Goal amendment](references/goal.md) — `--amend` pending-tail change protocol.
- [Boundary grill](references/boundary-grill.md) — embedded mini-review protocol for scope, module, and locked-decision conflicts.
- [Run loop and recovery](references/orchestrator-run-loop.md) — fenced `evolve` CLI dispatch, CLI reads, host mapping, and recovery.
- [Companion route](references/companion-route.md) — bounded `ew-companion` fast path.
- Steps (loaded when dispatched): [ew-companion](steps/ew-companion/SKILL.md), [ew-init](steps/ew-init/SKILL.md), [ew-brainstorm](steps/ew-brainstorm/SKILL.md), [ew-grill](steps/ew-grill/SKILL.md), [ew-blueprint](steps/ew-blueprint/SKILL.md), [ew-roadmap](steps/ew-roadmap/SKILL.md), [ew-analyze](steps/ew-analyze/SKILL.md), [ew-plan](steps/ew-plan/SKILL.md), [ew-execute](steps/ew-execute/SKILL.md), [ew-verify](steps/ew-verify/SKILL.md), [ew-test](steps/ew-test/SKILL.md), [ew-auto-test](steps/ew-auto-test/SKILL.md), [ew-review](steps/ew-review/SKILL.md), [ew-debug](steps/ew-debug/SKILL.md), [ew-retrospective](steps/ew-retrospective/SKILL.md).
</deferred_reading>

<purpose>
Route a user intent to the lightest sufficient **task execution** path. For durable multi-step or verifiable edit work in an Evolve-managed project (or when explicitly invoked via `/ew-orchestrate`), open one canonical topic Session (`evolve session create`) and drive it through the shared Run loop (`orchestrator-run-loop.md`). Standalone knowledge governance, closeout harvesting, Wiki publication, and legacy `.workflow/` migration route to `ew-knowledge` (`evolve skill workflows show ew-knowledge`). Modifying Skill packages / Harness behavior itself belongs strictly to explicit `/workflow-evolve` (`disable-model-invocation: true`), never auto-invoked inside task execution.
</purpose>

## Routing Boundaries

<goal_long_chain>
`--goal <goal>` selects long-chain mode. Read `references/auto-policy.md` (and `references/goal.md` when `--amend` is present) to map `<goal>` to `Session.objective` and derive `--definition-of-done`, `boundary_contract`, and observable `goals` persisted on `evolve session create` (`--boundary-contract`, `--goals`, `--goal-mode`, `--auto`), binding `post-goal-audit` before `session complete`. Child steps under `steps/` remain steps of this Session rather than standalone Skill invocations.
</goal_long_chain>

<companion_route>
Inside an Evolve-initialized workspace (or an explicit `/ew-orchestrate` task), any bounded, mechanically clear task that **modifies workspace files or runs state-changing verification** with a single focus (`<= 2` files) and no typed handoff uses `references/companion-route.md` (`ew-companion` on the canonical Session/Run lifecycle), escalating in the same Session (`run cancel` -> `session step delete` -> `session step add` for `ew-analyze`/`ew-debug` -> `ew-plan` -> `ew-execute` -> `ew-verify`/`ew-review`) if scope expands or self-check fails. Pure read-only Q&A, status/CLI queries, and standalone edits in projects that have not adopted Evolve Session/Run orchestration exit via `END` without opening a Session.
</companion_route>

## Public Flags & Host Mapping

- `-y` — auto-confirm low-risk classification and proposals; NEVER bypasses high risk, confidence < 60, ambiguity requiring user input, failed gates, or drift escalation (and NEVER authorizes Wiki publication).
- `-c` — continue the unique live compatible open Session via `evolve session list --status open` (if 0 match, run cold-start fallback; if >1 match, ask the user to select).
- `--resume <session-id>` — resume exact Session via `evolve session get` / `evolve run get`.
- `--auto` — sets `policy.auto_mode` (`continuation.authority = automatic`) with bounded retries (default `--retry-max 3` attached via `session step add|replace`) and recovery policy (`auto-policy.md`).
- `--goal <goal>` — durable outcome-driven chain (`--goal-mode`, `auto-policy.md`); `<goal>` becomes `Session.objective` and drives `--definition-of-done`, `--boundary-contract`, and `--goals` JSON.
- `--amend` — amend live Session `objective`/`--definition-of-done` and pending-tail chain (`references/goal.md`; Runtime appends `CHG-NNN` automatically).
- **Host capabilities**: use capability-neutral host primitives (parallel/subagent execution with mandatory join/cancel before advancing, structured user prompts, web search, and browser rendering/verification); resolve host-specific tool names via [Host Adapter Mapping](references/orchestrator-run-loop.md#host-adapter-mapping).

### OMP native delegation and strict CLI analysis

- Use `scout` for research, `reviewer` for review, and `task` for implementation. For independent slices, batch `{ context, tasks: [{ agent, task, solutionSpace, ... }] }`; shared background belongs in `context`, agent/model selection in each item. Eval `agent()` is the equivalent handle-based path (read `xd://eval/agents` before using it); join handles at dependency barriers or cancel them before ending scope.
- Results auto-deliver; continue useful independent work after spawning. Never poll agent/job status or output. When completely blocked, use the host `wait`; collect all results before synthesis. `ask` handles user decisions; `todo` mirrors progress only, never replaces the canonical Session/Run state.
- Agent responsibilities are not OS permissions. Native `scout`/`reviewer` instructions and `tools` lists do not establish strict read-only isolation or prove that additional MCP tools are excluded. In particular, task/eval `tools` names share parent eval-defined tools; they are not a denylist for ambient MCP.
- When strict analysis is required, use a separate one-shot `evolve agent exec` process, not a native child or Plan mode:

  ```sh
  evolve agent exec "<prompt>" --to omp --mode analysis|write [--role <name>] [--model <selector>] [--timeout <milliseconds>] [--session <id> --run <id>]
  ```

  Default mode is `analysis`; default model roles are `analysis=@plan` and `write=@task`. Explicit `--model` takes precedence over `--role`. Roles only select models: they neither enter Plan mode nor authorize operations. `--timeout` is milliseconds and defaults to `600000`; `OMP_EXECUTABLE` overrides the executable. OMP's `--trusted-extension` loads Evolve's bundled SDK bridge without an additional OMP npm dependency, community sandbox, or container. This is a one-shot restricted worker, not a managed OMP `start`/`send` session, and it does not support worktrees or `--stream`.
- The analysis boundary exposes only `read`/`grep`/`glob` plus the six bound Run knowledge tools when bound: `evolve_read_skill`, `evolve_read_artifact`, `evolve_wiki_context`, `evolve_wiki_reference`, `evolve_memory_search`, `evolve_memory_get`. These tools use shared in-process execution, not an MCP child process. No `bash`, `eval`, `write`, `task`, or ambient MCP. Write mode exposes only read/write tools, `bash`, and `lsp` (plus bound Run knowledge tools); it does not override user approvals or enable yolo. Native child roles are not substitutes for this boundary.
- Pass `--session <id> --run <id>` together for bound Codex or OMP delegation; Agy remains standalone without those flags. Existing Codex defaults remain unchanged. Examples selecting Codex in step guides remain valid; OMP is an additional explicit executor, not a global replacement.
- This CLI delegation is distinct from the OMP installable plugin: it does not load plugin tools and does not require the plugin to be installed. Plugin packaging and its in-process knowledge tools are a separate distribution surface owned by the OMP plugin branch.
- A second opinion must explicitly select an operator-authorized model (`--model <selector>` for OMP, or a supported authorized host selector), different from the original model when claiming independent cross-model verification. Same-model subagents provide another perspective, not independent-model validation; never silently substitute them or create agent definitions/user configuration to gain authorization.

<invariants>
1. **One chain** — one canonical Session/Run protocol; no executor-specific Session types.
2. **Session before execution** — `evolve session create` precedes allocating any step Run (except read-only `END` queries or pre-Git bootstrap, where an uninitialized directory runs `git init`, `evolve skill install`, and commits Skill packages to `HEAD` before opening an `ew-init` Session).
3. **Creator owns decomposition** — Evolve persists `boundary_contract` and outcome `goals` on the Session; downstream steps consume without overwriting.
4. **Runtime owns mutation** — never edit SQLite/protocol state directly or bypass fenced CLI commands.
5. **Coordinator proposal & gate discipline** — chain updates follow Run `report.md` `next` (`chain-proposal/1.0`, validated at Run completion) and fenced `evolve session step add|update|delete` + `evolve run decide`. Decision gates under `--auto`/`--goal` MUST pass `--confidence <0-100>`; `CONFIDENCE_SCORE < 60` or `REGROUND_HALT` prevents automatic `proceed` and requires `escalate` (or `fix` with explicit target/evidence) alongside Runtime `--confidence` / `--target-step` validation.
6. **Verdict advances** — advance execution steps only via fenced `evolve run complete ... --verdict done|done_with_concerns`, and decision steps via fenced `evolve run decide` (exact CLI syntax and `report.md` verdict mapping in `orchestrator-run-loop.md`).
7. **Historical similarity is read-only** — never selects a Session or binds outputs (Session resolution uses `evolve session list --status open`).
8. **Auto is bounded** — `-y` never skips high risk, low confidence, ambiguity, failed gates, or drift halts.
9. **Running means continue** — when `continuation.authority` is `automatic`, execute the next action and re-read the receipt in the same turn without ending on soft warnings.
</invariants>

<state_machine>
```text
S_PARSE:
  -> S_AMEND    WHEN --amend                  (follow references/goal.md)
  -> S_CONTINUE WHEN --resume <id> OR -c      (resolve live Session)
  -> S_CLASSIFY WHEN intent present           (follow references/ew-orchestrate.md + planning.md)
  -> S_FALLBACK OTHERWISE                     (ask for intent / disambiguation)

# Evaluate S_CLASSIFY guards in exact priority order per references/planning.md:
S_CLASSIFY:
  -> END         WHEN `status` / `状态` / `dashboard` read-only short-circuit (present status and stop)
  -> END         WHEN pure read-only Q&A or info lookup modifying no files
  -> S_CONTINUE  WHEN `continue` / `next` / `go` / `继续` / `下一步`
  -> S_RUN_LOOP  WHEN existing compatible open Session found
  -> S_FALLBACK  WHEN confidence < 60 or target/intent remains ambiguous
  -> S_COMPANION WHEN single-focus change/check (`<= 2` files) needs no typed handoff or decision gate (references/companion-route.md)
  -> S_DECOMPOSE -> S_CREATE WHEN multi-step/broad (`>= 3` modules or cross-package or `>= 2` open scope/constraint/DoD questions)
  -> S_CREATE    WHEN narrow/single-step chain needing typed artifact/gate (or UI design/brief work routing to ew-impeccable)

S_AMEND:
  -> S_RUN_LOOP  WHEN amendment committed and pending chain valid
  -> S_FALLBACK  WHEN 0 or >1 open Sessions match, or goals/boundary change requires user decision
  -> END         WHEN cancelled

S_CONTINUE:
  -> S_RECOVER   WHEN active Run is blocked/stuck/failed
  -> S_RUN_LOOP  WHEN unique compatible open Session has next/decide/complete action
  -> S_CLASSIFY  WHEN 0 open Sessions match (cold-start fallback)
  -> S_FALLBACK  WHEN >1 open Sessions match (ask user to choose)

S_RECOVER:
  -> S_RUN_LOOP  WHEN Run transitioned/cancelled/unblocked or escalate resolved
  -> END         WHEN aborted or escalated awaiting user action

S_CREATE -> S_RUN_LOOP WHEN -y AND risk != high AND confidence >= 60 (else S_CONFIRM)
S_CONFIRM -> S_RUN_LOOP (confirmed) | S_CLASSIFY (revised) | END (cancelled)
S_RUN_LOOP -> END (session complete / closeout via ew-knowledge) | S_RECOVER (Run blocked/failed/retry exhausted/escalated) | S_CONFIRM (high-risk amendment)
S_COMPANION -> END (verified) | S_CLASSIFY (scope expands / self-check fails -> cancel active run if any, `session step delete`, and `session step add` in same Session)
S_FALLBACK -> S_CLASSIFY (intent clarified) | S_CONTINUE (Session selected) | END (cancelled)
```
</state_machine>

<task_tracking>
Keep any host UI plan mirrored (never authoritative over SQLite Session state): initialize steps after `session create`, mark `in_progress` on `run create`, `completed` on `run complete`, and record failure reason on `run transition failed`.
</task_tracking>

<success_criteria>
- Classification is auditable (`ew-orchestrate.md`) and Session exists before step execution.
- Steps execute via `run create`, seal via `run complete`, decide via `run decide`, and recover via `run check` / `run get` / `run transition`.
- Chain amendments use fenced `session step add|update|delete`; post-session closeout and Wiki governance hand off to `ew-knowledge`.
</success_criteria>
