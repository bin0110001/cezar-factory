# Conservative Godot dependency graph

`scripts/collect-godot-dependencies.ps1` scans a Godot project and writes a stable JSON graph. The implementation workflow runs it as a command step and saves the result to `.factory/godot-dependencies.json`. Non-Godot repositories skip cleanly.

The graph records resource-to-resource edges from `.tscn` and `.tres` external resource declarations, literal `preload()` and `load()` calls in `.gd` files, autoloads from `[autoload]` in `project.godot`, and optional explicit edges in `godot-impact.json`. An edge points from the dependent resource to the resource it needs. `reverseIndex` maps a resource to its direct dependents; `affected` lists transitive dependents for the requested `-ChangedPath` values.

Dynamic or multiline GDScript resource expressions are listed in `uncertain`; they are not guessed. Missing files, unresolved UIDs, unsafe paths, malformed declarations, unreadable files, and scan limits appear in `diagnostics`. Consumers should treat uncertainty and diagnostics conservatively. The graph is context for impact analysis and does not choose or skip tests.

An explicit manifest has this shape:

```json
{
  "schemaVersion": 1,
  "dependencies": [
    { "source": "res://scenes/main.tscn", "dependsOn": ["res://resources/theme.tres"] }
  ]
}
```

Paths in the manifest are project-root relative. Graph paths are normalized to project-relative paths with forward slashes. The collector limits the number and size of scanned files and does not follow directory reparse points.
