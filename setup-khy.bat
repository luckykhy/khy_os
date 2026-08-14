@echo off
chcp 65001 >nul
:: Khy-OS Global Command - One-Click Setup
:: Double-click to configure khy command globally

echo.
echo ========================================
echo   Khy-OS Global Command Setup
echo ========================================
echo.
echo Configuring... Please wait...
echo.

:: Execute PowerShell configuration
powershell -NoProfile -ExecutionPolicy Bypass -Command "$profilePath = $PROFILE; if (!(Test-Path -Path $profilePath)) { New-Item -ItemType File -Path $profilePath -Force | Out-Null; Write-Host 'Created PowerShell profile' -ForegroundColor Green }; $content = Get-Content $profilePath -ErrorAction SilentlyContinue; if ($content -notmatch 'khy-os') { Add-Content $profilePath \"`n# Khy-OS Global Command`nfunction khy { node C:\khy-os\services\backend\bin\khy.js `$args }`n\"; Write-Host 'Added khy function to PowerShell profile' -ForegroundColor Green } else { Write-Host 'khy command already configured' -ForegroundColor Yellow }"

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================
    echo   Setup Complete!
    echo ========================================
    echo.
    echo Next Steps:
    echo   1. Open a NEW PowerShell window
    echo   2. Run: khy --version
    echo   3. If you see version number, success!
    echo.
) else (
    echo.
    echo ========================================
    echo   Setup Failed
    echo ========================================
    echo.
    echo Please try manual setup:
    echo   1. Open PowerShell
    echo   2. Run: notepad $PROFILE
    echo   3. Add: function khy { node C:\khy-os\services\backend\bin\khy.js $args }
    echo   4. Save and restart PowerShell
    echo.
)

echo Tip: You can also use .\khy.bat directly
echo.
pause
