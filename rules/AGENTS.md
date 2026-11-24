# Self-Evolving Workflow

When a project uses Evolve Session/Run orchestration (`ew-orchestrate`) or the user invokes it, read the relevant package in `skills/` for a project installation (or from this plugin's bundled `skills/`) and commit project-scoped packages so Evolve can bind Runs to a Git revision. Keep ordinary task orchestration (`ew-orchestrate`) separate from Skill/harness modification (`workflow-evolve`, explicit `/workflow-evolve` only).

Ensure the `evolve` CLI is available (`evolve --version`); if missing, install it globally with `npm install -g self-evolving-workflow` before running Evolve commands.

## Knowledge Gate

- Run `evolve search "<task keywords>" --mode context` before inspecting project files (default single-line compact JSON; add `--format compact` for terse plain text or `--verbose` for full metadata). Follow project instructions for knowledge scope, and inspect governing or truncated entries via `evolve kb get <id|q-N:idx>... --resolved` (or `--pick <n,...>`), recording Run knowledge reads.
- Search results use collision-safe short prefix IDs (and top-level `search_id` `q-N` + `idx` when `--reads` is passed); bodies <= 300 chars inline `content`, longer ones return `snippet` + `truncated: true`, and `--mode context` caps `constraints` at 20 items / 4000 chars (`constraints_notice` indicates overflow).
- Never write `wiki/entries/`, `.workflow/specs/`, or `.workflow/knowhow/` directly; publish or update Wiki entries only through governed `evolve kb propose` / `evolve kb apply` commands.
- Run `evolve skill workflows` to list bundled workflow docs; read `evolve skill workflows show session-run` for Session/Run dispatch and recovery, and `evolve skill workflows show agent-usage` for subagent/`evolve agent` delegation rules.
- Use `evolve kb import` to preview legacy Spec and Knowhow in the source project. Add `--apply` to import them.

## Memory Recording

- Record useful working evidence as `--kind episodic` during execution. On the first confirmed misunderstanding or user correction, save the mistaken interpretation, the correction and its basis before continuing work that depends on it; do not wait for repeated corrections or task completion.
- Also record key evidence that changes a judgment or rules out a hypothesis, confirmed requirements and decisions with their rationale, informative failed approaches with their conditions, non-obvious verified methods, and blockers needed for handoff. Evidence can be recorded before the root cause is known; label unresolved conclusions as unverified.
- Each memory must be independently understandable: include the subject, applicable project/version/environment, observation or decision, evidence/source references and verification state. Distinguish user decisions, suggestions, tool observations and Agent inferences; omit fragments, routine progress and unsupported causes. Use `correction`, `work_fact`, `error` or `verified_fix` as appropriate; reserve `verified_fix` for a demonstrated fix.
- Search for an existing memory before adding one. Update the same subject when conclusions change, preserve supporting sources, and state what is superseded or still unresolved. Omitting `--evidence` preserves existing source IDs; supplying it replaces the source list, so repeat `--evidence` for every old and new reference that should remain. Keep project-specific evidence in project scope; do not silently turn it into a global rule.
- Before context compaction, handoff and task closeout, check that material findings and unresolved state were saved. Background extraction and reminders are fallback mechanisms. Confirm the write result and read back the record with `evolve kb get <id>` before claiming it was saved.

## Wiki Recording

- Propose Wiki knowledge when a reusable method, reference or constraint has sufficient evidence and a stable applicability scope. During a Run or active task, record working lessons via `evolve kb add --kind episodic` and stage findings in required outputs/`report.md` — NEVER run `kb harvest` during task execution or between chain steps. Run the returned `closeout_command` only after `evolve session complete`, and run `kb harvest conversation` for a standalone task only on explicit closeout request or confirmed final completion.
- Compare candidates with existing entries before proposing additions, updates or retirements. Keep suggestions, unresolved hypotheses and one-off task state in working memory; do not promote them as established Wiki knowledge.
- `kb harvest` generates review candidates; an exact duplicate may only supplement sources through governance. `kb propose` stages a change without publishing it. Inspect the concrete change and apply it only within explicit human authorization for its IDs, targets and action; otherwise retain it for review. Follow `evolve skill workflows show ew-knowledge` for publication and conflict handling.

## Key Knowledge Commands

| Command | Purpose and timing |
| --- | --- |
| `evolve search "<keywords>" --mode context [--format compact]` | Before project exploration or a change of scope, retrieve constraints, references, memories and code (short IDs; <= 300 chars inline, longer `snippet` + `truncated: true`). |
| `evolve kb get <id|q-N:idx>...` / `evolve kb sources <memory-id>` | Batch-read complete record(s) or code symbol slices by short prefix, `q-N:idx`, or `--pick <n,...>`; trace memory provenance to original messages. |
| `evolve kb add "<memory>" --kind episodic --type <type> --scene <step> --session <session-id> --evidence <source-ref>` | Save an in-flight memory immediately; include real evidence references, not invented IDs. |
| `evolve kb update <memory-id> "<revised memory>" --kind episodic` | Revise content while retaining original provenance. To replace sources, add repeated `--evidence <source-ref>` flags containing the full desired source list. |
| `evolve kb delete <memory-id> --kind episodic` | Remove an exact memory when explicitly requested; do not use it to hide failed attempts. |
| `evolve kb harvest session <session-id> --project <project-id>` | Post-completion only: after `evolve session complete` finishes the whole Session (never mid-chain), collect evidence-backed Wiki candidates; prefer the returned `closeout_command`. |
| `evolve kb harvest conversation <conversation-id> --host <host> --project <project-id>` | Explicit/final closeout only: collect candidates after a standalone task is completely finished (never mid-task or between turns), using its actual conversation ID and host (`codex`, `claude` or `agy`). |
| `evolve kb candidates show <receipt-id> --project <project-id>` | Inspect candidates using `receipt_id` from the harvest result and the same `--project` value. |
| `evolve kb propose <change.json> --evidence <source-ref>` / `evolve kb changes <change-id>` | Stage and inspect a governed Wiki change; neither command publishes it. |
| `evolve kb apply <change-id>` | Publish the inspected Wiki change after authorization, then read back the affected entry and change receipt. |

Use canonical full IDs returned by `kb get` for formal mutations (`propose` / `apply`) and the intended project root (`--root <project-root>`). In a Run, pass the same `--reads "<run-dir>/knowledge-reads.json"` to searches and `kb get` (reusing `--reads` auto-links `from_search_id` for `q-N:idx`, `--pick`, and prefix IDs; `--from-search <search-id|q-N>` overrides explicitly) and bind searches with `--session <session-id>`. Reads default to local project + global knowledge; writes default to project. Consult `evolve kb --help` for additional options.

## Closeout & Self-Evolution

- After `evolve session complete` (never after intermediate Runs), run its `closeout_command` (`evolve kb harvest session <id> --project <id>`). Do not auto-invoke `workflow-evolve` during task execution; only mention `/workflow-evolve` at closeout when `evolve_reminder` reflects a confirmed Skill or workflow defect.
- During standalone task execution, save lessons via `evolve kb add --kind episodic` instead of calling `kb harvest`; run `kb harvest conversation` only when the user explicitly requests closeout (`/ew-knowledge`) or confirms the entire standalone task is finished (zero eligible Wiki candidates is valid).
- Reserve `workflow-evolve` (`disable-model-invocation: true`) for explicit user requests to modify Skill/harness behavior (`skills/<id>/SKILL.md`), never for ordinary code bugs, failing tests, or routine task execution. Only suggest `/workflow-evolve` when repeated corrections (`>= 2`) or retries clearly expose a Skill/process gap; record the first user correction directly in episodic memory.
