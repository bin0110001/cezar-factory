# Bazzite Cezar GitHub live evidence

Verified on 2026-10-04 against the Bazzite host `Chinchilla` at
`192.168.86.69`.

The active Cezar container is `cezar` (`localhost/cezar:local`). It includes
GitHub CLI and mounts the persistent `cezar-gh-config` volume at
`/home/cezar/.config/gh`. The container runs as UID 10001, while the empty
mounted directory was owned by UID 1001 and could not be written. The directory
owner was corrected to UID/GID 10001 and mode 0700. The GitHub token was then
stored with `gh auth login --with-token` over the verified SSH connection; no
token value is recorded in this repository.

Read-only verification from inside Cezar:

- `gh api user --jq .login` returned `bin0110001`.
- `gh api repos/bin0110001/cezar-factory --jq .full_name` returned
  `bin0110001/cezar-factory`.
- `gh api --method GET search/issues -f q='repo:bin0110001/cezar-factory is:issue'`
  returned `total_count: 0`.
- The persisted `hosts.yml` is owned by UID/GID 10001 with mode 0600.

The GitHub CLI auth fix is on Bazzite in Cezar's persistent config volume.
No issue, pull request, or other GitHub state was changed. The full issue/PR
lifecycle remains unverified. The separate OpenHands `default` agent profile
currently has no MCP server references, so this evidence covers Cezar's CLI
path only.

## 2026-10-27 runtime and automation profile snapshot

Read-only checks at 2026-10-27 07:29 UTC used the three targets explicitly
listed in the host-local `config/factory-projects.json` registry. The Cezar
automations endpoint reported:

| Target | Registered automations | Enabled | Notable disabled entries |
| --- | ---: | ---: | --- |
| `blackjackandhookersgadot` | 16 | 12 | Backlog reconciliation, failure audit, Godot upgrade, legacy default implementation route |
| `cezar-factory` | 17 | 14 | Backlog label audit, existing-issue intake, stale-workable refresh |
| `tableflux-animation-pipeline` | 14 | 12 | Backlog reconciliation, failure audit |

Across all three targets, the enabled definitions use Codex with
`factory-gateway/factory-code` for intake, investigation, fix review, and
maintenance; Claude `sonnet` for planning and review; and Codex with the
catalogued small/gateway, medium/`gpt-5.6-luna`, and large/`gpt-6.1-sol`
implementation variants. The legacy default implementation definition on
Blackjack is disabled. The API reports configured runner/model selections and
enabled flags; this does not prove provider authentication, capacity, or a
successful workflow run. Schedule enablement differs by project and is reported
above without inferring intent.

The Bazzite host `Chinchilla` reported a clean `stable` checkout at
`0185f0078984c6124e99d4d4c6f957b544f070a3`, version `0.3.53`. The active
`container-cezar.service` runs Cezar with the read-only bind mount
`/var/home/bin0110001/cezar-factory` → `/projects/cezar-factory`. Inside the
container, the mounted files also report version `0.3.53` and the host/container
content digest is identical (`493581820f96a8d0183254bbaed5ba1b4e75c20ce139fb2353486e133e087f44`),
but the container's Git metadata reports
`1eac4bf6d0bb726db87b4a8b472cee4da1339edf`. This differs from the host checkout
SHA and fails the exact-SHA parity rule in `docs/shared-factory.md`; matching
version and file content do not satisfy that rule. The autodeploy timer was
active and waiting, and its recent journal showed successful reconciliation at
the host's `0.3.53` revision. The discrepancy remains unresolved; no host or
container state was changed. The current development branch has not merged, so
its newer version is not expected on this runtime yet.
