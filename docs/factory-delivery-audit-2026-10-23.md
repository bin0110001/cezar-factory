# Factory delivery state audit — 2026-10-23

Scope: read-only source and Bazzite/Cezar runtime audit for issue #61. Host evidence was collected over the configured `bazzite` SSH alias. Cezar inspection was limited to the three project IDs in `config/factory-projects.json`. No host, container, project, timer, registry, or automation state was changed.

## Findings

| Area | Observed state | Delivery implication |
| --- | --- | --- |
| Source checkout | Bazzite `/var/home/bin0110001/cezar-factory` is clean on `stable` at `418585a2b74497f4c9bf8c231695892e63bb8ddc`, Factory `0.3.44`. This matches `origin/stable`; local `origin/dev` is 49 commits ahead. | Shared runtime is pinned to the older stable line; it does not follow current `dev`. |
| Autodeploy | `factory-autodeploy.timer` is active with a five-minute cadence. The service is inactive between runs and its last result was `success` at 16:58 EDT. The last 40 journal lines show repeated “already at origin/stable” runs and no `BLOCKED` message. | Timer health shows successful reconciliation attempts, not freshness relative to `dev`. |
| Container and mount | Container `cezar` is running `localhost/cezar:local`. The `/projects` volume is mounted; the Factory checkout is separately bind-mounted read-only at `/projects/cezar-factory`. `.ai/cezar` runtime state is a distinct volume at `/projects/cezar-factory/.ai/cezar`. | Runtime files and project files have different persistence and ownership boundaries. |
| Runtime identity | Bazzite SSH identity is `bin0110001` (UID/GID 1000). The Cezar process is UID/GID 10001. The shared Factory mount is root-owned and read-only in the container. | Any future controller must account for host-owned release state and the unprivileged Cezar reader. |
| Runtime source | Inside Cezar, `/projects/cezar-factory` resolves to the same Git SHA as the host checkout. `FACTORY_RUNTIME_ROOT=/projects/cezar-factory`; `CEZ_SHARED_WORKFLOWS_DIRS` and `CEZ_SHARED_SKILL_DIRS` were not present in the running container environment. | The runtime root is mounted, but the process environment does not advertise shared workflow/skill roots. Resolve effective loader configuration before cutover. |
| Loader precedence and image identity | The source at `origin/dev` (`9da0d0a`) loads `.ai/cezar/workflows` before configured shared workflow directories, so local same-name files win. Skills load project `.ai/cezar/skills`, `.ai/skills`, agent mirrors, and global skills before the operator-mounted shared catalog. The live container has no shared directory variables and uses image digest `d32ddaffe261412fbd9085ea1615fca7095dbf29fc5a1721fcd885d46523bdbe`; its OCI version/revision labels are empty. | In the audited source implementation, Tableflux's local copies take precedence and the shared catalog is not configured in the current process environment. The image cannot be tied to that source commit from available labels, so exact running-code provenance remains unknown. |
| Registry | Three targets are configured: `blackjackandhookersgadot`, `cezar-factory`, and `tableflux-animation-pipeline`. Each has `remote-cezar-plus-bazzite-host` deployment metadata. None declares a Factory `mode` or a `channel`. | No target is explicitly assigned to `dev`/`stable`; shared versus copied installation is not represented in the registry. |
| Project paths | `/projects/blackjackandhookersgadot` is absent. `/projects/cezar-factory` exists as the read-only Factory checkout. `/projects/tableflux-animation-pipeline` exists on the `/projects` volume and is owned by UID/GID 10001. | Registry membership does not guarantee a corresponding mounted local project directory. The missing path needs investigation before migration. |
| Tableflux shadows | Tableflux contains `.ai/factory` files including `factory.config.yaml`, `factory-startup.ps1`, and `audit-factory-failures.ps1`; it also contains seven `factory-*` workflow files and seven `factory-*` skill directories under `.ai/cezar`. | Project-local Factory copies remain and can shadow or diverge from the shared tree. Their contents and ownership history were not modified or inferred. |
| Automation receipts | Tableflux `.ai/cezar/automation-receipts.ndjson` contains 428 records: 417 `launched`, 7 `launch-error`, and 4 `reserved`. | These are automation execution receipts, not proof of artifact activation or runtime parity. The seven launch errors need their own bounded investigation. |
| Release receipts | No immutable artifact manifest, per-target deployment receipt, or desired/actual/observed SHA record was found in the searched Factory `.factory` and `.ai` paths. The existing push script reports `RELEASE_STATUS synchronized` when Cezar accepts automation definitions. | Current success evidence stops at API acceptance and cannot prove that a particular Factory SHA is active in a project. |

## Per-target readiness

| Project ID | Configured deployment | Local path | Channel / mode | Readiness |
| --- | --- | --- | --- | --- |
| `blackjackandhookersgadot` | Remote Cezar + Bazzite | Missing at `/projects/blackjackandhookersgadot` | Not set | Blocked on identifying its actual project storage and determining whether copied Factory content exists. |
| `cezar-factory` | Remote Cezar + Bazzite | Shared Factory checkout at `/projects/cezar-factory` | Not set | Runtime source is visible read-only; shared workflow/skill roots are not advertised in process environment. |
| `tableflux-animation-pipeline` | Remote Cezar + Bazzite | Present at `/projects/tableflux-animation-pipeline` | Not set | Existing `.ai/factory`, workflow, and skill shadows need a reviewed, ownership-aware migration plan. |

## Remediation matrix

| Priority | Action | Guard / evidence needed |
| --- | --- | --- |
| 1 | Resolve the high-risk release orchestration plan and receipt format tracked by #29. | Human approval of the recorded plan; preserve refusal behavior for dirty or mismatched checkouts. |
| 2 | Define the immutable manifest and deployment receipt contract (#62) before writing activation logic. | Full source SHA, verified checksums, explicit compatibility outcome, and per-target observed state. |
| 3 | Establish channel and installation mode for each registered project. | Registry-backed decision; do not infer channels or scan for additional targets. |
| 4 | Locate the registered Blackjack project and inspect its Factory shadows. | Use the configured Cezar project identity and approved storage mapping; do not create a replacement directory. |
| 5 | Inventory Tableflux project-local copies and distinguish managed shadows from project-owned modifications. | Compare content and ownership markers before any migration/removal. |
| 6 | Add artifact and target receipts, then test failure and recovery cases before cutover. | Receipt SHA must match the tested artifact; tests use fake host/API targets and do not mutate Bazzite. |
| 7 | Investigate the seven automation `launch-error` records. | Separate automation launch failure from artifact verification or deployment failure. |

## Limits

- This is a point-in-time inspection. The timer can change state after collection.
- Loader precedence is confirmed from the repository source at `origin/dev`, but the running Cezar image has no source revision label; exact binary-to-source parity remains unverified.
- The container exposes no `dev`/`stable` channel setting in the target registry, and no immutable deployment record was observed; no channel assignment or deployment success is inferred.
- Automation receipt records were summarized by status only. Run IDs and receipt payloads are intentionally omitted.
- The audit did not inspect or change other projects, hosts, containers, or filesystems.
- Issue #29 remains `factory:needs-help` pending explicit approval of its high-risk plan. This report supplies evidence but does not satisfy that gate.
