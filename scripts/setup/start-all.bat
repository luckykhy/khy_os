@echo off
:: Khy-OS - Complete Startup (Backend + Frontend)
:: This starts both services for full functionality

:: Resolve repo root: this script lives in <root>\scripts\setup\
pushd "%~dp0..\.."
set "KHY_REPO_ROOT=%CD%"
popd
cd /d "%KHY_REPO_ROOT%"

echo ========================================
echo   Starting Khy-OS Complete System
echo ========================================
echo.

:: Start backend in new window
echo Starting backend server...
start "Khy-OS Backend" /D "%KHY_REPO_ROOT%\services\backend" cmd /k "npm run dev"

:: Wait a moment
timeout /t 3 /nobreak >nul

:: Start frontend in new window
echo Starting frontend...
start "Khy-OS Frontend" /D "%KHY_REPO_ROOT%\apps\ai-frontend" cmd /k "npm run dev"

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
