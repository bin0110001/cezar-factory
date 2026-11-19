# Capability-tier model routing

`scripts/capacity/model_routing.py` lets a task name a capability **tier** instead of a provider model, and
chooses an eligible configured model/account at runtime. It is pure and deterministic: the same task, config,
profiles, time and active counts always give the same decision. Config: `config/model-routing.json.example`
(`schemas/model-routing.schema.json`); tiers are optional, so existing configs are unaffected.

- **Models** carry explicit features (`tools`, `contextTokens`, `coding`, `reasoning`, `multimodal`, `locality`,
  `quality`) separate from the provider `modelId`. Tier membership is user config; nothing assumes, for example,
  that a GPT model equals a Haiku model.
- **Tiers** list ordered `candidates`, `require`ments, `minQuality`, `providerAllow`/`providerDeny`,
  `accountAffinity` and `fallback` (`allow` or `none`; `none` accepts only the first preference).
- `validate_config(cfg, profiles)` reports unknown/dangling aliases, contradictory provider policy, a bad fallback,
  unknown affinity accounts and tiers no candidate can satisfy (for example an unreachable `minQuality`).
- `route(task, config, profiles, now, active)` consumes subscription profiles (#89): the account must match the
  model's provider and allow its `modelId`, not be disabled/exhausted, and be under `maxConcurrency`.
  Ranking: preference order, then account affinity, then account state (available before constrained before
  unknown/stale), then account id.
- A **pinned** task (`{"pinned": {"model": ..., "account": ...}}`) is evaluated against exactly that target. If it is
  ineligible the result is `deferred` (capacity only) or `failed`; it never switches model or silently downgrades.
  Pinning only a model may pick any eligible account for that model.
- The returned decision (`status`, `selected` model/account, `reason`, `fallback`, `rejections` with per-candidate
  reasons) is persisted on the attempt; `routing-event.schema.json` gained optional `selected.account`, `pinned`
  and `rejections` (additive).

Capacity reservation and deferral remain in `quota_admission.py`; use the ranked result as its candidate input.
