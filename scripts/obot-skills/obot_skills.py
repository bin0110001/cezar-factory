#!/usr/bin/env python3
"""Resolve approved, Git-pinned skill bundles for a project type (issue #168).

Obot indexes the Git sources; this tool is the supported CLI fetch path. It never
forks content: it fetches the pinned commit with git, verifies the bundle digest,
refuses unsafe packages, caches verified bytes and records installed refs. Once the
cache is warm, resolution works with no network. Uncached content is reported
unavailable, never substituted. Stdlib only.
"""
import argparse, hashlib, json, os, re, shutil, subprocess, sys, tempfile
from pathlib import Path

CATALOG = Path(__file__).parents[2] / "integrations" / "obot-skills" / "catalog.json"
COMMIT = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")


class SkillError(Exception):
    pass


def load_catalog(path=CATALOG):
    cat = json.loads(Path(path).read_text(encoding="utf-8"))
    if cat.get("schemaVersion") != 1:
        raise SkillError("unsupported catalog schemaVersion")
    seen = set()
    for b in cat.get("bundles", []):
        bid = b.get("id", "")
        if not ID.match(bid) or bid in seen:
            raise SkillError(f"bad or duplicate bundle id: {bid!r}")
        seen.add(bid)
        src = b.get("source", {})
        if not COMMIT.match(src.get("commit", "")):
            raise SkillError(f"{bid}: source.commit must be an immutable 40-hex commit")
        if not DIGEST.match(b.get("digest", "")):
            raise SkillError(f"{bid}: digest must be sha256:<64 hex>")
        if not src.get("repository") or not safe_rel(src.get("path", "")):
            raise SkillError(f"{bid}: source repository/path invalid")
        if not b.get("projectTypes"):
            raise SkillError(f"{bid}: projectTypes must be explicit (default-deny)")
        for key in ("owner", "license", "trust", "permissions", "languages"):
            if key not in b.get("metadata", {}):
                raise SkillError(f"{bid}: metadata.{key} missing")
    return cat


def safe_rel(p):
    parts = Path(p).parts
    return bool(p) and not os.path.isabs(p) and ".." not in parts and "\\" not in p and ":" not in p


def tree_digest(root):
    """sha256 over sorted 'relpath\\0filesha\\n'; rejects symlinks and escapes."""
    root = Path(root)
    h = hashlib.sha256()
    files = []
    for dirpath, dirs, names in os.walk(root):
        for n in dirs + names:
            if (Path(dirpath) / n).is_symlink():
                raise SkillError(f"unsafe package: symlink {Path(dirpath) / n}")
        files += [Path(dirpath) / n for n in names]
    if not any(f.name == "SKILL.md" and f.parent == root for f in files):
        raise SkillError("malformed package: no SKILL.md at bundle root")
    for f in sorted(files, key=lambda p: p.relative_to(root).as_posix()):
        h.update(f.relative_to(root).as_posix().encode() + b"\0" + hashlib.sha256(f.read_bytes()).hexdigest().encode() + b"\n")
    return "sha256:" + h.hexdigest()


def fetch(bundle, dest, git="git"):
    """Fetch only the pinned commit and copy the bundle path (supported CLI path)."""
    src = bundle["source"]
    with tempfile.TemporaryDirectory() as tmp:
        def run(*a):
            r = subprocess.run([git, *a], cwd=tmp, capture_output=True, text=True)
            if r.returncode:
                raise SkillError(f"git {a[0]} failed: {r.stderr.strip()[:300]}")
        run("init", "-q")
        run("fetch", "-q", "--depth", "1", src["repository"], src["commit"])
        run("checkout", "-q", "FETCH_HEAD")
        head = subprocess.run([git, "rev-parse", "HEAD"], cwd=tmp, capture_output=True, text=True).stdout.strip()
        if head != src["commit"]:
            raise SkillError(f"fetched {head}, expected pinned {src['commit']}")
        srcdir = Path(tmp) / src["path"]
        if not srcdir.is_dir():
            raise SkillError(f"path {src['path']} not found at pinned commit")
        shutil.copytree(srcdir, dest, symlinks=True, ignore=shutil.ignore_patterns(".git"))


def entry_dir(cache, bundle):
    return Path(cache) / bundle["id"] / bundle["digest"].replace(":", "-")


def eligible(cat, project_type):
    return [b for b in cat["bundles"] if project_type in b["projectTypes"]]


def resolve(cat, project_type, cache, offline=False, git="git"):
    """Return {bundles:[...], unavailable:[...]} for the project type; none for others."""
    out, missing = [], []
    for b in eligible(cat, project_type):
        d = entry_dir(cache, b)
        try:
            if d.is_dir():
                if tree_digest(d) != b["digest"]:
                    shutil.rmtree(d)
                    raise SkillError("cached bytes fail integrity check")
                state = "cache"
            elif offline:
                raise SkillError("not cached and offline")
            else:
                d.parent.mkdir(parents=True, exist_ok=True)
                tmp = d.with_name(d.name + ".part")
                shutil.rmtree(tmp, ignore_errors=True)
                try:
                    fetch(b, tmp, git)
                    got = tree_digest(tmp)
                    if got != b["digest"]:
                        raise SkillError(f"integrity mismatch: got {got}, approved {b['digest']}")
                    os.replace(tmp, d)
                finally:
                    shutil.rmtree(tmp, ignore_errors=True)
                state = "fetched"
            out.append({"id": b["id"], "version": b["version"], "path": str(d), "digest": b["digest"],
                        "commit": b["source"]["commit"], "repository": b["source"]["repository"], "from": state})
        except SkillError as e:
            missing.append({"id": b["id"], "reason": str(e)})
    return {"projectType": project_type, "bundles": out, "unavailable": missing}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("validate").add_argument("--catalog", default=str(CATALOG))
    r = sub.add_parser("resolve")
    r.add_argument("--project-type", required=True)
    r.add_argument("--cache", required=True)
    r.add_argument("--catalog", default=str(CATALOG))
    r.add_argument("--offline", action="store_true")
    r.add_argument("--lock", help="write installed refs here")
    a = p.parse_args(argv)
    try:
        cat = load_catalog(a.catalog)
        if a.cmd == "validate":
            print(f"OBOT_SKILLS_CATALOG_OK bundles={len(cat['bundles'])}")
            return 0
        res = resolve(cat, a.project_type, a.cache, a.offline)
    except (SkillError, OSError, ValueError) as e:
        print(f"OBOT_SKILLS_ERROR {e}", file=sys.stderr)
        return 2
    if a.lock:
        Path(a.lock).write_text(json.dumps(res, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(res, indent=2))
    return 1 if res["unavailable"] else 0


if __name__ == "__main__":
    sys.exit(main())
