---
name: release-gate
description: Validate release readiness against active Wiki constraints and emit a structured release-gate/1.0 artifact.
argument-hint: "--environment <production|staging|...> --artifact-sha256 <sha256:...> [--query <text>]"
version: 0.2.0
session-mode: run
contract:
  contract_version: 2.1
  consumes: []
  produces:
    - path: outputs/release-gate.json
      kind: verification
      schema: release-gate/1.0
      role: primary
      alias: latest-release-gate
      required: true
  gates:
    entry: []
    exit:
      - artifact_sha256 format verified
      - knowledge and production freeze checks recorded in outputs/release-gate.json
---

# Release Gate

> `nonShipped` E2E reference Skill (`src/workflow-install.ts`); excluded from `evolve skill install` and `AGENTS.md` routing.

1. **Inputs & Knowledge Gate**:
   - **Inputs**: Read `environment` (e.g. `production`, `staging`), `artifact_sha256`, and optional `query` from the invocation arguments, Run brief/arguments, or test payload. If `environment` or `artifact_sha256` is missing, fail closed (`decision: "blocked"` or `evolve run transition <run-id> blocked` with the missing-input reason).
   - **Knowledge Gate**: Follow the canonical Knowledge Gate with `--task release`:
     - Inside a Run, follow `evolve skill workflows show session-run` (prefer `session-priors` when its scope matches, otherwise record a single receipt via CLI `--reads "<run-dir>/knowledge-reads.json"` with `--task release` and `--from-search <search-id>`).
     - Outside a Run, follow `AGENTS.md` / `evolve skill workflows show ew-knowledge` with `--task release`.
2. **Checksum Verification**:
   - Verify `artifact_sha256` matches `^sha256:[a-f0-9]{64}$` and check active release checksum Wiki constraints (`evolve kb list --kind constraint --task release`), recording the consulted constraint ID in `consulted_knowledge_ids`.
   - **Failure branch**: If `artifact_sha256` fails format validation or no active release checksum constraint can be verified when required, fail closed (`decision: "blocked"`, record the mismatch or missing constraint gap in `reasons` — never fabricate a pass).
3. **Production Freeze Check & Authority Weight**:
   - When `environment=production`, search both Wiki (`evolve kb search --kind reference` + `evolve kb get <id> --resolved`) and working memory (`evolve kb search` + `evolve kb get <id>` / `evolve search --mode context --task release`).
   - **Authority rule**: Working memory (`authority: unverified_episodic`) is an investigative clue only, never standalone blocking authority. Final authority rests with **active Wiki entries (`status: active`, with `mode: constraint` taking precedence over `mode: reference` and memory)**:
     - Block (`decision: "blocked"`) if an `active` Wiki `constraint` directs a freeze/block, OR if an `active` Wiki protocol (`status: active`) delegates freeze status to an unresolved active freeze window reported in matching working memory (with no superseding resolved/lifted signal).
     - If working memory and an active Wiki `constraint` conflict, follow the active Wiki `constraint` and record both IDs plus the conflict note in `reasons`.
     - Include all consulted Wiki IDs in `consulted_knowledge_ids` and consulted memory IDs in `consulted_memory_ids`, and specify a rollback or hold action when `decision` is `blocked`.
4. **Output & Seal**:
   - **Decision enum**: `decision` MUST be one of `approved` | `blocked`.
   - Write `outputs/release-gate.json` with `_meta` (`kind: verification`, `schema: release-gate/1.0`, `role: primary`, `alias: latest-release-gate`), `schema_version: "release-gate/1.0"`, `environment`, `artifact_sha256`, `decision`, `reasons`, `consulted_knowledge_ids`, and `consulted_memory_ids`.
   - Summarize findings in `report.md` if required, then seal via `evolve run complete` (using `--verdict done` when `approved`, or `--verdict done_with_concerns` / `evolve run transition ... blocked` per `evolve skill workflows show session-run` when `blocked`).
