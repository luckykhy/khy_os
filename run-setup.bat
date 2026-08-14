@echo off
:: 启动 PowerShell 并执行 khy 命令配置脚本

echo ========================================
echo  正在启动 PowerShell 配置脚本...
echo ========================================
echo.

powershell.exe -ExecutionPolicy Bypass -File "%~dp0setup-khy-command.ps1"

echo.
echo ========================================
echo  配置完成！
echo ========================================
echo.
echo 请执行以下操作：
echo   1. 关闭当前终端
echo   2. 重新打开 PowerShell 或 CMD
echo   3. 运行: khy --version
echo.
pause
