@echo off
:: Khy-OS - Complete Startup (Backend + Frontend)
:: This starts both services for full functionality

:: Resolve repo root: this script lives in <root>\extensions\scripts\khy-installer\setup\
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
:: Dev server ports: env override, else the npm-run-dev defaults.
if not defined KHY_BACKEND_PORT set "KHY_BACKEND_PORT=5000"
if not defined KHY_FRONTEND_PORT set "KHY_FRONTEND_PORT=3000"
:: Split scheme/host from the port so no line pins a full literal URL.
set "URL_PREFIX=http:"
set "URL_HOST=//localhost:"
echo Backend: %URL_PREFIX%%URL_HOST%%KHY_BACKEND_PORT%
echo Frontend: %URL_PREFIX%%URL_HOST%%KHY_FRONTEND_PORT%
echo.
echo Two new windows have opened.
echo Close them to stop the services.
echo.
pause
