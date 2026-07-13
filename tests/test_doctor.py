import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from notebooklm_chunker.doctor import _auth_check, notebooklm_auth_paths


class NotebookLMAuthPathsTest(unittest.TestCase):
    def test_detects_legacy_home_root_layout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "storage_state.json").write_text("{}", encoding="utf-8")

            found = notebooklm_auth_paths(root)

            self.assertEqual(found, [root / "storage_state.json"])

    def test_detects_profile_layout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = root / "profiles" / "default"
            profile.mkdir(parents=True)
            (profile / "storage_state.json").write_text("{}", encoding="utf-8")

            found = notebooklm_auth_paths(root)

            self.assertIn(profile / "storage_state.json", found)

    def test_returns_empty_when_no_auth_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(notebooklm_auth_paths(Path(directory)), [])


class AuthCheckTest(unittest.TestCase):
    def test_auth_check_ok_for_profile_layout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = root / "profiles" / "default"
            profile.mkdir(parents=True)
            (profile / "storage_state.json").write_text("{}", encoding="utf-8")

            with patch.dict("os.environ", {"NOTEBOOKLM_HOME": str(root)}, clear=False):
                with patch.dict("os.environ", {"NOTEBOOKLM_AUTH_JSON": ""}, clear=False):
                    check = _auth_check()

            self.assertEqual(check.status, "ok")

    def test_auth_check_warns_when_missing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(
                "os.environ",
                {"NOTEBOOKLM_HOME": directory, "NOTEBOOKLM_AUTH_JSON": ""},
                clear=False,
            ):
                check = _auth_check()

            self.assertEqual(check.status, "warn")


if __name__ == "__main__":
    unittest.main()
