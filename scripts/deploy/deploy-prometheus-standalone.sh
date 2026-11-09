#!/usr/bin/env bash
set -Eeuo pipefail

# Deploy Prometheus, and the blackbox exporter that probes Cezar and LiteLLM liveness, on the Bazzite host as
# systemd-managed Quadlet containers.
#
# Why this exists instead of deploy-bazzite.sh: on this host Cezar, LiteLLM and Hindsight run as standalone
# containers, and the compose monitoring stack (Prometheus, Grafana, Vault, OpenHands, Langfuse) is stopped.
# deploy-bazzite.sh would start all of it. This script starts only Prometheus, scraping what really exists, and
# makes it a user systemd service so it comes back after a reboot (user lingering must be on) and after a crash.
#
# Run it from the Bazzite Factory checkout:  scripts/deploy/deploy-prometheus-standalone.sh [--validate-only|--down]

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
. "$ROOT_DIR/scripts/deploy/lib-topology.sh"
load_factory_topology "$ROOT_DIR"

STACK_DIR="$ROOT_DIR/integrations/bazzite"
SRC_DIR="$STACK_DIR/standalone"
ENV_FILE="$STACK_DIR/.env"
STATE_DIR="${FACTORY_PROMETHEUS_STATE_DIR:-$HOME/.local/share/cezar-factory/prometheus}"
CONFIG_DIR="$STATE_DIR/config"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
UNIT_NAME="factory-prometheus"
BLACKBOX_UNIT="factory-blackbox"
BLACKBOX_DIR="$STATE_DIR/blackbox"
LISTEN="127.0.0.1:9090"
VALIDATE_ONLY=0
DOWN=0

