# Cezar Factory getting started

This guide is a reusable setup path for a new Factory deployment. It uses
three logical roles:

- **operator workstation**: the machine used to edit configuration and run
  deployment commands;
- **control-plane host**: runs Cezar, OpenHands, the gateway, memory, and
  observability services;
- **model host**: runs the local vLLM-compatible model endpoint.

The control-plane and model roles may be separate machines or the same trusted
host. Keep the role boundary explicit even when they share hardware.

## 1. Prepare the hosts

Install the tools required by the selected deployment method:

- Git and a shell capable of running Bash scripts;
- PowerShell 7 when using the Windows project-installation scripts;
- Podman and Podman Compose on the control-plane host, or a configured Podman
  remote connection from the operator workstation;
- Python 3 on the control-plane host for the OpenHands adapter and validators;
- SSH key authentication from the operator workstation to both hosts;
- a native vLLM runtime appropriate for the model host.

Use stable hostnames or documented addresses for the two hosts. Confirm that
the operator can reach the control-plane host over SSH and that the
control-plane host can reach the model endpoint over the trusted network.

Do not expose model, gateway, Agent Server, database, or observability ports
to the public Internet.

## 2. Install Factory files into a project

From the Factory checkout:

```powershell
./scripts/install.ps1 -ProjectPath ../my-project -ProjectType <project-type>
```

Add the project-specific validation scripts expected by the installed
workflow, then ensure the project’s generated state directory is ignored by
Git. Verify the installation:

```powershell
./scripts/verify.ps1 -ProjectPath ../my-project
```

Create the Factory labels and paused automations after Cezar is available:

```powershell
pwsh ../my-project/.ai/factory/scripts/create-labels.ps1
pwsh ../my-project/.ai/factory/scripts/sync-automations.ps1
```

Keep automations paused until the deployment and provider smoke tests pass.

## 3. Configure secrets and host-local settings

Copy, but never commit, the environment templates:

```bash
cp integrations/bazzite/env.example integrations/bazzite/.env
cp integrations/mac-mini/vllm/env.example integrations/mac-mini/vllm/.env
```

Fill in host-local values for:

- pinned container image references;
- Cezar project and API settings;
- OpenHands session authentication;
- gateway and memory credentials;
- model IDs, runtime paths, and context limits;
- trusted host addresses and allowed client ranges.

Use a host secret manager, Podman secrets, or protected environment files.
Do not place API keys, OAuth tokens, subscription files, or bearer tokens in
the repository, job fixtures, logs, result JSON, or screenshots.

Before deployment, confirm that example values and placeholder registry names
have been replaced and that the filled files are ignored by Git.

## 4. Deploy the model host first

The model host should serve an OpenAI-compatible endpoint on the trusted
network. Prefer native service management for model serving when the host
runtime requires it; do not run the model inside an unrelated control-plane
container.

Deploy and validate the default model profile:

```bash
./scripts/deploy/deploy-vllm-mac.sh
./scripts/deploy/deploy-vllm-mac.sh --validate-only
```

Use the general-model profile only when the host has enough memory:

```bash
./scripts/deploy/deploy-vllm-mac.sh --profile general
./scripts/deploy/deploy-vllm-mac.sh --profile general --validate-only
```

Record the model ID, runtime flags, hardware topology, context limit, startup
time, latency, throughput, and peak memory. A successful `/health` check is
not sufficient; also validate `/v1/models` and one authenticated completion.

### Optional trusted proxy

If the native model server does not provide authentication, bind it to
loopback and put the checked-in trusted proxy in front of it. Allow only the
control-plane host’s network identity and require a bearer token:

```bash
VLLM_PROXY_API_KEY=<host-local-secret> \
VLLM_PROXY_ALLOWED_CLIENT=<CONTROL_PLANE_CIDR> \
VLLM_BACKEND_PORT=<LOOPBACK_PORT> \
./scripts/deploy/deploy-vllm-trusted-proxy-mac.sh
```

Validate both unauthenticated rejection and authenticated success:

```bash
VLLM_PROXY_API_KEY=<host-local-secret> \
./scripts/deploy/validate-vllm-trusted-proxy-mac.sh
```

Keep the proxy credential aligned with the control-plane gateway credential,
without committing either value.

## 5. Deploy the control plane

