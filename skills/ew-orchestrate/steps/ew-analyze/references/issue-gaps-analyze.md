# Issue Gaps Analysis — Root-Cause Protocol

Root-cause analysis for registered issues, triggered by `ew-analyze --gaps [ISS-ID]`. Supports a single issue (`ISS-ID`) or batch (all `open` / `registered`) with grouping and parallel analysis, writing `analysis` enrichment per issue plus `outputs/findings.json` for downstream `ew-plan --gaps`.

## Input

- `ISS-ID` (optional): specific issue to analyze; if omitted, analyze all `open` / `registered` issues.
- `DEPTH`: `standard` or `deep` (default `standard`).

## Pipeline

```
Load Issues -> Classify & Group -> Gather Context -> Parallel Analysis -> Enrich Issue Records -> Write outputs/findings.json
```

1. **Load issues**: if `ISS-ID` is given, load that record (`E_ISSUE_NOT_FOUND` if missing) and skip grouping; otherwise load all `open`/`registered` records (`E_NO_ISSUES` if none).
2. **Classify & group (batch only)**: group by same location prefix (first 2 path segments) or shared `affected_components`; ungrouped items stay 1-issue groups `{ group_id, label, issues[], shared_context_keywords[] }`. Display breakdown unless `-y`.
3. **Gather codebase context (per group)** — run Knowledge Gate lookup first, then merge keywords (`title`, `description`, `location`, `affected_components`):
   - **standard**: `evolve code search` per group + targeted file reads.
   - **deep**: multi-query `evolve code search` + parallel `research` subagent exploration (error handling, data flow, dependencies); join all subagents before proceeding.
4. **Parallel analysis (per group)** — mandatory, not substitutable by manual reads alone:
   Dispatch per group via host subagent (OMP: native `task` with `scout`, shared `context` + `tasks[]`; join/cancel every child before advancing, never poll) or `evolve delegate "<group prompt>" --to codex|agy|omp --mode analysis` (pass `--session <session> --run <run>` for bound Codex/OMP; Agy stays standalone). Strict OMP analysis requires the separate CLI process. For each issue output `{ iss_id, root_cause, impact, related_files[], confidence, suggested_approach, cross_refs[] }` backed by `file:line` evidence. Retry once with a narrowed prompt or fallback executor on failure, noting any unverified scope explicitly.
5. **Write issue analysis**: set `issue.analysis = { root_cause, affected_files, impact_scope, fix_direction, confidence, cross_refs, analyzed_at, tool, depth }`, update `updated_at`, append `{ action: "analyzed" }` history (status unchanged), and re-read to confirm persistence.
6. **Output `outputs/findings.json` & `report.md`**: aggregate grouped root-cause findings, cross-group dependencies, and **Locked** (evidence-derived) / **Free** (planner discretion) decisions into `outputs/findings.json` (`mode: "gaps"`), summarizing highlights in `report.md`.
