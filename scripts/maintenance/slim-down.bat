@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1

:: ============================================================
::  Khy OS - Slim Down (one-shot size reduction)
::  Deletes build artifacts, logs, temp files and unused
::  platform binaries. Safe: everything removed here can be
::  regenerated (logs, build output) or is unused (llama CUDA).
:: ============================================================

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%\..\..\") do set "PROJECT_ROOT=%%~fI"
if "%PROJECT_ROOT:~-1%"=="\" set "PROJECT_ROOT=%PROJECT_ROOT:~0,-1%"

echo ==========================================
echo   Khy OS Slim Down
echo   Root: %PROJECT_ROOT%
echo ==========================================
echo.

:: Warn if a Khy-OS runtime is active (sqlite/db files may be locked)
tasklist /fi "imagename eq node.exe" /fo csv 2>nul | findstr /i "node.exe" >nul 2>&1
if !ERRORLEVEL! equ 0 (
    echo  [WARN] Node.js processes detected. Stop Khy-OS first or locked files will be skipped.
    echo         e.g.  taskkill /f /im node.exe
    echo.
)

set "FREED=0"
set "FREED_MB=0"

:: --- 1. Application logs (regenerated at runtime) ---
if exist "%PROJECT_ROOT%\platform\packages\shared\logs" (
    echo [1/5] Cleaning application logs...
    for /f "delims=" %%F in ('dir /a-d /b "%PROJECT_ROOT%\platform\packages\shared\logs" 2^>nul') do (
        set "SIZE=0"
        for %%A in ("%PROJECT_ROOT%\platform\packages\shared\logs\%%F") do set "SIZE=%%~zA"
        del /f /q "%PROJECT_ROOT%\platform\packages\shared\logs\%%F" >nul 2>&1
        if !SIZE! geq 1048576 (
            set /a FREED_MB+=!SIZE!/1048576
        )
    )
    echo       Done.
)

:: --- 2. SQLite WAL / SHM temp files ---
echo [2/5] Cleaning sqlite temp files (wal/shm)...
for /r "%PROJECT_ROOT%" %%F in (*.sqlite-wal *.sqlite-shm *.db-wal *.db-shm) do (
    set "SIZE=0"
    for %%A in ("%%F") do set "SIZE=%%~zA"
    del /f /q "%%F" >nul 2>&1
    if !SIZE! geq 1048576 (
        set /a FREED_MB+=!SIZE!/1048576
    )
)
echo       Done.

:: --- 3. Kernel build output (.o objects + disk images) ---
if exist "%PROJECT_ROOT%\kernel\build" (
    echo [3/5] Cleaning kernel build artifacts...
    del /f /q "%PROJECT_ROOT%\kernel\build\*.o" >nul 2>&1
    del /f /q "%PROJECT_ROOT%\kernel\build\khy-a7b-disk.img" >nul 2>&1
    del /f /q "%PROJECT_ROOT%\kernel\build\khy-a8-disk.img" >nul 2>&1
    del /f /q "%PROJECT_ROOT%\kernel\build\khy-brain-disk.img" >nul 2>&1
    echo       Done.
)

:: --- 4. Old dist zip archives ---
if exist "%PROJECT_ROOT%\dist" (
    echo [4/5] Cleaning old dist archives...
    del /f /q "%PROJECT_ROOT%\dist\*.zip" >nul 2>&1
    echo       Done.
)

:: --- 5. Unused node-llama-cpp platform binaries (keep win-x64) ---
::     Two install layouts: root hoisted (workspaces) and legacy backend-local.
for %%L in ("%PROJECT_ROOT%\node_modules\@node-llama-cpp" "%PROJECT_ROOT%\services\backend\node_modules\@node-llama-cpp") do (
    set "LLAMA=%%~L"
    if exist "!LLAMA!" (
        echo [5/5] Pruning unused llama platform binaries in %%~nxL\@node-llama-cpp ...
        for %%D in (win-arm64 win-x64-cuda win-x64-cuda-ext win-x64-vulkan) do (
            if exist "!LLAMA!\%%D" (
                for /f "delims=" %%F in ('dir /s /b /a-d "!LLAMA!\%%D" 2^>nul') do (
                    for %%A in ("%%F") do set "SZ=%%~zA"
                    if !SZ! geq 1048576 (
                        set /a FREED_MB+=!SZ!/1048576
                    )
                )
                rmdir /s /q "!LLAMA!\%%D" >nul 2>&1
                echo       Removed %%D
            )
        )
        echo       Done.
    )
)

echo.
echo ==========================================
echo   Slim Down Complete.
echo   Approx freed: !FREED_MB! MB
echo ==========================================
echo.
endlocal
