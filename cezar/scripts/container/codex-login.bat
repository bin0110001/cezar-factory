@echo off
rem One-time Codex login inside the cezar container (persists in the codex-home volume).
rem --device-auth because the browser callback cannot reach a container.
podman exec -it cezar codex login --device-auth
