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

Before inspecting project files or running `git`, release, or maintenance actions — and whenever the task scope changes mid-conversation — run `node dist/workflow-cli.js search "<1–3 task keywords>" --mode context` (installed equivalent: `evolve search`); inspect governing or truncated hits using `evolve kb get <id|q-N:idx>... --resolved`. Reuse complete, applicable `session-priors` for a Run or use one `--reads "<run-dir>/knowledge-reads.json"` receipt with `--session <session-id>`. Refine irrelevant results; re-query on scope change or repeated failed fixes. See `evolve skill workflows show session-run`.

## Memory Recording

Record the first confirmed correction before dependent work; also retain durable decisions, informative failures, non-obvious verified methods and handoff blockers with real evidence. Search existing records before adding; use `evolve kb add "<lesson>" --kind episodic --type <type> --scene <step> --session <session-id> --evidence <source-ref>` or update the existing record. Do not save routine requests/progress; mark unresolved hypotheses as unverified. Before handoff/compaction confirm material records using `kb get`. Follow `evolve skill workflows show ew-knowledge` for source retention and scope.

## Closeout & Self-Evolution

- Before `run complete`, record actual knowledge adoption/outcomes using `evolve kb feedback` on the existing Run receipt (see session-run); do not fabricate feedback.
- `evolve session complete` freezes evidence and queues extraction; inspect `evolve kb closeouts <session-id>` instead of launching duplicate harvest. Standalone tasks use explicit/final closeout only; never harvest between chain steps.
- Wiki publication and Skill modifications require explicit approval. Use governed `kb propose` / `kb apply` and the `ew-knowledge` route; keep unapproved candidates pending. `workflow-evolve` is explicit only for confirmed Skill/process defects.
- For knowledge/Hook failures or maintenance, run `evolve kb doctor` and follow `ew-knowledge`. Do not migrate, bulk-retry or change user-wide configuration without authorization.


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
