# Implementation result diagnostics

`validate-result.ps1` returns one compact JSON receipt for every result check. Version 1 keeps the legacy `status`, `kind`, and `errors` fields and adds `outcome`, `resultStatus`, `artifactRevision`, `evidenceRef`, coverage, and structured `findings`.

`outcome` describes what the validator established: `passed`, `failed`, `inconclusive`, `not_run`, or `validator_error`. A valid `failure` result is still a failed implementation outcome; a valid `incomplete` result is inconclusive and must include `incompleteReason`. Neither status may enter review. Already-resolved work is `not_run` because no result was evaluated.

Each finding carries a JSON field path, occurrence scope, category, severity, repairability, and the existing verification fingerprint shape (`findingFingerprint`, `findingStrategyId`, and `findingStrategyVersion`). Strategy `implementation-result-v1` fingerprints stable rule coordinates, not message text, source lines, timestamps, artifact hashes, or user-provided values. The artifact SHA-256 and evidence reference bind a finding to the exact result file without including its contents. Findings remain in the validation receipt; this change adds no database or independent finding ledger.

Coverage reports the schema's expected and present required fields plus the implementation success gates. Only a declared `success` result is checked against success gates. Missing coverage cannot be interpreted as a successful implementation. The router continues to send non-success implementation outcomes to investigation and calls incomplete work “inconclusive.”
