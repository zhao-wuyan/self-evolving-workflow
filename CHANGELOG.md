# Changelog

All notable changes to `self-evolving-workflow` are documented in this file.

## [Unreleased]

- 同步上游 v0.6.0（新增跨宿主历史信号收集 `evolve history`、Agent 原生自进化路线与 `evolve skill sync` / `validate --all`），保留 OpenViking 集成、个人跨项目经验与 OMP 宿主支持。
- 同步上游 v0.5.0（含多宿主插件与 Marketplace 文档），保留 OpenViking 集成、个人跨项目经验与 OMP Skills 说明。
- `kb lint` 兼容异步 OpenViking 知识源；三宿主插件导出与含 OMP 的普通 Skills 安装分别选择宿主，避免误写 Codex 插件目录。
- 同步上游 v0.3.1，保留 OpenViking 集成与 OMP 原生安装目录支持。
- OpenViking 远端 Memory 支持 `kb get --pick`、`q-N:idx` 和批量读取，文本输出继续保存远端读取证据。
- 共用模型客户端接纳上游响应校验，正确报告截断、仅推理输出和服务端错误。
- OMP 会话中的知识提炼与审阅可复用 `@memory` 角色及认证，使用无工具 SDK 会话；未配置独立 HTTP 模型时自动选择，候选审批流程保持。

## [0.6.0] - 2026-11-24

### Highlights

- **Incremental Cross-Host Signal Collection & Run History Search (`src/history-signals.ts`, `src/memory-history.ts`, `src/memory-reminders.ts`, `src/search-format.ts`, `src/knowledge-cli.ts`, `src/workflow-cli.ts`)**:
  - Added `evolve history collect|list|search|show` to incrementally index and search Codex, Claude Code, and Antigravity (`agy`) execution histories (`byte_offset` cursors in `.evolve/history-signals.db` skip unchanged transcripts and re-scan only new bytes).
  - Unified four signal sources (`transcript`, `memory`, `wiki`, and opt-in incremental `--llm`) with tool call/result/error parsing, noise-filtered `detectEntrySignals()`, `--role` parity across `--source signals|all`, and compact output rendering.
- **Agent-Executed `workflow-evolve` & Strengthened Skill Packaging/Sync (`skills/workflow-evolve/SKILL.md`, `skills/ew-skill-design/SKILL.md`, `src/workflow-skills.ts`, `src/workflow-install.ts`, `src/retrospective.ts`, `src/skill-design.ts`, `src/skill-replay.ts`, `src/closeout.ts`)**:
  - Streamlined `workflow-evolve` (`v0.5.0`) to an Agent-driven 4-step loop (`Collect -> Four-Way Triage & Strategy -> Execute Modify/Create -> Validate & Close`), keeping `evolve-loop.mjs` as an optional offline replay harness.
  - Added deterministic `evolve session review --no-llm` aggregation (covering `.evolve/runs/<session>/<run>/outputs/retrospective.json` and `memory.db`), `evolve skill sync` for project-local Skill distribution to host directories, project Skill discovery in `skill workflows`, `skill validate --all` scoping to committed project packages with `#heading` / `agents/openai.yaml` / `session-mode` checks, CRLF-tolerant `skill-replay` verification, optional `--skill` in `kb candidates route`, and `candidate_routes` tracking in `closeout.db`.
- **CodeGraph Lock & Dependency Update (`package.json`, `src/code.ts`, `test/unified-search.test.mjs`)**:
  - Updated `@colbymchenry/codegraph` to `1.6.4` and recognized `LockUnavailableError` in `isCodeLockError()` so mixed search gracefully degrades when the index is rebuilding.

### Verification

- `npm run build`: passed
- `npm run test:ew-layout`: passed
- `node dist/workflow-cli.js skill validate --all`: 32/32 passed
- `test/history-signals.test.mjs`, `test/evolve-workflow.test.mjs`, `test/integration.test.mjs`, and 12 unit/lifecycle suites: 142/142 passed
- `npm pack --dry-run`: 349 files, 8.5 MB unpacked

## [0.5.0] - 2026-11-24

### Highlights

