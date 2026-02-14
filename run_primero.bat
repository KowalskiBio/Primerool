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
    echo  Python is not installed on this computer.
    echo  Primerool requires Python and a few libraries to run.
    echo.
    echo  The following will be downloaded and installed automatically:
    echo    - Python 3.12        (~25 MB download, ~100 MB installed)
    echo    - Flask              (~2 MB)
    echo    - Primer3            (~5 MB)
    echo    - Requests           (~1 MB)
    echo.
    echo  Make sure you are connected to the internet before continuing.
    echo.
    set /p "CONFIRM=  Proceed with installation? (Y/N): "
    if /i not "%CONFIRM%"=="Y" (
        echo.
        echo  Installation cancelled. Exiting.
        pause
        exit /b 0
    )
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

    :: Find python.exe directly — check all common install locations
    set "PYTHON_EXE="
    if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    if exist "%LOCALAPPDATA%\Programs\Python\Python310\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
    if exist "%PROGRAMFILES%\Python312\python.exe" set "PYTHON_EXE=%PROGRAMFILES%\Python312\python.exe"
    if exist "%PROGRAMFILES%\Python311\python.exe" set "PYTHON_EXE=%PROGRAMFILES%\Python311\python.exe"
    if exist "%PROGRAMFILES%\Python310\python.exe" set "PYTHON_EXE=%PROGRAMFILES%\Python310\python.exe"

    if defined PYTHON_EXE (
        echo [OK] Found Python at: %PYTHON_EXE%
        :: Add its folder and Scripts subfolder to PATH for this session
        for %%F in ("%PYTHON_EXE%") do set "PATH=%%~dpF;%%~dpFScripts;%PATH%"
    ) else (
        echo.
        echo  ============================================
        echo   Python was installed successfully!
        echo  ============================================
        echo.
        echo   Please close this window and open
        echo   run_primero.bat again to launch Primerool.
        echo.
        pause
        exit /b 0
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
