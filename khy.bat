@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

:: =============================================================================
:: khy.bat - Windows launcher for Khy-OS CLI
:: =============================================================================

:: --- Proxy env vars: preserved (required for China network: agnes blocked without proxy) ---
:: set "HTTP_PROXY="
:: set "HTTPS_PROXY="
:: set "http_proxy="
:: set "https_proxy="

:: --- khy repair: one-shot portable self-repair (Node only, bypasses python cli) ---
if /i "%~1"=="repair" (
    where node >nul 2>&1
    if !ERRORLEVEL! neq 0 call :discover_node
    where node >nul 2>&1
    if !ERRORLEVEL! neq 0 (
        echo [ERROR] khy repair needs Node.js 20+ in PATH: https://nodejs.org/
        exit /b 1
    )
    set "KHYQUANT_PORTABLE_ROOT=%~dp0"
    node "%~dp0scripts\portable\repair-portable.js" %2 %3 %4 %5 %6 %7 %8 %9
    exit /b !ERRORLEVEL!
)

:: --- Detect Python 3.8+ ---
set "PYTHON_CMD="

for %%P in (python3 python) do (
    if not defined PYTHON_CMD (
        where %%P >nul 2>&1
        if !ERRORLEVEL! equ 0 (
            for /f "tokens=*" %%V in ('%%P -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2^>nul') do (
                for /f "tokens=1,2 delims=." %%A in ("%%V") do (
                    if %%A geq 3 (
                        if %%A equ 3 (
                            if %%B geq 8 set "PYTHON_CMD=%%P"
                        ) else (
                            set "PYTHON_CMD=%%P"
                        )
                    )
                )
            )
        )
    )
)

if not defined PYTHON_CMD (
    where py >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        for /f "tokens=*" %%V in ('py -3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2^>nul') do (
            for /f "tokens=1,2 delims=." %%A in ("%%V") do (
                if %%A geq 3 (
                    if %%A equ 3 (
                        if %%B geq 8 set "PYTHON_CMD=py -3"
                    ) else (
                        set "PYTHON_CMD=py -3"
                    )
                )
            )
        )
    )
)

if not defined PYTHON_CMD (
    echo [ERROR] 检测 Python 3.8+ 失败：未在 PATH 中找到 python
    echo 请安装 Python 3.8+: https://www.python.org/downloads/
    exit /b 1
)

:: --- Detect Node.js 20+ (PATH first, then auto-discovery fallback) ---
where node >nul 2>&1
if %ERRORLEVEL% neq 0 call :discover_node
if defined NODE_FOUND_DIR set "PATH=%NODE_FOUND_DIR%;%PATH%"
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] 检测 Node.js 20+ 失败：PATH 与常见安装位置均未找到 node
    echo 请安装 Node.js 20+: https://nodejs.org/
    exit /b 1
)

set "NODE_MAJOR=0"
for /f "tokens=1 delims=v." %%N in ('node --version 2^>nul') do (
    set "NODE_MAJOR=%%N"
)

if !NODE_MAJOR! lss 20 (
    echo [ERROR] 检测 Node.js 20+ 失败：当前版本过低，需要 v20+
    echo 请升级 Node.js: https://nodejs.org/
    exit /b 1
)

:: --- Set environment variables ---
set "KHYQUANT_PORTABLE_ROOT=%~dp0"
if not defined KHYQUANT_DATA_HOME set "KHYQUANT_DATA_HOME=%~dp0.khyquant-data"
set "PYTHONPATH=%~dp0platform;%~dp0software\khyquant;%PYTHONPATH%"
set "KHY_INVOKED_AS=khy"

:: --- Launch CLI ---
%PYTHON_CMD% -m khy_platform %*
exit /b %ERRORLEVEL%

:discover_node
set "KHY_FNM_BASE=%FNM_DIR%"
if not defined KHY_FNM_BASE if defined APPDATA set "KHY_FNM_BASE=%APPDATA%\fnm"
if defined KHY_FNM_BASE if exist "!KHY_FNM_BASE!\node-versions" (
    for /f "delims=" %%D in ('dir /b /ad "!KHY_FNM_BASE!\node-versions" 2^>nul') do (
        if exist "!KHY_FNM_BASE!\node-versions\%%D\installation\node.exe" (
            call :consider_node_version "%%D" "!KHY_FNM_BASE!\node-versions\%%D\installation"
        )
    )
)
if defined NODE_FOUND_DIR exit /b 0
if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\node.exe" set "NODE_FOUND_DIR=%NVM_SYMLINK%" & exit /b 0
if defined NVM_HOME if exist "%NVM_HOME%" (
    for /f "delims=" %%D in ('dir /b /ad "%NVM_HOME%" 2^>nul') do (
        if exist "%NVM_HOME%\%%D\node.exe" call :consider_node_version "%%D" "%NVM_HOME%\%%D"
    )
)
if defined NODE_FOUND_DIR exit /b 0
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_FOUND_DIR=%ProgramFiles%\nodejs" & exit /b 0
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_FOUND_DIR=%ProgramFiles(x86)%\nodejs" & exit /b 0
if defined VOLTA_HOME if exist "%VOLTA_HOME%\bin\node.exe" set "NODE_FOUND_DIR=%VOLTA_HOME%\bin" & exit /b 0
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\Volta\bin\node.exe" set "NODE_FOUND_DIR=%LOCALAPPDATA%\Volta\bin" & exit /b 0
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\khy\node" (
    for /f "delims=" %%D in ('dir /b /ad "%LOCALAPPDATA%\khy\node" 2^>nul') do (
        for /f "delims=" %%F in ('dir /b /s "%LOCALAPPDATA%\khy\node\%%D\node.exe" 2^>nul') do (
            call :consider_node_version "%%D" "%%~dpF"
        )
    )
)
exit /b 0

:consider_node_version
set "KHY_VER=%~1"
if /i "!KHY_VER:~0,1!"=="v" set "KHY_VER=!KHY_VER:~1!"
set "KHY_MAJ_RAW=0"
set "KHY_MIN_RAW=0"
for /f "tokens=1,2 delims=." %%A in ("!KHY_VER!") do (
    set "KHY_MAJ_RAW=%%A"
    if not "%%B"=="" set "KHY_MIN_RAW=%%B"
)
set "KHY_MAJ_NUM=0"
set "KHY_MIN_NUM=0"
2>nul set /a "KHY_MAJ_NUM=KHY_MAJ_RAW"
2>nul set /a "KHY_MIN_NUM=KHY_MIN_RAW"
if !KHY_MAJ_NUM! geq 20 (
    if !KHY_MAJ_NUM! gtr !KHY_BEST_MAJOR! (
        set "NODE_FOUND_DIR=%~2"
        set "KHY_BEST_MAJOR=!KHY_MAJ_NUM!"
        set "KHY_BEST_MINOR=!KHY_MIN_NUM!"
    ) else if !KHY_MAJ_NUM! equ !KHY_BEST_MAJOR! if !KHY_MIN_NUM! gtr !KHY_BEST_MINOR! (
        set "NODE_FOUND_DIR=%~2"
        set "KHY_BEST_MINOR=!KHY_MIN_NUM!"
    )
)
exit /b 0
