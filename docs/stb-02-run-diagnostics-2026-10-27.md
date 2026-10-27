# STB-02 bounded run diagnostics

Collected 2026-10-27 UTC from the three projects explicitly listed in the host
registry. Queries read recent Cezar run records and their event histories; no
run, issue, automation, or project state was changed. The runs endpoint returned
more records than its requested limit, so this is a selected diagnostic sample,
not a population or a reliability-rate estimate. Identifiers, task content,
URLs, and local paths are omitted.

## Sample observations

| Sample | Project and workflow | Observed evidence | Classification |
| --- | --- | --- | --- |
| Targeted tests A | Blackjack/Godot, `factory-implement` | On 2026-10-26, `targeted-tests` ran three times, each about 1.5 seconds. Each `check-output` reported exit 1 and a structured error saying Factory project config was not found. The recorded command field was empty. | Environment/configuration failure, not evidence of a test regression. The repeated exit 1 was incompatible with the current source contract, which classifies missing config as unavailable and maps it to exit 10. The record is from the older deployed runtime; source/runtime parity is not established for this run. |
| Targeted tests B | Blackjack/Godot, `factory-implement` | On 2026-10-25, a targeted check reported exit 1 after about 48 minutes. Its receipt named `test-changed.ps1`, but supplied no diagnostic message or captured command output. The overall run later ended after a Codex app-server timeout. | Command failure observed; underlying test or harness cause unknown. The later app-server timeout is the observed terminal run error, not proof of why the check failed. |
| Codex timeout A | Blackjack/Godot, `factory-investigate` | On 2026-10-20, the run lasted about 46.6 minutes. The persisted terminal error says the Codex app-server timed out after 30 minutes and was killed. History includes a completed tool result about seven seconds before timeout. | Timeout observed; provider stall, tool loop, context pressure, and legitimate long work remain hypotheses. |
| Codex timeout B | Blackjack/Godot, `factory-investigate` | On 2026-10-19, the run lasted about 36.8 minutes. The same 30-minute app-server timeout was recorded. Token-usage activity appeared about 34 seconds before timeout; the last completed tool result was about 154 seconds before it. | Timeout observed; cause unknown. Activity timestamps alone do not establish useful progress or provider behavior. |

## Source and evidence limits

- Current source wrappers `scripts/factory/test-changed.ps1` and
  `scripts/factory/test-full.ps1` call `Invoke-FactoryValidation` in
  `scripts/lib.ps1`. Missing project config maps to exit 10; only a structured
  test-regression/work-verdict failure maps to exit 1. `workflows/implement.yaml`
  retries exit 1 and classifies exit 10 as configuration. This supports the
  current source contract, but does not prove which exact revision produced the
  historical run.
- The sampled run records identify the runner as Codex and include model
  identity. They do not expose a provider response explaining the timeout.
- Failed command receipts did not consistently preserve stdout/stderr or a
  useful progress marker. No timeout-budget or retry-policy change is justified
  by these samples.
- Live Bazzite/runtime parity was previously observed to have matching managed
  content digest but differing host and container Git SHAs at Factory 0.3.53.
  That mismatch prevents treating current source as the verified source for
  these historical records.

## Follow-up

STB-02 remains partial. Preserve the unknown classifications, improve durable
command diagnostics through the supported workflow contract, and collect new
representative failures only after exact source/runtime parity is established.
