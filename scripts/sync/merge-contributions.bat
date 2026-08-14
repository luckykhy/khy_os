@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1

:: ============================================================
::  merge-contributions.bat - Merge multiple git bundles sequentially
::  (offline multi-person contribution merge with auto-verification)
::
::  Usage:
::    scripts\sync\merge-contributions.bat <bundle1> [bundle2 ...]
::                                [--dry-run] [--skip-verify]
::
::  Flow:
::    1. For each bundle (in argument order):
::       a. git bundle verify         - integrity check
::       b. git fetch                 - pull refs from bundle
::       c. git merge --no-ff --no-edit - merge into current branch
::       d. node scripts/ci/check-agent-rules.js --changed - rule check
::    2. On merge conflict: halt with resolution guidance
::    3. On rule-check failure: warn but continue (non-blocking)
::    4. Final summary: merged count + verification warnings
:: ============================================================

set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%..\.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1>"
cd /d "%ROOT%"

set "DRY_RUN=0"
set "SKIP_VERIFY=0"
set "BUNDLE_COUNT=0"

:: --- Parse arguments ---
:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--dry-run" (
    set "DRY_RUN=1"
    shift
    goto :parse_args
)
if /i "%~1"=="--skip-verify" (
    set "SKIP_VERIFY=1"
    shift
    goto :parse_args
)
if /i "%~1"=="--help" goto :usage
if /i "%~1"=="-h" goto :usage
:: Positional argument: bundle file (resolve to absolute path)
set /a "BUNDLE_COUNT+=1"
set "BUNDLES[!BUNDLE_COUNT!]=%~f1"
shift
goto :parse_args

:args_done

if !BUNDLE_COUNT! equ 0 (
    echo [ERROR] No bundle files specified. Provide at least one bundle path.
    goto :usage
)

:: --- Validate all bundle files exist ---
set "MISSING=0"
for /l %%I in (1,1,!BUNDLE_COUNT!) do (
    if not exist "!BUNDLES[%%I]!" (
        echo [ERROR] Bundle file not found: !BUNDLES[%%I]!
        set "MISSING=1"
    )
)
if "!MISSING!"=="1" exit /b 1

:: --- Ensure on a git branch ---
set "CUR_BRANCH="
for /f "delims=" %%C in ('git branch --show-current 2^>nul') do set "CUR_BRANCH=%%C"
if not defined CUR_BRANCH (
    echo [ERROR] Not on a git branch ^(detached HEAD^). Checkout a branch first.
    exit /b 1
)

:: --- Show merge plan ---
echo [INFO] Merge plan: !BUNDLE_COUNT! bundle^(s^), dry-run=!DRY_RUN!/0
if "!SKIP_VERIFY!"=="0" (
    echo [INFO] Post-merge rule check: enabled
) else (
    echo [INFO] Post-merge rule check: skipped (--skip-verify)
)
for /l %%I in (1,1,!BUNDLE_COUNT!) do (
    echo   [%%I/!BUNDLE_COUNT!] !BUNDLES[%%I]!
)
echo [INFO] Current branch: !CUR_BRANCH!

:: --- Dry-run: plan only, no changes ---
if "!DRY_RUN!"=="1" (
    echo.
    echo [INFO] Dry-run mode: nothing was changed.
    exit /b 0
)

:: --- Initialize counters ---
set "MERGED_OK=0"
set "SKIPPED=0"
set "VERIFY_WARNINGS=0"

:: --- Main merge loop ---
for /l %%I in (1,1,!BUNDLE_COUNT!) do (
    call :process_bundle %%I "!BUNDLES[%%I]!"
    if !ERRORLEVEL! equ 2 goto :merge_conflict
)
goto :summary

:: ============================================================
::  Subroutine: process_bundle
::  Returns: 0=ok, 1=skipped, 2=merge conflict (halt)
:: ============================================================
:process_bundle
set "IDX=%~1"
set "CURRENT_BUNDLE=%~2"

echo.
echo ========================================
echo  Bundle !IDX!/!BUNDLE_COUNT!: !CURRENT_BUNDLE!
echo ========================================

