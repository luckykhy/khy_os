@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

pushd "%~dp0..\..\.." >nul
if errorlevel 1 (
    echo [FAIL] Cannot resolve the project root from: %~dp0
    exit /b 1
)
set "PROJECT_ROOT=%CD%"
popd

set "FORCE=0"
set "ADD_TO_PATH=0"
:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--force" set "FORCE=1" & shift /1 & goto parse_args
if /i "%~1"=="--add-to-path" set "ADD_TO_PATH=1" & shift /1 & goto parse_args
if /i "%~1"=="--help" goto show_help
if /i "%~1"=="-h" goto show_help
echo [FAIL] Unknown argument: %~1
exit /b 1
:args_done

if not exist "%PROJECT_ROOT%\khy.bat" (
    echo [FAIL] khy.bat not found under: %PROJECT_ROOT%
    exit /b 1
)

set "BIN_DIR=%LocalAppData%\khy-os\bin"
if not exist "%BIN_DIR%" mkdir "%BIN_DIR%"
if errorlevel 1 (
    echo [FAIL] Cannot create directory: %BIN_DIR%
    exit /b 1
)

for %%N in (khy.bat khy-os.bat khyquant.bat) do (
    set "TARGET=%BIN_DIR%\%%N"
    set "WRITE_WRAPPER=1"
    if exist "!TARGET!" if "!FORCE!"=="0" set "WRITE_WRAPPER=0"
    if "!WRITE_WRAPPER!"=="0" (
        echo [SKIP] !TARGET! ^(use --force to overwrite^)
    ) else (
        > "!TARGET!" echo @echo off
        >> "!TARGET!" echo chcp 65001 ^>nul
        >> "!TARGET!" echo call "%PROJECT_ROOT%\khy.bat" %%*
        >> "!TARGET!" echo exit /b %%ERRORLEVEL%%
        if errorlevel 1 (
            echo [FAIL] Cannot write: !TARGET!
            exit /b 1
        )
        echo [OK] %%N -^> %PROJECT_ROOT%\khy.bat
    )
)

if "%ADD_TO_PATH%"=="1" (
    set "KhyPathBin=%BIN_DIR%"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$bin=$env:KhyPathBin; $current=[Environment]::GetEnvironmentVariable('Path','User'); $items=[Collections.Generic.List[string]]::new(); foreach($item in ($current -split ';')) { $trimmed=$item.Trim(); if($trimmed -and -not ($items | Where-Object { $_.TrimEnd('\') -ieq $trimmed.TrimEnd('\') })) { $items.Add($trimmed) } }; if(-not ($items | Where-Object { $_.TrimEnd('\') -ieq $bin.TrimEnd('\') })) { $items.Add($bin); [Environment]::SetEnvironmentVariable('Path', ($items -join ';'), 'User') }"
    if errorlevel 1 (
        echo [FAIL] Could not update the user PATH.
        exit /b 1
    )
    set "PATH=%BIN_DIR%;!PATH!"
)

echo.
echo [OK] Wrappers: %BIN_DIR%
if "%ADD_TO_PATH%"=="1" (
    echo [OK] User PATH updated. Open a new terminal to use khy everywhere.
) else (
    echo [INFO] Add this directory to PATH for global use: %BIN_DIR%
)
exit /b 0

:show_help
echo Usage: install-path-wrappers.bat [--force] [--add-to-path]
echo.
echo Installs khy command wrappers under %%LocalAppData%%\khy-os\bin.
exit /b 0
