@echo off
chcp 65001 >nul
setlocal

set "APP_DIR=%~dp0"
set "SHORTCUT_PATH=%USERPROFILE%\Desktop\KhyOS Desktop.lnk"

echo ========================================
echo   创建 KhyOS Desktop 桌面快捷方式
echo ========================================
echo.
echo 应用目录: %APP_DIR%
echo 快捷方式: %SHORTCUT_PATH%
echo.

powershell -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('%SHORTCUT_PATH%'); $sc.TargetPath = 'cmd.exe'; $sc.Arguments = '/c \"cd /d \"%APP_DIR%\" && npm run dev\"'; $sc.WorkingDirectory = '%APP_DIR%'; $sc.WindowStyle = 7; $sc.Description = 'KhyOS Desktop'; $sc.Save(); Write-Host 'OK'"

if exist "%SHORTCUT_PATH%" (
    echo [OK] 快捷方式创建成功！
    echo.
    echo 双击桌面上的 "KhyOS Desktop" 即可启动
) else (
    echo [FAIL] 创建失败，请手动创建
)

pause
