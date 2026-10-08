# Factory contributor instructions

For every change that modifies a Factory-managed asset (including `scripts/`,
`skills/`, `workflows/`, `policies/`, `templates/`, `automations/`, or Factory
versioning), validate the change and then use the `factory-release` skill to
push the new Factory version to all explicitly configured projects. Do not
silently leave a source-only Factory update.

When an update is finished, invoke the `factory-finish-release` skill. It
orchestrates validation, configured-target synchronization, Bazzite checkout
and Cezar runtime parity checks, and the reviewed `dev` PR auto-merge handoff.
It must stop on failed validation, missing target configuration, dirty or
mismatched remote checkouts, or missing review gates rather than overwriting
state.

The default release pipeline is remote-only Cezar synchronization: read
`apiUrl` and `projectId` from `config/factory-projects.json` and synchronize
the Factory checkout's automation definitions directly to each Cezar project.
Use a local `projectPath` only as a fallback when a project must receive the
full `.ai/factory` installation (workflows, skills, policies, scripts, or
project pinning).

Remote-only synchronization does not deploy application or infrastructure
files from `integrations/`. For Bazzite-hosted services, use the explicit
deployment inventory in `config/server-topology.env` and run the supported
deployment script from the Bazzite Factory checkout. In particular, LiteLLM
uses its host-local bind-mounted config and must be redeployed/restarted after
changes to `integrations/bazzite/litellm-config.yaml`.

When a project needs the full Factory layer, add an absolute, verified local
`projectPath` to its registry entry and run a dry run first. Do not put a
remote container path in `projectPath`; the release script resolves that path
on the Windows host. If the checkout is only on Bazzite, record its remote
checkout and service-config paths in the deployment inventory/operations notes
and use the host deployment flow instead.

Targets must be listed in the host-local `config/factory-projects.json` file or
explicitly supplied by the user. Do not scan drives for targets or deploy to an
unlisted project. If no target registry exists, create no external changes;
report that the release is ready but needs target configuration.

After an update passes validation and independent review, the implementation PR
must target `dev` and request GitHub auto-merge. This applies to every approved
risk level; high-risk work still requires its human plan-approval and independent
review gates before auto-merge can be requested. Do not merge a failed,
unreviewed, or unresolved PR.
