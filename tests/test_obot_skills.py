import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

PATH = Path(__file__).parents[1] / "scripts" / "obot-skills" / "obot_skills.py"
SPEC = importlib.util.spec_from_file_location("obot_skills", PATH)
os_ = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(os_)


def git(cwd, *a):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *a], cwd=cwd,
                          capture_output=True, text=True, check=True).stdout.strip()


class ObotSkills(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "repo"
        (self.repo / "skills" / "g").mkdir(parents=True)
        (self.repo / "skills" / "g" / "SKILL.md").write_text("# godot skill\n")
        git(self.repo, "init", "-q")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "x")
        self.commit = git(self.repo, "rev-parse", "HEAD")
        digest = os_.tree_digest(self.repo / "skills" / "g")
        self.catalog = {"schemaVersion": 1, "bundles": [{
            "id": "godot-core", "version": "1", "digest": digest, "projectTypes": ["godot"],
            "source": {"repository": str(self.repo), "path": "skills/g", "commit": self.commit},
            "metadata": {"owner": "o", "license": "MIT", "trust": "first-party", "permissions": [], "languages": ["godot"]}}]}
        self.cat_path = self.tmp / "catalog.json"
        self.write()
        self.cache = self.tmp / "cache"

    def write(self):
        self.cat_path.write_text(json.dumps(self.catalog))

    def resolve(self, ptype="godot", offline=False):
        return os_.resolve(os_.load_catalog(self.cat_path), ptype, self.cache, offline)

    def test_shipped_catalog_valid(self):
        self.assertTrue(os_.load_catalog()["bundles"])

    def test_two_projects_identical_and_non_godot_gets_nothing(self):
        a = self.resolve()
        b = self.resolve()
        self.assertEqual(a["bundles"][0]["digest"], b["bundles"][0]["digest"])
        self.assertEqual(a["bundles"][0]["from"], "fetched")
        self.assertEqual(b["bundles"][0]["from"], "cache")
        for t in ("dotnet", "python", "general"):
            self.assertEqual(self.resolve(t), {"projectType": t, "bundles": [], "unavailable": []})

    def test_offline_after_warmup_and_uncached_unavailable(self):
        self.assertEqual(self.resolve(offline=True)["unavailable"][0]["id"], "godot-core")
        self.resolve()
        (self.repo / "skills").rename(self.tmp / "gone")  # source gone: cache must still serve
        r = self.resolve(offline=True)
        self.assertEqual((len(r["bundles"]), r["unavailable"]), (1, []))

    def test_integrity_mismatch_rejected(self):
        self.catalog["bundles"][0]["digest"] = "sha256:" + "0" * 64
        self.write()
        r = self.resolve()
        self.assertIn("integrity mismatch", r["unavailable"][0]["reason"])
        self.assertFalse(self.cache.exists() and any(self.cache.rglob("SKILL.md")))

    def test_tampered_cache_detected(self):
        d = Path(self.resolve()["bundles"][0]["path"])
        (d / "SKILL.md").write_text("evil")
        r = self.resolve(offline=True)
        self.assertEqual(r["bundles"], [])
        self.assertIn("integrity", r["unavailable"][0]["reason"])

    def test_unmoved_ref_must_be_commit(self):
        self.catalog["bundles"][0]["source"]["commit"] = "main"
        self.write()
        with self.assertRaises(os_.SkillError):
            os_.load_catalog(self.cat_path)

    def test_unsafe_and_malformed_packages(self):
        d = self.tmp / "pkg"
        d.mkdir()
        with self.assertRaises(os_.SkillError):
            os_.tree_digest(d)
        (d / "SKILL.md").write_text("x")
        (d / "link").symlink_to("/etc/passwd")
        with self.assertRaises(os_.SkillError):
            os_.tree_digest(d)

    def test_path_traversal_and_missing_project_types_rejected(self):
        self.catalog["bundles"][0]["source"]["path"] = "../x"
        self.write()
        with self.assertRaises(os_.SkillError):
            os_.load_catalog(self.cat_path)
        self.catalog["bundles"][0]["source"]["path"] = "skills/g"
        self.catalog["bundles"][0]["projectTypes"] = []
        self.write()
        with self.assertRaises(os_.SkillError):
            os_.load_catalog(self.cat_path)


if __name__ == "__main__":
    unittest.main()
