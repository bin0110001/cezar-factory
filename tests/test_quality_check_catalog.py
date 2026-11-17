"""The quality check catalog (docs/quality-check-catalog.md) is verified against the code, not against checkbox state."""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
CATALOG = (ROOT / "docs" / "quality-check-catalog.md").read_text(encoding="utf8")


def rows():
    """Family rows of the first table: Family | Check | Category | Stages | Owner | Provider | Status | Code."""
    out = []
    for line in CATALOG.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) == 8 and cells[0].isdigit():
            out.append({"family": int(cells[0]), "check": cells[1], "category": cells[2], "stages": cells[3], "owner": cells[4], "provider": cells[5], "status": cells[6], "code": cells[7]})
    return out


def code_paths(cell):
    return re.findall(r"`([^`]+)`", cell)


class CatalogMatchesTheCode(unittest.TestCase):
    def test_every_family_one_to_seven_appears_with_an_owner_issue(self):
        families = {}
        for r in rows():
            families.setdefault(r["family"], []).append(r)
        self.assertEqual(sorted(families), [1, 2, 3, 4, 5, 6, 7])
        for fam, rs in families.items():
            for r in rs:
                self.assertRegex(r["owner"], r"#\d+", f"family {fam}: {r['check']} has no owner issue")

    def test_every_delivered_row_names_code_that_exists(self):
        checked = 0
        for r in rows():
            if r["status"] == "delivered":
                paths = code_paths(r["code"])
                self.assertTrue(paths, f"delivered row without code: {r['check']}")
                for p in paths:
                    resolved = (ROOT / p).resolve()
                    self.assertTrue(resolved.exists(), f"{r['check']} ({r['owner']}) names missing code {p}")
                    checked += 1
        self.assertGreater(checked, 15)

    def test_foundation_rows_name_code_that_exists(self):
        found = 0
        for line in CATALOG.splitlines():
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) == 4 and cells[2] == "delivered":
                for p in code_paths(cells[3]):
                    self.assertTrue((ROOT / p).exists(), f"{cells[0]} names missing code {p}")
                    found += 1
        self.assertGreaterEqual(found, 6)

    def test_open_rows_name_no_code_and_open_owners_are_linked_once(self):
        open_rows = [r for r in rows() if r["status"] == "open"]
        self.assertTrue(open_rows)
        for r in open_rows:
            self.assertEqual(r["code"], "—", f"open row {r['check']} must not claim code")
        self.assertIn("#662", CATALOG)
        self.assertIn("#603", CATALOG)

    def test_one_provider_per_maintainability_category_and_no_duplicate_owners_for_a_check(self):
        maintainability = [r for r in rows() if r["family"] == 5]
        self.assertEqual({r["provider"] for r in maintainability}, {"quality-metrics"})
        self.assertEqual({r["owner"] for r in maintainability}, {"#649"})
        seen = {}
        for r in rows():
            seen.setdefault(r["check"], set()).add(r["owner"])
        self.assertTrue(all(len(v) == 1 for v in seen.values()), "a check must have exactly one owner issue")

    def test_dependency_scanning_has_one_default_provider(self):
        sca = [r for r in rows() if r["category"] == "sca"]
        defaults = [r for r in sca if "default" in r["check"]]
        self.assertEqual([r["provider"] for r in defaults], ["trivy"])
        self.assertIn("osv-scanner", {r["provider"] for r in sca})


if __name__ == "__main__":
    unittest.main()