- **Asymptotic Knowledge Decay, Usage Tracking & Bounded Exploration (`src/knowledge-decay.ts`, `src/memory.ts`, `src/wiki.ts`, `src/kb.ts`, `src/search.ts`)**:
  - Added bounded exponential time decay (`floor = 0.3`, type-specific half-lives `constraint: 180d`, `reference: 60d`, `episodic: 30d`, quantized to whole days) with logarithmic consumption rejuvenation (`read_count`) so frequently opened knowledge resists forgetting while search exposure (`search_hits`) alone never inflates rank.
  - Added persistent `memory_usage` and `wiki_usage` tables that track `content_hash`, `content_changed_at`, `search_hits`, and `read_count` across `wiki.build()` rebuilds (cleaning deleted pages on full rebuilds) while keeping explicit `readOnly` queries side-effect-free.
  - Added `applyBoundedExploration()` for non-paginated top-K search results (`limit >= 4`) to surface under-exposed relevant candidates without breaking multi-page pagination coverage.
- **Zero-LLM Heuristic Conflict Detection & Governed Resolution (`src/knowledge-conflict.ts`, `src/closeout.ts`, `src/wiki-entry.ts`, `src/wiki-change.ts`, `src/search-format.ts`)**:
  - Implemented bilingual (`en`/`zh`) normative stance detection (`detectStance()`) and non-ordinal value divergence checks (`classifyKnowledgeRelation()`, `findHeuristicConflicts()`, `findCorpusConflicts()`) with scope-overlap filtering.
  - Wired heuristic conflict checks into `KnowledgeStore.add()`, `harvestCompletion()` (`compareReferences()`), and `proposeWikiChange()` / `Wiki` ranking (`confidence: 'contested'` and `needs_review` penalties plus `[CONTESTED]` / `[NEEDS_REVIEW]` badges in compact and JSON outputs).
- **Read-Only Knowledge Audit Command & Closed-Loop Tests (`src/knowledge-lint.ts`, `src/knowledge-cli.ts`, `test/knowledge-lifecycle.test.mjs`, `test/knowledge-closed-loop.test.mjs`)**:
  - Added `evolve kb lint [--scope project|global|local] [--format compact]` to report freshness distributions, potential conflicts, exact duplicates, `needs_review`/`contested` entries, broken `[[wikilink]]`s, orphan pages, missing repository path anchors, and exposure concentration (`P0`/`P1`/`P2`).
  - Added unit and 6 end-to-end closed-loop tests covering storage, search, decay, conflict discovery, governed retirement/deletion, and post-cleanup verification.

### Verification

- `npm run build`: passed
- `npm test` (`node --test test/*.test.mjs`): 138/138 passed
- `npm run test:ew-layout`: passed
- `npm run test:release-gate-flow`: passed (`candidate_passed: true`, `rollback: verified`)
- `npm pack --dry-run`: 347 files, 8.5 MB unpacked

## [0.4.0] - 2026-11-24

### Highlights

- **Multi-Host Plugin & Marketplace Support (`.claude-plugin/`, `.codex-plugin/`, `.antigravity-plugin/`, `.agents/plugins/marketplace.json`)**:
  - Added repository-level plugin and marketplace manifests plus shared `rules/AGENTS.md` and `assets/logo.svg` for Claude Code, Codex, and Antigravity (`agy`), and included them in `package.json` `files`.
  - Extended `evolve skill install|upgrade|status` in `src/workflow-install.ts` and `src/workflow-cli.ts` with `--plugin` and `--path <dir>` to install project/user plugins, upsert Codex `.agents/plugins/marketplace.json` while preserving existing entries, emit Claude local marketplace manifests, render host-specific agent definitions (`.toml` for Codex, `.md` for Claude/AGY), and export standalone universal or per-host plugin bundles excluding `release-gate`.
  - Added project-scoped plugin `skills/` directories to `projectSkillRoots` in `src/workflow-skills.ts` so committed plugin installations bind cleanly to `evolve skill validate` and Runs.
  - Updated `README.md` and `docs/install.md` with multi-host plugin installation, Marketplace commands, and global CLI (`npm install -g self-evolving-workflow`) guidance.
- **Deferred Closeout & Session-Scoped Reminder Hygiene (`src/memory-history.ts`, `src/memory-reminders.ts`, `AGENTS.md`, `skills/`)**:
  - Filtered active session IDs in `buildSessionStartNotice()` and updated hook notices, `AGENTS.md`, `ew-impeccable`, `ew-odyssey`, and `ew-orchestrate` step workflows to defer `kb harvest` until explicit closeout or `evolve session complete`.

### Verification

- `npm run build`: passed
- `npm test` (`node --test test/*.test.mjs`): 125/125 passed
- `npm run test:ew-layout`: passed
- `npm run test:release-gate-flow`: passed (`candidate_passed: true`, `rollback: verified`)
- `npm pack --dry-run`: 341 files, 8.4 MB unpacked

