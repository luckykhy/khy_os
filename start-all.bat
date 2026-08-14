@echo off
:: Khy-OS - Complete Startup (Backend + Frontend)
:: This starts both services for full functionality

cd /d "%~dp0"

echo ========================================
echo   Starting Khy-OS Complete System
echo ========================================
echo.

:: Start backend in new window
echo Starting backend server...
start "Khy-OS Backend" cmd /k "cd /d %~dp0services\backend && npm run dev"

:: Wait a moment
timeout /t 3 /nobreak >nul

:: Start frontend in new window
echo Starting frontend...
start "Khy-OS Frontend" cmd /k "cd /d %~dp0apps\ai-frontend && npm run dev"

echo.
echo ========================================
echo   Both services are starting!
echo ========================================
echo.
echo Backend: http://localhost:5000
echo Frontend: http://localhost:3000
echo.
echo Two new windows have opened.
echo Close them to stop the services.
echo.
pause
