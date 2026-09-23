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
:: P0-3: 增量 delta —— 记录上次同步的 ref；本次若 0 个新提交则跳过全量 bundle。
:: last-sync-ref 存在 <OUT_DIR>\.last-sync-ref 里（与 manifest 同目录，离线传输）。
set "LAST_SYNC_REF="
if exist "%OUT_DIR%\.last-sync-ref" (
    set /p LAST_SYNC_REF=<"%OUT_DIR%\.last-sync-ref"
)

set "NEW_COMMITS=-1"
if defined LAST_SYNC_REF (
    for /f "delims=" %%N in ('git rev-list --count "%LAST_SYNC_REF".."%BRANCH%" 2^>nul') do set "NEW_COMMITS=%%N"
)
if defined NEW_COMMITS if "%NEW_COMMITS%"=="0" (
    echo [INFO] 自上次同步以来无新增提交（last-sync-ref=%LAST_SYNC_REF%），跳过 bundle 导出。
    echo        如需强制全量导出，加 --force-full 或先删除 .last-sync-ref。
    goto :export_done_skip
)

set "DT="
for /f "delims=" %%T in ('wmic os get localdatetime 2^>nul ^| findstr /r "[0-9]"') do set "DT=%%T"
if not defined DT (
    for /f "tokens=1-3 delims=/ " %%A in ("%date%") do set "D=%%A%%B%%C"
    for /f "tokens=1-2 delims=: " %%A in ("%time%") do set "T=%%A%%B"
    set "DT=%D%-%T%"
)
set "STAMP=%DT:~0,8%-%DT:~8,6%"
set "BUNDLE=%OUT_DIR%\khy-sync-%BRANCH%-%STAMP%.bundle"

echo [INFO] 导出 bundle: %BUNDLE% (分支 %BRANCH%, 新增 %NEW_COMMITS% 个提交) ...
git bundle create "%BUNDLE%" "%BRANCH%"
if !ERRORLEVEL! neq 0 (
    echo [ERROR] git bundle create failed
    exit /b 1
)

:: P0-2: 同步清单 manifest —— 写 <OUT_DIR>\manifest.json（HEAD SHA / 本次新增 commit
:: 列表 / 时间戳 / bundle 文件名）。import-sync.bat 导入后用 git cat-file 逐条核对
:: 这些 commit 是否真实存在，缺/多即报具体条目。
:: 先把新增 commit 列表（last-sync-ref..HEAD 或 最近 500 条）取出。
set "COMMITS_FILE=%OUT_DIR%\_manifest_commits.txt"
if defined LAST_SYNC_REF (
    git rev-list --reverse "%LAST_SYNC_REF".."%BRANCH%" > "%COMMITS_FILE%"
) else (
    git rev-list -n 500 "%BRANCH%" > "%COMMITS_FILE%"
)

for /f "delims=" %%H in ('git rev-parse HEAD 2^>nul') do set "HEAD_SHA=%%H"
set "MANIFEST=%OUT_DIR%\manifest.json"
echo { > "%MANIFEST%"
echo   "schema": "khy-sync-manifest/v1", >> "%MANIFEST%"
echo   "exportedAt": "%DT:~0,4%-%DT:~4,2%-%DT:~6,2%T%DT:~8,2%:%DT:~10,2%", >> "%MANIFEST%"
echo   "branch": "%BRANCH%", >> "%MANIFEST%"
echo   "headSha": "%HEAD_SHA%", >> "%MANIFEST%"
echo   "bundleFile": "%BUNDLE:",=%BUNDLE%", >> "%MANIFEST%"
echo   "newCommitCount": %NEW_COMMITS%, >> "%MANIFEST%"
echo   "commits": [ >> "%MANIFEST%"
set "FIRST=1"
for /f "delims=" %%C in ('type "%COMMITS_FILE%"') do (
    if "!FIRST!"=="1" (
        set "FIRST=0"
        echo     "%%C" >> "%MANIFEST%"
    ) else (
        echo     "%%C", >> "%MANIFEST%"
    )
)
echo   ] >> "%MANIFEST%"
echo } >> "%MANIFEST%"
del "%COMMITS_FILE%" 2>nul
echo [INFO] manifest 已写入: %MANIFEST%

:: 更新 last-sync-ref（成功的导出才写，避免失败留脏基线）
echo "%HEAD_SHA%" > "%OUT_DIR%\.last-sync-ref"

echo.
echo ==========================================
echo   Export Complete
==========================================
  Bundle : %BUNDLE%
for %%F in ("%BUNDLE%") do echo   Size   : %%~zF bytes
  Branch : %BRANCH%
for /f "delims=" %%L in ('git log --oneline -1') do echo   Commit : %%L
echo.
echo   Next: send the bundle + manifest.json to the other machine and run
             scripts\sync\import-sync.bat --bundle ^<file^>
echo ==========================================
goto :export_done

:export_done_skip
echo.
echo ==========================================
echo   Export Skipped (no new commits)
==========================================
  Branch : %BRANCH%
for /f "delims=" %%L in ('git log --oneline -1') do echo   Tip    : %%L
echo.
echo   无新增提交，未生成 bundle。
echo ==========================================
exit /b 0

:export_done
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
