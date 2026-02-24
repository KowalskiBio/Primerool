@echo off
cd /d "%~dp0\.."

echo Building Windows executable...

:: --- Windows Python Alias Handling ---
set "PYTHON_CMD="
set "PY_CHECK="
for /f "delims=" %%i in ('python -c "import venv; print('OK')" 2^>nul') do set "PY_CHECK=%%i"
if "%PY_CHECK%"=="OK" (
    set "PYTHON_CMD=python"
    goto python_found
)
set "PY_CHECK="
for /f "delims=" %%i in ('py -c "import venv; print('OK')" 2^>nul') do set "PY_CHECK=%%i"
if "%PY_CHECK%"=="OK" (
    set "PYTHON_CMD=py"
    goto python_found
)
echo [INFO] Python is not installed or the Windows Store alias is interfering.
echo [INFO] Commencing automatic Python 3.12 installation...
winget --version >nul 2>&1
if not errorlevel 1 (
    winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
) else (
    powershell -command "Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.12.9/python-3.12.9-amd64.exe' -OutFile '%TEMP%\python_installer.exe'"
    start /wait %TEMP%\python_installer.exe /passive PrependPath=1
)

:: Re-check python
set "PY_CHECK="
for /f "delims=" %%i in ('python -c "import venv; print('OK')" 2^>nul') do set "PY_CHECK=%%i"
if "%PY_CHECK%"=="OK" (
    set "PYTHON_CMD=python"
    goto python_found
)
set "PY_CHECK="
for /f "delims=" %%i in ('py -c "import venv; print('OK')" 2^>nul') do set "PY_CHECK=%%i"
if "%PY_CHECK%"=="OK" (
    set "PYTHON_CMD=py"
    goto python_found
)

:: Try explicit paths
set "PYTHON_EXE="
if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if exist "%PROGRAMFILES%\Python312\python.exe" set "PYTHON_EXE=%PROGRAMFILES%\Python312\python.exe"

if defined PYTHON_EXE (
    set "PYTHON_CMD=%PYTHON_EXE%"
    goto python_found
)

echo [ERROR] Python installation failed or python executable could not be found.
echo Please install Python manually from https://python.org.
pause
exit /b 1

:python_found
echo Using Python command: %PYTHON_CMD%

:: Create a clean packaging environment
if exist build_venv rmdir /s /q build_venv
%PYTHON_CMD% -m venv build_venv
call build_venv\Scripts\activate.bat

:: Upgrade pip to suppress warnings
python -m pip install --upgrade pip

:: Install dependencies needed for compiling
pip install -r requirements.txt
pip install pyinstaller Pillow

:: Generate ICO file natively ensuring Windows transparency is retained
python -c "from PIL import Image; import os; img=Image.open('src/static/logo.png').convert('RGBA'); img.save('src/static/logo.ico', format='ICO', sizes=[(256,256), (128,128), (64,64), (32,32)])"

:: Clean up old builds
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist

:: Run PyInstaller
pyinstaller --noconfirm --clean primerool.spec

echo Build complete. Executable is in dist\Primerool.exe
pause
