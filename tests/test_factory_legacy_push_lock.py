from __future__ import annotations

import os
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "check-release-locks.py"


class LegacyPushLockTests(unittest.TestCase):
    def _held_lock(self, kind: str) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = pathlib.Path(tmp) / "controller.lock"
            lock_flag = "--controller-lock" if kind == "controller" else "--autodeploy-lock"
            process = subprocess.Popen(
                [
                    sys.executable, str(HELPER), lock_flag, str(lock_path), "--hold", "--",
                    sys.executable, "-c", "import time; time.sleep(1)",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                time.sleep(0.15)
                competing = subprocess.run(
                    [sys.executable, str(HELPER), lock_flag, str(lock_path)],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
                self.assertEqual(competing.returncode, 1, competing.stderr)
                self.assertIn("lock is active", competing.stderr)
                self.assertEqual(process.wait(timeout=5), 0)
                released = subprocess.run(
                    [sys.executable, str(HELPER), lock_flag, str(lock_path)],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
                self.assertEqual(released.returncode, 0, released.stderr)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)

    def test_controller_lock_is_held_for_the_entire_push_command(self) -> None:
        self._held_lock("controller")

    @unittest.skipIf(os.name == "nt", "autodeploy uses POSIX flock")
    def test_autodeploy_flock_is_held_for_the_entire_push_command(self) -> None:
        self._held_lock("autodeploy")

    @unittest.skipUnless(os.name == "nt", "Windows cannot inspect the host's POSIX autodeploy lock")
    def test_windows_refuses_an_unverifiable_autodeploy_lock(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = pathlib.Path(tmp) / "autodeploy.lock"
            result = subprocess.run(
                [sys.executable, str(HELPER), "--autodeploy-lock", str(lock_path)],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("cannot verify POSIX autodeploy lock", result.stderr)


if __name__ == "__main__":
    unittest.main()
