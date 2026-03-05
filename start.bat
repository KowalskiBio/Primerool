@echo off
setlocal enabledelayedexpansion
title Primerool

:: ──────────────────────────────────────────────────────────
::  Primerool – one-click launcher (Windows)
:: ──────────────────────────────────────────────────────────

set "ROOT=%~dp0"
cd /d "%ROOT%"

:: Print functions
set "CYAN=[INFO]"
set "GREEN=[OK]"
set "RED=[ERROR]"

:: Check Python
where python >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo %RED% Python 3 is required but not found. Please install Python from https://python.org
    pause
    exit /b 1
)

:: Check Node
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo %CYAN% Node.js not found. Please install Node.js from https://nodejs.org/en/download/prebuilt-installer
    pause
    exit /b 1
)

echo %GREEN% Python and Node.js found.

:: Setup Python venv
if not exist "%ROOT%.venv\Scripts\activate.bat" (
    echo %CYAN% Creating Python virtual environment...
    python -m venv "%ROOT%.venv"
)

call "%ROOT%.venv\Scripts\activate.bat"
echo %CYAN% Installing Python dependencies...
python -m pip install -q -r "%ROOT%requirements.txt"
echo %GREEN% Python packages ready.

:: Setup Node dependencies
if not exist "%ROOT%frontend\node_modules" (
    echo %CYAN% Installing Node dependencies (first run)...
    cd "%ROOT%frontend"
    call npm install
    cd "%ROOT%"
)
echo %GREEN% Node packages ready.

:: Start applications
echo %CYAN% Starting backend and frontend...
start "Primerool API" /B cmd /c "cd /d "%ROOT%" && python backend/main.py"
start "Primerool UI" /B cmd /c "cd /d "%ROOT%frontend" && npm run dev -- --host 0.0.0.0"

:: Start desktop window
echo %CYAN% Opening application window...
python webview_app.py --dev

echo.
echo %CYAN% Shutting down...
taskkill /FI "WINDOWTITLE eq Primerool API*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Primerool UI*" /T /F >nul 2>&1
echo %GREEN% Stopped.
pause
