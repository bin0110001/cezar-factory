# Backlog priority, rank and lane contract (#193, epic #192)

Foundation for conflict-aware scheduling. It stores *human intent* about the backlog and does
not schedule anything: dependency readiness (#159), capacity (#93), scoring (#150/#194) and
conflict admission (#198) read these records, they do not live here.

Code: `cezar/packages/cezar/src/server/backlog/`. Tests: `backlog.test.ts` in that directory
(`cd cezar/packages/cezar && CEZ_HOME=<tmp> npx vitest run src/server/backlog`).

## Five distinct concepts

| Concept | Owner | Meaning |
| --- | --- | --- |
| `basePriority` | human | `P0`–`P4` or explicit `unset`. Importance; never changed by blocking or conflicts. |
| `backlogRank` | human | Lexical sortable key ordering issues inside a repository. `null` = explicitly unranked (sorts last). |
| `lane` | workflow | Inbox, Backlog, Refinement, Ready, Active, Review, Done. Mutable. |
| readiness / eligibility | derived | Dependency graph + `workflowEligibility()`; separate reasons, not a score. |
| dispatch score | derived | Deterministic, produced later by #194/#198. Not stored here. |

A P0 in Refinement keeps `P0` but `workflowEligibility()` reports it not dispatchable; a Ready P2 is.

Other fields: `scope`, `owner`, `effort` (integer points), `expedite`, `hold`, `dueDate`
(`YYYY-MM-DD`), `policyConstraints` (gates dispatch), `issueState`, `archived`.

## Identity and versioning

- Identity is `{repository (case-insensitive owner/name), issueNumber}`; `a/x#7` and `b/x#7` never collide.
- Every accepted write bumps `revision` by exactly one and appends an audit row (actor, source
  `human|inferred|migrated|sync`, reason, before/after). No-op writes change nothing.
- Callers pass `expectedRevision`; a mismatch throws `stale_revision` (optimistic concurrency).
- Per-field provenance records who set each value. An `inferred` write can never overwrite a
  `human` field (`human_owned`).

## Lane transitions

```
Inbox      -> Backlog, Refinement, Done
Backlog    -> Inbox, Refinement, Ready, Done
Refinement -> Backlog, Ready, Done
Ready      -> Backlog, Refinement, Active, Done
Active     -> Ready, Backlog, Refinement, Review, Done
Review     -> Active, Ready, Backlog, Done
Done       -> Backlog   (reopen)
```

Ready entry requires: open, not archived, not on hold, no policy constraints, and (default
policy) an explicit base priority. Violations throw `not_ready` with every reason listed.

## Authoritative storage (decision)

GitHub issues stay canonical. Editable fields live in a versioned block in the issue body:

```
<!-- factory-backlog:v1 {"fields":{...},"version":3,"origin":"alice","writeId":"…","updatedAt":"…"} -->
```

GitHub Projects v2 was evaluated and **not** chosen as the source of truth: it needs a
`project` token scope and GraphQL access that the connector and runner credentials do not
guarantee, and field IDs are per-project (hard to migrate/cross-repo). The block needs only
issue write access, is human-readable, and survives project moves. A Projects v2 *mirror* can be
added later without changing this contract. Human-authored body text is never modified.

The SQLite file `<CEZ_HOME>/backlog/backlog.sqlite` is a **projection** (schema version 1,
migrations refuse newer schemas). It is rebuildable from GitHub; it is not a second issue database.

## Synchronisation

`applyRemote` → `pendingPush` → `markPushed`, driven by the existing intake reconciliation
(event + periodic full pass); this change supplies the protocol, wiring into those pollers
follows with #194.

- Three-way merge against `base_fields` (the last value both sides agreed on).
- Remote-only change → applied locally (audited, provenance `human`).
- Local-only change → stays *pending* (this is the offline write queue; flushing is idempotent).
- Both changed the same field differently → an **open conflict** row. Neither side is
  overwritten and the field is withheld from pushes until `resolveConflict(keep: 'local'|'remote')`.
- Own echoes (`origin: cezar` + matching `writeId`) are ignored, so pushes never loop.
- Metadata older than the folded-in `remote_version` is ignored (replay/out-of-order safe).
- `markPushed` rejects with `stale_remote` if the remote moved since the push was prepared, so
  a newer human edit is never overwritten blind.
- GitHub outage: reads/edits continue against the projection; on return `applyRemote` reconciles
  deterministically using the rules above.

## Migration from existing labels

`ensureFromLabels` creates a record once and never modifies an existing one (re-running cannot
undo a later edit). Labels are left on the issue, so rollback = delete the projection and re-run.

- `P0`–`P4` / `priority:p2` map directly; legacy numeric `priority:<n>` (higher first) maps 4+→P0 … ≤0→P4.
  Conflicting labels pick the most urgent and emit a warning. No label → `unset`.
- `factory:*` state labels map to lanes (`new/investigate`→Inbox, `needs-plan`→Refinement,
  `ready`→Ready, `working/changes-requested`→Active, `implemented/pr-open/review/human-review`→Review,
  `done`→Done); the furthest stage wins. Closed issues → Done; an open issue labelled done → Backlog.
- Unranked entries stay unranked. Archived/closed state is carried in `issueState`/`archived`.

## Rank mechanics

`rankBetween(before, after)` yields a base-62 string strictly between neighbours; ranks never
end in `0`, so insertion room is unbounded. `normalizeRanks(repository)` deterministically
separates colliding ranks (ties keep issue-number order).

## Not in this change

Scheduler integration, scoring, UI, and the Cezar HTTP surface are owned by #194, #198 and #201.
