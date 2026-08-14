@echo off
:: Simple one-liner to create default admin
cd /d "%~dp0services\backend"
echo Creating default admin account...
node scripts/create-admin.js
pause