## [0.3.1] - 2026-11-23

### Highlights

- **Sequential Run IDs & Lazy Run Directories (`src/workflow-runtime.ts`)**:
  - Replaced `run-<uuid>` generation in `WorkflowStore.next()` with Session-scoped sequential IDs (`run-001`, `run-002`, ...) via `nextRunId()`, preserving compatibility with historical `run-<uuid>` records and skipping existing/orphan directories.
  - Made `run_dir/outputs/` creation lazy in `next()` and `brief()` (pre-created only when `produces` declares a `required: true` slot), and automatically cleaned up empty `cancelled` Run directories that have no files or `knowledge_reads`.
  - Added `skill_entry_path` to Run packets so hosts can read bound Skill entry documents directly.
- **Streamlined Run State Progression & CLI Ergonomics (`src/workflow-runtime.ts`, `src/workflow-cli.ts`)**:
  - Decoupled `evolve run read skill` from blocking `run complete` (`readProof` missing links remain informational in `skill_reads`), keeping `run read skill` as an optional pinned-commit reader.
  - Made `--actor` (defaulting to `EVOLVE_ACTOR` or `'agent'`) and `--expected-orchestration-revision` / `--expected-run-revision` optional in single-coordinator flows while keeping strict `REVISION_CONFLICT` checks whenever revision fences are supplied, and ensured omitted `--request-id` + omitted revision mutations do not collide in the `requests` idempotency cache.
  - Added `evolve run complete --next` to seal the current Run and immediately dispatch the next pending Run in one CLI call.
- **Converged Session Thresholds & Topic Reuse (`skills/ew-orchestrate/`)**:
  - Tightened `END` vs `ew-companion` thresholds in `SKILL.md`, `ew-orchestrate.md`, `planning.md`, `companion-route.md`, `orchestrator-run-loop.md`, `auto-policy.md`, `goal.md`, and `steps/ew-companion/SKILL.md`: zero-deliverable-mutation diagnostics/probes and trivial 1-turn tweaks route to `END`; multi-turn topic work reuses `open` Topic Sessions via `session step add` and defers `session complete` until topic wrap-up.

### Verification

- `npm run build`: passed
- `npm test` (`node --test test/*.test.mjs`): 124/124 passed
- `npm run test:ew-layout`: passed
- `npm run test:release-gate-flow`: passed (`candidate_passed: true`, `rollback: verified`)

## [0.3.0] - 2026-11-22

### Highlights

- **Compact Search & Provenance Receipts (`src/search-format.ts`, `src/knowledge-reads.ts`, `src/knowledge-cli.ts`)**:
  - Updated `evolve search` / `evolve kb search` to emit compact JSON by default (plus `--format compact` terse plain text and `--verbose` for full fields), with collision-safe short prefix IDs, `300`-char inline bodies, and `snippet` + `truncated: true` for longer entries.
  - Added `q-N` query receipts (`q-N:idx`) and batch `evolve kb get <id|q-N:idx>...` / `--pick <n,...>` resolution, automatically linking `from_search_id` when reusing `--reads`.
  - Refined `search` two-stage path filtering and stripped numeric-pollution tokens for cleaner agent-facing queries.
- **CodeGraph Resilience & Node 22+ Liftoff (`src/code.ts`, `src/workflow-cli.ts`)**:
  - Added automatic `--liftoff-only` relaunch on Node `>= 22` for WASM CodeGraph indexing/syncing (`code build|sync`, `search` unindexed local code, `session open|create`), plus stderr progress reporting.
  - Added `CodeIndexLockedError`, `evolve-write.lock` / `evolve-build.json` incomplete-build detection and recovery, read-lock graceful degradation, prefix-based symbol resolution, and clean Git snapshot incremental sync.
- **New `ew-prototype` Skill & `ew-odyssey` `arch` Mode**:
  - Added top-level `skills/ew-prototype/` (`prototype` alias, `session-mode: none`) for throwaway logic/state HTML demos and multi-variant UI exploration before folding into production.
  - Added `--mode arch` (`odyssey-arch.md`, `prepare/odyssey-arch.md`) to `skills/ew-odyssey` for iterative module deepening, seam decoupling, and boundary hardening.
