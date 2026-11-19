# Epic #588 close-out: single-active candidate and three-stage promotion

Tracking record only; no behavior changes. All child issues #589-#603 are
closed with `factory:done`.

| Epic acceptance bullet | Delivered by | Reference |
| --- | --- | --- |
| Two projects, different schedules, one generic implementation | #589, #591, #644 | `release-pipeline-config.md`, `release-triggers.md`, `release-pilot-adoption.md` |
| Races never produce two active candidates; deterministic crash recovery | #590, #642 | `release-candidate-store.md`, `release-rollout.md` |
| Dev merges while a candidate runs; stable only from a proven revision | #592, #593, #595 | `release-snapshot.md`, `release-verification.md`, `release-promotion.md` |
| Fixes revalidate and forward-port into dev; audit-visible states | #594, #596, #635 | `release-repair.md`, `release-candidate-read-model.md` |
| Existing two-branch repositories keep operating until migrated | #597, #639, #641, #643 | `release-migration-inventory.md`, `release-rollout.md` |
| Quality/security evidence on an existing candidate, never a new one | #598-#603 | `quality-gate-pipeline.md` |

Gaps: none found. Any future gap is filed as a new follow-up issue.
