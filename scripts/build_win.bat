@echo off
cd /d "%~dp0\.."

echo Building Windows executable...

:: Create a clean packaging environment
python -m venv build_venv
call build_venv\Scripts\activate.bat

:: Upgrade pip to suppress warnings
python -m pip install --upgrade pip

:: Install dependencies needed for compiling
pip install -r requirements.txt
pip install pyinstaller Pillow

:: Generate ICO file from PNG for the Windows executable icon
python -c "from PIL import Image; import os; img=Image.open('src/static/logo.png'); img.save('src/static/logo.ico', format='ICO')"

:: Clean up old builds
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist

:: Run PyInstaller
pyinstaller --noconfirm --clean primerool.spec

echo Build complete. Executable is in dist\Primerool.exe
pause
