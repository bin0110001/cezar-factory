@echo off
rem Rebuild the cezar image from the current source and replace the running container.
rem Volumes (logins, cezar state) are kept. CEZAR_WORKSPACE overrides the mounted repo.
setlocal
cd /d "%~dp0..\.."
if "%CEZAR_WORKSPACE%"=="" set "CEZAR_WORKSPACE=%CD%"

podman build -t localhost/cezar:local . || goto :fail
podman rm -f cezar >nul 2>&1

rem Host side is loopback-only: cezar has no auth of its own.
podman run -d --name cezar --restart unless-stopped ^
  --health-cmd "curl -fsS http://127.0.0.1:4321/api/v1/health" --health-interval 30s --health-start-period 20s ^
  -p 127.0.0.1:4321:4321 -e CEZ_REMOTE=1 ^
  -v cezar-home:/home/cezar/.cezar ^
  -v claude-home:/home/cezar/.claude ^
  -v gh-config:/home/cezar/.config/gh ^
  -v codex-home:/home/cezar/.codex ^
  -v opencode-data:/home/cezar/.local/share/opencode ^
  -v opencode-config:/home/cezar/.config/opencode ^
  -v "%CEZAR_WORKSPACE%:/workspace" ^
  localhost/cezar:local || goto :fail

echo cezar is starting at http://127.0.0.1:4321
exit /b 0

:fail
echo redeploy failed 1>&2
exit /b 1
