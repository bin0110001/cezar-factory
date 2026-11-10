# Hindsight provenance and supersession

Hindsight is optional semantic memory. The append-only run, verification, and
incident ledgers remain authoritative for run state, test outcomes, incident
counts, and gates. If Hindsight is unavailable, recall and retention return an
unavailable status and workflow execution continues.

## Candidate and record contract

New candidates declare `scope` (`repo` or `global`), `claimType` (`fact` or
`hypothesis`), and at least one evidence link. Links identify a `run`, `issue`,
`commit`, `test`, or `file` by stable `ref`, and may include a SHA-256 digest.
Candidates missing these fields or containing sensitive/transient material are
rejected with a specific reason.

A requested `fact` becomes a validated fact only when its run, commit, or test
link exactly matches a `verified: true` entry in the deterministic index. A
candidate cannot validate itself. Other candidates are stored as
`hypothesis` / `unvalidated`, including legacy memories without provenance.
Hindsight metadata carries the scope, claim type, validation state, evidence
links, version, content hash, and prior version references. Repository-owned
instructions remain in versioned files.

## Deterministic-first recall

The recall boundary checks exact failure fingerprints and test IDs in the
optional local deterministic index before making semantic Hindsight requests.
The index is JSON with `schemaVersion: 1` and a `records` array matching
`schemas/hindsight-deterministic-index.schema.json`. Set
`HINDSIGHT_DETERMINISTIC_INDEX` to its path. A missing or malformed index is a
deterministic miss; semantic recall still works.

Every recall artifact includes a `retrievalCapture` with the project, read
timestamp, deterministic matches, and each selected memory's ID, version,
content hash, read time, and validation state. Legacy memories without a known
version carry `null` rather than an invented version number. The output remains bounded to 8
memories and 12,000 excerpt characters. Existing recall artifacts without
provenance fields remain valid.

## Versions and supersession

The client keeps a local append-only provenance index at
`$CEZ_HOME/hindsight/provenance.jsonl` (or `.factory/context/` when `CEZ_HOME`
is not configured). `HINDSIGHT_PROVENANCE_INDEX` can select another path.
Retained versions preserve the prior IDs, versions, content hashes, and retain
timestamps, capped at 32 history entries.

Superseding a memory requires an approved replacement with validated evidence
and the same topic and scope. The replacement records `supersedes` and the old
record is projected as `supersededBy` with a timestamp. Default recall excludes
superseded entries. This is a client-side overlay because Hindsight does not
provide a stable update operation for these records; the append-only local index
is the source for supersession state.

The `memory-candidate`, `memory-record`, `memory-recall`, and
`memory-retrieval-capture` schemas define candidate, retained, recall, and audit
shapes. New recall fields are optional in the wire schema so existing artifacts
remain readable.
