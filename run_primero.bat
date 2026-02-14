@echo off
setlocal

:: Get the directory where this script is located
cd /d "%~dp0"

echo Starting Primeroonline...

:: Check if Python is installed
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Python not found. Attempting to install automatically...

    :: Try winget first (available on Windows 10 1709+ and Windows 11)
    winget --version >nul 2>&1
    if %errorlevel% equ 0 (
        echo Installing Python via winget...
        winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
    ) else (
        :: Fallback: download installer via curl (built into Windows 10+)
        echo winget not available. Downloading Python installer...
        curl -L -o "%TEMP%\python_installer.exe" "https://www.python.org/ftp/python/3.12.9/python-3.12.9-amd64.exe"
        if %errorlevel% neq 0 (
            echo Failed to download Python installer. Please install manually from https://www.python.org/downloads/windows/
            pause
            exit /b 1
        )
        echo Running Python installer (follow the prompts, check "Add Python to PATH")...
        "%TEMP%\python_installer.exe" /passive PrependPath=1
    )

    :: Re-check after install
    python --version >nul 2>&1
    if %errorlevel% neq 0 (
        echo Python installation may require a restart of this window.
        echo Please close and reopen this script after installation completes.
        pause
        exit /b 1
    )
)

:: Create virtual environment if it doesn't exist
if not exist "venv" (
    echo Creating virtual environment...
    python -m venv venv
)

:: Activate virtual environment
call venv\Scripts\activate.bat

:: Install dependencies if needed
if exist "requirements.txt" (
    echo Checking dependencies...
    pip install -r requirements.txt
)

:: Open browser after a short delay
start "" "http://127.0.0.1:5050"

:: Run the application
echo Server running at http://127.0.0.1:5050
echo Press Ctrl+C to stop the server.
python src\app.py

pause
