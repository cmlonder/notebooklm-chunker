#!/usr/bin/env bash
# Rebuild the desktop app icons from desktop/build/icon.svg.
#
# Output: desktop/build/icon.png (512px), icon.icns, icon.ico
#
# macOS only: it rasterizes with headless Google Chrome and packs with the
# system `sips` and `iconutil`. CHROME overrides the browser binary.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$REPO_ROOT/desktop/build"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/icon.html" <<HTML
<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:1024px;height:1024px}</style>
<img src="file://$BUILD_DIR/icon.svg">
HTML

"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 --window-size=1024,1024 \
  --screenshot="$WORK/icon-1024.png" "file://$WORK/icon.html" >/dev/null 2>&1

ICONSET="$WORK/icon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$WORK/icon-1024.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$WORK/icon-1024.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$BUILD_DIR/icon.icns"
cp "$ICONSET/icon_512x512.png" "$BUILD_DIR/icon.png"

# .ico is a small directory of PNG images; pack it without extra tooling.
for size in 16 24 32 48 64 128 256; do
  sips -z "$size" "$size" "$WORK/icon-1024.png" --out "$WORK/ico-$size.png" >/dev/null
done
python3 - "$WORK" "$BUILD_DIR/icon.ico" <<'PY'
import struct
import sys
from pathlib import Path

work, target = Path(sys.argv[1]), Path(sys.argv[2])
sizes = [16, 24, 32, 48, 64, 128, 256]
images = [(size, (work / f"ico-{size}.png").read_bytes()) for size in sizes]
offset = 6 + 16 * len(images)
header = struct.pack("<HHH", 0, 1, len(images))
entries = b""
for size, data in images:
    entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
    offset += len(data)
target.write_bytes(header + entries + b"".join(data for _, data in images))
PY

echo "Icons written to $BUILD_DIR"
