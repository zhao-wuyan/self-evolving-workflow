# Self-Evolving Workflow

For this repository, the Knowledge Gate and Workflow Routing below take precedence over host-wide defaults for knowledge lookups and Session/Run control. The Agent Memory lookup here fulfills inherited knowledge-search requirements for this repository.

## Guardrails & Engineering Standards

- **Minimize changes** — modify only what the task requires; no drive-by refactors, formatting, cleanups, or scope growth.
- **No unsolicited documentation** — NEVER generate reports, summaries, or documentation files unless the active command requires them (a Run's `report.md` or a declared typed output).
- **Join your subagents** — every subagent you spawn must be joined, stopped, or cancelled before your scope ends (except idle `browser` subagents kept open per host rules); never fire-and-forget.
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

- Search returns single-line compact JSON by default (`--format compact` for terse plain text, `--verbose` for full fields and `commands` templates), using collision-safe short prefix IDs (`search_id` `q-N` + `idx` with `--reads`), inline `content` for bodies `<= 300` chars or `snippet` + `truncated: true`, and a `20`-item / `4000`-char `constraints` cap (`constraints_notice` indicates overflow).
- Inspect governing or truncated hits with `evolve kb get <id|q-N:idx>... --resolved` or `--pick <n,...>` (supports short prefixes and batch IDs across Wiki/memory/code symbols). Reusing the same `--reads` receipt auto-links `from_search_id` (`--from-search <search-id|q-N>` overrides explicitly).
- Refine an empty or irrelevant query before exploring; proceed after inspecting a zero-result refined query. Follow any initialization/recovery hint and re-query when entering a new subsystem, facing a design decision, or after 2 failed fixes.
- Persist in-flight lessons via `evolve kb add --kind episodic` or Run `report.md` frontmatter — NEVER run `evolve kb harvest` or `ew-knowledge` closeout mid-task (see **Wiki Recording** and **Key Knowledge Commands**). Keep previous project knowledge directories as migration inputs.

## Memory Recording

- Record useful working evidence as `--kind episodic` during execution. On the first confirmed misunderstanding or user correction, save the mistaken interpretation, correction, and basis before continuing dependent work.
- Also record key evidence ruling out hypotheses, confirmed requirements/decisions with rationale, informative failed approaches with conditions, non-obvious verified methods, and handoff blockers (label unresolved conclusions as unverified).
- Make each memory self-contained: subject, applicable project/version/environment, observation or decision, evidence/source references, and verification state. Distinguish user decisions, suggestions, tool observations, and Agent inferences; omit fragments and unsupported causes. Use `correction`, `work_fact`, `error`, or `verified_fix` (demonstrated fix only).
- Search existing memories before adding; update the same subject when conclusions change, noting what is superseded or unresolved. Omitting `--evidence` preserves existing sources; passing `--evidence` replaces the full list, so repeat all retained refs. Keep project-specific evidence in project scope.
- Check memory completeness before compaction, handoff, or closeout (don't rely on background reminders); confirm the write result and read back with `evolve kb get <id>` before claiming it was saved.

## Wiki Recording

- Propose Wiki knowledge only for reusable methods, references, or constraints with sufficient evidence and stable scope; keep suggestions, unresolved hypotheses, and one-off task state in working memory.
- **Harvest timing**: NEVER run `kb harvest` during execution or between chain steps. Run the returned `closeout_command` only after `evolve session complete` finishes the whole Session, and run `kb harvest conversation` for a standalone task only on explicit user closeout request (`/ew-knowledge`) or confirmed final wrap-up (zero eligible candidates is valid).
- `kb harvest` generates review candidates (exact duplicates only supplement sources via governance). `kb propose` stages a change without publishing it; inspect the diff and run `kb apply` only with explicit human authorization for IDs, targets, and action. Follow [ew-knowledge](skills/ew-knowledge/SKILL.md) / `evolve skill workflows show ew-knowledge` for publication and conflict handling.

## Key Knowledge Commands

| Command | Purpose and timing |
| --- | --- |
| `evolve search "<keywords>" --mode context [--format compact]` | Before project exploration or scope change, retrieve constraints, references, memories, and code. |
| `evolve kb get <id|q-N:idx>...` / `evolve kb sources <memory-id>` | Batch-read full records or code symbol slices; trace memory provenance to original messages. |
| `evolve kb add "<memory>" --kind episodic --type <type> --scene <step> --session <session-id> --evidence <source-ref>` | Save an in-flight memory immediately using real evidence references (never invented IDs). |
| `evolve kb update <memory-id> "<revised memory>" --kind episodic` | Revise content while retaining provenance (add repeated `--evidence` flags only when replacing the source list). |
| `evolve kb delete <memory-id> --kind episodic` | Remove an exact memory only when explicitly requested (never to hide failed attempts). |
| `evolve kb harvest session <session-id> --project <project-id>` | **Post-completion only**: after `evolve session complete` (never mid-chain); prefer the returned `closeout_command`. |
| `evolve kb harvest conversation <conversation-id> --host <host> --project <project-id>` | **Explicit/final closeout only**: after a standalone task fully finishes, using actual conversation ID and host (`codex`, `claude`, or `agy`). |
| `evolve kb candidates show <receipt-id> --project <project-id>` | Inspect candidates using `receipt_id` from harvest output and the same `--project` value. |
| `evolve kb propose <change.json> --evidence <source-ref>` / `evolve kb changes <change-id>` | Stage and inspect a governed Wiki change (does not publish). |
| `evolve kb apply <change-id>` | Publish an inspected Wiki change after authorization, then read back the affected entry and receipt. |

Use canonical full IDs from `kb get` for formal mutations (`propose` / `apply`) and `--root <project-root>` when targeting another root. In a Run, pass the same `--reads "<run-dir>/knowledge-reads.json"` to searches and `kb get`, and bind searches with `--session <session-id>`. Reads default to project + global; writes default to project (`evolve kb --help` for options).

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
| Evidence-driven Skill / harness improvement | [Workflow Evolve](skills/workflow-evolve/SKILL.md) | **Explicit `/workflow-evolve` invocation only** (`disable-model-invocation: true`); modifies `skills/<id>/SKILL.md` only (never for ordinary code/test failures; suggest at closeout only when `evolve_reminder` or `>= 2` repeated corrections/retries expose a Skill/process gap) |
| Host subagent & external `evolve agent` delegation | [Agent usage](skills/ew-orchestrate/references/agent-usage.md) | Reference (`evolve skill workflows show agent-usage`; `evolve agent --help`) |

From this source checkout, build with `npm run build`. The executable is `node dist/workflow-cli.js` (`evolve`, including `evolve skill review|draft|replay|apply|rollback`). Public command groups are `search`, `kb`, `code`, `session`, `run`, `agent`, and `skill`.

# 中文回复准则

- 所有回复使用简体中文，保留英文技术术语、代码变量名、文件/命令路径与错误日志（代码注释沿用所在文件现有语言风格）。
- 中英文/数字间加空格，使用中文标点，代码与命令使用反引号。
- Git Commit 使用中文提交信息，格式：`类型: 简短描述`（`feat/fix/refactor/docs/test/chore`）。
