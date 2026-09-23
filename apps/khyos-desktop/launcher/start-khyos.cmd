@echo off
rem KhyOS Desktop launcher - self-locating, no window flash on double-click.
rem The shortcut's WorkingDirectory is this launcher folder, so this file
rem always runs from its own location regardless of where the .lnk was
rem copied. electron.exe is resolved 4 levels up from this folder:
rem   <root>\apps\khyos-desktop\launcher -> <root>
setlocal
set "APP_DIR=%~dp0"
for %%d in ("%APP_DIR%..") do set "APP_DIR=%%~fd"
rem launcher -> khyos-desktop -> apps -> khy-os (root): 3 levels up from APP_DIR
set "ROOT="
for %%d in ("%APP_DIR%..\..\..") do set "ROOT=%%~fd"
rem electron.exe: pnpm virtual store first, then a plain node_modules
set "ELECTRON="
for /d %%p in ("%ROOT%\node_modules\.pnpm\electron@44.2.0") do if exist "%%~p\node_modules\electron\dist\electron.exe" set "ELECTRON=%%~p\node_modules\electron\dist\electron.exe"
if not defined ELECTRON (
    for /d %%p in ("%ROOT%\node_modules\.pnpm\electron@*") do if exist "%%~p\node_modules\electron\dist\electron.exe" set "ELECTRON=%%~p\node_modules\electron\dist\electron.exe"
)
if not defined ELECTRON (
    if exist "%ROOT%\node_modules\electron\dist\electron.exe" set "ELECTRON=%ROOT%\node_modules\electron\dist\electron.exe"
)
if not defined ELECTRON (
    echo [ERR] electron.exe not found under %ROOT% - repo moved? & pause & exit /b 1
)
rem Kill ALL stale Electron processes to prevent GPU cache locks
taskkill /F /IM electron.exe >nul 2>&1
ping -n 4 127.0.0.1 >nul
if exist "%APP_DIR%\out\main\index.js" (
    pushd "%APP_DIR%"
    start "" "%ELECTRON%" . --disable-gpu --disable-software-rasterizer --in-process-gpu
    popd
) else (
    echo [i] out/ not built yet - launching dev mode ^(npm run dev^)
    pushd "%APP_DIR%"
    call npm run dev
    popd
)
endlocal
