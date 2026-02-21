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

# Generate ICNS file from PNG
python3 -c "from PIL import Image; import os; img=Image.open('src/static/logo.png'); img.save('src/static/logo.icns', format='ICNS')"

# We don't want to redirect the pyinstaller cache because it needs to work natively for the user
rm -rf build dist

# Run PyInstaller
pyinstaller --noconfirm --clean primerool.spec

# Create DMG from the built .app
echo "Packaging into Primerool.dmg..."
hdiutil create -volname "Primerool" -srcfolder dist/Primerool.app -ov -format UDZO dist/Primerool.dmg

echo "Build complete. Executable is in dist/Primerool.dmg"
