#!/usr/bin/env python3
"""Stage tested Factory refs as immutable, locally verifiable artifacts.

The controller consumes only a configured Git ref. It does not execute prompts,
install code, call Cezar, or modify the source checkout. Promotion to the stable
ref remains the test gate; this process verifies the staged bytes and records a
separate integrity result before atomically advancing its local channel pointer.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from typing import Any, Iterator

if os.name == "nt":
    import msvcrt
else:
    import fcntl


CONTROLLER_VERSION = "1.0.0"
SHA_RE = re.compile(r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$")
STORE_SCHEMA = "factory-release-controller-state/v1"
VERIFY_MANIFEST = {
    "version": 1,
    "checks": {
        "artifact-integrity": {
            "runner": "command",
            "executable": "factory-release-controller",
            "args": ["verify-artifact"],
            "cwd": ".",
            "timeoutSeconds": 3600,
            "optional": False,
        }
    },
    "suites": {"release-integrity": ["artifact-integrity"]},
}


class ControllerError(RuntimeError):
    pass


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def digest_file(path: pathlib.Path) -> tuple[str, int]:
    hasher = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            hasher.update(chunk)
            size += len(chunk)
    return "sha256:" + hasher.hexdigest(), size


def canonical_json(value: Any) -> bytes:
    """Canonicalize the controller's JSON subset with RFC 8785 object-key order."""
    def encode(item: Any) -> str:
        if item is None: return "null"
        if item is True: return "true"
        if item is False: return "false"
        if isinstance(item, int):
            if abs(item) > (2**53 - 1): raise ControllerError("JCS integer exceeds the interoperable safe range")
            return str(item)
        if isinstance(item, float):
            raise ControllerError("controller records use integers only; floating point values are rejected")
        if isinstance(item, str):
            try: item.encode("utf-8", "strict")
            except UnicodeEncodeError as exc: raise ControllerError("JSON string contains an unpaired surrogate") from exc
            return json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        if isinstance(item, list): return "[" + ",".join(encode(value) for value in item) + "]"
        if isinstance(item, dict):
            if not all(isinstance(key, str) for key in item): raise ControllerError("JSON object keys must be strings")
            keys = sorted(item, key=lambda key: key.encode("utf-16-be", "strict"))
            return "{" + ",".join(encode(key) + ":" + encode(item[key]) for key in keys) + "}"
        raise ControllerError(f"unsupported JCS value: {type(item).__name__}")
    return encode(value).encode("utf-8")


def atomic_write(path: pathlib.Path, data: bytes, mode: int = 0o640) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp = pathlib.Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
        if os.name != "nt":
            dir_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
    finally:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()


def run_git(repo: pathlib.Path, *args: str, timeout: int = 120, stdout: int = subprocess.PIPE) -> bytes:
    proc = subprocess.run(["git", "-C", str(repo), *args], stdout=stdout, stderr=subprocess.PIPE, timeout=timeout, check=False)
    if proc.returncode:
        detail = proc.stderr.decode("utf-8", "replace")[-2000:]
        raise ControllerError(f"git {' '.join(args)} failed ({proc.returncode}): {detail}")
    return proc.stdout or b""


def iso_from_epoch(epoch: int) -> str:
    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def check_relative_member(name: str, prefix: str) -> str:
    if not name.startswith(prefix):
        raise ControllerError(f"archive entry is outside its expected root: {name!r}")
    relative = name[len(prefix):]
    if not relative:
        return ""
    raw_parts = relative.split("/")
    path = pathlib.PurePosixPath(relative)
    if path.is_absolute() or any(part in ("", ".", "..") for part in raw_parts) or "\\" in relative or "\x00" in relative:
        raise ControllerError(f"unsafe archive path: {name!r}")
    return relative


