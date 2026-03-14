#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/desktop"

case "$(uname -s)" in
  Darwin)
    BUILD_CMD="npm run build:mac"
    ;;
  Linux)
    BUILD_CMD="npm run build:linux"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    BUILD_CMD="npm run build:win"
    ;;
  *)
    echo "Unsupported platform for local desktop build: $(uname -s)" >&2
    exit 1
    ;;
esac

cd "$DESKTOP_DIR"

echo "==> Desktop tests"
npm test

echo
echo "==> Desktop build ($BUILD_CMD)"
$BUILD_CMD

echo
echo "==> Desktop artifacts"
find dist -maxdepth 1 -type f | sort
