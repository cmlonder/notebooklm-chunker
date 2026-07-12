"""PyInstaller entry point for the bundled `nblm` sidecar binary."""

from notebooklm_chunker.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
