# GPU exporter evaluation

Checked on 2026-10-03 against Bazzite host `192.168.86.69`.

- Hardware: AMD Rembrandt Radeon 680M integrated GPU (`e5:00.0`).
- Kernel device nodes: `/dev/dri/card1` and `/dev/dri/renderD128`.
- Available telemetry tool: `sensors`.
- Not installed: `nvidia-smi`, `rocm-smi`, `amd-smi`, `radeontop`, and
  `intel_gpu_top`.
- No GPU exporter container is currently running.

The official AMD SMI and ROCm device-metrics exporters are designed for AMD
server/datacenter or ROCm-managed environments; this host does not currently
provide the required userspace stack, and no compatible image has been
validated against the 680M iGPU. Prometheus/node-exporter and cAdvisor remain
deployed for host and container metrics. The GPU-exporter workplan item stays
open until a compatible exporter and driver stack are available.
