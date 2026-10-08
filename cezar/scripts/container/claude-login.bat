@echo off
rem One-time Claude Code login inside the cezar container (persists in the claude-home volume).
podman exec -it cezar claude login
