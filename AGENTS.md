# Self-Evolving Workflow

For this repository, the Knowledge Gate and Workflow Routing below take precedence over host-wide defaults for knowledge lookups and Session/Run control. The Agent Memory lookup here fulfills inherited knowledge-search requirements for this repository.

## Guardrails & Engineering Standards

- **Minimize changes** — modify only what the task requires; no drive-by refactors, formatting, cleanups, or scope growth.
- **No unsolicited documentation** — NEVER generate reports, summaries, or documentation files unless the active command requires them (a Run's `report.md` or a declared typed output).
- **Join your subagents** — every subagent you spawn must be joined, stopped, or cancelled before your scope ends; never fire-and-forget.
- **Fix root causes, don't hide them** — no skipped tests, `@ts-ignore`, empty catches, `as any`, or padded timeouts to silence failures; trace root causes, check adjacent code for the same defect, and stop after 3 failed attempts to reassess.
- **No direct knowledge writes** — never write `wiki/entries/` or legacy `.workflow/specs/` / `.workflow/knowhow/` files directly; use the governed `evolve kb` (or `evolve kb candidates publish`) commands in the knowledge route.
- **Verify before claiming completion** — support completion claims with actual check results; fix clear in-scope errors before reporting, stop once acceptance criteria pass, and explicitly state any checks not run or blockers.
- **Keep audit metadata in chat/reports only** — in final chat replies, concisely state outcome, verification evidence (including unverified limits), and any decisions needing user judgment; NEVER leak QA ledgers, test status codes, or defensive disclaimers into manuscript prose.
- **Simplicity & compatibility** — design data structures first, keep single-responsibility functions with shallow nesting, preserve backward compatibility, follow existing codebase conventions/tooling, and separate abstraction layers without duplicating content across them.
- **Before implementing** — study 3+ existing similar patterns, map integration points, decompose complex work (>3 modules or >5 subtasks), and use `write_file` / shell text replacement as fallback if `edit_file` fails 2+ times on the same file.

## Knowledge Gate (required)

Search project knowledge before inspecting, analyzing, planning against, or changing project files. Start with a query of 1–3 task-specific keywords. Run the knowledge lookup before `git status`, `rg`, file reads, or other project exploration.

| Task context | Required opening |
| --- | --- |
| Standalone task | In this checkout, run `node dist/workflow-cli.js search "<query>" --mode context [--format compact]` as the first project-related tool call. The installed equivalent is `evolve search "<query>" --mode context [--format compact]`. |
| New Evolve Run | Inspect the Run packet. Open bound `session-priors` when it covers the current scope. Otherwise, use `evolve search "<query>" --mode context --reads "<run-dir>/knowledge-reads.json"` and open governing or truncated hits with `evolve kb get <id|q-N:idx>... --reads "<run-dir>/knowledge-reads.json"` (or `--pick <n,...>`, auto-linking `from_search_id`; `--from-search <search-id|q-N>` overrides explicitly) before exploring the project. |
| Resumed Evolve Run | Recover the packet with `evolve run get <run-id> --session <session-id>`, then resolve project knowledge before resuming exploration. Reuse complete entries already in context and reload any entry represented only by an ID or summary. |

For a CLI lookup in a Run, use `evolve search "<query>" --mode context --session <session-id> --reads "<run-dir>/knowledge-reads.json"`. Add `--task` or `--path` when that scope is known. Use one receipt source per Run. Code search with `evolve code search <query>` is available after the opening lookup.

- Search returns single-line compact JSON by default (`--format compact` for terse plain text, `--verbose` for full fields and `commands` templates), using collision-safe short prefix IDs (and top-level `search_id` `q-N` + `idx` when `--reads` is passed), inline `content` for bodies `<= 300` chars or `snippet` + `truncated: true` for longer entries, and a `20`-item / `4000`-char `constraints` budget (`constraints_notice` indicates overflow).
- Inspect applicable constraints and truncated hits with `evolve kb get <id|q-N:idx>... --resolved` or `evolve kb get --pick <n,...>` (supports short prefixes, batch IDs across Wiki/memory/code symbols). In a Run, reusing the same `--reads` receipt auto-links `from_search_id` (explicit `--from-search <search-id|q-N>` still works).
- Refine an empty or irrelevant query before exploring. Proceed after inspecting a successful zero-result response to the refined query. Follow any initialization or recovery hint and retry. Re-query when the task enters a new subsystem, an approach needs a decision, or the same fix fails twice.
- Seal verified outputs and evidence through Evolve. Follow [ew-knowledge](skills/ew-knowledge/SKILL.md) to stage reusable findings via `evolve kb harvest` (`session` / `conversation` / `skill`) or `evolve kb add --kind episodic`. Review candidates before promotion. Zero candidates is a valid outcome. Keep previous project knowledge directories as migration inputs.
- Reserve [Workflow Evolve](skills/workflow-evolve/SKILL.md) (`disable-model-invocation: true`) strictly for explicit `/workflow-evolve` runs that modify Skill/harness behavior (`skills/<id>/SKILL.md`), never for ordinary task execution or routine code/test failures. Only mention `/workflow-evolve` at closeout when `evolve_reminder` or repeated corrections (`>= 2`) clearly point to a Skill/process gap.

## Memory Recording

- Record useful working evidence as `--kind episodic` during execution. On the first confirmed misunderstanding or user correction, save the mistaken interpretation, the correction and its basis before continuing work that depends on it; do not wait for repeated corrections or task completion.
- Also record key evidence that changes a judgment or rules out a hypothesis, confirmed requirements and decisions with their rationale, informative failed approaches with their conditions, non-obvious verified methods, and blockers needed for handoff. Evidence can be recorded before the root cause is known; label unresolved conclusions as unverified.
- Each memory must be independently understandable: include the subject, applicable project/version/environment, observation or decision, evidence/source references and verification state. Distinguish user decisions, suggestions, tool observations and Agent inferences; omit fragments, routine progress and unsupported causes. Use `correction`, `work_fact`, `error` or `verified_fix` as appropriate; reserve `verified_fix` for a demonstrated fix.
- Search for an existing memory before adding one. Update the same subject when conclusions change, preserve supporting sources, and state what is superseded or still unresolved. Omitting `--evidence` preserves existing source IDs; supplying it replaces the source list, so repeat `--evidence` for every old and new reference that should remain. Keep project-specific evidence in project scope; do not silently turn it into a global rule.
- Before context compaction, handoff and task closeout, check that material findings and unresolved state were saved. Background extraction and reminders are fallback mechanisms. Confirm the write result and read back the record with `evolve kb get <id>` before claiming it was saved.

## Wiki Recording

- Propose Wiki knowledge when a reusable method, reference or constraint has sufficient evidence and a stable applicability scope. During a Run, stage findings and evidence in its required outputs/report; after the whole Session completes, run its returned `closeout_command`. For a standalone task, harvest the actual host conversation. Do not wait until closeout to save important working memory.
- Compare candidates with existing entries before proposing additions, updates or retirements. Keep suggestions, unresolved hypotheses and one-off task state in working memory; do not promote them as established Wiki knowledge.
- `kb harvest` generates review candidates; an exact duplicate may only supplement sources through governance. `kb propose` stages a change without publishing it. Inspect the concrete change and apply it only within explicit human authorization for its IDs, targets and action; otherwise retain it for review. Follow `evolve skill workflows show ew-knowledge` for publication and conflict handling.

## Key Knowledge Commands

| Command | Purpose and timing |
| --- | --- |
| `evolve search "<keywords>" --mode context [--format compact]` | Before project exploration or a change of scope, retrieve constraints, references, memories and code (short IDs; `<= 300` chars inline, longer `snippet` + `truncated: true`). |
| `evolve kb get <id|q-N:idx>...` / `evolve kb sources <memory-id>` | Batch-read complete record(s) or code symbol slices by short prefix, `q-N:idx`, or `--pick <n,...>`; trace memory provenance to original messages. |
| `evolve kb add "<memory>" --kind episodic --type <type> --scene <step> --session <session-id> --evidence <source-ref>` | Save an in-flight memory immediately; include real evidence references, not invented IDs. |
| `evolve kb update <memory-id> "<revised memory>" --kind episodic` | Revise content while retaining original provenance. To replace sources, add repeated `--evidence <source-ref>` flags containing the full desired source list. |
| `evolve kb delete <memory-id> --kind episodic` | Remove an exact memory when explicitly requested; do not use it to hide failed attempts. |
| `evolve kb harvest session <session-id> --project <project-id>` | After Evolve Session completion, collect evidence-backed Wiki candidates; prefer the returned `closeout_command`. |
| `evolve kb harvest conversation <conversation-id> --host <host> --project <project-id>` | Collect candidates after a standalone task using its actual conversation ID and host (`codex`, `claude` or `agy`). |
| `evolve kb candidates show <receipt-id> --project <project-id>` | Inspect candidates using `receipt_id` from the harvest result and the same `--project` value. |
| `evolve kb propose <change.json> --evidence <source-ref>` / `evolve kb changes <change-id>` | Stage and inspect a governed Wiki change; neither command publishes it. |
| `evolve kb apply <change-id>` | Publish the inspected Wiki change after authorization, then read back the affected entry and change receipt. |

Use canonical full IDs returned by `kb get` for formal mutations (`propose` / `apply`) and the intended project root (`--root <project-root>`). In a Run, pass the same `--reads "<run-dir>/knowledge-reads.json"` to searches and `kb get` (reusing `--reads` auto-links `from_search_id` for `q-N:idx`, `--pick`, and prefix IDs; `--from-search <search-id|q-N>` overrides explicitly) and bind searches with `--session <session-id>`. Reads default to local project + global knowledge; writes default to project. Consult `evolve kb --help` for additional options.

## Workflow Routing

| Intent | Entry | Invocation & Scope |
| --- | --- | --- |
| Ordinary orchestration, single-pass `ew-review`, bounded in-chain `ew-debug` (`<= 2` modules), and `--goal` chains | [ew-orchestrate](skills/ew-orchestrate/SKILL.md) | Auto-routable or explicit `/ew-orchestrate`; use for single-concern `ew-companion` or typed Session/Run chains |
| Knowledge governance, closeout, Wiki review, and legacy knowledge (`.workflow/`) migration | [ew-knowledge](skills/ew-knowledge/SKILL.md) | Auto-routable or explicit `/ew-knowledge`; standalone knowledge lifecycle and `kb candidates route` handoff |
| Multi-iteration audit, bug-hunt, architecture deepening, defensive/security, or UI campaign | [ew-odyssey](skills/ew-odyssey/SKILL.md) | **Explicit `/ew-odyssey` invocation only** (`disable-model-invocation: true`); includes `--mode arch` (architecture deepening); `ui` mode loads `ew-impeccable` context & `craft-floor.md` |
| Parallel ACO exploration and scoring | [ew-swarm](skills/ew-swarm/SKILL.md) | **Explicit `/ew-swarm` invocation only** (`disable-model-invocation: true`); multi-ant ACO exploration |
| Frontend design, UI rebuild, single-pass UI audit, or finish polish | [ew-impeccable](skills/ew-impeccable/SKILL.md) | Auto-routable or explicit `/ew-impeccable`; single-round frontend/UX work (`shape` feeds `ew-plan`) |
| Throwaway logic/state or multi-variant UI prototyping to settle open design questions | [ew-prototype](skills/ew-prototype/SKILL.md) | Auto-routable or explicit `/ew-prototype`; standalone `session-mode: none` (`references/logic.md` / `references/ui.md`; fold winner, archive variants on `prototype/<name>`) |
| Skill authoring, Skill package migration, and package validation | [ew-skill-design](skills/ew-skill-design/SKILL.md) | Auto-routable or explicit `/ew-skill-design`; structural Skill work and `kb candidates route` `skill-design` handoff |
| Session/Run, artifact and recovery commands | [Evolve controller](skills/ew-orchestrate/references/orchestrator-run-loop.md) | Reference (`evolve skill workflows show session-run`) |
| Historical review and Wiki governance rules | [ew-knowledge route](skills/ew-knowledge/references/knowledge-route.md) | Reference (`evolve skill workflows show ew-knowledge`) |
| Evidence-driven Skill / harness improvement | [Workflow Evolve](skills/workflow-evolve/SKILL.md) | **Explicit `/workflow-evolve` invocation only** (`disable-model-invocation: true`); modifies Skill packages only (never auto-invoked during normal tasks) |
| Host subagent & external `evolve agent` delegation | [Agent usage](skills/ew-orchestrate/references/agent-usage.md) | Reference (`evolve skill workflows show agent-usage`; `evolve agent --help`) |

From this source checkout, build with `npm run build`. The executable is `node dist/workflow-cli.js` (`evolve`, including `evolve skill review|draft|replay|apply|rollback`). Public command groups are `search`, `kb`, `code`, `session`, `run`, `agent`, and `skill`.

# 中文回复准则

- 所有回复使用简体中文，保留英文技术术语、代码变量名、文件/命令路径与错误日志（代码注释使用中文）。
- 中英文/数字间加空格，使用中文标点，代码与命令使用反引号。
- Git Commit 使用中文提交信息，格式：`类型: 简短描述`（`feat/fix/refactor/docs/test/chore`）。
