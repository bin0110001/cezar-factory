@echo off
rem One-time OpenCode provider login inside the cezar container (persists in the opencode volumes).
podman exec -it cezar opencode auth login
