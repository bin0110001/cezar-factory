# Supply-chain hygiene checks: license, SBOM, container/IaC and Scorecard (#652, #653, #654)

Modules in `cezar/packages/cezar/src/server/verification/checks/` behind the check-provider contract
(`docs/check-provider-contract.md`). All compute stays on local Factory workers; nothing here uses GitHub Actions.

## SBOM and license policy (`sbom.ts`, `license-policy.ts`, #652)

- **SBOM.** `validateSbom` accepts CycloneDX 1.x and SPDX 2.x documents against a small schema (the fields policy and provenance
  need) and extracts each component's license; a bad document throws with the failing path. `recordSbom` binds the SBOM to a full
  source SHA (a branch name is refused) and records format, spec version, component count, generator, byte size and a SHA-256 over
  canonical JSON (key order does not change the digest). `sbomEvidenceEntry` produces an `artifact` entry that matches
  `schemas/evidence-manifest.schema.json` (plain hex digest, no extra properties); the SHA/generator provenance travels in the
  companion `SbomProvenance`.
- **License policy.** `licensePolicySchema` has allow, deny and review lists over SPDX ids, `unknown` handling (`review` or `deny`;
  there is no silent `allow`), and reviewed per-package exceptions that expire. A list conflict is rejected. `evaluateExpression`
  handles `OR` (best), `AND` (worst), parentheses and `WITH`; anything it cannot parse is `unknown`. A denied license is a
  blocking `license` finding; review and unknown findings do not block unless policy makes unknown a denial. Findings are identified
  per package. An empty SBOM is `unknown`, not a pass.

## Container and IaC (`infra-policy.ts`, #653)

Static analysis with no external scanner. `analyzeDockerfile` flags a base image with no tag or `latest` (high), a tag without a
digest (medium, configurable), an untrusted registry, remote `ADD` and a root runtime user, and understands multi-stage builds and
`scratch`. `analyzeTerraform` flags public bucket ACLs, public databases, disabled encryption and network rules open to the world
(high on sensitive ports or all ports, low otherwise), with line numbers and ignoring comments; it is not a full HCL parser.
Files are found by name. A project with no Dockerfile or `.tf` is NOT_APPLICABLE through capability planning
(`docs/check-capabilities.md`).

## OpenSSF Scorecard (`providers/scorecard-adapter.ts`, #654)

Opt-in and report-only. Disabled by default: zero scorecard calls and an explicit reason. When enabled, the report is parsed into a
`ScorecardRecord` (repo, commit, score, Scorecard version, run time, low-scoring checks) handed to `onRecord`; findings are capped
at `low`, so the run is at worst `warn` and cannot block. A score of -1 (not evaluated) is not a finding. The check definition is
advisory (`mandatory: false`), has `periodic-independent` and `manual` triggers on its own weekly or monthly schedule, and has no
effect on any candidate. Scorecard needs network access to its data sources; the isolated scanner profile must allow that
explicitly for this phase.

Runner changes: a plugin may declare `noFeed` (a missing feed timestamp is then not an outage), and the normalizer identifies a
rule hit on a specific dependency per package rather than per rule.
