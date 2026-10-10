---
name: factory-project-onboarding
description: Onboard a new GitHub repository into Cezar Factory with a dev branch, target registration, Factory labels, bounded issue seeding, reviewed release, and runtime parity checks.
---

# Factory project onboarding

Use this skill when a new GitHub repository must become a Cezar/Factory project. The goal is a verified handoff from an empty or issue-only repository to an enabled, observable project—not merely a source checkout.

## Scope and boundaries

- Work only with the explicitly named repository and the host-local target registry. Never scan drives or infer deployment targets.
- The operator onboarding entry point is `scripts/onboard-project.ps1`. It creates or verifies `dev`, ensures the standard Factory labels, registers the target, and can seed a small bounded set of eligible issues.
- The onboarding entry point does not merge pull requests, enable live automations, dispatch issue work, or repair a Bazzite checkout. Keep those actions behind the normal review and release gates.
- Confirm that the corresponding Cezar project exists before reporting onboarding complete. A GitHub repository alone is not a configured runtime target.

## Procedure

1. Resolve the canonical GitHub repository, Cezar project ID/API endpoint, project type, and target registry entry. For a first pass, seed at most three open issues unless the operator explicitly requests another bound.
2. Use the onboarding entry point with the repository and project details. Prefer dry-run first when the target entry is new or uncertain. Review its summary for the `dev` branch, labels, registry update, and seeded issue IDs.
3. Verify that seeded issues have `factory:new` only when they have no existing `factory:*` state label. Do not overwrite existing workflow state; the intake automation owns subsequent routing.
4. Put any Factory content changes through the required PR targeting `dev`. Obtain independent review before requesting auto-merge; do not merge a failed, unresolved, or unreviewed PR.
5. After merge, use the `factory-release` and `factory-finish-release` flow. Promote only a fully tested commit to `stable`, synchronize the explicitly configured Cezar targets, and enable automations through that release flow.
6. Verify runtime parity before declaring success: the Bazzite checkout is clean and on the promoted stable commit, the Factory version and mounted Cezar version agree, the `factory-autodeploy.timer` is enabled and active, and the new project reports its expected automation count and enabled state.

## Recovery and stop conditions

- There is no UI force-refresh substitute for the release gate. If a host is stale, inspect the checked-in guidance in `docs/shared-factory.md` and use only the documented, operator-authorized host setup/recovery.
- Stop rather than resetting, overwriting, or manually editing a dirty or diverged Bazzite checkout. Stop as well when the host-local deployment inventory or target registry is missing, or when the timer/service cannot be verified.
- A remote-only automation sync does not deploy application or infrastructure files. Use the documented host deployment flow for Bazzite services and their bind-mounted configuration.

## Handoff report

Report the repository, `dev` branch result, target registration, seeded issue IDs, PR/review state, promoted stable SHA/version, per-target synchronization result, Bazzite checkout/container parity, timer state, and the new project's enabled automation count. Call out any skipped repair or remaining human gate explicitly.
