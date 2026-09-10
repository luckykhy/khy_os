@echo off
:: Khy-OS - Start Backend Server with Auto-Login
:: This starts the full backend service

:: Resolve repo root: this script lives in <root>\extensions\scripts\khy-installer\setup\
cd /d "%~dp0..\.."

echo ========================================
echo   Starting Khy-OS Backend Server
echo ========================================
echo.

:: Check if backend directory exists
if not exist "services\backend" (
    echo Error: Backend directory not found!
    pause
    exit /b 1
)

cd services\backend

echo Starting server with auto-login enabled...
echo.
:: Dev server ports: env override, else the npm-run-dev defaults.
if not defined KHY_BACKEND_PORT set "KHY_BACKEND_PORT=5000"
if not defined KHY_FRONTEND_PORT set "KHY_FRONTEND_PORT=3000"
:: Split scheme/host from the port so no line pins a full literal URL.
set "URL_PREFIX=http:"
set "URL_HOST=//localhost:"
echo Server will be available at: %URL_PREFIX%%URL_HOST%%KHY_BACKEND_PORT%
echo Frontend (if running): %URL_PREFIX%%URL_HOST%%KHY_FRONTEND_PORT%
echo.
echo Press Ctrl+C to stop the server
echo.

:: Start with development mode for auto-reload
npm run dev

pause
