# Factory Synchronization

This document describes how the cezar factory synchronizes with individual projects.

## Overview

The cezar factory maintains reusable components (workflows, skills, automations, policies) that are synchronized into individual projects. This allows for centralized updates while preserving project-specific customizations.

## Synchronization Process

Synchronization occurs through three main scripts:

1. install.ps1 - Initial installation of factory components
2. update.ps1 - Updating to a newer factory version
3. diff.ps1 - Checking for drift between factory and project

## Versioning

The factory uses semantic versioning (MAJOR.MINOR.PATCH):

- MAJOR: Breaking changes requiring project updates
- MINOR: New features or enhancements (backward compatible)
- PATCH: Bug fixes and minor improvements (backward compatible)

Each project pins to a specific factory version in its configuration.

## Files Synchronized

During synchronization, the following files are copied from the factory to the project:

### Workflows
- .ai/cezar/workflows/*.yaml

### Skills
- .ai/cezar/skills/*/SKILL.md

### Automations
- .ai/cezar/automations/*.yaml

### Policies
- .ai/cezar/policies/*.yaml
- .ai/cezar/policies/*.md

### Schemas
- .ai/cezar/schemas/*.json

### Templates
- .ai/cezar/templates/*

### Scripts
- scripts/factory/*.ps1

## Project-Specific Customizations

Projects can override factory components through:

1. Skill Extensions: Project-specific skills in .ai/skills/ take precedence
2. Workflow Overrides: Complete workflow replacement in .ai/factory/overrides/workflows/
3. Policy Overrides: Project-specific values in .ai/factory/config.yaml
4. Validation Scripts: Project-specific validation in scripts/factory/*

## Synchronization Safety

The synchronization system includes several safety features:

- Managed File Markers: Synchronized files include headers indicating their source
- Dry-run Mode: All scripts support a -DryRun flag to preview changes
- Atomic Writes: File updates use temporary files and atomic renames
- Backup Creation: Critical files are backed up before modification
- Validation: Post-synchronization verification ensures consistency

## Conflict Resolution

When synchronization encounters conflicts:

1. Factory vs Project Files: Project files in override directories take precedence
2. Local Modifications: Modified synchronized files trigger warnings
3. Version Mismatches: Explicit version changes required for updates
4. Obsolete Files: Files removed from factory are optionally removed from projects

## CI Integration

Synchronization can be integrated into CI pipelines:

- factory diff - Check for drift (can fail CI if drift detected)
- factory verify - Validate installation correctness
- factory update - Update to latest compatible version
