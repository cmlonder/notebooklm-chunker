from __future__ import annotations

import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from notebooklm_chunker import login_browser


class ResolveLoginBrowserTests(TestCase):
    def test_explicit_choice_is_kept(self) -> None:
        with patch.object(login_browser, "playwright_chromium_path") as probe:
            self.assertEqual(login_browser.resolve_login_browser("MSEdge"), "msedge")

        probe.assert_not_called()

    def test_auto_prefers_playwright_chromium(self) -> None:
        with (
            patch.object(login_browser, "playwright_chromium_path", return_value=Path("/c")),
            patch.object(login_browser, "system_browser_channel", return_value="chrome"),
        ):
            self.assertEqual(login_browser.resolve_login_browser(), "chromium")

    def test_auto_falls_back_to_an_installed_browser(self) -> None:
        with (
            patch.object(login_browser, "playwright_chromium_path", return_value=None),
            patch.object(login_browser, "system_browser_channel", return_value="chrome"),
        ):
            self.assertEqual(login_browser.resolve_login_browser("auto"), "chrome")

    def test_auto_downloads_chromium_when_nothing_is_installed(self) -> None:
        with (
            patch.object(login_browser, "playwright_chromium_path", return_value=None),
            patch.object(login_browser, "system_browser_channel", return_value=None),
        ):
            self.assertEqual(login_browser.resolve_login_browser(), "chromium")


class SystemBrowserChannelTests(TestCase):
    def test_reports_the_first_installed_browser(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            edge = Path(directory) / "edge"
            edge.write_text("", encoding="utf-8")
            candidates = {"chrome": [Path(directory) / "missing"], "msedge": [edge]}
            with patch.object(login_browser, "_system_browser_candidates", return_value=candidates):
                self.assertEqual(login_browser.system_browser_channel(), "msedge")

    def test_reports_none_without_a_browser(self) -> None:
        with patch.object(
            login_browser, "_system_browser_candidates", return_value={"chrome": [], "msedge": []}
        ):
            self.assertIsNone(login_browser.system_browser_channel())


class NotebooklmCommandTests(TestCase):
    def test_uses_the_console_script_from_a_pip_install(self) -> None:
        with patch.object(login_browser.sys, "frozen", False, create=True):
            self.assertEqual(login_browser.notebooklm_command(), ["notebooklm"])
