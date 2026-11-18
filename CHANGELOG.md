# Changelog

All notable changes to `self-evolving-workflow` are documented in this file.

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
