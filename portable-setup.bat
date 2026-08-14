@echo off
:: Khy-OS Portable Setup
:: Run this once on any new computer to enable 'khy' command globally

setlocal enabledelayedexpansion

echo ========================================
echo   Khy-OS Portable Setup
echo ========================================
echo.

:: Get current directory (project root)
set "PROJECT_DIR=%~dp0"
set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"

echo Project location: %PROJECT_DIR%
echo.
echo Setting up global 'khy' command...
echo.

:: Check if PowerShell profile exists
powershell -NoProfile -Command "if (!(Test-Path $PROFILE)) { $null = New-Item -ItemType File -Path $PROFILE -Force; Write-Host 'Created PowerShell profile' }"

:: Add or update khy function in profile
powershell -NoProfile -Command ^
"$profilePath = $PROFILE; ^
$content = Get-Content $profilePath -Raw -ErrorAction SilentlyContinue; ^
if ($content -match 'function khy') { ^
    $content = $content -replace 'function khy \{[^}]+\}', ('function khy { node \"' + '%PROJECT_DIR%' + '\services\backend\bin\khy.js\" $args }'); ^
    Set-Content $profilePath $content; ^
    Write-Host 'Updated existing khy function' -ForegroundColor Yellow ^
} else { ^
    Add-Content $profilePath \"`n# Khy-OS Command`nfunction khy { node \`\"%PROJECT_DIR%\services\backend\bin\khy.js\`\" `$args }`n\"; ^
    Write-Host 'Added khy function to profile' -ForegroundColor Green ^
}"

echo.
echo ========================================
echo   Setup Complete!
echo ========================================
echo.
echo The 'khy' command will work from this location:
echo %PROJECT_DIR%
echo.
echo Next steps:
echo   1. Restart PowerShell
echo   2. Run: khy --version
echo.
echo If you move this project to a different location,
echo run this script again to update the path.
echo.
pause
