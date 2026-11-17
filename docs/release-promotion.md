# Stable promotion, approvals and rollback (#595)

`scripts/release/release_promotion.py` (library only, own SQLite ledger) promotes only a verified candidate revision to
stable and keeps a safe way back. It does not replace the live promoter (`docs/promotion-pipeline.md`); it is the contract
the three-stage pipeline adopts.

## Authorization

`authorize` decides from the exact candidate SHA and manifest hash and returns every reason it may not proceed:

- required suite evidence valid and passing (`release_verification.gate`); missing, stale, pending or failing blocks;
- no unresolved candidate-authored forward-port obligations (`release_repair.blocks_stable`);
- `approval` mode (the default): an approval from a `human` or `operator` that names this SHA and manifest, has not
  expired and is not from the author. An implementation agent cannot approve its own release. `auto` mode is an explicit
  configuration choice and still needs the evidence;
- freshness of dev: `allow` (an older tested candidate still promotes while dev has moved on), `warn`, or `block`;
- the SHA is not quarantined by an earlier failed activation.

## Two phases

1. **Ref.** `begin` records the authorized promotion; a partial unique index allows one in-progress promotion per project
   and a replay returns the same record. `move_stable` fast-forwards `stable` to the tested SHA by compare-and-swap. If
   stable is no longer the recorded prior value (another writer) or the SHA does not descend from it, the promotion is
   refused and nothing is overwritten. A crash between the CAS and the ledger write resumes without a second move.
2. **Activation.** `begin_activation`, then `record_probe` receipts. `complete_activation` marks `active` only when every
   required probe's latest receipt passed (and refuses an empty probe list). Git ref movement alone is never reported as
   deployed. `fail_activation` restores the prior stable by CAS only if stable still names the promoted SHA, quarantines
   the SHA and keeps the audit trail. `stale_activations` lists interrupted activations for recovery.

`detect_drift` compares the stable ref, the serving version and the last confirmed-active promotion; a ref ahead of
serving is drift (#559 handles the live case). Every decision is appended to an audit table, including refusals of the
ref move.

## Not here

Choosing whether stable is a branch pointer, a merge or an artifact channel per project, signing the manifest, and the
actual deployment and probes belong to the adopting workflow and the existing delivery path (#60). Emergency hotfix
planning is `release_repair.plan_emergency`.
