@echo off
rem One-time GitHub CLI login inside the cezar container (persists in the gh-config volume).
podman exec -it cezar gh auth login
