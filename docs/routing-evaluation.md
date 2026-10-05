# Routing evaluation

Evaluated on 2026-10-03 after the live local utility and OpenHands smoke
tests. The Factory has evidence for bounded local classification/summarization
jobs and a deterministic provider boundary for coding jobs, but it does not
yet have comparable subscription-agent success data: GitHub authentication and
Codex/Claude subscriptions are not connected.

The current deterministic routing policy is therefore justified. It keeps
bounded utility jobs local, sends implementation to the selected execution
provider, and records the selected worker without adding a learned router or
confidence-based fallback. Revisit sophisticated routing after premium-agent
comparisons exist.