for arg in "$@"; do
  case "$arg" in
    --validate-only) VALIDATE_ONLY=1 ;;
    --down) DOWN=1 ;;
    -h|--help) echo "Usage: deploy-prometheus-standalone.sh [--validate-only|--down]"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v podman >/dev/null || { echo "podman is required" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemctl is required" >&2; exit 1; }

env_value() { # env_value NAME -> value from the host-local .env, empty when absent
  [[ -f "$ENV_FILE" ]] || return 0
  grep -E "^${1}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

if (( DOWN )); then
  systemctl --user stop "$UNIT_NAME.service" "$BLACKBOX_UNIT.service" 2>/dev/null || true
  rm -f "$UNIT_DIR/$UNIT_NAME.container" "$UNIT_DIR/$BLACKBOX_UNIT.container"
  systemctl --user daemon-reload
  echo "stopped and removed $UNIT_NAME and $BLACKBOX_UNIT (data volume factory-prometheus-data kept)"
  exit 0
fi

# Image: the same pin the compose stack uses, fully qualified so a rootless pull never prompts for a registry.
IMAGE="$(env_value PROMETHEUS_IMAGE)"
IMAGE="${IMAGE:-prom/prometheus:v2.55.1}"
[[ "$IMAGE" == */*/* || "$IMAGE" == *.*/* ]] || IMAGE="docker.io/$IMAGE"
BLACKBOX_IMAGE="$(env_value BLACKBOX_IMAGE)"
BLACKBOX_IMAGE="${BLACKBOX_IMAGE:-prom/blackbox-exporter:v0.25.0}"
[[ "$BLACKBOX_IMAGE" == */*/* || "$BLACKBOX_IMAGE" == *.*/* ]] || BLACKBOX_IMAGE="docker.io/$BLACKBOX_IMAGE"

# --- render the config directory (a fresh copy every run; the unit mounts it read-only) --------------------------
mkdir -p "$CONFIG_DIR"
cp "$SRC_DIR/prometheus.yml" "$CONFIG_DIR/prometheus.yml"
cp "$STACK_DIR/prometheus-alerts.yml" "$CONFIG_DIR/prometheus-alerts.yml"
printf '[\n  {"targets": ["%s"], "labels": {"role": "model-host"}}\n]\n' "$FACTORY_VLLM_METRICS_TARGET" \
  > "$CONFIG_DIR/model-targets.json"

# The model-host proxy demands a bearer token on /metrics. A missing key renders a placeholder: the scrape is then
# a visible 401 rather than a config Prometheus refuses to load. World-readable because the container user differs;
# the value is the LAN-only vLLM proxy key.
vllm_key="$(env_value VLLM_API_KEY)"
printf '%s' "${vllm_key:-unset}" > "$CONFIG_DIR/vllm-token"
chmod 0644 "$CONFIG_DIR/vllm-token" "$CONFIG_DIR/prometheus.yml" "$CONFIG_DIR/prometheus-alerts.yml" "$CONFIG_DIR/model-targets.json"
chmod 0755 "$STATE_DIR" "$CONFIG_DIR"

mkdir -p "$BLACKBOX_DIR"
cp "$SRC_DIR/blackbox.yml" "$BLACKBOX_DIR/blackbox.yml"
chmod 0755 "$BLACKBOX_DIR"
chmod 0644 "$BLACKBOX_DIR/blackbox.yml"

# --- validate with promtool from the very image that will run it (config AND rules) ------------------------------
echo "validating config and alert rules with promtool ($IMAGE)"
podman run --rm --network none --entrypoint promtool -v "$CONFIG_DIR:/etc/prometheus:ro,Z" "$IMAGE" \
  check config /etc/prometheus/prometheus.yml
echo "validating the blackbox probe modules ($BLACKBOX_IMAGE)"
podman run --rm --network none -v "$BLACKBOX_DIR:/etc/blackbox:ro,Z" "$BLACKBOX_IMAGE" \
  --config.check --config.file=/etc/blackbox/blackbox.yml

if (( VALIDATE_ONLY )); then
  echo "validate-only: config renders and passes promtool; nothing installed or started"
  exit 0
fi

# --- install the Quadlet unit ------------------------------------------------------------------------------------
mkdir -p "$UNIT_DIR"
sed -e "s|__IMAGE__|$IMAGE|g" -e "s|__CONFIG_DIR__|$CONFIG_DIR|g" \
  "$SRC_DIR/factory-prometheus.container.template" > "$UNIT_DIR/$UNIT_NAME.container"
sed -e "s|__BLACKBOX_IMAGE__|$BLACKBOX_IMAGE|g" -e "s|__BLACKBOX_DIR__|$BLACKBOX_DIR|g" \
  "$SRC_DIR/factory-blackbox.container.template" > "$UNIT_DIR/$BLACKBOX_UNIT.container"

# A leftover compose-era Prometheus is flagged to start on boot and publishes the same port. Stop it ever winning
# that race: it is not removed (recreating it is one compose command), only told not to restart.
if podman container exists cezar-factory-prometheus 2>/dev/null; then
  podman update --restart=no cezar-factory-prometheus >/dev/null 2>&1 \
    && echo "compose-era cezar-factory-prometheus set to restart=no" \
    || echo "WARNING: could not set restart=no on cezar-factory-prometheus; if it starts at boot it will contend for port 9090" >&2
fi

systemctl --user daemon-reload
systemctl --user restart "$BLACKBOX_UNIT.service" # first: Prometheus scrapes it
systemctl --user restart "$UNIT_NAME.service"

# --- verify ------------------------------------------------------------------------------------------------------
for _ in $(seq 1 60); do
  curl -fsS -m 3 "http://$LISTEN/-/ready" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS -m 3 "http://$LISTEN/-/ready" >/dev/null || { echo "Prometheus did not become ready on $LISTEN" >&2; journalctl --user -u "$UNIT_NAME.service" -n 20 --no-pager >&2 || true; exit 1; }

sleep 20 # let the first scrapes land
curl -fsS -m 10 "http://$LISTEN/api/v1/targets" | python3 -c '
import json, sys
t = json.load(sys.stdin)["data"]["activeTargets"]
bad = [x for x in t if x["health"] != "up"]
for x in sorted(t, key=lambda x: x["labels"]["job"]):
    print("  %-16s %-5s %s" % (x["labels"]["job"], x["health"], x["scrapeUrl"]))
sys.exit(1 if bad else 0)
' || { echo "one or more scrape targets are not up (see above)" >&2; exit 1; }
# `up` only says the exporter answered; probe_success is the verdict on Cezar and LiteLLM themselves.
curl -fsS -m 10 "http://$LISTEN/api/v1/query?query=probe_success" | python3 -c '
import json, sys
r = json.load(sys.stdin)["data"]["result"]
for x in sorted(r, key=lambda x: x["metric"].get("service", "")):
    print("  liveness %-9s %s  %s" % (x["metric"].get("service", "?"), "OK  " if x["value"][1] == "1" else "FAIL", x["metric"].get("instance", "")))
sys.exit(0 if len(r) >= 2 and all(x["value"][1] == "1" for x in r) else 1)
' || { echo "a liveness probe is failing or missing (see above)" >&2; exit 1; }
curl -fsS -m 10 "http://$LISTEN/api/v1/rules" | python3 -c '
import json, sys
g = json.load(sys.stdin)["data"]["groups"]
print("  alert rule groups loaded: " + ", ".join("%s(%d)" % (x["name"], len(x["rules"])) for x in g))
'

linger="$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo unknown)"
for unit in "$UNIT_NAME" "$BLACKBOX_UNIT"; do
  wanted_by="$(systemctl --user show "$unit.service" -p WantedBy --value || true)"
  echo "boot persistence: $unit WantedBy=${wanted_by:-<none>} linger=$linger"
  [[ "$wanted_by" == *default.target* && "$linger" == yes ]] || { echo "WARNING: $unit will not start at boot (needs WantedBy=default.target and Linger=yes)" >&2; exit 1; }
done
echo "prometheus is up on http://$LISTEN with liveness probes; both are user systemd services that start at boot"
