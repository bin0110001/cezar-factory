# Factory contributor instructions

For every change that modifies a Factory-managed asset (including `scripts/`,
`skills/`, `workflows/`, `policies/`, `templates/`, `automations/`, or Factory
versioning), validate the change and then use the `factory-release` skill to
push the new Factory version to all explicitly configured projects. Do not
silently leave a source-only Factory update.

Targets must be listed in the host-local `config/factory-projects.json` file or
explicitly supplied by the user. Do not scan drives for targets or deploy to an
unlisted project. If no target registry exists, create no external changes;
report that the release is ready but needs target configuration.
