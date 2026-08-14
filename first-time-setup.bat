@echo off
:: Khy-OS - One-Time Setup for CLI Auto-Login
:: This creates the default admin account so CLI can auto-login

cd /d "%~dp0"

echo ========================================
echo   Khy-OS 一次性设置
echo ========================================
echo.
echo 正在创建默认管理员账号...
echo 这只需要运行一次！
echo.

cd services\backend

:: Run quick setup script
node scripts\quick-setup.js

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================
    echo   ✓ 设置完成！
    echo ========================================
    echo.
    echo 默认管理员账号已创建。
    echo.
    echo 现在运行 khy 命令将自动登录：
    echo.
    echo   khy
    echo.
) else (
    echo.
    echo ========================================
    echo   ❌ 设置失败
    echo ========================================
    echo.
    echo 请尝试：
    echo   1. cd services\backend
    echo   2. npm run seed
    echo.
)

pause
