# Subscription profiles and capacity windows

`scripts/capacity/subscription_profiles.py` models subscription accounts independently of
provider/model definitions (schema: `schemas/subscription-profile.schema.json`, example:
`config/subscription-profiles.json.example`). It makes no scheduling or routing decisions;
consumers are #88 and #90-#94.

## Profile

`id`, `provider`, `accountLabel`, `adapters`, `enabled`, `maxConcurrency`, `allowedModelIds`,
`credentialRef`, `windows`. Two accounts of one provider carry their own models, concurrency and
windows and never affect each other (see the example file).

## Windows

Each window is independent: `name` (e.g. `5h`, `weekly`), `kind` (`rolling` | `fixed`),
`durationSeconds`, `resetAt`, `unit`, `limit`, `remaining`, `confidence`, `source`, `observedAt`,
`stalenessSeconds`. Times are UTC ISO-8601.

## State

`evaluate_state(profile, now)` is pure (inject `now`) and returns exactly one of `unknown`,
`available`, `constrained`, `exhausted`, `stale`, `disabled`.

- `disabled` wins. Otherwise the most constrained window decides (`exhausted` > `stale`/`unknown` > `constrained` > `available`).
- A window past `resetAt` is treated as reset (remaining = limit).
- An observation older than `stalenessSeconds` is `stale`; a window with no observation or no remaining is `unknown`.
- Clock drift: `CLOCK_DRIFT_TOLERANCE_SECONDS` (120) is applied to both the reset and staleness
  boundaries so small disagreement between clocks does not flip state.
- `constrained` means remaining/limit is at or below 20%.

## Secrets and billing

Secrets stay in the existing credential store; a profile holds only the opaque `credentialRef`.
Validation rejects secret-looking fields. `serialize_profile` is an allow-list and omits
`credentialRef`; use it for every API payload and log line. API billing is the separate
`ApiBillingUsage` type and is never counted as subscription usage.

## Migration

`schemaVersion` is 2. Version 1 stores (`accounts` with `fiveHour`/`weekly` blocks) are migrated
forward on load; a newer unknown version is rejected.

The older `capacity_telemetry` snapshot (`5h`/`weekly`, `schemas/capacity-snapshot.schema.json`)
describes one window of one provider and maps onto a profile window with the same field names.
