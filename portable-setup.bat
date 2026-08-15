@echo off
setlocal EnableExtensions
chcp 65001 >nul

echo ========================================
echo   Khy-OS Portable Command Setup
echo ========================================
echo.

set "PROJECT_ROOT=%~dp0"
if "%PROJECT_ROOT:~-1%"=="\" set "PROJECT_ROOT=%PROJECT_ROOT:~0,-1%"
if not exist "%PROJECT_ROOT%\khy.bat" (
    echo [FAIL] khy.bat not found under: %PROJECT_ROOT%
    pause
    exit /b 1
)

call "%PROJECT_ROOT%\scripts\portable\install-path-wrappers.bat" --force --add-to-path
if errorlevel 1 (
    echo.
    echo [FAIL] Command setup failed.
    pause
    exit /b 1
)

set "BIN_DIR=%LocalAppData%\khy-os\bin"
for %%N in (khy.bat khy-os.bat khyquant.bat) do if not exist "%BIN_DIR%\%%N" (
    echo [FAIL] Missing wrapper: %BIN_DIR%\%%N
    pause
    exit /b 1
)

call "%BIN_DIR%\khy.bat" --help >nul
if errorlevel 1 (
    echo [FAIL] Wrapper verification failed. Try: "%PROJECT_ROOT%\khy.bat" --help
    pause
    exit /b 1
)

echo.
echo [OK] khy command configured.
echo Project: %PROJECT_ROOT%
echo Wrappers: %BIN_DIR%
echo Open a NEW terminal, then run: khy --help
echo If this folder moves, run this script again.
echo.
pause
exit /b 0
