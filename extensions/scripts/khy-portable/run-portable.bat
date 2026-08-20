@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

:: =============================================================================
:: run-portable.bat - Build a portable copy of Khy-OS
:: Copies the project to a target directory, ready to run via khy.bat
:: =============================================================================

set "SCRIPT_DIR=%~dp0"
:: Remove trailing backslash
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
:: Project root is two levels up from extensions\scripts\khy-portable\
for %%I in ("%SCRIPT_DIR%\..\..\") do set "ROOT_DIR=%%~fI"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"

:: --- Defaults ---
set "TARGET_DIR="
set "WITH_NODE_MODULES=0"
set "MIRROR_MODE=0"
set "DRY_RUN=0"

:: --- Parse arguments ---
:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--target" (
    set "TARGET_DIR=%~2"
    shift
    shift
    goto :parse_args
)
if /i "%~1"=="-t" (
    set "TARGET_DIR=%~2"
    shift
    shift
    goto :parse_args
)
if /i "%~1"=="--with-node-modules" (
    set "WITH_NODE_MODULES=1"
    shift
    goto :parse_args
)
if /i "%~1"=="--mirror" (
    set "MIRROR_MODE=1"
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

:: --- Validate target ---
if not defined TARGET_DIR (
    echo [ERROR] Missing required argument: --target
    echo.
    goto :usage
)

:: Resolve to absolute path if relative
pushd "%TARGET_DIR%" 2>nul
if !ERRORLEVEL! equ 0 (
    set "TARGET_DIR=!CD!"
    popd
) else (
    :: Directory doesn't exist yet, resolve parent
    for %%I in ("%TARGET_DIR%") do set "TARGET_DIR=%%~fI"
)

:: Prevent copying to self
if /i "%ROOT_DIR%"=="%TARGET_DIR%" (
    echo [ERROR] Target directory cannot be the same as the source directory
    exit /b 1
)

echo.
echo  ========================================
echo   Khy-OS Portable Build
echo  ========================================
echo.
echo  Source:  %ROOT_DIR%
echo  Target:  %TARGET_DIR%
if "%WITH_NODE_MODULES%"=="1" (
    echo  Node modules: Include (copy-and-run ready)
) else (
    echo  Node modules: Exclude (first boot will auto-install)
)
if "%MIRROR_MODE%"=="1" (
    echo  Mode: Mirror (target will match source exactly)
) else (
    echo  Mode: Copy (additive, won't delete target extras)
)
echo.

:: --- Check if target exists and has content ---
if exist "%TARGET_DIR%\*" (
    dir /b "%TARGET_DIR%" 2>nul | find /v "" >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        if "%MIRROR_MODE%"=="0" (
            echo [WARN] Target directory already has content. Files will be merged.
            echo        Use --mirror to make an exact copy (deletes extra files in target).
            set /p "CONFIRM=Continue? (Y/n): "
            if /i "!CONFIRM!"=="n" (
                echo Aborted.
                exit /b 0
            )
        ) else (
            echo [WARN] --mirror mode: files in target not present in source will be DELETED.
            set /p "CONFIRM=Continue? (Y/n): "
            if /i "!CONFIRM!"=="n" (
                echo Aborted.
                exit /b 0
            )
        )
    )
)

:: --- Build robocopy command ---
:: Base exclusions: .git, __pycache__, .tmp, dist
set "XD_LIST=.git __pycache__ .tmp dist"

if "%WITH_NODE_MODULES%"=="0" (
    :: Exclude all node_modules
    set "XD_LIST=!XD_LIST! node_modules"
)

:: Build robocopy flags
set "RC_FLAGS=/E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /nc /ns /np"

if "%MIRROR_MODE%"=="1" (
    set "RC_FLAGS=/MIR /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /nc /ns /np"
)

if "%DRY_RUN%"=="1" (
    set "RC_FLAGS=!RC_FLAGS! /L"
    echo [DRY-RUN] Showing what would be copied (no actual changes):
    echo.
)

:: --- Handle services/backend/node_modules inclusion ---
:: When --with-node-modules is set, we need a two-pass approach:
:: Pass 1: robocopy with node_modules excluded globally
:: Pass 2: robocopy only services/backend/node_modules
:: This is because robocopy /XD excludes by name at all levels.

if "%WITH_NODE_MODULES%"=="1" (
    :: First pass: copy everything except .git, __pycache__, .tmp, dist, node_modules
    :: Then second pass: copy only services/backend/node_modules
    set "XD_PASS1=.git __pycache__ .tmp dist node_modules"

    echo [1/2] Copying project files (excluding node_modules)...
    robocopy "%ROOT_DIR%" "%TARGET_DIR%" /E /XD !XD_PASS1! /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /nc /ns /np
    set "RC1=!ERRORLEVEL!"

    echo [2/2] Copying services\backend\node_modules...
    if exist "%ROOT_DIR%\services\backend\node_modules" (
        robocopy "%ROOT_DIR%\services\backend\node_modules" "%TARGET_DIR%\services\backend\node_modules" /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /nc /ns /np
        set "RC2=!ERRORLEVEL!"
    ) else (
        echo        [SKIP] services\backend\node_modules not found in source
        set "RC2=0"
    )

    :: robocopy exit codes 0-7 are all success
    if !RC1! gtr 7 (
        echo [ERROR] Robocopy failed with exit code !RC1!
        exit /b 1
    )
    if !RC2! gtr 7 (
        echo [ERROR] Robocopy failed copying node_modules with exit code !RC2!
        exit /b 1
    )
) else (
    echo Copying project files...
    robocopy "%ROOT_DIR%" "%TARGET_DIR%" %RC_FLAGS% /XD %XD_LIST%
    set "RC1=!ERRORLEVEL!"

    if !RC1! gtr 7 (
        echo [ERROR] Robocopy failed with exit code !RC1!
        exit /b 1
    )
)

:: --- Post-copy cleanup: remove non-portable runtime payloads ---
if "%DRY_RUN%"=="0" (
    if exist "%TARGET_DIR%\services\backend\models" (
        rmdir /s /q "%TARGET_DIR%\services\backend\models" 2>nul
    )
    if exist "%TARGET_DIR%\services\backend\bin\llama-cpp" (
        rmdir /s /q "%TARGET_DIR%\services\backend\bin\llama-cpp" 2>nul
    )
    if exist "%TARGET_DIR%\services\backend\bin\ollama-runner" (
        rmdir /s /q "%TARGET_DIR%\services\backend\bin\ollama-runner" 2>nul
    )
)

:: --- Verify critical files ---
if "%DRY_RUN%"=="0" (
    echo.
    echo Verifying critical files...
    set "VERIFY_OK=1"

    for %%F in (
        "khy.bat"
        "khy.sh"
        "software\khyquant\khy_quant\cli.py"
        "services\backend\bin\khy.js"
        "services\backend\package.json"
        "docs\06_DEPLOY_部署\PORTABLE.md"
    ) do (
        if exist "%TARGET_DIR%\%%~F" (
            echo   [OK]   %%~F
        ) else (
            echo   [MISS] %%~F
            set "VERIFY_OK=0"
        )
    )

    if "!VERIFY_OK!"=="0" (
        echo.
        echo [WARN] Some critical files are missing. The portable copy may be incomplete.
    ) else (
        echo.
        echo [OK] All critical files verified.
    )
)

echo.
echo  ========================================
if "%DRY_RUN%"=="1" (
    echo   Dry run complete. No files were changed.
) else (
    echo   Portable build complete!
)
echo  ========================================
echo.
if "%DRY_RUN%"=="0" (
    echo  To start:  %TARGET_DIR%\khy.bat
    echo  Data dir:  %TARGET_DIR%\.khyquant-data\
    echo.
    echo  Prerequisites: Python 3.8+ and Node.js 20+ must be in PATH
    if "%WITH_NODE_MODULES%"=="0" (
        echo  Note: First launch will auto-run npm install (requires network)
    )
)
echo.
exit /b 0

:usage
echo.
echo Usage:
echo   extensions\scripts\khy-portable\run-portable.bat --target ^<dir^> [options]
echo.
echo Options:
echo   --target, -t ^<dir^>    Target directory (required)
echo   --with-node-modules    Include services/backend/node_modules (copy-and-run ready)
echo   --mirror               Mirror mode: delete target files not in source
echo   --dry-run              Show what would be copied without making changes
echo   --help, -h             Show this help
echo.
echo Examples:
echo   extensions\scripts\khy-portable\run-portable.bat --target D:\Portable
echo   extensions\scripts\khy-portable\run-portable.bat --target E:\khy-os --with-node-modules
echo   extensions\scripts\khy-portable\run-portable.bat --target D:\Portable --mirror --with-node-modules
echo.
exit /b 0
