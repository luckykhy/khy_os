@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1

:: ============================================================
::  import-sync.bat - Import a git bundle from another machine
::  (two-machine code sync via git bundle offline packages)
::
::  Usage:
::    scripts\sync\import-sync.bat --bundle <file> [--branch <name>]
::                                [--merge] [--dry-run]
::
::  Flow:
::    1. git fetch pulls the remote branch from the bundle
::    2. default: checkout/update to that branch (--merge merges instead)
:: ============================================================

set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%..\.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"

set "BUNDLE="
set "BRANCH="
set "MODE=checkout"
set "DRY_RUN=0"

:: --- Parse arguments ---
:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--bundle" (
    set "BUNDLE=%~2"
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
if /i "%~1"=="--merge" (
    set "MODE=merge"
    shift
    goto :parse_args
)
if /i "%~1"=="--dry-run" (
    set "DRY_RUN=1"
    shift
    goto :parse_args
)
if /i "%~1"=="--help" goto :usage
if /i "%~1"=="-h" goto :usage
echo [ERROR] Unknown argument: %~1
goto :usage

:args_done

if not defined BUNDLE (
    echo [ERROR] Missing required argument: --bundle ^<file^>
    goto :usage
)
if not exist "%BUNDLE%" (
    echo [ERROR] Bundle file not found: %BUNDLE%
    exit /b 1
)

:: --- Verify bundle ---
echo [INFO] Verifying bundle: %BUNDLE% ...
git bundle verify "%BUNDLE%"
if !ERRORLEVEL! neq 0 (
    echo [ERROR] Bundle verification failed
    exit /b 1
)

:: --- Discover branch from bundle ---
if not defined BRANCH (
    set "REFNAME="
    for /f "delims=" %%L in ('git bundle list-heads "%BUNDLE%"') do (
        set "LINE=%%L"
    )
    if defined LINE (
        for /f "tokens=2" %%A in ("!LINE!") do set "REFNAME=%%A"
    )
    if defined REFNAME (
        set "BRANCH=!REFNAME:refs/heads/=!"
    )
)
if not defined BRANCH (
    echo [ERROR] Cannot determine branch from bundle. Use --branch to specify.
    exit /b 1
)
echo [INFO] Target branch: %BRANCH%

:: --- Dry-run ---
if "%DRY_RUN%"=="1" (
    echo [INFO] [dry-run] Bundle contents:
    git bundle list-heads "%BUNDLE%"
    echo   dry-run mode: nothing was changed
    exit /b 0
)

:: --- Fetch from bundle into a temp ref (avoids "checked out" refusal) ---
echo [INFO] Fetching branch %BRANCH% from bundle ...
git fetch "%BUNDLE%" "refs/heads/%BRANCH%:refs/remotes/bundle-import/%BRANCH%"
if !ERRORLEVEL! neq 0 (
    echo [ERROR] git fetch failed
    echo   The branch you requested does not exist in the bundle.
    echo   Available branches in this bundle:
    git bundle list-heads "%BUNDLE%"
    exit /b 1
)

if /i "%MODE%"=="merge" (
    for /f "delims=" %%C in ('git branch --show-current 2^>nul') do set "CUR=%%C"
    if not defined CUR (
        echo [ERROR] Not on a branch, cannot --merge
        exit /b 1
    )
    echo [INFO] Merging %BRANCH% into current branch !CUR! ...
    git merge "refs/remotes/bundle-import/%BRANCH%" --no-edit
    if !ERRORLEVEL! neq 0 (
        echo [WARN] Merge may have conflicts. Resolve manually then:
        echo        git add -A ^&^& git commit
    )
) else (
    git rev-parse --verify --quiet "refs/heads/%BRANCH%" >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        echo [INFO] Switching to existing local branch %BRANCH% ...
        git checkout "%BRANCH%"
        if !ERRORLEVEL! neq 0 (
            echo [ERROR] git checkout failed
            exit /b 1
        )
        echo [INFO] Merging bundle changes into %BRANCH% ...
        git merge "refs/remotes/bundle-import/%BRANCH%" --no-edit
    ) else (
        echo [INFO] Creating and switching to branch %BRANCH% from bundle ...
        git branch "%BRANCH%" "refs/remotes/bundle-import/%BRANCH%"
        if !ERRORLEVEL! neq 0 (
            echo [ERROR] git branch failed
            exit /b 1
        )
        git checkout "%BRANCH%"
        if !ERRORLEVEL! neq 0 (
            echo [ERROR] git checkout failed
            echo   Untracked files conflict with the imported branch.
            echo   Options:
            echo     - Move/backup conflicting files, then re-run this script
            echo     - Or discard local untracked files: git clean -fd
            echo   Import aborted. Your local files were NOT changed.
            exit /b 1
        )
    )
)

echo.
echo ==========================================
echo   Import Complete
echo ==========================================
for /f "delims=" %%B in ('git branch --show-current 2^>nul') do echo   Branch : %%B
for /f "delims=" %%L in ('git log --oneline -1') do echo   Head   : %%L
echo.
echo   If a merge produced conflicts, resolve manually then:
echo     git add -A ^&^& git commit
echo ==========================================
exit /b 0

:usage
echo.
echo Usage:
echo   scripts\sync\import-sync.bat --bundle ^<file^> [options]
echo.
echo Required:
echo   --bundle ^<file^>       Bundle file exported by the other machine
echo.
echo Options:
echo   --branch ^<name^>       Target branch (default: branch inside bundle)
echo   --merge                 Merge into current branch instead of switching
echo   --dry-run               Preview only, no changes
echo   --help, -h              Show this help
echo.
exit /b 0
