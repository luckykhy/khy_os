@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

:: =============================================================================
:: khy.bat - Windows launcher for Khy-OS CLI
:: =============================================================================

:: --- Clear proxy env vars (Agnes API is directly accessible) ---
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "http_proxy="
set "https_proxy="
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
    echo [ERROR] 妫€娴?Python 3.8+ 澶辫触锛氭湭鍦?PATH 涓壘鍒?python
    echo 璇峰畨瑁?Python 3.8+: https://www.python.org/downloads/
    exit /b 1
)

:: --- Detect Node.js 20+ ---
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] 妫€娴?Node.js 20+ 澶辫触锛氭湭鍦?PATH 涓壘鍒?node
    echo 璇峰畨瑁?Node.js 20+: https://nodejs.org/
    exit /b 1
)

:: node --version returns "v20.x.x", use delims=v. to strip the 'v' prefix
for /f "tokens=1 delims=v." %%N in ('node --version 2^>nul') do (
    set "NODE_MAJOR=%%N"
)

if !NODE_MAJOR! lss 20 (
    echo [ERROR] 妫€娴?Node.js 20+ 澶辫触锛氬綋鍓嶇増鏈繃浣庯紙闇€瑕?v20+锛?
    echo 璇峰崌绾?Node.js: https://nodejs.org/
    exit /b 1
)

:: --- Set environment variables ---
set "KHYQUANT_PORTABLE_ROOT=%~dp0"
if not defined KHYQUANT_DATA_HOME set "KHYQUANT_DATA_HOME=%~dp0.khyquant-data"
set "PYTHONPATH=%~dp0software\khyquant;%PYTHONPATH%"

:: --- Launch CLI ---
%PYTHON_CMD% -m khy_quant.cli %*
exit /b %ERRORLEVEL%
