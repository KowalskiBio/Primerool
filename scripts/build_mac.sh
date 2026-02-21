#!/bin/bash

# Ensure script is run from project root
cd "$(dirname "$0")/.."

echo "Building macOS application..."

# Create a clean packaging environment
python3 -m venv build_venv
source build_venv/bin/activate

# Upgrade pip to suppress warnings
python3 -m pip install --upgrade pip

# Install dependencies needed for compiling
pip install -r requirements.txt
pip install pyinstaller Pillow

# Generate ICNS file natively to preserve PNG transparency
echo "Converting logo to .icns natively via sips and iconutil..."
ICON_PNG="src/static/logo.png"
ICON_ICNS="src/static/logo.icns"
ICONSET="src/static/logo.iconset"

mkdir -p "$ICONSET"
sips -z 16 16     "$ICON_PNG" --out "$ICONSET/icon_16x16.png" >/dev/null
sips -z 32 32     "$ICON_PNG" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
sips -z 32 32     "$ICON_PNG" --out "$ICONSET/icon_32x32.png" >/dev/null
sips -z 64 64     "$ICON_PNG" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
sips -z 128 128   "$ICON_PNG" --out "$ICONSET/icon_128x128.png" >/dev/null
sips -z 256 256   "$ICON_PNG" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256   "$ICON_PNG" --out "$ICONSET/icon_256x256.png" >/dev/null
sips -z 512 512   "$ICON_PNG" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512   "$ICON_PNG" --out "$ICONSET/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$ICON_PNG" --out "$ICONSET/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$ICONSET" -o "$ICON_ICNS" || echo "Native icon generation failed."
rm -rf "$ICONSET"

# We don't want to redirect the pyinstaller cache because it needs to work natively for the user
rm -rf build dist

# Run PyInstaller
pyinstaller --noconfirm --clean primerool.spec

# Create DMG from the built .app
echo "Packaging into Primerool.dmg..."
# Force natively inject the transparent icon directly to the bundle resource fork (similar to Get Info -> Paste)
python -c "import Cocoa; ws = Cocoa.NSWorkspace.sharedWorkspace(); img = Cocoa.NSImage.alloc().initWithContentsOfFile_('src/static/logo.png'); ws.setIcon_forFile_options_(img, 'dist/Primerool.app', 0)" || echo "Native Icon override failed."

hdiutil create -volname "Primerool" -srcfolder dist/Primerool.app -ov -format UDZO dist/Primerool.dmg

echo "Build complete. Executable is in dist/Primerool.dmg"
