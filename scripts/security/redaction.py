#!/usr/bin/env python3
"""Shared collection-boundary secret redaction (#579).

One pattern source (redaction-patterns.json) is used by this module and by
redaction.ps1, so Python and PowerShell collectors cannot drift.
"""
import json
import os
import re
from pathlib import Path

_DATA = json.loads(Path(__file__).with_name("redaction-patterns.json").read_text(encoding="utf-8"))
MARKER = _DATA["marker"]


def _compile(rules):
    return [(re.compile(r["pattern"]), re.sub(r"\$(\d)", r"\\g<\1>", r["replacement"]).replace(MARKER, "\x00M\x00")) for r in rules]


_RULES = _compile(_DATA["rules"])
_STRICT = _compile(_DATA["strictRules"])
_ENV_NAME = re.compile(_DATA["envNamePattern"])


def env_secret_values(env=None):
    env = os.environ if env is None else env
    values = {str(v) for k, v in env.items() if _ENV_NAME.search(str(k)) and len(str(v)) >= _DATA["envMinLength"]}
    return sorted(values, key=len, reverse=True)


def redact(text, env=None, strict=False, marker=None):
    """Mask secrets in ``text``; ``env`` literals are masked too (default: process env)."""
    marker = MARKER if marker is None else marker
    out = str(text)
    for value in env_secret_values(env):
        out = out.replace(value, "\x00M\x00")
    for pattern, repl in _RULES + (_STRICT if strict else []):
        out = pattern.sub(repl, out)
    return out.replace("\x00M\x00", marker)