Configure the operator workstation’s Podman connection, if deployment is
remote. The connection must target the control-plane host, not the model host
or a local Podman VM.

Deploy and validate:

```bash
./scripts/deploy/deploy-bazzite.sh
./scripts/deploy/deploy-bazzite.sh --validate-only
```

The deployment should expose only the intended trusted-LAN operator surface.
Keep OpenHands Canvas loopback-bound by default. For temporary configuration
from another trusted workstation, set the host-local bind address to the
trusted LAN interface, redeploy, configure the service, and restore loopback
binding immediately afterward.

Validate the complete service set: Cezar, OpenHands, the gateway, memory,
Langfuse, Prometheus, and Grafana. Confirm that the gateway can reach the
model host and that the model host cannot be reached from outside the trusted
network.

### LiteLLM Admin UI access

The deployment does not create a separate LiteLLM user database account. The
default Admin UI credentials are:

- username: `admin`;
- password: the host-local `LITELLM_MASTER_KEY`.

The model-host credential (`VLLM_API_KEY`) is not the LiteLLM UI password. By
default the gateway UI is bound to loopback. From an operator workstation,
use an SSH tunnel to the control-plane host, then open the local URL:

```bash
ssh -N -L <LOCAL_PORT>:127.0.0.1:<LITELLM_PORT> \
  <CONTROL_USER>@<CONTROL_PLANE_HOST>
```

Open `http://127.0.0.1:<LOCAL_PORT>/ui` and sign in as `admin` with the
master key. The Bazzite deployment exposes LiteLLM on `<LITELLM_PORT>` `4001`
and keeps the container-internal service port at `4000`. Do not use an
unrelated LiteLLM instance on the same host. Keep the tunnel private and never
paste the master key into a
browser URL, issue, log, or screenshot. LiteLLM documents the master key as
the proxy admin credential and Admin UI password.

The gateway template is intentionally a lightweight, config-file-backed
deployment and provisions a dedicated internal LiteLLM PostgreSQL database.
Keep `LITELLM_DATABASE_URL`, `LITELLM_DB_PASSWORD`, and
`LITELLM_SALT_KEY` host-local. The database is not published to the network;
back it up and test restoration as part of operations. If an older deployment
returns `no_db_connection`, redeploy the updated stack and confirm the
`litellm-db` health check before relying on the Admin UI.

If you do not know the current value, use the repository helper from
PowerShell. It logs into the control-plane host through SSH and extracts only
the named variable from the host-local env file:

```powershell
./scripts/deploy/Get-LiteLLMMasterKey.ps1 -CopyToClipboard
```

The helper prompts for the SSH host, user, optional identity configured in
your SSH client, and the absolute path to the LiteLLM env file. It does not
print the env file or any other variables. Clear the clipboard after signing
in. If the key is unavailable, rotate it through the deployment secret
process and restart the LiteLLM service rather than committing a replacement
to the repository.

## 6. Initialize OpenHands persistence

The persistent OpenHands project workspace must already be a valid, clean Git
worktree before any job requests `worktree=true`.

Clone or seed the project into the persistent workspace using the account that
the OpenHands runtime uses. Do not assume that a mounted volume contains a
repository merely because the directory exists. Then run:

```bash
./scripts/deploy/validate-openhands-workspace.sh
```

When the project must have a configured remote, use:

```bash
./scripts/deploy/validate-openhands-workspace.sh --require-origin
```

The validator must report a valid `HEAD` and a clean status. This step avoids
the common failure where worktree creation fails with an invalid reference.

## 7. Configure OpenHands agents and MCP

Use the Canvas configuration surface to create provider profiles. Keep the
following concerns separate:

- **local profile**: points to the authenticated local gateway/model endpoint;
- **Codex profile**: uses the existing supported subscription or ACP login;
- **Claude profile**: uses the existing supported subscription or ACP login;
- **MCP configuration**: points to GitHub and any approved memory/tools.

Do not put premium API keys into the Cezar adapter. The adapter should pass a
profile identifier and let OpenHands resolve provider authentication
server-side. For local jobs, route through the gateway to the model host and
keep the gateway credential in the host environment.

After creating or changing a profile, run the ACP readiness check:

```bash
./scripts/deploy/validate-openhands-acp.sh
```

Use `--require-ready` only when an authenticated ACP profile is expected:

