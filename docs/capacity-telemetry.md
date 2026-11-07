# Capacity telemetry

`scripts/capacity/capacity_telemetry.py` gives the UI and scheduler one consistent capacity
snapshot per provider and window (`5h`, `weekly`; schema: `schemas/capacity-snapshot.schema.json`).
Consumers: #88, #91-#94. The profile/window schema itself belongs to #89; this is a minimal local
schema to be aligned when it lands.

## Sources and honesty rules

| source | meaning | confidence |
| --- | --- | --- |
| `native` | provider-reported via a supported mechanism | `exact` only if the provider states it |
| `manual` | operator override from config (`tests/capacity-fixtures/manual-valid.json` shape) | `estimated`, own timestamp/TTL |
| `observed` | rate-limit/cooldown seen at runtime (honours `retry-after`, exponential backoff) | `estimated` |
| `unsupported` | nothing available | `unknown`, no remaining value |

- Unsupported, malformed or missing data is `unknown` and never presented as exact.
- Freshness is `fresh`, `stale` (older than TTL), `expired` (past reset) or `unknown`; only `fresh`,
  non-error, non-unknown snapshots are authoritative.
- `effectiveRemaining` = raw remaining minus the configured safety reserve (floored at 0).
- `percentRemaining` is only computed when a positive limit is known; raw units are always preserved.
- An active observed cooldown overrides other sources (remaining 0 until reset).

## Researched telemetry mechanisms (as of 2026-11)

- Codex CLI and Claude Code expose interactive usage/limit views to the logged-in user, but no
  documented, stable programmatic usage API for subscription quota is relied on here. Native
  adapters therefore return `unsupported` unless a documented mechanism is added later.
- Rate-limit responses (HTTP 429 / CLI limit messages with a reset time) are supported signals and
  feed the observed-cooldown tracker.
- Terms and limitations: provider telemetry may change or be restricted by terms of service.

## Forbidden

No scraping of web consoles, no extracting or sharing session tokens or credentials, no
workarounds that bypass provider terms. If a mechanism is not documented and permitted, use manual
configuration and observed rate limits.
