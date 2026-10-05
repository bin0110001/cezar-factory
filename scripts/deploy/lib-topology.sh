#!/usr/bin/env bash
set -Eeuo pipefail
# Shared, deliberately simple inventory loader. The config is a shell-style
# key/value file so it works on both the operator workstation and deployment
# hosts without adding a YAML/JSON parser dependency.

load_factory_topology() {
  local root_dir="$1"
  local topology_file="${FACTORY_TOPOLOGY_FILE:-$root_dir/config/server-topology.env}"
  [[ -f "$topology_file" ]] || {
    echo "missing $topology_file; copy config/server-topology.env.example and configure this installation" >&2
    return 1
  }
  # shellcheck disable=SC1090
  source "$topology_file"
  : "${FACTORY_CONTROL_PLANE_ID:?topology missing FACTORY_CONTROL_PLANE_ID}"
  : "${FACTORY_CONTROL_PLANE_SSH_TARGET:?topology missing FACTORY_CONTROL_PLANE_SSH_TARGET}"
  : "${FACTORY_CONTROL_PLANE_ADDRESS:?topology missing FACTORY_CONTROL_PLANE_ADDRESS}"
  : "${FACTORY_CONTROL_PLANE_PODMAN_CONNECTION:?topology missing FACTORY_CONTROL_PLANE_PODMAN_CONNECTION}"
  : "${FACTORY_CONTROL_PLANE_SERVICES:?topology missing FACTORY_CONTROL_PLANE_SERVICES}"
  : "${FACTORY_MODEL_HOST_ID:?topology missing FACTORY_MODEL_HOST_ID}"
  : "${FACTORY_MODEL_HOST_SSH_TARGET:?topology missing FACTORY_MODEL_HOST_SSH_TARGET}"
  : "${FACTORY_MODEL_HOST_ADDRESS:?topology missing FACTORY_MODEL_HOST_ADDRESS}"
  : "${FACTORY_MODEL_HOST_SERVICES:?topology missing FACTORY_MODEL_HOST_SERVICES}"
  : "${FACTORY_VLLM_BASE_URL:?topology missing FACTORY_VLLM_BASE_URL}"
  : "${FACTORY_VLLM_METRICS_TARGET:?topology missing FACTORY_VLLM_METRICS_TARGET}"
  : "${FACTORY_VLLM_ALLOWED_CLIENTS:?topology missing FACTORY_VLLM_ALLOWED_CLIENTS}"
}

topology_host_runs() {
  local host_services="$1" service="$2"
  [[ " $host_services " == *" $service "* ]]
}
