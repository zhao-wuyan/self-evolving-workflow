---
name: ew-odyssey-debug
description: "Odyssey debug mode — symptom-driven investigation through archaeology, exploration, hypothesis testing, fix, and confirmation, producing diagnosis with full evidence trail"
argument-hint: "<issue> [--template performance|memory-leak|race-condition|regression|crash] [--skip-fix] [--skip-generalize] [-y] [-c]"
contract:
  contract_version: 2.1
  produces:
    - path: outputs/session.json
      kind: session
      schema: session/1.0
      role: primary
      alias: debug-session
      required: true
    - path: outputs/evidence.ndjson
      kind: evidence
      schema: evidence/1.0
      role: evidence
      alias: debug-evidence
      required: true
    - path: outputs/understanding.md
      kind: diagnosis-report
      schema: diagnosis-report/1.0
      role: primary
      alias: debug-understanding
      required: true
    - path: outputs/explore.json
      kind: exploration
      schema: exploration/1.0
      role: evidence
      alias: debug-explore
      required: false
goal: true
---

# Pre-task Thinking: odyssey-debug

## Purpose

Odyssey debug is a multi-iteration standalone debugging cycle: symptom intake → archaeology → code exploration → hypothesis-driven diagnosis → fix → confirmation → 3-layer generalization → discovery → knowledge persistence. Unlike single-concern quick edits (`ew-orchestrate` `ew-companion`, `<=2` files) or bounded single-pass root-cause diagnosis inside an Evolve chain (`ew-orchestrate` `ew-debug`, `<=2–3` modules, producing `diagnosis.json` + `fix-directions.json` for `ew-plan --gaps`), odyssey-debug carries through to fix, confirm, generalize sibling occurrences, and persist learnings.

## Input Interpretation

Entry modes:

| Mode | Trigger | Symptom source |
|------|---------|----------------|
| standalone | issue description in `<intent>` | Parse issue description directly |
| template | `--template <name>` | Apply predefined investigation strategy (performance, memory-leak, race-condition, regression, crash) |
| continuation | `-c` | Resume via latest session, jump to `current_state` |

Template strategies:

| Template | Strategy | Use case |
|----------|----------|----------|
| `performance` | profiling → hot path → allocation → cache | Performance degradation |
| `memory-leak` | heap snapshot → retention chain → lifecycle | Memory leaks |
| `race-condition` | timeline → concurrent access → lock analysis | Race conditions |
| `regression` | git bisect → diff analysis → boundary check | Regressions |
| `crash` | stack trace → null chain → error propagation | Crashes / exceptions |

## Required Context

Satisfy the Knowledge Gate per [shared base](../odyssey-base.md) §Phase Initialization & Pre-load (`evolve skill workflows show session-run` — `session-priors` when scope matches → `evolve search "<query>" --mode context` / `evolve kb get <id>` with CLI `--reads`) for `debug` and `coding` scope before searching code (`evolve code search "<symptom keywords>"` → module boundaries, call graph, ownership).

When prior debug artifacts of the same scope exist, check their root cause first to avoid re-investigating an already-confirmed root cause.

## Boundaries and Invariants

- **State chain:** `S_INTAKE → S_ARCHAEOLOGY → S_EXPLORE → S_DIAGNOSE → S_FIX → S_CONFIRM → [back-half]`
- **Evidence append-only** — evidence.ndjson entries are immutable observations; modifying or deleting them is forbidden.
- **Phase goal tracking** — mark each goal done/failed before transition; no silent skips.
- **Root cause confirmation requires evidence** — a hypothesis without reproduction or code/log evidence stays "suspected", never promoted to confirmed.
- **3-strike round escalation & fix loop cap** — if all hypotheses in a diagnosis round fail (`disproved`/`inconclusive`), increment `diagnosis_retries` (`A_ESCALATE_DIAGNOSIS` via cross-angle inspection while `retries < 3`); stop at `diagnosis_retries >= 3` (`Normal`: user prompt for 1 bounded extension or `INCONCLUSIVE → S_RECORD`; `-y`: `INCONCLUSIVE → S_RECORD`). `S_CONFIRM → S_FIX` rework loops are bounded by `fix_rounds < max_fix_rounds` (default `5`).
- **Backward trace** from where the error first appears to where correct data turned wrong; fix at the source, not at the symptom.
- **Generalize is mandatory** unless `skip_generalize == true`; prior-phase convergence is NOT a valid skip reason.
- **Fix scope:** source code modifications during fix phase are in-scope and MUST be committed per verified fix/action (`evidence phase=fix`). Session artifacts target `{run_dir}/outputs/` only.
- **In scope:** Multi-iteration bug-hunt + fix + generalize loop. **Out of scope:** Small edit (`<=2` files) → `ew-orchestrate` (`ew-companion`) | Bounded chain diagnosis (`<=2–3` modules) → `ew-orchestrate` (`ew-debug`) | Features → `--mode planex` | Quality review → `--mode review` | UI → `--mode ui` | Architecture investigation → `/ew-orchestrate "<architecture investigation intent>"`.

## Run Artifact Metadata

Follow [runtime adapters](../runtime-adapters.md) §4 for `_meta` attachment (`outputs/session.json`, `outputs/explore.json`, first record of `outputs/evidence.ndjson`, YAML frontmatter of `outputs/understanding.md`), `current_state: "END"`, and `evolve run complete` sealing.

## Risk Checklist

- Is every confirmed root cause backed by a reproduction or code/log evidence? A hypothesis without evidence must stay "suspected", never promoted to confirmed.
- Did you change only one variable at a time during diagnosis? Simultaneous changes make attribution impossible.
- Have 3 diagnosis rounds failed (`diagnosis_retries >= 3`)? Stop and escalate (user prompt or `INCONCLUSIVE` under `-y`) — do not keep guessing indefinitely.
- Did the trace reach the true source? Fixing at the symptom rather than where correct data first turned wrong leaves the root cause live.
- Are archaeology/explore results properly logged even on partial failure (W003/W006)? Missing evidence must be flagged, not silently omitted.
- Is every discovery hit individually classified with a reason? Blanket "pre-existing" skips are forbidden.
- Are all 3 generalization layers (syntax/semantic/structural) attempted? A single-layer quick grep does NOT satisfy the thoroughness floor.

## Gate Intent

- `discovery-complete`: archaeology and/or exploration phases have logged evidence, understanding.md §2-§3 are updated, and discovery goal (G2) is marked. Log W003 on partial archaeology failure or W006 when no CLI exploration executor is available, and record what was covered.
- `diagnosis-confirmed`: all hypotheses are tested with evidence logged (phase=diagnosis), root cause is confirmed with reproduction or code/log evidence (or INCONCLUSIVE after 3-strike escalation), and understanding.md §4-§5 are written. Zero hypotheses tested is BLOCKED.
- `fix-confirmed`: fix is implemented and tests pass, CLI review completed, `confirmation.overall` is set, understanding.md §6 is written, and verify goal (G3) is marked. `needs_rework` routes back to FIX. Skippable only when `skip_fix == true`.
