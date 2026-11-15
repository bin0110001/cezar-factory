# Distributed verification pilots, fault tests and benchmarks (#220)

Validation is local only (`tests/run-tests.ps1` receipts, `docs/local-validation.md`); no GitHub Actions compute.
Rollout is opt-in and local-only. State as of this document: no distributed worker runtime, #116 mock remote worker
fixtures, #217 multi-role session contract or #51 project adapter exists on `dev`. Every result row is therefore an
**explicit coverage gap**, never green. A row changes only when a named local test or evidence file replaces it.
Profile and capability names are generic; no personal hardware, host names or private network details belong here.

## Acceptance traceability
| #220 acceptance bullet | Test / evidence | Status |
| --- | --- | --- |
| Two-host physical scenario correct; single-host simulation cannot satisfy distinct-host requirement | none yet | coverage gap: runtime not merged |
| Non-Godot pilot and Windows/Linux contract tests on the same core APIs | none yet | coverage gap: runtime not merged |
| Failure injection passes with no false pass or lost source work | fault matrix below | coverage gap: fixtures not merged |
| Benchmark report with pinned evidence, gains and costs | benchmark section below | coverage gap: nothing measured |
| Rollout opt-in with documented rollback | rollout and rollback section below (policy only) | policy documented, unproven |

## Fault-injection matrix (to implement on the #116 fixtures)
Each case must end with: no false-green aggregate, no lost source work, no leaked lease/session/staging residue.

| Case | Expected outcome | Status |
| --- | --- | --- |
| Protocol version mismatch | worker refused, job stays queued or runs locally | gap |
| Stale capability report | dispatch refused until re-advertised | gap |
| Connection loss and reconnect | job fenced; at most one result accepted | gap |
| Worker revocation | in-flight job cancelled, credentials unusable | gap |
| Duplicate dispatch / duplicate receipt | idempotent; second receipt ignored | gap |
| Atomic multi-role contention | all-or-none reservation, deterministic teardown | gap |
| Partition loss, concurrent cancellation | one terminal state, cleanup complete | gap |
| Corrupt artifact, incomplete media upload | result rejected, never reported as pass | gap |
| Unauthorized asset access | denied and audited | gap |
| Stale control token, competing display leases | fenced, deterministic loser | gap |
| Missing compositor, GPU reset or unavailable API, viewport crash | explicit unsupported/failed, not pass | gap |
| Mismatched visual baseline, browser failure | failed with evidence | gap |

## Pilots (all through identical core APIs; project adapters own application behaviour)
| Pilot | Owner | Status |
| --- | --- | --- |
| Generic non-Godot integration fixture (detects framework leakage) | core | gap |
| Godot parse / GdUnit / startup via the project-owned #51 adapter | project | gap |
| Headless browser (Playwright): screenshot, trace, real DOM assertion, isolated repeats, cancel | core (#329) | gap |
| Non-Godot desktop app on a virtual display with verified capture | core (#328/#329) | gap |
| Rendered Godot client; `--headless` must not satisfy rendered requirements | project (#330) | gap |
| Godot dedicated server plus two GUI clients on distinct hosts (#217) | project | gap |

## Reference deployment (policy)
At least two heterogeneous worker resource profiles on separate hosts, plus the existing local worker. Name profiles
by capability (for example `cpu-small`, `cpu-large-render`), never by machine. Primary runtime is rootless Podman
under a systemd user unit; other OCI runtime adapters are acceptable only where they satisfy the same worker
contract. Unsupported runtimes and platforms are recorded as such, not assumed.

## Benchmark protocol
Pin and record before any run: source commit, policy and manifest revision, image digests, environment
fingerprint. Compare single versus multi-worker on: expected versus actual tests and correctness (first),
throughput, queue time, CPU and memory, cache and staging, retries, network overhead, media artifact overhead,
render startup latency against the ordinary headless baseline, and coding-worker fairness. Report median and p95
over a stated run count. No figure is recorded because none has been measured; estimates are not evidence.

## OS and GPU support matrix
| Platform | Status |
| --- | --- |
| Linux, software rendering | untested |
| Linux, GPU | untested; separately gated |
| Windows | untested; no OS parity is assumed |

## Rollout and rollback
- Feature flag defaults off; with it off, or workers unavailable, execution is local-only and unchanged.
- Adoption gates: every gap above closed with a named test or evidence file; two-host scenario passed on physical
  hosts; benchmark shows correct results at acceptable cost.
- Rollback: disable the flag, drain workers, revoke worker credentials, remove staging; rolling upgrades drain one
  worker at a time and revert by re-pinning the previous image digest.
- No test or pilot deploys anything or uses GitHub Actions.

## Operator onboarding and security
Onboarding: enrol a worker with a scoped credential, advertise generic capabilities, run the contract test, then
allow it. Security: least-privilege per-job credentials, asset access only through the manifest, audit every
revocation and denial. Calibration and the project template are added with the runtime.
