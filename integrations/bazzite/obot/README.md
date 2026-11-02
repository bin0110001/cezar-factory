# Obot MCP gateway proof of concept

This is a standalone, reversible Obot evaluation service. It does not change
the Cezar, LiteLLM, vLLM, or main Bazzite Compose stacks. It runs Obot and a
pinned Caddy TLS reverse proxy. Obot uses its built-in PostgreSQL and file
storage. No Podman or Docker socket is mounted, so Obot cannot launch sibling
containers. The GitHub MCP server is configured as a remote service.

The Obot image is pinned to v0.27.0 by immutable registry digest. The Caddy
image is also pinned by version and digest. Review the official [Obot release
notes](https://github.com/obot-platform/obot/releases/tag/v0.27.0) before
changing its pin, and use a current supported Caddy release for proxy updates.

## Host placement and setup

Run these operator steps from the Factory checkout on the Bazzite control-plane
host. The deployment script reads `config/server-topology.env` and refuses to
run unless `obot` and `obot-https` are explicitly listed under
`FACTORY_CONTROL_PLANE_SERVICES`. It checks that Podman's active graphroot and
all Obot/Caddy data volumes are on the required secondary mount
`/var/mnt/podman`, so a future storage change cannot silently put them on the
primary drive.

Copy `env.example` to `.env`, set a random bootstrap token, and restrict the
file to the owning account:

```bash
cp integrations/bazzite/obot/env.example integrations/bazzite/obot/.env
chmod 600 integrations/bazzite/obot/.env
```

The POC uses sslip.io wildcard DNS for `obot.192.168.86.69.sslip.io`, which
resolves to the Bazzite LAN address, and
`https://obot.192.168.86.69.sslip.io:8443` for Obot. DNS lookups for this name
go to the configured DNS resolver and then sslip.io. The returned address is
private; no public listener or port forward is configured.
The deployment checks the DNS answer against the host topology address. Caddy
binds only to that LAN address on TCP 8443 and issues a certificate from its
persistent internal CA. Obot remains published only to `127.0.0.1:8787`.

Trust is explicit: Caddy's public root certificate is persisted at
`caddy/pki/authorities/local/root.crt` beneath the proxy data volume mountpoint.
Find the mountpoint with `podman volume inspect --format '{{.Mountpoint}}'
"$OBOT_PROXY_DATA_VOLUME"`. After deployment, copy that `root.crt` to the
Windows client over SSH and import it into the current user's Trusted Root
Certification Authorities store:

```powershell
Import-Certificate -FilePath .\root.crt -CertStoreLocation Cert:\CurrentUser\Root
```

Do not copy or export the CA private key. Verify the browser shows the
certificate as valid before registering the GitHub OAuth callback. Other LAN
clients need the same public root certificate installed in their own trust
store. `validate.sh` verifies the endpoint with Caddy's root certificate and
checks that the proxy listener is bound to the Bazzite LAN address, not a
wildcard address.

After setting `.env`, deploy and validate with:

```bash
integrations/bazzite/obot/deploy.sh
integrations/bazzite/obot/validate.sh
```

The deployment checks both version-plus-digest pins, host inventory, the local
control-plane address, DNS resolution, the LAN-only TLS bind, the loopback app
listener, and secondary storage mount before creating anything. Health is
checked at `/api/healthz`. The validate command reports actionable failures
without printing container logs, because logs may contain sensitive payloads.
If validation fails, inspect logs locally and remove tokens and request bodies
before sharing excerpts.

## GitHub MCP configuration

In Obot, add the official remote server as
`https://api.githubcopilot.com/mcp/x/repos/readonly`. This selects the repos
toolset and enforces read-only mode upstream. Add it to a new vMCP and expose
only `get_file_contents` for the smoke test, against a public repository.
Do not grant write tools or add a private repository for this POC. Obot's vMCP
tool selection is the gateway allow-list; the GitHub endpoint's read-only path
is a second restriction. GitHub OAuth scopes remain an upstream capability, so
request only the scopes needed by the public-repository read test.

The GitHub MCP OAuth flow requires a dedicated OAuth App and a client secret.
Obot stores those credentials in its database; enter them only in the Obot UI,
never in this repository or `.env`. Set the OAuth App callback URL to
`https://obot.192.168.86.69.sslip.io:8443/oauth/mcp/callback` and leave
wildcard callback matching disabled. The browser must trust the Caddy internal
CA for the entire authorization flow. Do not relax Obot's remote-network
protections or expose the unauthenticated UI to work around callback errors.

Use the Obot vMCP connection instructions to obtain the endpoint and connect a
fresh isolated MCP client. Verify that it lists only the selected read-only
tool, calls that tool successfully, and cannot invoke an unselected tool. In
Obot, record the call in MCP audit metadata. Do not grant the Auditor role for
the test; that role can view full request/response bodies. Keep profile grants
limited to the test user and vMCP.

For failures, distinguish the boundary before changing settings:

- Obot unavailable: check both container states, then `/api/healthz`, DNS, and
  the LAN TLS listener.
- Login or callback failure: compare the callback URL in Obot, GitHub, and the
  browser address; do not enable wildcard callback matching.
- GitHub MCP connection failure: test remote server reachability from Obot,
  then reauthenticate the upstream connection. A broker outage should return
  an Obot connection error; it must not fall back to direct GitHub credentials
  in the client.
- A missing tool: review vMCP component selection and tool grants. Do not add
  broad tool access to mask a missing permission.

## Data, backups, upgrades, and rollback

The `cezar-factory-obot-poc-data` volume contains the embedded database and
persistent files. The proxy data volume contains Caddy's CA and TLS state; the
proxy config volume preserves Caddy's saved config. All are under Podman's
graphroot on the secondary disk. Before an upgrade, stop the service and
export the volumes to a protected backup location:

```bash
podman compose --project-name cezar-factory-obot-poc \
  --env-file integrations/bazzite/obot/.env \
  -f integrations/bazzite/obot/compose.yaml down
install -d -m 700 /var/mnt/podman/obot-backups
podman volume export cezar-factory-obot-poc-data \
  --output /var/mnt/podman/obot-backups/obot-data-before-upgrade.tar
podman volume export cezar-factory-obot-poc-proxy-data \
  --output /var/mnt/podman/obot-backups/obot-proxy-data-before-upgrade.tar
podman volume export cezar-factory-obot-poc-proxy-config \
  --output /var/mnt/podman/obot-backups/obot-proxy-config-before-upgrade.tar
chmod 600 /var/mnt/podman/obot-backups/obot-data-before-upgrade.tar
chmod 600 /var/mnt/podman/obot-backups/obot-proxy-data-before-upgrade.tar
chmod 600 /var/mnt/podman/obot-backups/obot-proxy-config-before-upgrade.tar
```

Protect and copy the archive to a separate backup device; the secondary disk
alone does not protect against disk failure. Restore only while the stack is
stopped and into empty volumes. Preserve the previous volumes until the
restored service passes `/api/healthz`, login, vMCP discovery, and a read-only
GitHub call. For rollback, restore the prior image digests in `.env`, then
start the service and validate. If the newer release migrated the database, restore the
pre-upgrade volume instead of assuming the old image can read the migrated
data.

To restore without overwriting the current volume, create a new empty volume,
import the stopped-volume archive, and point `.env` at that new volume before
starting Obot:

```bash
podman volume create cezar-factory-obot-poc-restore
podman volume import cezar-factory-obot-poc-restore \
  /var/mnt/podman/obot-backups/obot-data-before-upgrade.tar
podman volume create cezar-factory-obot-poc-proxy-restore
podman volume import cezar-factory-obot-poc-proxy-restore \
  /var/mnt/podman/obot-backups/obot-proxy-data-before-upgrade.tar
podman volume create cezar-factory-obot-poc-proxy-config-restore
podman volume import cezar-factory-obot-poc-proxy-config-restore \
  /var/mnt/podman/obot-backups/obot-proxy-config-before-upgrade.tar
# Point all three *_VOLUME variables at the restored volumes in .env.
integrations/bazzite/obot/deploy.sh
integrations/bazzite/obot/validate.sh
```

Keep the original volumes until restore validation passes. Podman volume
import merges archive files into an existing volume, so always restore into
new volumes rather than importing over current data.

To upgrade, update `OBOT_IMAGE` to an audited version and immutable digest,
validate the Compose configuration, run `deploy.sh`, then run `validate.sh`.
Do not use floating tags such as `latest`.

`teardown.sh` removes only the POC containers and network and preserves all
data volumes. To remove data as well, use `teardown.sh --purge-data` and
confirm the exact POC volume names at the prompt. Back up first.

## Measurement and decision record

Capture before/after host free space on `/var/mnt/podman`, Obot and Caddy CPU
and memory (`podman stats --no-stream cezar-factory-obot-poc
cezar-factory-obot-poc-https`), and container restart counts. Compare the
observed footprint and the isolation
trade-off with Obot's Kubernetes deployment and a direct GitHub MCP client.
Obot's Docker evaluation guidance sizes a host at 2+ CPU cores, 4 GB RAM, and
10 GB free disk; keep this small LAN-only POC separate from production until
the live OAuth and isolated-client evidence supports a written go/no-go.

### Security and alternatives

- Allowed for the POC: the authenticated Obot UI and one user-scoped vMCP with
  one selected read-only GitHub MCP tool against a public repository.
- Denied: all GitHub write tools, private repositories, other vMCP components,
  direct agent-to-GitHub fallback, and the Docker/Podman runtime socket.
- Credential boundary: GitHub OAuth client credentials are stored through the
  Obot UI in its persistent data store. No PAT, OAuth secret, or client token
  is written to Git, `.env`, shell arguments, or deployment logs.
- Audit boundary: keep the Auditor role unassigned; it can access full request
  and response bodies. Share only sanitized container diagnostics and Obot
  audit metadata.
- Caddy drops all Linux capabilities except `NET_BIND_SERVICE`. The official
  Caddy image marks its binary with that file capability; keeping
  `no-new-privileges` enabled prevents the binary from starting. Caddy listens
  on unprivileged port 8443 and binds only to the configured LAN address.
- The read-only Caddyfile bind mount uses the shared SELinux `z` label so the
  host and Cezar's read-only Factory checkout can both read it. A private `Z`
  label prevents the mounted Cezar runtime from verifying the promoted tree.
- Caddy's exclusive named data and config volumes use private `Z` relabeling
  so Podman updates their SELinux category when it recreates the proxy.
- Direct GitHub MCP client: fewer services and less operational overhead, but
  does not provide Obot's central vMCP selection, profile grants, or gateway
  audit boundary.
- Obot's Docker evaluation deployment: supports local hosted MCP servers, but
  its documented host socket exposes host-level container management. This
  POC uses only a remote GitHub MCP entry and mounts no runtime socket.
- Obot Kubernetes deployment: offers stronger workload isolation through
  pod security and network policy, with a larger operations footprint. No
  Kubernetes cluster is included in the configured Factory topology.

Decision status: **pending live deployment evidence**. Fill in the release
digest, disk delta, peak CPU/memory, HTTPS callback result, OAuth scopes,
allowed/denied tool results, and broker-outage diagnostics before recording a
go/no-go. Production integration remains out of scope for this POC.
