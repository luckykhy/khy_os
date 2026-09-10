@echo off
chcp 65001 >nul
title KhyOS Desktop — 开发模式
cd /d "%~dp0"
echo ========================================
echo   KhyOS Desktop — 正在启动开发服务器...
echo ========================================
echo.
npm run dev
pause
