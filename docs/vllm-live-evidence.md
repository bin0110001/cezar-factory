# vLLM live evidence

Verified on 2026-10-02 against the Mac mini native service over the authorized
SSH connection.

- Host: `kyles-mac-mini.lan`
- Runtime: `/Users/caffeinator/.venv-vllm-metal/bin/vllm`
- OpenAI-compatible service: `127.0.0.1:8000`
- Served model: `qwen3.5-9b`
- Model root: `mlx-community/Qwen3.5-9B-5bit`
- Context length: 16,384 tokens
- vLLM fingerprint: `vllm-0.30.0-b92ab3af`
- GPU topology: integrated Apple M6 GPU, 12 GPU cores, Metal 4
- Unified memory: 16 GB

Checks performed:

- `/health` returned successfully.
- `/v1/models` returned the expected served model.
- A bounded chat completion with `max_tokens=16` and thinking disabled returned
  `READY` with `finish_reason=stop`.
- From the Bazzite network namespace, the live endpoint at
  `http://192.168.86.60:8000/v1/models` returned HTTP 200 with `qwen3.5-9b`.
  The `.62` wired address is reachable from the operator workstation but was
  not routable from Bazzite during this check.

Benchmark sample:

- Five sequential completions averaged 2.008 seconds; the slowest was 2.810
  seconds.
- Sequential aggregate generation was 13.94 completion tokens/sec.
- Four concurrent completions completed in 3.684 seconds wall time at 34.75
  aggregate completion tokens/sec; each request took about 3.683 seconds.
- vLLM process RSS increased from 59,024 KiB to 83,792 KiB during the
  sequential sample. This is a host-memory proxy, not a direct Metal VRAM
  measurement.
- The Mac reported 16 GiB total unified memory and 82% system-wide free memory
  after the sample; this is additional host telemetry, not a VRAM allocation
  measurement.
- A bounded coding capability check returned JSON containing a Python `add`
  function and assertion; the response parsed as JSON and compiled successfully
  without executing generated code. The selected coding model is
  `qwen3.5-9b`.
- On 2026-10-03, the launchd plist was restarted with
  `--enable-auto-tool-choice --tool-call-parser qwen3_xml`. A bounded request
  with `tool_choice=auto` returned HTTP 200 and a structured `tool_calls` entry
  for `live_tool` with `{"location":"Boston"}`. The prior `hermes` trial
  returned the model's XML as plain assistant text and was replaced by the
  Qwen-specific parser.
- A cached general-model candidate,
  `mlx-community/gemma-4-E4B-it-qat-4bit`, loaded successfully as `gemma-4`
  on temporary localhost port 8001 with a 4,096-token context. A bounded
  completion returned `GENERAL` in 0.992 seconds. It is now managed persistently
  by `com.vllm.gemma4.plist` on localhost port 8001, and the primary Qwen
  service remains healthy.
- Both model profiles have live benchmark evidence: Qwen has the five-request
  sequential and four-request concurrent measurements above; Gemma has the
  bounded 0.992-second completion and successful repeated completion requests
  in its launchd log. The samples are intentionally recorded as observed
  measurements, not a claim of statistically equivalent benchmark conditions.

Unified-memory footprint sample (2026-10-03):

- The live Qwen process (PID 30375) reported a 1,336 MB physical footprint
  through macOS `footprint`.
- Its recorded peak physical footprint was 4,164 MB during the process lifetime.
- `vm_stat` reported 16 GiB total unified memory and `memory_pressure` reported
  87% system-wide free memory during the sample.
- Apple Silicon exposes shared unified memory rather than a separate VRAM pool;
  these are the appropriate platform-level capacity and footprint measures, not
  a dedicated-VRAM allocation reading.

This verifies local inference readiness and records the available
platform-appropriate memory footprint. Dedicated-VRAM, multi-GPU, and
multi-node measurements remain inapplicable or pending for this single-GPU
Mac mini.

## Trusted proxy cutover

On 2026-10-03, the native Qwen service was moved from `0.0.0.0:8000` to
`127.0.0.1:8002` and placed behind the checked-in user-level launchd proxy
`com.vllm.trusted-proxy` on port 8000. The proxy allows the Bazzite client
`192.168.86.69/32` (plus loopback for local health checks) and requires the
configured bearer token.

Live checks:

- Mac-local non-allowlisted request: HTTP 403.
- Bazzite request without the bearer token: HTTP 401.
- Authenticated Bazzite `/health`: HTTP 200.
- Authenticated Bazzite `/v1/models`: HTTP 200 with `qwen3.5-9b`.
- Direct Bazzite request to Mac port 8002: connection refused.
- Authenticated LiteLLM completion through the proxy: HTTP 200.

The pre-cutover plist is retained at
`~/Library/LaunchAgents/com.vllm.qwen35.plist.codex-proxy-cutover` for
operator rollback. Proxy deployment is defined by
`scripts/deploy/deploy-vllm-trusted-proxy-mac.sh`.

The hardware report contains serial and device identifiers; those values are
intentionally not recorded in this repository.
