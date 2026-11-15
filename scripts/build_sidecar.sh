#!/usr/bin/env bash
# Build a standalone `nblm` binary (PyInstaller) for bundling into the
# desktop app, so end users do not need Python/pip/PATH setup.
#
# Output: desktop/sidecar/dist/nblm
#
# The binary also answers `nblm -m <module>` / `nblm -c <code>` (see
# scripts/sidecar_entry.py), which is how `nblm login` runs notebooklm-py's
# CLI and its Chromium download without a Python install on the machine.
#
# Runs on macOS, Linux and Windows (Git Bash). PYTHON overrides the
# interpreter used to create the build venv.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$REPO_ROOT/desktop/sidecar"
VENV_DIR="$BUILD_DIR/.build-venv"

mkdir -p "$BUILD_DIR"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) VENV_BIN="$VENV_DIR/Scripts"; EXE=".exe" ;;
  *) VENV_BIN="$VENV_DIR/bin"; EXE="" ;;
esac
VENV_PYTHON="$VENV_BIN/python$EXE"

if [ ! -x "$VENV_PYTHON" ]; then
  "${PYTHON:-python3}" -m venv "$VENV_DIR"
fi

"$VENV_PYTHON" -m pip install --quiet --upgrade pip
"$VENV_PYTHON" -m pip install --quiet "$REPO_ROOT" pyinstaller
# pip skips same-version reinstalls, which would freeze stale code into the
# binary; force just the project package to rebuild from the working tree.
"$VENV_PYTHON" -m pip install --quiet --force-reinstall --no-deps --no-cache-dir "$REPO_ROOT"

# --onedir instead of --onefile: onefile unpacks itself on EVERY invocation
# (7-10s per command on macOS), which makes the desktop app feel frozen.
"$VENV_PYTHON" -m PyInstaller \
  --onedir \
  --name nblm \
  --distpath "$BUILD_DIR/dist" \
  --workpath "$BUILD_DIR/build" \
  --specpath "$BUILD_DIR" \
  --collect-all notebooklm \
  --collect-all pymupdf \
  --hidden-import notebooklm_chunker \
  --hidden-import playwright.__main__ \
  --noconfirm \
  "$REPO_ROOT/scripts/sidecar_entry.py"

echo
SIDECAR="$BUILD_DIR/dist/nblm/nblm$EXE"
echo "Sidecar binary: $SIDECAR"
"$SIDECAR" --version
# The interpreter shim is what sign-in depends on; fail the build if it broke.
"$SIDECAR" -m notebooklm --version
"$SIDECAR" -m playwright --version
