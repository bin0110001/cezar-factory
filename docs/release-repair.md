# Regression repair and dev forward-port reconciliation (#594)

`scripts/release/release_repair.py` (library only, own SQLite file) keeps candidate repairs narrow, bounded and
reconciled with dev, without merging the regression branch into dev.

- **One task per failure.** `open_repair` is keyed by (candidate, revision, failure). A replayed or concurrent
  duplicate event returns the same task. It is refused for an obsolete revision, while validation runs are not
  terminal (revisions stay sequential), or with no scope paths.
- **Bounded.** `record_attempt` enforces attempt, cost and time caps. At a cap the task escalates (`manual` when manual
  review is configured, otherwise `abandon`) and counts nothing further, so an unresolved repair cannot loop.
- **Forward-port obligations.** `register_fix` records each fix once per (candidate, `patch_id`), so a rebased copy of the
  same patch is not a second obligation. States are `pending`, `applied`, `equivalent`, `conflict`, `waived`, each
  transition with a receipt; terminal states cannot move, replays are no-ops, and only an `operator` may waive.
- **Detecting what dev already has.** `classify_forward_port` uses `git cherry` for an equivalent patch already on dev,
  `git merge-tree --write-tree` for a clean apply (`pending`) versus `conflict` (needs git 2.38 or newer; the host runs
  2.39). Anything undecidable is reported as `conflict`, never as done.
- **One resolver.** `claim_conflict` lets exactly one owner work a conflicting obligation.
- **Promotion.** `blocks_stable` lists unresolved candidate-authored obligations (the default policy blocks on them);
  `block_all` widens it, `block_authored=False` turns it off.
- **Emergency fixes.** `plan_emergency` validates a hotfix branched from stable independently. If a candidate is active an
  explicit `reconcile`, `revise` or `abandon` decision is required first, so the one-active rule is kept and two
  candidates are never promoted at once.

Opening the forward-port PR goes through the existing merge coordinator (#199); this library only tracks the obligation
and its status.

## Host incident recovery outcomes

The host-local release controller remains the authority for incident fingerprints, attempt budgets, backoff,
repair actions, and the original post-repair probe. `factory_release_controller.py repair --apply --event-id <stable-id>`
records one idempotent ledger admission per finding and returns that admission alongside the bounded repair result and
inline receipt record. Replaying a delivery ID returns the existing admission and does not repeat a repair side effect.
Operators without a delivery system can omit `--event-id` and keep the existing backoff behavior.

`workflows/release-incident-recovery.workflow.json` adapts those structured records into child-workflow outcomes for
release or verification callers. It returns `passed` only when the receipt fingerprint matches and says both
`state: fixed` and `probePassed: true`; a still-failing probe stays blocked, a ledger backoff is retryable, a final
unresolved attempt escalates, and missing or conflicting evidence remains unknown. It only accepts bounded redacted
evidence references. Agent and Hindsight summaries do not participate in the decision.
