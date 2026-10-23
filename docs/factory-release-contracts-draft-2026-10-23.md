# Immutable Factory release contracts — draft for #62

Status: proposed contract for review; no runtime behavior is changed by this document. It follows the live baseline in [the #61 audit](factory-delivery-audit-2026-10-23.md). Implementation remains behind the repository's risk approval and independent review gates.

## Goals

- Identify one immutable artifact by its complete Git object ID and content digests.
- Let the host controller and Cezar UI read the same versioned JSON contracts and fixtures.
- Keep artifact facts immutable; record channel activation and target observations in separate receipts.
- Report Cezar incompatibility distinctly from a failed build or verification run.
- Retain every artifact still referenced by a channel, rollback point, review, or active task.

## Proposed contract set

### 1. Release manifest (`factory-release-manifest/v1`)

Artifact path: `releases/<sourceSha>/`, where `sourceSha` is the complete lowercase Git object ID (40 hex for SHA-1 or 64 hex for SHA-256 repositories). The directory and its manifest are write-once. Rebuilding the same SHA to different content is a collision and fails closed; it never overwrites the first artifact.

Required fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Contract identifier, initially `factory-release-manifest/v1`. |
| `source` | Repository identity, full `sha`, source ref, and Git object format. Ref is provenance only; the SHA identifies content. |
| `artifact` | Archive/directory format, byte size, and SHA-256 digest of the deployable bundle. |
| `files` | Sorted relative paths, byte sizes, and SHA-256 digests for every shipped file; reject absolute paths, `..`, duplicate paths, and links escaping the artifact root. |
| `build` | Unique build ID, builder name/version, workflow, and UTC start/completion timestamps. It must not contain credentials or arbitrary environment dumps. |
| `compatibility` | Supported Cezar API/version range and required runtime capabilities. |
| `verification` | Verification schema/version, terminal outcome, digest of the verification evidence, and evidence reference. The referenced result contract remains owned by #49/#19; do not embed their result schema here. |
| `manifestDigest` | SHA-256 over canonical UTF-8 JSON with this field omitted. |

The manifest records artifact facts, not mutable deployment status. The `source.sha`, bundle digest, per-file digests, and manifest digest must be verified before an artifact becomes eligible for activation. Unknown schema versions, malformed paths, missing digests, and checksum mismatches are hard failures.

### 2. Release state (`factory-release-state/v1`)

Release state is controller-owned and keyed by full `sourceSha`. Proposed values: `built`, `verified`, `quarantined`. `verified` requires a passing verification reference whose digest matches the manifest. `quarantined` records a reason code and timestamp and cannot be activated without a new reviewed artifact identity. Channel-specific active state belongs in deployment receipts, not this record.

### 3. Deployment receipt (`factory-deployment-receipt/v1`)

One receipt per idempotent attempt and target. Required identity: receipt schema version, `targetId`, `channel`, full `desiredSha`, `artifactDigest`, idempotency key, attempt number, and UTC timestamps for requested, staged, activation, and observation events where those events occurred.

Record three separate SHA observations:

- `desiredSha`: the channel head the controller intends to activate.
- `actualSha`: the artifact/pointer the controller last wrote.
- `observedSha`: the SHA reported by the running Cezar runtime after health checks.

Proposed terminal states: `active`, `incompatible`, `failed`, `rolled_back`. Intermediate states are `pending`, `staged`, and `activating`. `incompatible` means the artifact is valid but the target's Cezar version or capabilities do not satisfy the manifest. `failed` means build/integrity/activation/health work failed. A valid artifact that is incompatible must not be called a failed test or marked active. Receipt detail uses bounded reason codes and a short sanitized message; logs and secrets are referenced by safe IDs, not copied into the receipt.

Idempotency key: SHA-256 of a canonical tuple `(targetId, channel, desiredSha, activationGeneration)`. Retrying the same generation returns or advances the existing attempt; an intentional retry after correcting a blocker uses a new generation and links to the prior receipt.

### 4. Task release lease (`factory-release-lease/v1`)

At task start, Cezar pins the task to one full `sourceSha` and stores the lease in the run record. Required fields: run ID, project ID, channel, source SHA, acquired/heartbeat/expiry timestamps, and lease state. A task continues using its pinned SHA for its entire life even if the channel pointer changes. A lease is live while the task is active and its heartbeat is within the configured expiry window; recovery must explicitly reconcile stale leases before reclaiming their artifacts.

### 5. Retention decision

An artifact is not collectible while referenced by either channel pointer, the last known-good rollback point, an open release/review, or a live task lease. Proposed floor after reference checks: keep the newest three healthy artifacts per channel and every artifact younger than 30 days. Make counts and age controller policy, not per-project overrides. If the controller cannot establish reference state, retention fails closed and deletes nothing.

## Validation and consumer rules

1. Validate schema version and shape before trusting any field.
2. Verify full source identity, artifact SHA-256, every file checksum, manifest digest, and path containment before extraction/activation.
3. Verify the verification evidence reference and digest; `skipped`, `unknown`, missing, or malformed evidence is not `verified`.
4. Check target Cezar API range and required capabilities before activation; report `incompatible` separately.
5. Persist the intended receipt before mutating the active pointer, then record the controller's actual SHA and the runtime's observed SHA after health checks.
6. The CLI and Cezar UI consume the same schema and fixture set; the UI may display state but cannot synthesize successful receipts.
7. Contract tests cover valid manifests/receipts, malformed and unknown versions, tampered bundle and file digests, incompatible Cezar, interrupted activation, stale task leases, and retention references. Tests use temporary directories and fake controller/Cezar adapters only.

## Fixture sketch

The implementation should publish shared fixtures under a single repository-owned directory (proposed: `schemas/factory-release/fixtures/`) with paired valid and invalid cases. Both CLI and Cezar contract tests load these files directly; neither consumer maintains private copies.

Example manifest identity (digests are illustrative and must be generated by fixture tooling):

```json
{
  "schemaVersion": "factory-release-manifest/v1",
  "source": {
    "repository": "bin0110001/cezar-factory",
    "sha": "0123456789abcdef0123456789abcdef01234567",
    "gitObjectFormat": "sha1",
    "ref": "refs/heads/dev"
  },
  "artifact": {
    "format": "tar",
    "byteSize": 123456,
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "files": [
    {
      "path": "VERSION",
      "byteSize": 7,
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  ],
  "build": {
    "id": "local-2026-10-23T18:00:00Z-1",
    "builder": "factory-controller",
    "builderVersion": "1.0.0",
    "workflow": "factory-release",
    "startedAt": "2026-10-23T18:00:00Z",
    "completedAt": "2026-10-23T18:02:00Z"
  },
  "compatibility": {
    "cezarApi": ">=1.0.0 <2.0.0",
    "requiredCapabilities": ["shared-factory-runtime-v1"]
  },
  "verification": {
    "schemaVersion": "factory-verification-result/v1",
    "outcome": "passed",
    "digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "evidenceRef": "verification/0123456789abcdef0123456789abcdef01234567.json"
  },
  "manifestDigest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
}
```

This sample is illustrative, not a validated fixture: a follow-up implementation must generate consistent byte sizes and digests and publish negative fixtures. The `factory-verification-result/v1` identifier is provisional until coordinated with #49/#19.

## Dependencies, risks, and approval

- #61's live audit is recorded in the adjacent report. It found no deployment receipt and found project-local shadows on Tableflux.
- Coordinate verification evidence fields with #49 and the adapter compatibility requirements of #19; neither schema is assumed here.
- #29 is marked `factory:needs-help` and records a high-risk plan awaiting explicit human approval. The release controller and activation implementation must wait for that approval and for this contract to be accepted.
- This proposal is high risk because it defines cross-project artifact identity, activation evidence, task pinning, and garbage-collection protection. Required path: human plan approval, implementation, full validation, independent review, then a `dev` PR with auto-merge requested. No host deployment or GitHub Actions compute is part of contract tests.

## Decisions requested before implementation

1. Approve the contract split: immutable manifest and build facts; mutable controller state and per-target receipts; task leases for retention.
2. Approve compatibility as a Cezar API semver range plus required capability names, with `incompatible` distinct from `failed`.
3. Approve the retention floor of three healthy artifacts per channel and 30 days, always extended by active references and failing closed when references cannot be enumerated.
4. Confirm the verification-result identifier/fields with #49/#19 before publishing final schemas and fixtures.
