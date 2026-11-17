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
- [Run loop and recovery](references/orchestrator-run-loop.md) — fenced `evolve` CLI dispatch, MCP/CLI reads, and recovery.
- [Companion route](references/companion-route.md) — bounded `ew-companion` fast path.
- Steps (loaded when dispatched): [ew-companion](steps/ew-companion/SKILL.md), [ew-init](steps/ew-init/SKILL.md), [ew-brainstorm](steps/ew-brainstorm/SKILL.md), [ew-grill](steps/ew-grill/SKILL.md), [ew-blueprint](steps/ew-blueprint/SKILL.md), [ew-roadmap](steps/ew-roadmap/SKILL.md), [ew-analyze](steps/ew-analyze/SKILL.md), [ew-plan](steps/ew-plan/SKILL.md), [ew-execute](steps/ew-execute/SKILL.md), [ew-verify](steps/ew-verify/SKILL.md), [ew-test](steps/ew-test/SKILL.md), [ew-auto-test](steps/ew-auto-test/SKILL.md), [ew-review](steps/ew-review/SKILL.md), [ew-debug](steps/ew-debug/SKILL.md), [ew-retrospective](steps/ew-retrospective/SKILL.md).
</deferred_reading>

<purpose>
Route a user intent to the lightest sufficient execution path. For durable multi-step or verifiable edit work, open one canonical topic Session (`evolve session open`) and drive it through the shared Run loop (`orchestrator-run-loop.md`). Standalone knowledge governance, closeout harvesting, Wiki publication, and legacy migration route to `ew-knowledge` (`evolve workflows show knowledge`).
</purpose>

## Routing Boundaries

<goal_long_chain>
`--goal <goal>` selects long-chain mode. Read `references/auto-policy.md` (and `references/goal.md` when `--amend` is present) to derive `boundary_contract` and observable `goals` persisted on `evolve session open` (`--boundary-contract`, `--goals`, `--goal-mode`, `--auto`), binding `post-goal-audit` before `session complete`. Child steps under `steps/` remain steps of this Session rather than standalone Skill invocations.
</goal_long_chain>

<companion_route>
Any bounded, mechanically clear task that **modifies workspace files or runs state-changing verification** with a single focus and no typed handoff uses `references/companion-route.md` (`ew-companion` on the canonical Session/Run lifecycle), escalating to `ew-analyze`/`ew-plan`/`ew-execute`/`ew-verify`/`ew-review` if scope expands or self-check fails. Pure read-only Q&A or status/CLI queries exit via `END` without opening a Session.
</companion_route>

## Public Flags & Host Mapping

- `-y` — auto-confirm low-risk classification and proposals; NEVER bypasses high risk, confidence < 60, ambiguity requiring user input, failed gates, or drift escalation (and NEVER authorizes Wiki publication).
- `-c` — continue the unique live compatible Session (ask if 0 or >1 match).
- `--resume <session-id>` — resume exact Session via `evolve session status` / `evolve run brief`.
- `--auto` — sets `policy.auto_mode` (`continuation.authority = automatic`) with bounded retries (`--retry-max`) and recovery policy (`auto-policy.md`).
- `--goal <goal>` — durable outcome-driven chain (`--goal-mode`, `auto-policy.md`).
- `--amend` — amend live Session goal (`references/goal.md`, appends `CHG-NNN`).
- **Host capabilities**: map subagent/parallel steps to native tools: Antigravity `invoke_subagent` / `swarm` / `run_workflow`; Codex `spawn_agent` / `wait_agent`; OMP `task` or eval `agent()`. Join or cancel every spawned child before advancing or ending. User prompts map to Antigravity `ask_question`, Codex `request_user_input`, or OMP `ask`; progress mirrors use Codex `update_plan` or OMP `todo`. Web/browser acceptance uses the available host search/browser tools, Playwright, or Chrome DevTools.

### OMP native delegation and strict CLI analysis

- Use `scout` for research, `reviewer` for review, and `task` for implementation. For independent slices, batch `{ context, tasks: [{ agent, task, solutionSpace, ... }] }`; shared background belongs in `context`, agent/model selection in each item. Eval `agent()` is the equivalent handle-based path (read `xd://eval/agents` before using it); join handles at dependency barriers or cancel them before ending scope.
- Results auto-deliver; continue useful independent work after spawning. Never poll agent/job status or output. When completely blocked, use the host `wait`; collect all results before synthesis. `ask` handles user decisions; `todo` mirrors progress only, never replaces the canonical Session/Run state.
- Agent responsibilities are not OS permissions. Native `scout`/`reviewer` instructions and `tools` lists do not establish strict read-only isolation or prove that additional MCP tools are excluded. In particular, task/eval `tools` names share parent eval-defined tools; they are not a denylist for ambient MCP.
- When strict analysis is required, use a separate `evolve delegate` process, not a native child or Plan mode:

  ```sh
  evolve delegate "<prompt>" --to omp --mode analysis|write [--role <name>] [--model <selector>] [--timeout <seconds>] [--session <id> --run <id>]
  ```

  Default mode is `analysis`; default model roles are `analysis=@plan` and `write=@task`. Explicit `--model` takes precedence over `--role`. Roles only select models: they neither enter Plan mode nor authorize operations. Default timeout is 600 seconds; `OMP_EXECUTABLE` overrides the executable. OMP's `--trusted-extension` loads Evolve's bundled SDK bridge without an additional OMP npm dependency, community sandbox, or container.
