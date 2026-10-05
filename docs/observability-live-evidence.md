# Observability live deployment evidence

Captured 2026-10-03 on Bazzite.

- Prometheus: `docker.io/prom/prometheus:v2.55.1`, localhost port 9090, persistent volume `cezar-factory-prometheus-data`.
- Grafana: `docker.io/grafana/grafana:11.4.0`, localhost port 3003, persistent volume `cezar-factory-grafana-data`.
- Both run in the `cezar-factory-observability` Podman network.

## Live checks

- Prometheus `/-/ready`: HTTP 200, `Prometheus Server is Ready.`
- Prometheus target API: `vllm-mac-mini` is `up` for `192.168.86.60:8000`.
- Grafana `/api/health`: database `ok`, version `11.4.0`.
- Provisioned dashboard search returned `Cezar Factory Overview` in the `Factory` folder.
- Grafana’s provisioned `factory-prometheus` datasource health: `OK`.

The standalone proof deployment intentionally reports absent Compose-only services as down; the live vLLM target, datasource, dashboard provisioning, and both service health checks are the validated scope here.
