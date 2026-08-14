@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1

:: ============================================================
::  export-sync.bat - Export local git incremental bundle
::  (two-machine code sync via git bundle offline packages)
::
::  Usage:
::    scripts\sync\export-sync.bat [--out <dir>] [--branch <name>]
::                                [--message <msg>] [--no-commit]
::
::  Flow:
::    1. git add -A + git commit (commit local changes to current branch)
::    2. git bundle create -> incremental bundle with full branch history
::    3. send the bundle to the other machine; apply with import-sync.bat
::
::  Local AI data (.khy/, .env, config.json ...) is gitignored and never
::  enters the bundle, keeping each machine's AI config isolated.
:: ============================================================

set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%..\.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"

:: --- Defaults ---
set "OUT_DIR="
set "BRANCH="
set "COMMIT_MSG="
set "NO_COMMIT=0"

:: --- Parse arguments ---
:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--out" (
    set "OUT_DIR=%~2"
    shift
    shift
    goto :parse_args
)
if /i "%~1"=="--branch" (
    set "BRANCH=%~2"
    shift
    shift
    goto :parse_args
)
if /i "%~1"=="--message" (
    set "COMMIT_MSG=%~2"
    shift
    shift
    goto :parse_args
)
if /i "%~1"=="--no-commit" (
    set "NO_COMMIT=1"
    shift
    goto :parse_args
)
if /i "%~1"=="--help" goto :usage
if /i "%~1"=="-h" goto :usage
echo [ERROR] Unknown argument: %~1
goto :usage

:args_done

:: --- Resolve branch ---
if not defined BRANCH (
    for /f "delims=" %%B in ('git branch --show-current 2^>nul') do set "BRANCH=%%B"
)
if not defined BRANCH (
    echo [ERROR] Cannot determine current branch. Use --branch to specify.
    exit /b 1
)

:: --- Default output dir: <project parent>\khy-sync ---
if not defined OUT_DIR (
    for %%I in ("%ROOT%\..\khy-sync") do set "OUT_DIR=%%~fI"
)
if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

:: --- Optional commit ---
if "%NO_COMMIT%"=="0" (
    set "HAS_CHANGES=0"
    for /f "delims=" %%S in ('git status --porcelain 2^>nul') do set "HAS_CHANGES=1"
    if "!HAS_CHANGES!"=="1" (
        if not defined COMMIT_MSG set "COMMIT_MSG=sync: auto commit %date%"
        echo [INFO] Committing local changes to %BRANCH% ...
        git add -A
        git commit -m "%COMMIT_MSG%"
        if !ERRORLEVEL! neq 0 (
            echo [ERROR] git commit failed
            exit /b 1
        )
        for /f "delims=" %%L in ('git log --oneline -1') do echo [OK] Committed: %%L
    ) else (
        echo [INFO] Working tree clean, no new commit
    )
) else (
    echo [INFO] --no-commit: skipping commit
)

:: --- Create bundle ---
set "DT="
for /f "delims=" %%T in ('wmic os get localdatetime 2^>nul ^| findstr /r "[0-9]"') do set "DT=%%T"
if not defined DT (
    for /f "tokens=1-3 delims=/ " %%A in ("%date%") do set "D=%%A%%B%%C"
    for /f "tokens=1-2 delims=: " %%A in ("%time%") do set "T=%%A%%B"
    set "DT=%D%-%T%"
)
set "STAMP=%DT:~0,8%-%DT:~8,6%"
set "BUNDLE=%OUT_DIR%\khy-sync-%BRANCH%-%STAMP%.bundle"

echo [INFO] Exporting bundle: %BUNDLE% (branch %BRANCH%) ...
git bundle create "%BUNDLE%" "%BRANCH%"
if !ERRORLEVEL! neq 0 (
    echo [ERROR] git bundle create failed
    exit /b 1
)

echo.
echo ==========================================
echo   Export Complete
echo ==========================================
echo   Bundle : %BUNDLE%
for %%F in ("%BUNDLE%") do echo   Size   : %%~zF bytes
echo   Branch : %BRANCH%
for /f "delims=" %%L in ('git log --oneline -1') do echo   Commit : %%L
echo.
echo   Next: send the bundle to the other machine and run
echo         scripts\sync\import-sync.bat --bundle ^<file^>
echo ==========================================
exit /b 0

:usage
echo.
echo Usage:
echo   scripts\sync\export-sync.bat [options]
echo.
echo Options:
echo   --out ^<dir^>           Bundle output dir (default: ^<project root^>\..\khy-sync\)
echo   --branch ^<name^>       Branch to export (default: current branch)
echo   --message ^<msg^>       Commit message (default: "sync: auto commit ^<date^>")
echo   --no-commit             Do not commit; only export existing commits
echo   --help, -h              Show this help
echo.
exit /b 0
