@echo off
setlocal

:: Keep window open on any unexpected exit
if "%1"=="--child" goto :main
cmd /k "%~f0" --child
exit /b

:main

:: Get the directory where this script is located
cd /d "%~dp0"

echo ============================================
echo  Starting Primerool
echo ============================================
echo.

:: -----------------------------------------------
:: 1. Check / install Python
:: -----------------------------------------------
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Python not found. Attempting to install automatically...
    echo.

    :: Try winget first (Windows 10 1709+ / Windows 11)
    winget --version >nul 2>&1
    if %errorlevel% equ 0 (
        echo [INFO] Installing Python via winget...
        winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
    ) else (
        :: Fallback: use the PowerShell helper script (avoids all quoting issues)
        echo [INFO] winget not available. Running PowerShell installer script...
        powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_python.ps1"
        if %errorlevel% neq 0 (
            echo [ERROR] Python installation failed. Please install manually from:
            echo         https://www.python.org/downloads/windows/
            echo         Make sure to check "Add Python to PATH" during installation.
            pause
            exit /b 1
        )
    )

    :: Refresh PATH from both user and system registry entries
    for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v PATH 2^>nul') do set "PATH=%PATH%;%%B"
    for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v PATH 2^>nul') do set "PATH=%PATH%;%%B"

    :: Also check the most common Python install locations directly
    if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
        set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts"
    )
    if exist "%PROGRAMFILES%\Python312\python.exe" (
        set "PATH=%PATH%;%PROGRAMFILES%\Python312;%PROGRAMFILES%\Python312\Scripts"
    )

    python --version >nul 2>&1
    if %errorlevel% neq 0 (
        echo.
        echo [INFO] Python was installed but this window needs to be reopened
        echo        to pick up the new PATH. Please close and run again.
        pause
        exit /b 1
    )
)

for /f "tokens=*" %%v in ('python --version 2^>^&1') do echo [OK] Found %%v
echo.

:: -----------------------------------------------
:: 2. Create virtual environment
:: -----------------------------------------------
if not exist "venv" (
    echo [INFO] Creating virtual environment...
    python -m venv venv
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to create virtual environment.
        pause
        exit /b 1
    )
    echo [OK] Virtual environment created.
    echo.
)

:: -----------------------------------------------
:: 3. Activate virtual environment
:: -----------------------------------------------
call venv\Scripts\activate.bat
if %errorlevel% neq 0 (
    echo [ERROR] Failed to activate virtual environment.
    pause
    exit /b 1
)

:: -----------------------------------------------
:: 4. Install / update dependencies
:: -----------------------------------------------
if exist "requirements.txt" (
    echo [INFO] Installing dependencies...
    pip install -r requirements.txt
    if %errorlevel% neq 0 (
        echo [ERROR] pip install failed. Check your internet connection.
        pause
        exit /b 1
    )
    echo [OK] Dependencies ready.
    echo.
)

:: -----------------------------------------------
:: 5. Launch app
:: -----------------------------------------------
echo [INFO] Server starting at http://127.0.0.1:5050
echo [INFO] Press Ctrl+C to stop.
echo.

:: Open browser after a short delay
start "" "http://127.0.0.1:5050"

python src\app.py
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] The application exited with an error (code %errorlevel%).
    echo         See the output above for details.
)

pause
