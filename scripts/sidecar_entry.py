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


def _run_as_interpreter(argv: list[str]) -> bool:
    """Answer `<engine> -c <code>` and `<engine> -m <module> ...` like Python.

    notebooklm-py re-invokes `sys.executable` this way to probe for Chromium,
    to download it, and (from `nblm login`) to run its own CLI. In the frozen
    engine `sys.executable` is this binary, so it has to play interpreter.
    """

    if len(argv) >= 3 and argv[1] == "-c":
        sys.argv = ["-c", *argv[3:]]
        exec(compile(argv[2], "<string>", "exec"), {"__name__": "__main__"})
        return True
    if len(argv) >= 3 and argv[1] == "-m":
        import runpy

        sys.argv = [argv[2], *argv[3:]]
        runpy.run_module(argv[2], run_name="__main__", alter_sys=True)
        return True
    return False


if __name__ == "__main__":
    if not _run_as_interpreter(sys.argv):
        from notebooklm_chunker.cli import main

        raise SystemExit(main())
