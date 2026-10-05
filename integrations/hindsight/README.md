# Hindsight integration contract

Hindsight runs on Bazzite and is reached only from the trusted Factory network.
The Factory uses separate memory banks for shared operational knowledge and
project-specific knowledge. Credentials are supplied through the host-local
environment; they are never committed here.

The Cezar planning and investigation stages should request a bounded recall,
include the queried bank in their structured evidence, and retain only durable
lessons after successful resolution. Transcripts, source files, raw logs, and
temporary task state are excluded by policy.

`scripts/hindsight/client.py` uses Hindsight's built-in single-bank MCP
endpoint (`/mcp/{bank}/`) for the `recall` and `retain` tools. Recall is
best-effort and writes only the bounded, redacted recall artifact; an absent
runtime, authorization failure, timeout, or malformed response becomes an
observable `unavailable` miss. Retain requires the wrapper's explicit
`-Approved` switch and emits a compact receipt rather than a raw response.