- The analysis bridge exposes only `read`/`grep`/`glob` plus the six bound Run knowledge tools when bound: `evolve_read_skill`, `evolve_read_artifact`, `evolve_wiki_context`, `evolve_wiki_reference`, `evolve_memory_search`, `evolve_memory_get`. No `bash`, `eval`, `write`, `task`, or ambient MCP. Write mode exposes only read/write tools, `bash`, and `lsp` (plus bound Run knowledge tools); it does not override user approvals or enable yolo. Native child roles are not substitutes for this boundary.
- Pass `--session <id> --run <id>` together for bound Codex or OMP delegation; Agy remains standalone without those flags. Existing Codex defaults remain unchanged. Examples selecting Codex in step guides remain valid; OMP is an additional explicit executor, not a global replacement.
- A second opinion must explicitly select an operator-authorized model (`--model <selector>` for OMP, or a supported authorized host selector), different from the original model when claiming independent cross-model verification. Same-model subagents provide another perspective, not independent-model validation; never silently substitute them or create agent definitions/user configuration to gain authorization.

<invariants>
1. **One chain** — one canonical Session/Run protocol; no executor-specific Session types.
2. **Session before execution** — `evolve session open` precedes allocating any step Run (except read-only `END` queries or pre-Git bootstrap).
3. **Creator owns decomposition** — Evolve persists `boundary_contract` and outcome `goals` on the Session; downstream steps consume without overwriting.
4. **Runtime owns mutation** — never edit SQLite/protocol state directly or bypass fenced CLI/MCP commands.
5. **Coordinator proposal & gate discipline** — chain updates follow Run `report.md` `next` (`chain-proposal/1.0`, validated at Run completion) and fenced `evolve session chain insert|replace|skip` + `evolve run decide`. Decision-gate thresholds (`CONFIDENCE_SCORE < 60`, `REGROUND_HALT`) are enforced by the coordinator alongside Runtime `--confidence` / `--target-step` validation.
6. **Verdict advances** — advance execution steps only via fenced `evolve run complete ... --verdict done|done_with_concerns`, and decision steps via fenced `evolve run decide` (exact CLI syntax in `orchestrator-run-loop.md`).
7. **Historical similarity is read-only** — never selects a Session or binds outputs.
8. **Auto is bounded** — `-y` never skips high risk, low confidence, ambiguity, failed gates, or drift halts.
9. **Running means continue** — when `continuation.authority` is `automatic`, execute the next action and re-read the receipt in the same turn without ending on soft warnings.
</invariants>

<state_machine>
```text
S_PARSE:
  -> S_AMEND    WHEN --amend                  (follow references/goal.md)
  -> S_CONTINUE WHEN --resume <id> OR -c      (resolve live Session; stuck/blocked Run -> S_RECOVER)
  -> S_CLASSIFY WHEN intent present           (follow references/ew-orchestrate.md + planning.md)
  -> S_FALLBACK OTHERWISE                     (ask for intent / disambiguation)

S_CLASSIFY:
  -> S_RUN_LOOP  WHEN existing compatible open Session found (or `status` read-only short-circuit)
  -> END         WHEN pure read-only Q&A or info lookup modifying no files
  -> S_COMPANION WHEN single-focus change/check needs no typed handoff or decision gate (references/companion-route.md)
  -> S_DECOMPOSE -> S_CREATE WHEN multi-step/broad (>=3 modules or cross-package or >=2 open scope/constraint/DoD questions)
  -> S_CREATE    WHEN narrow/single-step chain needing typed artifact/gate
  -> S_FALLBACK  WHEN confidence < 60

S_CREATE -> S_RUN_LOOP WHEN -y AND risk != high AND confidence >= 60 (else S_CONFIRM)
S_CONFIRM -> S_RUN_LOOP (confirmed) | S_CLASSIFY (revised) | END (cancelled)
S_COMPANION -> END (verified) | S_CLASSIFY (scope expands / self-check fails)
```
</state_machine>

<task_tracking>
Keep any host UI plan mirrored (never authoritative over SQLite Session state): initialize steps after `session open`, mark `in_progress` on `run next`, `completed` on `run complete`, and record failure reason on `run transition failed`.
</task_tracking>

<success_criteria>
- Classification is auditable (`ew-orchestrate.md`) and Session exists before step execution.
- Steps execute via `run next`, seal via `run complete`, decide via `run decide`, and recover via `run check` / `run brief` / `run transition`.
- Chain amendments use fenced `session chain insert|replace|skip`; post-session closeout and Wiki governance hand off to `ew-knowledge`.
</success_criteria>
