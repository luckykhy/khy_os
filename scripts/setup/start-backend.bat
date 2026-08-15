@echo off
:: Khy-OS - Start Backend Server with Auto-Login
:: This starts the full backend service

:: Resolve repo root: this script lives in <root>\scripts\setup\
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
echo Server will be available at: http://localhost:5000
echo Frontend (if running): http://localhost:3000
echo.
echo Press Ctrl+C to stop the server
echo.

:: Start with development mode for auto-reload
npm run dev

pause