```bash
./scripts/deploy/validate-openhands-acp.sh --require-ready
```

The check distinguishes installed ACP runtimes from an authenticated ACP
profile; installed executables alone do not prove provider connectivity.

## 8. Run the local smoke test first

Before using premium providers or changing GitHub state, run a bounded local
job through the checked-in adapter. Use a read-only task, a finite iteration
limit, and an explicit validation command:

```bash
python3 scripts/openhands/run-job.py \
  --request tests/fixtures/openhands-job-request.json \
  --output /tmp/factory-local-result.json \
  --workspace <OPENHANDS_PROJECT_WORKSPACE> \
  --llm-base-url <LOCAL_GATEWAY_BASE_URL> \
  --max-iterations 20 \
  --max-attempts 1 \
  --timeout-seconds 300
```

Provide the session and local gateway credentials through environment
variables, not command-line arguments:

```bash
export OPENHANDS_AGENT_SERVER_URL=<OPENHANDS_SERVER_URL>
export OPENHANDS_SESSION_API_KEY=<OPENHANDS_SESSION_SECRET>
export OPENHANDS_LLM_API_KEY=<LOCAL_GATEWAY_SECRET>
export OPENHANDS_LLM_MODEL=<LOCAL_MODEL_NAME>
```

The result should be compact, validation-backed, and include status, branch,
attempt count, duration, model, and coarse usage when the provider supplies
it. Inspect the event-backed validation and preserve failure artifacts.

## 9. Connect Cezar and enable automation gradually

Cezar should remain the lifecycle authority. The provider boundary should
receive a validated issue, task, risk classification, branch, and bounded
validation command, then return a compact result. OpenHands owns the session,
worktree, tool trace, and provider-side artifacts.

Enable automation in this order:

1. Factory self-tests and schema validation.
2. Local OpenHands read-only smoke test.
3. Local bounded implementation test in an isolated worktree.
4. Failed-task recovery and bounded retry test.
5. Premium profile read-only test.
6. One low-risk GitHub issue and its branch/PR lifecycle.
7. Concurrent isolated jobs only after the single-job path is reliable.

Do not enable unattended premium or GitHub-mutating automation until the
previous stage has recorded evidence.

## 10. Final validation checklist

Run the repository test suite:

```powershell
powershell -ExecutionPolicy Bypass -File tests/run-tests.ps1
```

Run the cross-host validation after setting the operator-specific SSH
targets:

```bash
export BAZZITE_SSH_TARGET=bazzite
export MAC_MINI_SSH_TARGET=<MODEL_USER>@<MODEL_HOST>
./scripts/deploy/validate-remote.sh
```

On the configured Windows workstation, `bazzite` is the SSH alias for the
Bazzite host and uses the saved key at `~/.ssh/vps_deploy_key`. See
[`integrations/deployment/README.md`](../integrations/deployment/README.md#ssh-access-to-bazzite-from-windows)
for the connection setup and the `connections/SSH_into_Bazzite.bat` launcher.

Confirm all of the following before calling the deployment ready:

- health endpoints and authenticated model requests pass;
- OpenHands persistence has a clean Git `HEAD`;
- local adapter jobs succeed within configured bounds;
- failure and retry artifacts are actionable;
- memory recall/retain and observability metadata are verified;
- premium profiles reach the LLM before enabling GitHub tools;
- GitHub authentication is valid before creating issues or pull requests;
- LAN exposure is intentional and no public exposure exists;
- secrets do not appear in Git, logs, fixtures, or result artifacts.

## Remaining manual gates

Some workplan items cannot be completed by repository changes alone:

1. Authenticate Codex through a supported OpenHands profile or ACP provider.
2. Authenticate Claude Code through its supported profile or ACP provider.
3. Configure and verify GitHub MCP or CLI credentials, then run a real
   low-risk issue through branch, validation, and pull-request completion.
4. Run Codex and Claude concurrently only after each single-provider path
   succeeds.
5. Add a second compatible GPU or node before testing tensor parallelism,
   replicas, Ray, multi-node serving, or node recovery.
6. Revisit native editor/client integrations only if the measured workflow
   demonstrates a real context or throughput gap.

Record the output of each manual gate beside the relevant workplan item. Do
not mark a gate complete from configuration alone; require a successful,
observable runtime result.
