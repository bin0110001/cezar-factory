# Non-Godot verification pilot (#115)

Goal: show that the verification schemas and executor contain no Godot-specific core logic by running a non-Godot project end to end through the generic path.

## What was run

`cezar/packages/cezar/src/verification/non-godot-pilot.test.ts` builds a .NET-shaped project in a temporary git repository (an `App.csproj`, a
`tests/` directory, and a project manifest `.ai/factory/factory.config.yaml` declaring a `unit` check in a `quick` suite) and runs it with the
generic `executeVerification` and nothing else:

- a passing run produces a contract-validated `passed` result and artifact;
- a failing run produces `failed` with a non-zero semantic exit code, never a pass;
- neither artifact contains a Godot identifier.

The check runs a small Node script that prints a `dotnet test` style summary, so the pilot proves the schema and executor path, not the .NET
toolchain. The `tests/fixtures/dotnet-project` and `tests/fixtures/generic-project` directories remain the Factory-script fixtures for the
PowerShell suite (owner decision recorded on #115: an in-repo fixture is an acceptable non-Godot pilot).

## The leak lint

The same file enforces the boundary: every non-test module in `cezar/packages/cezar/src/verification/` except the named adapter
(`godot-adapter.ts`) and the fixture that deliberately exercises it (`visual-evidence-fixtures.ts`), and every `verification*.ts` in the contract
package, must contain no Godot identifier in executable code (comments are ignored): `godot`, `gdunit`, `gdscript`, `.tscn`, `.gd`, `.import`. The
test also proves the pattern catches a leak. A new Godot reference in a core module fails the test and belongs in the adapter instead.

## Findings

- No schema leak was found: the contract and the executor are engine-agnostic, and the Godot-specific code is confined to the adapter.
- `visual-baseline.ts` mentions Godot in comments only (an example of an adapter that produces captures); this is documentation, not logic.
- `visual-evidence-fixtures.ts` names a `godot` fixture adapter and a `godot-4.4` app version. It is a fixture of the Godot adapter, so it is excluded
  from the lint on purpose.

Gap: this pilot uses a stand-in command, not a real .NET toolchain on a registered target. Running a registered non-Godot project (#39 needs verified
local paths for the registered targets) is the live follow-up.
