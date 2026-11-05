# Latest failure repair

`factory-repair-latest-failure` selects the most recently completed failed run
in the current Cezar project, excluding its own workflow and the current task.
It does not select a backlog issue or start a replacement task. Use the existing
Cezar automation interface to queue `[factory] repair latest failure`; an agent
asked to run it queues its automation ID and reports the task ID.

The command controller checks `config/known-failures.json` before starting an
agent. Explicit transport errors, provider HTTP 429/502/503/504 responses and
service-unavailable diagnostics are operational: it records them and exits
successfully without a model call. Generic timeouts and exit code 1 remain
unknown. Assertion, syntax and type errors take precedence over operational
words so a test of network handling is not silently dismissed. Rules are
reviewed source changes; model-generated classifications do not add skip rules.

History lives in the project's persistent `.ai/cezar/failure-repair.sqlite`,
outside disposable task worktrees. Each fingerprint records classification,
occurrences, latest source run, attempt count, repair/review result, PR, and
deployment status. Run IDs, timestamps and artifact hashes are normalized while
error codes and source diagnostics remain significant. SQLite reserves one
attempt atomically. An interrupted or unsuccessful attempt remains visible and
does not regain its budget on the next hourly run. A repeated unknown error is
reported with its previous state and PR rather than charged another repair.

Unknown failures receive one bounded repair attempt through `codex exec` with the hosted
OpenAI provider explicitly selected and user provider configuration ignored.
The built-in provider chooses its official endpoint for the saved authentication
mode. The local gateway and task model defaults are not used. Existing saved
ChatGPT authentication is reused. The model runs read-only and returns a patch;
it is instructed to use no tools. The controller supplies tracked source ranges,
contributor instructions and a compact file catalog. It initially selects paths
from the failure; one additional request of at most eight 400-line ranges is
allowed. Each context collection is limited to 48,000 source characters and the
failure evidence to 12,000 characters. An attempt starts at most two hosted
invocations sharing one deadline. The default deadline is 900 seconds;
configuration permits 30–1200 seconds. Reported usage is stored
when available; an invocation limit is not a hard token quota.

## Host configuration

Copy `config/failure-repair.json.example` to host-local
`config/failure-repair.json` and replace the example paths with verified paths
available to the workflow process. Every project must also be explicitly listed
in `config/factory-projects.json`; project IDs are never discovered by scanning.
Both files are ignored by Git. Missing configuration stops before model spend.
`FACTORY_FAILURE_REPAIR_CONFIG` and `FACTORY_PROJECTS_REGISTRY` can supply their
absolute paths. Otherwise configuration follows `FACTORY_RUNTIME_SOURCE_ROOT`,
so immutable release artifacts still use the host-local configuration.

For each project, configure the repository, non-stable base branch and release
channel, trusted validation argv arrays, and deployment settings. The task must
use an isolated clean worktree. Its task branch may fast-forward to the current
configured base; divergent or unrelated commits stop the workflow. The workflow
does not reset or overwrite a mismatched checkout. Full Factory validation is the
example for cezar-factory. Tests and deployments are never selected by the LLM.

Factory deployments use `kind: factory` and the existing transactional release
activation controller. It stages the exact reviewed merge SHA, validates the
candidate, and reconciles **every explicitly registered project already on
dev**, including cezar-factory when it selects dev. Stable projects are skipped.
A verified dev pointer, configured release store and a cezar-factory project
selecting dev must exist before activation. The workflow does not convert
stable projects, bootstrap an untested channel or modify the host checkout.
An absent dev selection/pointer is a release blocker, not a successful deploy.
Factory runtime mount/parity requirements remain those in the release skill.

For application repositories, use `kind: commands` with explicit deployment
`commands` argv arrays. Each command must bind both `{channel}` and
`{mergeSha}` and follow that application's supported deployment contract.
Commands must be idempotent: an interrupted deployment is retried without
another LLM invocation. Stable deployment arguments are rejected.
Deployment reconciliation holds a per-history process lock so concurrent
invocations cannot deploy the same repair simultaneously.

## Review and delivery

The controller checks that the patch touches exactly its declared source files,
rejects protected paths, binary changes and renames, and uses Git's applicability
check before applying it. The hosted model cannot directly edit the worktree.
The controller then validates the exact file manifest, runs configured checks, and
only then commits and pushes the source changes. It opens a PR into the
configured non-stable branch. Other eligible maintainers are requested as
reviewers when available. In a solo-maintainer repository, the structured
self-review plus actual validation evidence satisfies the repository's gate;
unresolved findings stop publication. Auto-merge is requested with the validated
head SHA. CI and repository branch protections still apply.

The following deployment command, and subsequent hourly invocations, reconcile
pending PRs without a model call. A merged PR must retain its validated head/base
and complete passing CI before deployment. Closing a PR without merging records
that outcome. A failed publication after push is retried from its history
checkpoint. Failure during validation preserves the task's edits and does not
push or deploy them.

This run-failure workflow complements #105's verification-check repair loop.
It does not change that loop's routing or create competing failure-audit issues.
