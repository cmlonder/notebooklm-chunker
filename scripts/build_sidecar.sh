#!/usr/bin/env bash
# Build a standalone `nblm` binary (PyInstaller) for bundling into the
# desktop app, so end users do not need Python/pip/PATH setup.
#
# Output: desktop/sidecar/dist/nblm
#
# Experimental notes:
# - `nblm login` opens Playwright Chromium. The bundled binary still requires
#   `python -m playwright install chromium` to have been run once on the
#   machine, OR login can be done with a system nblm; run state and auth are
#   shared. All other commands (prepare/run/resume/studios/doctor) work
#   self-contained.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$REPO_ROOT/desktop/sidecar"
VENV_DIR="$BUILD_DIR/.build-venv"

mkdir -p "$BUILD_DIR"

if [ ! -x "$VENV_DIR/bin/python" ]; then
  python3 -m venv "$VENV_DIR"
fi

"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet "$REPO_ROOT" pyinstaller
# pip skips same-version reinstalls, which would freeze stale code into the
# binary; force just the project package to rebuild from the working tree.
"$VENV_DIR/bin/pip" install --quiet --force-reinstall --no-deps --no-cache-dir "$REPO_ROOT"

# --onedir instead of --onefile: onefile unpacks itself on EVERY invocation
# (7-10s per command on macOS), which makes the desktop app feel frozen.
"$VENV_DIR/bin/pyinstaller" \
  --onedir \
  --name nblm \
  --distpath "$BUILD_DIR/dist" \
  --workpath "$BUILD_DIR/build" \
  --specpath "$BUILD_DIR" \
  --collect-all notebooklm \
  --collect-all pymupdf \
  --hidden-import notebooklm_chunker \
  --noconfirm \
  "$REPO_ROOT/scripts/sidecar_entry.py"

echo
echo "Sidecar binary: $BUILD_DIR/dist/nblm/nblm"
"$BUILD_DIR/dist/nblm/nblm" --version
