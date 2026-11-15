"""Pick the browser `nblm login` opens, and how to reach the `notebooklm` CLI.

A pip install has a `notebooklm` console script and (after
`python -m playwright install chromium`) Playwright's own Chromium. The
desktop app's bundled engine has neither on a fresh machine, so sign-in
prefers a browser that is already installed and only downloads Chromium when
there is nothing else to use.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

LOGIN_BROWSERS = ("auto", "chromium", "chrome", "msedge")

_SYSTEM_BROWSER_LABELS = {"chrome": "Google Chrome", "msedge": "Microsoft Edge"}


def is_frozen() -> bool:
    """True inside the PyInstaller engine bundled with the desktop app."""

    return bool(getattr(sys, "frozen", False))


def notebooklm_command() -> list[str]:
    """Command prefix that runs the notebooklm-py CLI.

    The bundled engine ships no `notebooklm` script; its entry point runs a
    module when called as `<engine> -m <module>`, so it re-invokes itself.
    """

    if is_frozen():
        return [sys.executable, "-m", "notebooklm"]
    return ["notebooklm"]


def _system_browser_candidates() -> dict[str, list[Path]]:
    home = Path.home()
    if sys.platform == "darwin":
        return {
            "chrome": [
                Path("/Applications/Google Chrome.app"),
                home / "Applications" / "Google Chrome.app",
            ],
            "msedge": [
                Path("/Applications/Microsoft Edge.app"),
                home / "Applications" / "Microsoft Edge.app",
            ],
        }
    if sys.platform == "win32":
        roots = [
            Path(value)
            for value in (
                os.environ.get("PROGRAMFILES"),
                os.environ.get("PROGRAMFILES(X86)"),
                os.environ.get("LOCALAPPDATA"),
            )
            if value
        ]
        return {
            "chrome": [root / "Google" / "Chrome" / "Application" / "chrome.exe" for root in roots],
            "msedge": [
                root / "Microsoft" / "Edge" / "Application" / "msedge.exe" for root in roots
            ],
        }
    return {
        "chrome": [
            Path(found)
            for name in ("google-chrome", "google-chrome-stable")
            if (found := shutil.which(name))
        ],
        "msedge": [
            Path(found)
            for name in ("microsoft-edge", "microsoft-edge-stable")
            if (found := shutil.which(name))
        ],
    }


def system_browser_channel() -> str | None:
    """Installed browser Playwright can drive without a download, if any."""

    for channel, paths in _system_browser_candidates().items():
        if any(path.exists() for path in paths):
            return channel
    return None


def system_browser_label(channel: str) -> str:
    return _SYSTEM_BROWSER_LABELS.get(channel, channel)


def playwright_chromium_path() -> Path | None:
    """Playwright's own Chromium, when it is already downloaded."""

    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            executable_path = Path(playwright.chromium.executable_path)
    except Exception:
        return None
    return executable_path if executable_path.exists() else None


def resolve_login_browser(requested: str | None = None) -> str:
    """Turn `auto` into a concrete browser for `notebooklm login --browser`.

    Order: Playwright's Chromium when present (the long-standing default),
    then an installed Chrome or Edge, and only then Chromium again — which
    notebooklm-py downloads on first use.
    """

    choice = (requested or "auto").strip().lower()
    if choice != "auto":
        return choice
    if playwright_chromium_path() is not None:
        return "chromium"
    return system_browser_channel() or "chromium"
