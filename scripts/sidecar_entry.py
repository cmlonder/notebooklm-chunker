"""PyInstaller entry point for the bundled `nblm` sidecar binary."""

import os
import sys
from pathlib import Path


def _default_playwright_cache() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "ms-playwright"
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "ms-playwright"
    base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base) / "ms-playwright"


# Playwright defaults frozen apps to PLAYWRIGHT_BROWSERS_PATH=0, which looks
# for browsers inside the bundle instead of the shared ms-playwright cache
# where `python -m playwright install chromium` puts them. Point it back at
# the shared cache so the sidecar sees the same browsers as a pip install.
os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(_default_playwright_cache()))

from notebooklm_chunker.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
