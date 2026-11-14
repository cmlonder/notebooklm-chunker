import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from notebooklm_chunker.doctor import (
    _auth_check,
    account_email_for_storage,
    notebooklm_auth_paths,
)


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

            with (
                patch.dict(
                    "os.environ",
                    {"NOTEBOOKLM_HOME": str(root), "NOTEBOOKLM_AUTH_JSON": ""},
                    clear=False,
                ),
                patch("notebooklm_chunker.doctor._saved_session_rejected", return_value=False),
            ):
                check = _auth_check()

            self.assertEqual(check.status, "ok")

    def test_auth_check_warns_when_saved_session_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = root / "profiles" / "work"
            profile.mkdir(parents=True)
            (profile / "storage_state.json").write_text("{}", encoding="utf-8")

            with (
                patch.dict(
                    "os.environ",
                    {"NOTEBOOKLM_HOME": str(root), "NOTEBOOKLM_AUTH_JSON": ""},
                    clear=False,
                ),
                patch("notebooklm_chunker.doctor._saved_session_rejected", return_value=True),
            ):
                check = _auth_check()

            self.assertEqual(check.status, "warn")
            self.assertIn("expired", check.summary)
            self.assertIn("work", check.summary)
            self.assertIn("nblm login", check.hint or "")

    def test_auth_check_skips_session_probe_without_session_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "profiles" / "default" / "browser_profile").mkdir(parents=True)

            with (
                patch.dict(
                    "os.environ",
                    {"NOTEBOOKLM_HOME": str(root), "NOTEBOOKLM_AUTH_JSON": ""},
                    clear=False,
                ),
                patch("notebooklm_chunker.doctor._saved_session_rejected") as probe,
            ):
                check = _auth_check()

            self.assertEqual(check.status, "ok")
            probe.assert_not_called()

    def test_auth_check_warns_when_missing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(
                "os.environ",
                {"NOTEBOOKLM_HOME": directory, "NOTEBOOKLM_AUTH_JSON": ""},
                clear=False,
            ):
                check = _auth_check()

            self.assertEqual(check.status, "warn")


class AccountEmailTest(unittest.TestCase):
    def test_reads_email_from_whichever_module_has_the_helper(self) -> None:
        class _Module:
            @staticmethod
            def get_account_email_for_storage(path: Path) -> str:
                return "person@example.com"

        def fake_import(name: str) -> object:
            if name == "notebooklm._auth.storage":
                raise ImportError(name)
            return _Module

        with patch("notebooklm_chunker.doctor.importlib.import_module", side_effect=fake_import):
            email = account_email_for_storage(Path("storage_state.json"))

        self.assertEqual(email, "person@example.com")

    def test_returns_none_when_helper_is_missing_everywhere(self) -> None:
        with patch(
            "notebooklm_chunker.doctor.importlib.import_module", side_effect=ImportError("gone")
        ):
            self.assertIsNone(account_email_for_storage(Path("storage_state.json")))


if __name__ == "__main__":
    unittest.main()
