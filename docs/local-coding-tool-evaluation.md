# Local coding-tool evaluation

Evaluated on 2026-10-03 from the Factory operator workstation.

## Aider

The operator environment has no `aider` or `aider-chat` executable. The
Factory already has a live local implementation path through OpenHands with
isolated worktrees, bounded iterations, event-backed validation, and retry
artifacts. Installing a second local coding runner would duplicate that
execution boundary without adding evidence-backed capability, so Aider is not
adopted at this stage. The separate repository-map experiment remains open if
future context pressure justifies it.

## Continue

The operator environment has no `continue` executable or checked-in Continue
configuration. Continue is therefore not useful for the current headless
Factory workflow: the deployed OpenHands Agent Server is the execution surface
and the local utility path already handles bounded tasks. A future interactive
editor workflow may revisit Continue; no dependency is added now.

This is a scope decision, not a claim that either tool is generally
incompatible with the Factory.

## Native Codex CLI

The installed Codex CLI was tested in bounded read-only mode on 2026-10-03
with the Mac mini OpenAI-compatible endpoint supplied as the base URL and the
local gateway credential kept in-process. The CLI started, but selected its
ChatGPT-account provider and rejected `qwen3.5-9b` with an unsupported-model
error before reading the repository. It also reported that the configured
ChatGPT MCP servers lacked usable credentials. This does not satisfy native
Codex repository exploration; the item remains open until Codex supports the
local endpoint through a compatible provider mode or a supported local
profile is configured.
