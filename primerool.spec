# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all

import sys
import os

block_cipher = None

# Handle separator for add-data
# Windows uses ';', others use ':'
sep = ';' if os.name == 'nt' else ':'

# Define icon path based on platform
icon_ext = 'ico' if sys.platform == 'win32' else 'icns'
icon_path = os.path.join('src', 'static', f'logo.{icon_ext}')

datas_primer3, binaries_primer3, hiddenimports_primer3 = collect_all('primer3')

a = Analysis(
    ['src/app.py'],
    pathex=[os.path.abspath('src')],
    binaries=[] + binaries_primer3,
    datas=[
        ('src/templates', 'templates'),
        ('src/static', 'static')
    ] + datas_primer3,
    hiddenimports=['primer3'] + hiddenimports_primer3,
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
    [],
    exclude_binaries=True,
    name='Primerool',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=[icon_path] if os.path.exists(icon_path) else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='Primerool'
)

if sys.platform == 'darwin':
    app = BUNDLE(
        coll,
        name='Primerool.app',
        icon=icon_path if os.path.exists(icon_path) else None,
        bundle_identifier='com.primerool.desktop',
        info_plist={
            'NSHighResolutionCapable': 'True',
            'LSBackgroundOnly': 'False',
        }
    )
