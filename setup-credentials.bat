@echo off
:: Khy-OS - Create Default Admin Credentials
:: Run this once to generate credentials for CLI auto-login

cd /d "%~dp0"

echo ========================================
echo   Khy-OS - 生成默认管理员凭据
echo ========================================
echo.
echo 正在生成默认管理员账号...
echo.

cd services\backend

:: Run the create-admin script
node scripts\create-admin.js

echo.
echo ========================================
echo   完成！
echo ========================================
echo.
echo 默认管理员账号已创建。
echo.
echo 现在您可以使用 khy 命令自动登录了！
echo.
echo 测试：
echo   khy
echo.
pause
