#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "==> Python tests"
python3 -m unittest discover -s tests -v

echo
echo "==> Desktop tests"
(cd desktop && npm test)

echo
echo "==> Build"
python -m build

echo
echo "==> Twine check"
python -m twine check dist/*

echo
echo "==> Release prep complete"
echo "Next:"
echo "  1. Commit and push your changes"
echo "  2. Create a tag, for example: git tag -a vX.Y.Z -m \"Release vX.Y.Z\""
echo "  3. Push the tag: git push origin main --tags"
echo "  4. Publish a GitHub release for that tag"
echo "  5. Wait for .github/workflows/publish.yml to upload to PyPI"
