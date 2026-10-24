# Cezar verification contract v1

The shared Zod-first contract is defined in `packages/contract/src/verification.ts`.
This document explains the wire-level expectations for projects and Cezar
consumers. It is additive: a project with only `validation.changed`,
`validation.full`, and `validation.verify` remains on the legacy adapter path.

## Manifest

A v1 manifest has a literal `version: 1`, a map of named command checks, and
named suites containing check IDs. A command is represented by an executable
and argv array; commands are not shell strings. `cwd` is normalized and
relative to the registered project's worktree root. Timeouts are 1–3,600
seconds. A check may declare capabilities, tags, owned paths, optionality, and
exclusive resource names. A suite must be non-empty, contain no duplicate IDs,
and refer only to declared checks. Unknown versions and invalid manifests are
incomplete results and must not launch commands or report success.

## Results

A result pins a verification ID, Cezar run ID, project ID, worktree ID, commit
SHA, manifest digest, timestamps, and tool/environment versions. Check and run
records use normalized statuses while preserving the raw command exit code.
Diagnostics, metrics, coverage, and artifact references are bounded by
`VERIFICATION_LIMITS`; artifact paths are normalized relative paths and each
reference includes a media type, byte count, and SHA-256 digest. Raw logs are
not inlined as artifacts.

Check coverage must agree with the check status. Run coverage must account for
every check result exactly once, and the aggregate status's semantic exit code
must match. A passed result requires at least one selected required check, all
required checks passed, and any non-passing optional checks to be explicit
skips. Empty results, zero tests, required skips, unknown or incomplete
evidence, crashes, timeouts, cancellation, and truncated output cannot be
reported as passed. Truncation makes the affected check `unknown`.

Semantic exit codes are: `0` passed, `1` failed required checks, `2` skipped,
no-tests, unknown, or not-selected, `3` infrastructure error, and `4`
cancelled. The original child exit code remains separate for diagnosis. A
missing capability is `skipped` only for an optional check; a required check
becomes `unknown`.

## Compatibility and fixtures

The checked-in `packages/contract/fixtures/verification/` corpus is the shared
language-neutral fixture set. It includes legacy configuration, a valid v1
manifest, malformed manifests, passing and optional-skip results, a zero-tests
result, and truncated evidence. The Cezar test suite validates the Zod schemas
and executes the fixtures through a standalone Node consumer. Existing
validation adapters are not rewritten by enabling the optional manifest
contract.