- **Visual Reports, Agent Usage Spec & Skill Package Hardening**:
  - Added `skills/ew-orchestrate/references/visual-report.md` (`--visual` HTML/Mermaid inspection standard) and `skills/ew-orchestrate/references/agent-usage.md` (subagent / swarm / `evolve agent` delegation spec + dedicated `evolve agent --help`).
  - Enforced strict YAML frontmatter parsing (`strict: true`, `uniqueKeys: true`) in `src/workflow-skills.ts` and refreshed managed instructions and Skill packages (`AGENTS.md`, `agents/`, `skills/`, `workflows/index.json`).

### Verification

- `npm run build`: passed
- `npm test` (`node --test test/*.test.mjs`): 123/123 passed
- `npm run test:ew-layout`: passed
- `npm run test:release-gate-flow`: passed (`candidate_passed: true`, `rollback: verified`)

## [0.2.0] - 2026-11-18

### Highlights

- **Unified CLI & Knowledge Store (`evolve`, `src/kb.ts`)**: Consolidated the public CLI into 7 unified command groups (`search`, `kb`, `code`, `session`, `run`, `agent`, `skill`), introduced `KnowledgeStore` unifying `episodic` memories with `reference` and `constraint` Wiki entries, and added file locking, background hook job queuing, and evolution reminders (`src/memory-file-lock.ts`, `src/memory-hook-jobs.ts`, `src/memory-reminders.ts`).
- **Multi-Host Agent Orchestrator (`./orchestrator`, `agents/`)**: Added `src/orchestrator.ts` (`src/orchestrator/*`) with `AgentManager`, `ProviderRegistry`, `AgentSessionStore`, `WorktreeManager`, and provider adapters for `codex`, `claude`, `agy`, and custom CLIs. Exported `./orchestrator` in `package.json` and bundled `agents/*.md` role definitions in the package.
- **Skill Package Upgrades & Learning Governance**:
  - Renamed `skills/team-swarm` to `skills/ew-swarm` with `host-adapters.md` and `team-coordination.md`.
  - Upgraded bundled `ew-impeccable` to upstream `4.9.2` (engine `0.1.25`) via `scripts/impeccable.mjs` and removed legacy Node detector scripts.
  - Added `src/skill-learnings.ts` (`skill learnings`, `skill retire`) and `skill design` chain support for usage tracking, bloat detection, and governed consolidation.
- **Install & Upgrade Documentation**: Added `docs/install.md` covering multi-host project/user installation, `evolve skill status`, `--upgrade`, `--prune`, and refreshed `README.md`.

### Breaking Changes

- Removed the legacy `agent-memory` bin entry (`src/cli.ts`), `src/workflow-mcp.ts`, and `skills/workflow-evolve/scripts/memory-codex-mcp.mjs` in favor of the unified `evolve` CLI.

### Verification

- `npm run build`: passed
- `npm test` (`node --test test/*.test.mjs`): 115/115 passed
- `node test/ew-layout.mjs`: passed
- `npm run test:release-gate-flow`: passed (`candidate_passed: true`, `rollback: verified`)

## [0.1.5] - 2026-11-16

- **Antigravity (`agy`) User-Scope Install Path**: Updated `evolve install --scope user --host agy` to install skills into `~/.gemini/config/skills/` and rules into `~/.gemini/AGENTS.md` (keeping project-level `.agents/` unchanged).
- **Packaging Fix**: Normalized `bin` paths in `package.json` via `npm pkg fix` to eliminate `npm publish` warnings.
- **Docs & Regression Coverage**: Updated `README.md` and added user-scope `--host agy` test coverage in `test/integration.test.mjs`.

## [0.1.4] - 2026-11-16

- **Standalone `ew-knowledge` Skill**: Extracted top-level `ew-knowledge` to replace the legacy `workflow-closeout` stub while keeping CLI aliases for backward compatibility.
- **Complete 15-Step Orchestration in `ew-orchestrate`**: Migrated 9 steps (`ew-init`, `ew-grill`, `ew-blueprint`, `ew-roadmap`, `ew-verify`, `ew-test`, `ew-auto-test`, `ew-debug`, `ew-retrospective`) alongside `ew-companion`, `ew-brainstorm`, `ew-analyze`, `ew-plan`, `ew-execute`, and `ew-review`.
- **Long-Chain Continuity & Routing Safeguards**: Added `BoundaryContract`, `SessionGoal[]`, `SessionAmendment[]` (`CHG-NNN`), `SessionPolicy`, `outputs/priors.json` generation, `report.md` frontmatter validation, and `session list --status --query`.
- **Homepage & Skill Package Polish**: Upgraded `README.md` quickstart and overview, and unified all workflow Skill packages.

## [0.1.0] - 2026-11-15

- Initial release of `self-evolving-workflow`.