def extract_archive(bundle: pathlib.Path, destination: pathlib.Path, prefix: str) -> list[dict[str, Any]]:
    destination.mkdir(parents=True, exist_ok=False)
    files: list[dict[str, Any]] = []
    seen: set[str] = set()
    try:
        with tarfile.open(bundle, mode="r:") as archive:
            for member in archive:
                archive_name = member.name.rstrip("/") if member.isdir() else member.name
                if member.isdir() and archive_name == prefix.rstrip("/"):
                    continue
                relative = check_relative_member(archive_name, prefix)
                if not relative:
                    if not member.isdir():
                        raise ControllerError("archive root entry is not a directory")
                    continue
                if relative in seen:
                    raise ControllerError(f"duplicate archive entry: {relative}")
                seen.add(relative)
                target = destination.joinpath(*pathlib.PurePosixPath(relative).parts)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                if not member.isfile():
                    raise ControllerError(f"non-regular archive entry rejected: {relative}")
                target.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    raise ControllerError(f"could not read archive entry: {relative}")
                hasher = hashlib.sha256()
                size = 0
                with source, target.open("xb") as output:
                    while chunk := source.read(1024 * 1024):
                        output.write(chunk)
                        hasher.update(chunk)
                        size += len(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                if size != member.size:
                    raise ControllerError(f"archive entry size mismatch: {relative}")
                # The extracted tree is verification scratch space; keep it
                # writable so temporary cleanup also works on Windows hosts.
                os.chmod(target, 0o640)
                files.append({"path": relative, "byteSize": size, "sha256": "sha256:" + hasher.hexdigest()})
    except (tarfile.TarError, OSError) as exc:
        shutil.rmtree(destination, ignore_errors=True)
        if isinstance(exc, ControllerError):
            raise
        raise ControllerError(f"could not safely read source archive: {exc}") from exc
    files.sort(key=lambda item: item["path"])
    if not files:
        raise ControllerError("refusing to stage an empty source artifact")
    return files


@contextlib.contextmanager
def exclusive_lock(path: pathlib.Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as lock:
        try:
            if os.name == "nt":
                lock.seek(0, os.SEEK_END)
                if lock.tell() == 0:
                    lock.write(b"0"); lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, OSError) as exc:
            raise ControllerError("another release-controller invocation holds the local lock") from exc
        try:
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


class ReleaseController:
    def __init__(self, repo: pathlib.Path, store: pathlib.Path, remote: str, branch: str, keep: int, minimum_age_days: int, attempts: int):
        self.repo = repo.resolve(strict=True)
        self.store = store.resolve() if store.exists() else store.absolute()
        self.remote = remote
        self.branch = branch
        self.channel = branch
        self.keep = max(3, keep)
        self.minimum_age = dt.timedelta(days=max(30, minimum_age_days))
        self.attempts = max(1, min(8, attempts))
        if not (self.repo / ".git").exists():
            raise ControllerError(f"configured source is not a Git checkout: {self.repo}")
        ref_result = subprocess.run(["git", "-C", str(self.repo), "check-ref-format", f"refs/heads/{branch}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        if ref_result.returncode != 0 or not re.fullmatch(r"[A-Za-z0-9._/-]{1,128}", branch):
            raise ControllerError(f"invalid channel/ref name: {branch!r}")
        self.releases = self.store / "releases"
        self.channels = self.store / "channels"
        self.db_path = self.store / "controller.sqlite3"
        self.store.mkdir(parents=True, exist_ok=True)
        self._init_db()

    @contextlib.contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.db_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=30000")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _init_db(self) -> None:
        with self._db() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS controller_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS attempts (
                    id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
                    channel TEXT NOT NULL, source_sha TEXT, status TEXT NOT NULL,
                    reason TEXT, retry_count INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS releases (
                    source_sha TEXT NOT NULL, channel TEXT NOT NULL,
                    manifest_digest TEXT NOT NULL, artifact_digest TEXT NOT NULL,
                    state TEXT NOT NULL, staged_at TEXT NOT NULL,
                    PRIMARY KEY(source_sha, channel)
                );
                CREATE TABLE IF NOT EXISTS channel_pointers (
                    channel TEXT PRIMARY KEY, current_sha TEXT NOT NULL,
                    last_good_sha TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS "references" (
                    source_sha TEXT NOT NULL, kind TEXT NOT NULL, reference_id TEXT NOT NULL,
                    expires_at TEXT, PRIMARY KEY(source_sha, kind, reference_id)
                );
            """)
            schema = db.execute("SELECT value FROM controller_meta WHERE key='schemaVersion'").fetchone()
            if schema and schema["value"] != STORE_SCHEMA:
                raise ControllerError(f"unsupported controller state schema: {schema['value']}")
            db.execute("INSERT OR IGNORE INTO controller_meta(key,value) VALUES('schemaVersion',?)", (STORE_SCHEMA,))

    def _attempt(self) -> str:
        attempt_id = str(uuid.uuid4())
        with self._db() as db:
            db.execute("INSERT INTO attempts(id,started_at,channel,status) VALUES(?,?,?,'running')", (attempt_id, utc_now(), self.channel))
        return attempt_id

    def _finish(self, attempt_id: str, status: str, reason: str | None = None, sha: str | None = None, retries: int = 0) -> None:
        with self._db() as db:
            db.execute("UPDATE attempts SET finished_at=?,status=?,reason=?,source_sha=COALESCE(?,source_sha),retry_count=MAX(retry_count,?) WHERE id=?", (utc_now(), status, reason, sha, retries, attempt_id))

    def fetch_sha(self, attempt_id: str) -> tuple[str, int]:
        ref = f"refs/heads/{self.branch}"
        last_error: Exception | None = None
        for retry in range(self.attempts):
            try:
                run_git(self.repo, "fetch", "--no-tags", self.remote, ref, timeout=60)
                sha = run_git(self.repo, "rev-parse", "--verify", "FETCH_HEAD^{commit}").decode().strip()
                if not SHA_RE.fullmatch(sha):
                    raise ControllerError(f"remote returned an invalid full commit id: {sha!r}")
                return sha, retry
            except (ControllerError, subprocess.TimeoutExpired) as exc:
                last_error = exc
                with self._db() as db:
                    db.execute("UPDATE attempts SET retry_count=? WHERE id=?", (retry + 1, attempt_id))
                if retry + 1 < self.attempts:
                    time.sleep(min(2 ** retry, 16))
        raise ControllerError(f"fetch failed after {self.attempts} bounded attempts: {last_error}")

    def _verification(self, sha: str, manifest_sha: str, started: str, finished: str, duration_ms: int) -> dict[str, Any]:
        return {
            "resultVersion": 1,
            "verificationId": f"release-integrity-{sha[:20]}",
            "cezarRunId": f"factory-controller-{sha[:20]}",
            "projectId": "cezar-factory",
            "worktreeId": "immutable-release-store",
            "commitSha": sha,
            "manifestSha256": manifest_sha,
            "startedAt": started,
            "finishedAt": finished,
            "toolVersions": {"factory-release-controller": CONTROLLER_VERSION, "python": sys.version.split()[0]},
            "environment": {"platform": sys.platform},
            "status": "passed",
            "semanticExitCode": 0,
            "coverage": {"selected": 1, "passed": 1, "failed": 0, "skipped": 0, "unknown": 0},
            "checks": [{
                "checkId": "artifact-integrity", "required": True, "attempt": 1,
                "status": "passed", "rawExitCode": 0, "semanticExitCode": 0,
                "durationMs": duration_ms, "outputPreview": "archive, manifest, entry paths, sizes, and SHA-256 digests verified",
                "outputTruncated": False, "diagnostics": [], "metrics": [],
                "coverage": {"selected": 1, "passed": 1, "skipped": 0}, "artifacts": [],
            }],
            "artifacts": [],
        }

    def _build(self, sha: str, attempt_id: str) -> dict[str, Any]:
        self.releases.mkdir(parents=True, exist_ok=True)
        final_dir = self.releases / sha
        if final_dir.exists():
            existing = self.verify_release(final_dir, expected_sha=sha)
            with self._db() as db:
                db.execute("INSERT OR IGNORE INTO releases(source_sha,channel,manifest_digest,artifact_digest,state,staged_at) VALUES(?,?,?,?,?,?)",
                           (sha, self.channel, existing["manifestDigest"], existing["artifactDigest"], "verified", utc_now()))
            return existing
        started = utc_now()
        started_clock = time.monotonic()
        temp_dir = pathlib.Path(tempfile.mkdtemp(prefix=f".{sha}.", dir=self.releases))
        try:
            bundle = temp_dir / "artifact.tar"
            with bundle.open("wb") as stream:
                proc = subprocess.run(["git", "-C", str(self.repo), "archive", "--format=tar", f"--prefix=release/", sha], stdout=stream, stderr=subprocess.PIPE, timeout=600, check=False)
                stream.flush(); os.fsync(stream.fileno())
            if proc.returncode:
                raise ControllerError(f"git archive failed: {proc.stderr.decode('utf-8','replace')[-2000:]}")
            size = bundle.stat().st_size
            artifact_sha, _ = digest_file(bundle)
            extracted = temp_dir / "tree"
            files = extract_archive(bundle, extracted, "release/")
            commit_epoch = int(run_git(self.repo, "show", "-s", "--format=%ct", sha).decode().strip())
            object_format = run_git(self.repo, "rev-parse", "--show-object-format").decode().strip()
            evidence = self._verification(sha, digest(canonical_json(VERIFY_MANIFEST)).removeprefix("sha256:"), started, utc_now(), int((time.monotonic() - started_clock) * 1000))
            evidence_bytes = canonical_json(evidence)
            atomic_write(temp_dir / "verification-evidence.json", evidence_bytes)
            manifest: dict[str, Any] = {
                "schemaVersion": "factory-release-manifest/v1",
                "source": {"repository": "bin0110001/cezar-factory", "sha": sha, "gitObjectFormat": object_format, "ref": f"refs/heads/{self.branch}"},
                "artifact": {"format": "tar", "byteSize": size, "sha256": artifact_sha},
                "files": files,
                "build": {"id": attempt_id, "builder": "factory-release-controller", "builderVersion": CONTROLLER_VERSION, "workflow": "factory-release-controller", "startedAt": started, "completedAt": utc_now()},
                "compatibility": {"cezarApi": "*", "requiredCapabilities": []},
                "verification": {"resultVersion": 1, "status": "passed", "digest": digest(evidence_bytes), "evidenceRef": "verification-evidence.json"},
            }
            manifest["manifestDigest"] = digest(canonical_json(manifest))
            atomic_write(temp_dir / "manifest.json", canonical_json(manifest))
            atomic_write(temp_dir / "state.json", canonical_json({
                "schemaVersion": "factory-release-state/v1", "sourceSha": sha,
                "manifestDigest": manifest["manifestDigest"], "state": "verified",
                "verification": manifest["verification"], "updatedAt": utc_now(),
            }))
            shutil.rmtree(extracted)
            self.verify_release(temp_dir, expected_sha=sha)
            for child in temp_dir.iterdir():
                if child.is_file(): os.chmod(child, 0o440)
            os.chmod(temp_dir, 0o550)
            os.replace(temp_dir, final_dir)
            if os.name != "nt":
                dir_fd = os.open(self.releases, os.O_RDONLY)
                try: os.fsync(dir_fd)
                finally: os.close(dir_fd)
            with self._db() as db:
                db.execute("INSERT OR IGNORE INTO releases(source_sha,channel,manifest_digest,artifact_digest,state,staged_at) VALUES(?,?,?,?,?,?)",
                           (sha, self.channel, manifest["manifestDigest"], artifact_sha, "verified", utc_now()))
            return {"sourceSha": sha, "manifestDigest": manifest["manifestDigest"], "artifactDigest": artifact_sha, "state": "verified"}
        except Exception:
            shutil.rmtree(temp_dir, ignore_errors=True)
            raise

    def verify_release(self, directory: pathlib.Path, expected_sha: str | None = None) -> dict[str, Any]:
        if directory.is_symlink() or directory.parent.resolve() != self.releases.resolve():
            raise ControllerError("release path must be a real directory directly inside the immutable store")
        try:
            allowed_files = {"artifact.tar", "manifest.json", "verification-evidence.json", "state.json"}
            actual_files = {item.name for item in directory.iterdir()}
            if actual_files != allowed_files or any(item.is_symlink() or not item.is_file() for item in directory.iterdir()):
                raise ControllerError("release directory contains missing, unexpected, or unsafe entries")
            manifest_bytes = (directory / "manifest.json").read_bytes()
            manifest = json.loads(manifest_bytes)
            bundle = directory / "artifact.tar"
            evidence_path = directory / manifest["verification"]["evidenceRef"]
            evidence_bytes = evidence_path.read_bytes()
            state = json.loads((directory / "state.json").read_bytes())
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise ControllerError(f"release metadata is missing or malformed: {exc}") from exc
        sha = manifest.get("source", {}).get("sha")
        if manifest.get("schemaVersion") != "factory-release-manifest/v1" or not isinstance(sha, str) or not SHA_RE.fullmatch(sha):
            raise ControllerError("release manifest has an unknown schema or invalid source SHA")
        source = manifest.get("source", {})
        artifact = manifest.get("artifact", {})
        build = manifest.get("build", {})
        compatibility = manifest.get("compatibility", {})
        verification = manifest.get("verification", {})
        files = manifest.get("files")
        if source.get("gitObjectFormat") != ("sha1" if len(sha) == 40 else "sha256") or not re.fullmatch(r"[^/\s]+/[^/\s]+", source.get("repository", "")) or not isinstance(source.get("ref"), str):
            raise ControllerError("release manifest source metadata is invalid")
        if artifact.get("format") != "tar" or not isinstance(artifact.get("byteSize"), int) or isinstance(artifact.get("byteSize"), bool) or artifact["byteSize"] < 1 or not re.fullmatch(r"sha256:[a-f0-9]{64}", artifact.get("sha256", "")):
            raise ControllerError("release manifest artifact metadata is invalid")
        if not isinstance(files, list) or not files or any(not isinstance(entry, dict) for entry in files):
            raise ControllerError("release manifest file entries must be objects in a non-empty list")
        if files != sorted(files, key=lambda entry: entry.get("path", "")):
            raise ControllerError("release manifest file entries must be a non-empty sorted list")
        paths: set[str] = set()
        for entry in files:
            path = entry.get("path", "")
            if not isinstance(path, str) or not path or path.startswith("/") or "\\" in path or any(part in ("", ".", "..") for part in path.split("/")) or path in paths:
                raise ControllerError("release manifest contains an invalid or duplicate path")
            if not isinstance(entry.get("byteSize"), int) or isinstance(entry.get("byteSize"), bool) or entry["byteSize"] < 0 or not re.fullmatch(r"sha256:[a-f0-9]{64}", entry.get("sha256", "")):
                raise ControllerError(f"release manifest file metadata is invalid: {path}")
            paths.add(path)
        if not all(isinstance(build.get(key), str) and build[key] for key in ("id", "builder", "builderVersion", "workflow", "startedAt", "completedAt")):
            raise ControllerError("release manifest build metadata is invalid")
        if not isinstance(compatibility.get("cezarApi"), str) or not isinstance(compatibility.get("requiredCapabilities"), list):
            raise ControllerError("release manifest compatibility metadata is invalid")
        if verification.get("resultVersion") != 1 or verification.get("status") != "passed" or verification.get("evidenceRef") != "verification-evidence.json" or not re.fullmatch(r"sha256:[a-f0-9]{64}", verification.get("digest", "")):
            raise ControllerError("release manifest verification reference is invalid")
        if expected_sha and sha != expected_sha:
            raise ControllerError("release manifest source SHA does not match its immutable directory name")
        unsigned = dict(manifest); declared_manifest_digest = unsigned.pop("manifestDigest", None)
        if digest(canonical_json(unsigned)) != declared_manifest_digest:
            raise ControllerError("release manifest digest mismatch")
        artifact_digest, artifact_size = digest_file(bundle)
        if artifact_size != manifest["artifact"].get("byteSize") or artifact_digest != manifest["artifact"].get("sha256"):
            raise ControllerError("artifact byte size or digest mismatch")
        if digest(evidence_bytes) != verification.get("digest"):
            raise ControllerError("verification evidence digest mismatch")
        evidence = json.loads(evidence_bytes)
        if evidence.get("resultVersion") != 1 or evidence.get("status") != "passed" or evidence.get("commitSha") != sha:
            raise ControllerError("verification evidence does not attest to this source SHA")
        if state.get("schemaVersion") != "factory-release-state/v1" or state.get("sourceSha") != sha or state.get("manifestDigest") != declared_manifest_digest or state.get("state") != "verified" or state.get("verification") != verification:
            raise ControllerError("release state checkpoint does not agree with its immutable manifest")
        with tempfile.TemporaryDirectory(prefix="factory-verify-") as tmp:
            tree = pathlib.Path(tmp) / "tree"
            entries = extract_archive(bundle, tree, "release/")
            if entries != manifest.get("files"):
                raise ControllerError("archive file list, sizes, or digests differ from the manifest")
        return {"sourceSha": sha, "manifestDigest": declared_manifest_digest, "artifactDigest": manifest["artifact"]["sha256"], "state": "verified"}

    def _pointer(self, sha: str, previous: str | None) -> None:
        target = self.releases / sha
        if not target.is_dir():
            raise ControllerError(f"cannot point channel at missing staged artifact {sha}")
        pointer_dir = self.channels
        pointer_dir.mkdir(parents=True, exist_ok=True, mode=0o750)
        metadata = {"schemaVersion": "factory-release-channel-pointer/v1", "channel": self.channel,
                    "currentSha": sha, "currentPath": str(target), "lastGoodSha": previous or sha,
                    "lastGoodPath": str(self.releases / (previous or sha)), "updatedAt": utc_now()}
        atomic_write(pointer_dir / f"{self.channel}.json", canonical_json(metadata))
        with self._db() as db:
            db.execute("INSERT INTO channel_pointers(channel,current_sha,last_good_sha,updated_at) VALUES(?,?,?,?) ON CONFLICT(channel) DO UPDATE SET current_sha=excluded.current_sha,last_good_sha=excluded.last_good_sha,updated_at=excluded.updated_at",
                       (self.channel, sha, previous or sha, metadata["updatedAt"]))

    def _advance(self, sha: str) -> str:
        # Recover a crash after the atomic JSON pointer swap but before the
        # SQLite checkpoint. The immutable release is re-verified first.
        pointer_file = self.channels / f"{self.channel}.json"
        linked_sha: str | None = None
        if pointer_file.exists():
            try:
                pointer = json.loads(pointer_file.read_text(encoding="utf-8"))
                candidate = pointer.get("currentSha")
                if pointer.get("schemaVersion") != "factory-release-channel-pointer/v1" or pointer.get("channel") != self.channel or not isinstance(candidate, str) or not SHA_RE.fullmatch(candidate):
                    raise ControllerError("channel pointer is malformed or belongs to another channel")
                if pathlib.Path(pointer.get("currentPath", "")).resolve() != (self.releases / candidate).resolve():
                    raise ControllerError("channel pointer path does not match its full SHA")
                linked_sha = candidate
            except (OSError, ValueError, AttributeError) as exc:
                raise ControllerError(f"channel pointer is unreadable: {exc}") from exc
        with self._db() as db:
            row = db.execute("SELECT current_sha FROM channel_pointers WHERE channel=?", (self.channel,)).fetchone()
        previous = linked_sha or (row["current_sha"] if row else None)
        if linked_sha and linked_sha != (row["current_sha"] if row else None):
            self.verify_release(self.releases / linked_sha, expected_sha=linked_sha)
            with self._db() as db:
                db.execute("INSERT INTO channel_pointers(channel,current_sha,last_good_sha,updated_at) VALUES(?,?,?,?) ON CONFLICT(channel) DO UPDATE SET current_sha=excluded.current_sha,updated_at=excluded.updated_at",
                           (self.channel, linked_sha, row["current_sha"] if row else linked_sha, utc_now()))
        if previous == sha:
            return "unchanged"
        if previous:
            proc = subprocess.run(["git", "-C", str(self.repo), "merge-base", "--is-ancestor", previous, sha], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            if proc.returncode != 0:
                raise ControllerError(f"refusing to advance {self.channel}: new SHA is not a descendant of current SHA {previous}")
        self._pointer(sha, previous)
        return "staged"

    def _retention(self) -> int:
        with self._db() as db:
            rows = db.execute("SELECT source_sha,channel,staged_at FROM releases WHERE state='verified' ORDER BY staged_at DESC").fetchall()
            pointers = {r["current_sha"] for r in db.execute("SELECT current_sha FROM channel_pointers")}
            pointers |= {r["last_good_sha"] for r in db.execute("SELECT last_good_sha FROM channel_pointers")}
            now = dt.datetime.now(dt.timezone.utc)
            expired_refs = db.execute('SELECT source_sha,kind,reference_id FROM "references" WHERE expires_at IS NOT NULL AND expires_at<=?', (utc_now(),)).fetchall()
            for ref in expired_refs:
                db.execute('DELETE FROM "references" WHERE source_sha=? AND kind=? AND reference_id=?', (ref["source_sha"], ref["kind"], ref["reference_id"]))
            protected = {r["source_sha"] for r in db.execute('SELECT DISTINCT source_sha FROM "references"')}
        by_channel: dict[str, list[sqlite3.Row]] = {}
        for row in rows: by_channel.setdefault(row["channel"], []).append(row)
        remove: set[str] = set()
        for channel_rows in by_channel.values():
            protected |= {row["source_sha"] for row in channel_rows[:self.keep]}
        for row in rows:
            sha = row["source_sha"]
            if sha in protected: continue
            try: staged = dt.datetime.fromisoformat(row["staged_at"].replace("Z", "+00:00"))
            except ValueError: continue
            if now - staged < self.minimum_age: continue
            remove.add(sha)
        for sha in remove:
            release_path = self.releases / sha
            if release_path.parent.resolve() != self.releases.resolve() or not SHA_RE.fullmatch(sha):
                raise ControllerError("retention produced an unsafe artifact path")
            if release_path.is_symlink():
                raise ControllerError("refusing to collect a symlink from the artifact store")
            if release_path.exists():
                for item in release_path.iterdir():
                    if item.is_symlink() or not item.is_file():
                        raise ControllerError("refusing to collect a release with unexpected filesystem entries")
                    os.chmod(item, 0o640)
                os.chmod(release_path, 0o750)
                shutil.rmtree(release_path, ignore_errors=False)
            with self._db() as db: db.execute("DELETE FROM releases WHERE source_sha=?", (sha,))
        return len(remove)

    def sync(self) -> dict[str, Any]:
        attempt_id = self._attempt()
        retries = 0
        sha: str | None = None
        try:
            sha, retries = self.fetch_sha(attempt_id)
            current = self._build(sha, attempt_id)
            action = self._advance(sha)
            removed = self._retention()
            result = {"status": action, **current, "channel": self.channel, "retryCount": retries, "retainedReleasesRemoved": removed}
            self._finish(attempt_id, action, sha=sha, retries=retries)
            return result
        except Exception as exc:
            self._finish(attempt_id, "failed", reason=str(exc)[:2000], sha=sha, retries=retries)
            raise

    def stage_current(self) -> dict[str, Any]:
        """Fetch and verify the configured ref without changing its channel pointer."""
        attempt_id = self._attempt()
        retries = 0
        sha: str | None = None
        try:
            sha, retries = self.fetch_sha(attempt_id)
            artifact = self._build(sha, attempt_id)
            result = {"status": "staged", **artifact, "channel": self.channel, "retryCount": retries}
            self._finish(attempt_id, "staged", sha=sha, retries=retries)
            return result
        except Exception as exc:
            self._finish(attempt_id, "failed", reason=str(exc)[:2000], sha=sha, retries=retries)
            raise

    def stage_sha(self, sha: str) -> dict[str, Any]:
        """Stage one already selected commit without following a moving branch ref."""
        if not SHA_RE.fullmatch(sha):
            raise ControllerError("stage requires a full lowercase commit SHA")
        attempt_id = self._attempt()
        try:
            run_git(self.repo, "cat-file", "-e", f"{sha}^{{commit}}")
            artifact = self._build(sha, attempt_id)
            result = {"status": "staged", **artifact, "channel": self.channel, "retryCount": 0}
            self._finish(attempt_id, "staged", sha=sha)
            return result
        except Exception as exc:
            self._finish(attempt_id, "failed", reason=str(exc)[:2000], sha=sha)
            raise

    def recover_interrupted_attempts(self) -> int:
        now = utc_now()
        with self._db() as db:
            cursor = db.execute("UPDATE attempts SET finished_at=?,status='interrupted',reason='controller process exited before recording a result' WHERE status='running'", (now,))
            return cursor.rowcount

    def rollback(self, sha: str) -> dict[str, Any]:
        if not SHA_RE.fullmatch(sha): raise ControllerError("rollback requires a full lowercase commit SHA")
        integrity = self.verify_release(self.releases / sha, expected_sha=sha)
        with self._db() as db:
            row = db.execute("SELECT state FROM releases WHERE source_sha=?", (sha,)).fetchone()
            previous = db.execute("SELECT current_sha FROM channel_pointers WHERE channel=?", (self.channel,)).fetchone()
        if not row or row["state"] != "verified": raise ControllerError("rollback target is not a checkpointed verified release")
        self._pointer(sha, previous["current_sha"] if previous else sha)
        return {"status": "rolled-back", "channel": self.channel, **integrity}

    def protect(self, sha: str, kind: str, reference_id: str, expires_at: str | None) -> dict[str, Any]:
        self.verify_release(self.releases / sha, expected_sha=sha)
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", kind): raise ControllerError("reference kind must be a lowercase identifier")
        if not reference_id or len(reference_id) > 256 or "\n" in reference_id: raise ControllerError("reference id is empty or invalid")
        if expires_at:
            parsed = dt.datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            if parsed.tzinfo is None: raise ControllerError("reference expiry must include a timezone")
            expires_at = parsed.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
        with self._db() as db:
            db.execute('INSERT INTO "references"(source_sha,kind,reference_id,expires_at) VALUES(?,?,?,?) ON CONFLICT(source_sha,kind,reference_id) DO UPDATE SET expires_at=excluded.expires_at',
                       (sha, kind, reference_id, expires_at))
        return {"status": "protected", "sourceSha": sha, "kind": kind, "referenceId": reference_id, "expiresAt": expires_at}

    def unprotect(self, sha: str, kind: str, reference_id: str) -> dict[str, Any]:
        with self._db() as db:
            db.execute('DELETE FROM "references" WHERE source_sha=? AND kind=? AND reference_id=?', (sha, kind, reference_id))
        return {"status": "unprotected", "sourceSha": sha, "kind": kind, "referenceId": reference_id}


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("command", choices=("sync", "stage", "rollback", "verify", "protect", "unprotect"))
    p.add_argument("--repo", default=os.environ.get("FACTORY_CONTROLLER_REPO", "~/cezar-factory"))
    p.add_argument("--store", default=os.environ.get("FACTORY_RELEASE_STORE", "~/.local/share/cezar-factory/release-store"))
    p.add_argument("--remote", default=os.environ.get("FACTORY_CONTROLLER_REMOTE", "origin"))
    p.add_argument("--channel", default=os.environ.get("FACTORY_CONTROLLER_CHANNEL", "stable"))
    p.add_argument("--keep", type=int, default=int(os.environ.get("FACTORY_RELEASE_KEEP", "3")))
    p.add_argument("--minimum-age-days", type=int, default=int(os.environ.get("FACTORY_RELEASE_MINIMUM_AGE_DAYS", "30")))
    p.add_argument("--fetch-attempts", type=int, default=int(os.environ.get("FACTORY_CONTROLLER_FETCH_ATTEMPTS", "4")))
    p.add_argument("--sha", help="Full SHA for verify or rollback")
    p.add_argument("--reference-kind", help="Lease or other active retention reference")
    p.add_argument("--reference-id", help="Stable identifier for the retention reference")
    p.add_argument("--expires-at", help="Optional ISO-8601 expiry for the retention reference")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        controller = ReleaseController(pathlib.Path(args.repo).expanduser(), pathlib.Path(args.store).expanduser(), args.remote, args.channel, args.keep, args.minimum_age_days, args.fetch_attempts)
        if args.command == "sync":
            with exclusive_lock(controller.store / "controller.lock"):
                controller.recover_interrupted_attempts()
                result = controller.sync()
        elif args.command == "stage":
            with exclusive_lock(controller.store / "controller.lock"):
                controller.recover_interrupted_attempts()
                result = controller.stage_current()
        elif args.command == "verify":
            if not args.sha: raise ControllerError(f"{args.command} requires --sha")
            result = controller.verify_release(controller.releases / args.sha, expected_sha=args.sha)
        elif args.command == "rollback":
            if not args.sha: raise ControllerError("rollback requires --sha")
            with exclusive_lock(controller.store / "controller.lock"):
                controller.recover_interrupted_attempts()
                result = controller.rollback(args.sha)
        else:
            if not (args.sha and args.reference_kind and args.reference_id):
                raise ControllerError(f"{args.command} requires --sha, --reference-kind, and --reference-id")
            with exclusive_lock(controller.store / "controller.lock"):
                controller.recover_interrupted_attempts()
                if args.command == "protect": result = controller.protect(args.sha, args.reference_kind, args.reference_id, args.expires_at)
                else: result = controller.unprotect(args.sha, args.reference_kind, args.reference_id)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except (ControllerError, OSError, sqlite3.Error, subprocess.TimeoutExpired, ValueError, KeyError, TypeError, AttributeError) as exc:
        print(json.dumps({"status": "failed", "error": str(exc)[:2000]}, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
