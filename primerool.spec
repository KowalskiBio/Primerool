# -*- mode: python ; coding: utf-8 -*-

import sys
import os

block_cipher = None

# Handle separator for add-data
# Windows uses ';', others use ':'
sep = ';' if os.name == 'nt' else ':'

# Define icon path based on platform
icon_ext = 'ico' if sys.platform == 'win32' else 'icns'
icon_path = os.path.join('src', 'static', f'logo.{icon_ext}')

a = Analysis(
    ['src/app.py'],
    pathex=[os.path.abspath('src')],
    binaries=[],
    datas=[
        ('src/templates', 'templates'),
        ('src/static', 'static')
    ],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='Primerool',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=[icon_path] if os.path.exists(icon_path) else None,
)

if sys.platform == 'darwin':
    app = BUNDLE(
        exe,
        name='Primerool.app',
        icon=icon_path if os.path.exists(icon_path) else None,
        bundle_identifier='com.primerool.desktop',
    )
