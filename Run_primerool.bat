@echo off
setlocal

:: Get the directory where this script is located
cd /d "%~dp0"

echo Starting Primeroonline...

:: Check if Python is installed
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Error: Python is not installed or not in your PATH.
    echo Please install Python from https://www.python.org/downloads/windows/
    echo Make sure to check "Add Python to PATH" during installation.
    pause
    exit /b 1
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
