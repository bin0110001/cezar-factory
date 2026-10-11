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
3. Distinguish automation synchronization from project-layer installation. Remote-only synchronization creates Cezar automation records but does not install the project’s `.ai/cezar` workflows, skills, policies, or scripts. If Cezar’s workflow list contains only `quick-task`, perform the supported full-layer installation for that project: dry-run first, then apply it to the project checkout/mount.
4. Enable the requested Factory features in the project-owned config before updating the layer. For maintenance, set `features.maintenance: true`; the update should materialize `factory-maintenance`, `factory-backlog-label-audit`, and the maintenance automation definition. Verify Cezar registers `factory-maintenance` before attempting a manual or scheduled run. A synchronized automation with an unregistered workflow fails immediately as `unknown workflow`.
5. Verify that seeded issues have `factory:new` only when they have no existing `factory:*` state label. Do not overwrite existing workflow state; the intake automation owns subsequent routing.
6. Put any Factory content changes through the required PR targeting `dev`. Obtain independent review before requesting auto-merge; do not merge a failed, unresolved, or unreviewed PR.
7. After merge, use the `factory-release` and `factory-finish-release` flow. Promote only a fully tested commit to `stable`, synchronize the explicitly configured Cezar targets, and enable automations through that release flow.
8. Verify runtime parity before declaring success: the Bazzite checkout is clean and on the promoted stable commit, the Factory version and mounted Cezar version agree, the `factory-autodeploy.timer` is enabled and active, and the new project reports its expected automation count and enabled state.

## Recovery and stop conditions

- There is no UI force-refresh substitute for the release gate. If a host is stale, inspect the checked-in guidance in `docs/shared-factory.md` and use only the documented, operator-authorized host setup/recovery.
- Stop rather than resetting, overwriting, or manually editing a dirty or diverged Bazzite checkout. Stop as well when the host-local deployment inventory or target registry is missing, or when the timer/service cannot be verified.
- A remote-only automation sync does not deploy application or infrastructure files. Use the documented host deployment flow for Bazzite services and their bind-mounted configuration.
- For an empty generic repository, the full-layer verifier may report missing project-owned validation scripts or ignore rules. Record those as onboarding gaps and do not misrepresent a successful workflow registration as a clean application verification.

## Handoff report

Report the repository, `dev` branch result, target registration, seeded issue IDs, project-layer installation and feature flags, registered workflow names, PR/review state, promoted stable SHA/version, per-target synchronization result, Bazzite checkout/container parity, timer state, and the new project's enabled automation count. Call out any skipped repair or remaining human gate explicitly.