:: --- Verify bundle integrity ---
echo [INFO] Verifying bundle !IDX!/!BUNDLE_COUNT!: !CURRENT_BUNDLE! ...
git bundle verify "!CURRENT_BUNDLE!"
if !ERRORLEVEL! neq 0 (
    echo [ERROR] Bundle verification failed !IDX!/!BUNDLE_COUNT!. Skipping.
    set /a "SKIPPED+=1"
    exit /b 1
)

:: --- Fetch from bundle ---
echo [INFO] Fetching bundle !IDX!/!BUNDLE_COUNT!: !CURRENT_BUNDLE! ...
git fetch "!CURRENT_BUNDLE!"
if !ERRORLEVEL! neq 0 (
    echo [ERROR] git fetch failed !IDX!/!BUNDLE_COUNT!. Skipping.
    set /a "SKIPPED+=1"
    exit /b 1
)

:: --- Capture pre-merge HEAD for diff base ---
set "PRE_MERGE_HEAD="
for /f "delims=" %%H in ('git rev-parse HEAD 2^>nul') do set "PRE_MERGE_HEAD=%%H"

:: --- Merge with --no-ff ---
echo [INFO] Merging bundle !IDX!/!BUNDLE_COUNT! with --no-ff --no-edit ...
git merge --no-ff --no-edit FETCH_HEAD
if !ERRORLEVEL! neq 0 (
    echo [ERROR] Merge conflict detected !IDX!/!BUNDLE_COUNT!. Halting.
    set "CONFLICT_BUNDLE=!CURRENT_BUNDLE!"
    set "CONFLICT_INDEX=!IDX!"
    exit /b 2
)

:: --- Post-merge rule check ---
if "!SKIP_VERIFY!"=="1" goto :skip_check

echo [INFO] Running rule check !IDX!/!BUNDLE_COUNT!: check-agent-rules.js --changed ...
if defined PRE_MERGE_HEAD set "GIT_BASE_REF=!PRE_MERGE_HEAD!"
node scripts\ci\check-agent-rules.js --changed
set "CHECK_EXIT=!ERRORLEVEL!"
set "GIT_BASE_REF="
if !CHECK_EXIT! neq 0 (
    echo [WARN] Rule check reported issues !IDX!/!BUNDLE_COUNT!, exit !CHECK_EXIT!. Continuing.
    set /a "VERIFY_WARNINGS+=1"
) else (
    echo [INFO] Rule check passed !IDX!/!BUNDLE_COUNT!.
)

:skip_check
set /a "MERGED_OK+=1"
exit /b 0

:: ============================================================
::  Merge conflict handler
:: ============================================================
:merge_conflict
echo.
echo ==========================================
echo  MERGE CONFLICT - Halting
echo ==========================================
echo  Bundle : !CONFLICT_BUNDLE!
echo  Index  : !CONFLICT_INDEX!/!BUNDLE_COUNT!
echo.
echo  Resolve the conflict manually, then:
echo    1. Fix conflicting files
echo    2. git add -A
echo    3. git commit
echo    4. Re-run this script with remaining bundles
echo.
echo  Or abort the merge:
echo    git merge --abort
echo ==========================================
exit /b 1

:: ============================================================
::  Summary
:: ============================================================
:summary
echo.
echo ==========================================
echo  Merge Summary
echo ==========================================
echo  Bundles given       : !BUNDLE_COUNT!
echo  Successful merges   : !MERGED_OK!
echo  Skipped (errors)    : !SKIPPED!
echo  Rule-check warnings : !VERIFY_WARNINGS!
if "!SKIP_VERIFY!"=="1" (
    echo  Verification mode   : skipped (--skip-verify)
) else (
    echo  Verification mode   : enabled
)
for /f "delims=" %%B in ('git branch --show-current 2^>nul') do echo  Current branch      : %%B
for /f "delims=" %%L in ('git log --oneline -1') do echo  HEAD                : %%L
echo ==========================================
exit /b 0

:: ============================================================
::  Usage
:: ============================================================
:usage
echo.
echo Usage:
echo   scripts\sync\merge-contributions.bat ^<bundle1^> [bundle2 ...] [options]
echo.
echo Required:
echo   ^<bundleN^>              One or more git bundle files to merge in order
echo.
echo Options:
echo   --dry-run               Preview merge plan only, no changes
echo   --skip-verify           Skip post-merge check-agent-rules.js verification
echo   --help, -h              Show this help
echo.
exit /b 0
