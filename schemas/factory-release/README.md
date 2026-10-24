# Factory release contracts

These records are shared by the local Factory controller and Cezar. Each file
is versioned independently; consumers must reject versions they do not
understand and preserve the original bytes for repair. A migration writes a
new record with `migratedFrom` provenance instead of rewriting an old manifest
or receipt.

- `manifest.schema.json` describes immutable source, build, artifact, file,
  compatibility, and verification-reference facts. The manifest digest is
  `sha256:` plus SHA-256 of RFC 8785 JSON Canonicalization Scheme (JCS) bytes
  after omitting `manifestDigest`.
- `state.schema.json` holds mutable controller state keyed by full source SHA.
  Channel activation belongs in target receipts.
- `receipt.schema.json` is append-only, one record per target activation
  attempt. `desiredSha`, `actualSha`, and `observedSha` have separate meanings.
  `incompatible` is a valid artifact rejected by target compatibility checks;
  it is not a build or test failure.
- `lease.schema.json` pins a task to one full source SHA. Controllers must
  reconcile stale leases before collecting their artifacts.

Every SHA is a full lowercase Git object ID (40 hex for SHA-1 or 64 hex for
SHA-256); every content digest is `sha256:` plus 64 lowercase hex characters.
Manifest file entries are normalized relative paths, unique and sorted in
ordinal order. Archive readers must reject symlinks and any entry that escapes
the artifact root before extraction; a manifest shape check alone cannot prove
that an archive is safe.

The receipt idempotency key is `sha256:` plus the JCS digest of the tuple
`[targetId, channel, desiredSha, activationGeneration]`. Repeated requests with
the same tuple share one activation generation; a corrected retry increments
the generation and links to its previous receipt.

The verification field is only a reference to the version 1 result contract
owned by issue #49: `resultVersion: 1`, `status: passed`, evidence digest, and a
relative evidence reference. It does not copy the verification result schema.
The API compatibility expression is preserved as data and interpreted by the
controller. Required capability names are explicit; no capability is inferred
from a version number.

Draft-07 validates the receipt shape but cannot express equality between
`desiredSha`, `actualSha`, and `observedSha`. Consumers must apply the shared
semantic contract in addition to JSON Schema; an `active` receipt is valid only
when all three SHAs match and its target evidence is compatible.

The manifest verifier checks the digest of the exact bundle bytes before it
checks extracted file entries. Callers must obtain `entries` by extracting
those same verified bundle bytes with an archive reader that rejects symlinks
and traversal before returning entries.

The retention floor is three healthy artifacts per channel and 30 days, after
protecting channel pointers, last-known-good rollback points, open releases or
reviews, and live task leases. If reference state is incomplete, collection
must retain artifacts and report the missing evidence.

Fixtures live under `fixtures/` and are consumed directly by the Cezar contract
tests. They use only synthetic values and must never be treated as deployable
artifacts.
