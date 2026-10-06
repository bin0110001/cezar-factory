@echo off
setlocal EnableExtensions

rem Rotate the GitHub CLI credential stored in the Cezar container.
rem The token is read on the remote terminal without echo and is never placed
rem in a command line, file, environment variable, or this script's output.
rem Override SSH_TARGET or SSH_KEY before running when needed.

if "%SSH_TARGET%"=="" set "SSH_TARGET=bin0110001@192.168.86.69"
if "%SSH_KEY%"=="" set "SSH_KEY=C:\Users\bin01\.ssh\vps_deploy_key"

set "SSH_KEY_ARG="
if exist "%SSH_KEY%" set "SSH_KEY_ARG=-i \"%SSH_KEY%\""

echo This replaces Cezar's stored GitHub CLI credential on %SSH_TARGET%.
echo SSH will prompt for a password or key passphrase if the connection needs one.
echo The remote host will then prompt for the new GitHub token without echoing it.
echo.

ssh -tt %SSH_KEY_ARG% -o BatchMode=no -o StrictHostKeyChecking=accept-new %SSH_TARGET% "bash -lc 'read -r -s -p \"New GitHub token: \" token; printf \"\\n\"; printf \"%%s\" \"$token\" | podman exec -i cezar gh auth login --hostname github.com --with-token'"
if errorlevel 1 (
  echo.
  echo Credential rotation failed. The existing credential was not intentionally removed by this helper.
  exit /b 1
)

echo.
echo Verifying the authenticated GitHub account without displaying token metadata...
ssh %SSH_KEY_ARG% -o BatchMode=no -o StrictHostKeyChecking=accept-new %SSH_TARGET% "podman exec cezar gh api user --jq .login"
if errorlevel 1 (
  echo Verification failed. Check the account and retry the rotation.
  exit /b 1
)

pause

echo Credential rotation completed.
exit /b 0
