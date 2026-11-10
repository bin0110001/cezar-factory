#!/usr/bin/env python3
"""Coordinate legacy pushes with the release locks used by Factory services."""

from __future__ import annotations

import argparse
import os
import pathlib
import subprocess
import sys


def acquire(path: pathlib.Path, kind: str) -> tuple[int, str]:
    if os.name == "nt" and kind != "controller":
        raise RuntimeError(f"cannot verify POSIX {kind} lock on Windows: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        handle = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    except OSError as exc:
        raise RuntimeError(f"cannot inspect {kind} lock {path}: {exc}") from exc
    try:
        if os.name == "nt":
            import msvcrt

            if os.fstat(handle).st_size == 0:
                os.write(handle, b"0")
            os.lseek(handle, 0, os.SEEK_SET)
            try:
                msvcrt.locking(handle, msvcrt.LK_NBLCK, 1)
            except OSError:
                os.close(handle)
                return -1, "locked"
            return handle, "locked-here"

        import fcntl

        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(handle)
            return -1, "locked"
        return handle, "locked-here"
    except Exception:
        os.close(handle)
        raise


def release(handle: int, kind: str) -> None:
    if os.name == "nt":
        import msvcrt

        os.lseek(handle, 0, os.SEEK_SET)
        msvcrt.locking(handle, msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(handle, fcntl.LOCK_UN)
    os.close(handle)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--controller-lock", type=pathlib.Path)
    parser.add_argument("--autodeploy-lock", type=pathlib.Path)
    parser.add_argument("--hold", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    acquired: list[tuple[int, str]] = []
    seen: set[tuple[str, str]] = set()
    for kind, path in (("controller", args.controller_lock), ("autodeploy", args.autodeploy_lock)):
        if path is None:
            continue
        key = (kind, str(path.resolve()))
        if key in seen:
            continue
        seen.add(key)
        try:
            handle, state = acquire(path, kind)
        except RuntimeError as exc:
            print(str(exc), file=sys.stderr)
            for old_handle, old_kind in reversed(acquired):
                release(old_handle, old_kind)
            return 2
        if state == "locked":
            for old_handle, old_kind in reversed(acquired):
                release(old_handle, old_kind)
            print(f"{kind} lock is active: {path}", file=sys.stderr)
            return 1
        acquired.append((handle, kind))
    if args.hold:
        command = args.command[1:] if args.command and args.command[0] == "--" else args.command
        if not command:
            print("--hold requires a command", file=sys.stderr)
            return 2
        env = os.environ.copy()
        env["FACTORY_RELEASE_LOCKS_HELD"] = "1"
        try:
            return subprocess.run(command, env=env, check=False).returncode
        finally:
            for handle, kind in reversed(acquired):
                release(handle, kind)
    for handle, kind in reversed(acquired):
        release(handle, kind)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
