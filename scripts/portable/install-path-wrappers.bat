@echo off
setlocal enabledelayedexpansion

:: Parse arguments
set "FORCE=0"
:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--force" (
    set "FORCE=1"
    shift
    goto :parse_args
)
if /i "%~1"=="--help" goto :show_help
if /i "%~1"=="-h" goto :show_help
echo [FAIL] Unknown argument: %~1
exit /b 1
:args_done

:: Calculate project root (two levels up from scripts\portable\)
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%\..\..\") do set "PROJECT_ROOT=%%~fI"
:: Remove trailing backslash
if "%PROJECT_ROOT:~-1%"=="\" set "PROJECT_ROOT=%PROJECT_ROOT:~0,-1%"

:: Verify khy.bat exists in project root
if not exist "%PROJECT_ROOT%\khy.bat" (
    echo [FAIL] khy.bat not found under: %PROJECT_ROOT%
    exit /b 1
)

:: Create target bin directory
set "BIN_DIR=%LocalAppData%\khy-os\bin"
if not exist "%BIN_DIR%" (
    mkdir "%BIN_DIR%"
    if errorlevel 1 (
        echo [FAIL] Cannot create directory: %BIN_DIR%
        exit /b 1
    )
)

:: Install wrappers
call :install_wrapper "khy.bat"
call :install_wrapper "khy-os.bat"
call :install_wrapper "khyquant.bat"

echo.

:: Check if PATH contains BIN_DIR
echo %PATH% | find /i "%BIN_DIR%" >nul 2>&1
if %errorlevel%==0 (
    echo [OK] PATH 已包含 %BIN_DIR%
) else (
    echo [WARN] PATH 中未找到目标目录。
    echo 请将以下目录添加到系统 PATH: %BIN_DIR%
    echo 或运行: setx PATH "%%PATH%%;%BIN_DIR%"
)

echo.
echo 试试: khy --help
exit /b 0

:: ============================================================
:install_wrapper
set "WRAPPER_NAME=%~1"
set "TARGET=%BIN_DIR%\%WRAPPER_NAME%"
if exist "%TARGET%" (
    if "!FORCE!"=="0" (
        echo [SKIP] 已存在: %TARGET% ^(使用 --force 覆盖^)
        goto :eof
    )
)
:: Write wrapper content
(
    echo @echo off
    echo "%PROJECT_ROOT%\khy.bat" %%*
) > "%TARGET%"
echo [OK] 已安装: %WRAPPER_NAME% -^> %PROJECT_ROOT%\khy.bat
goto :eof

:: ============================================================
:show_help
echo Usage:
echo   install-path-wrappers.bat [options]
echo.
echo Options:
echo   --force    Overwrite existing wrappers
echo   -h, --help Show this help
echo.
echo Creates command wrappers in %%LocalAppData%%\khy-os\bin\
exit /b 0
