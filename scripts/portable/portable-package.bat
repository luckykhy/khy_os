@echo off
setlocal
cd /d "%~dp0"

echo Building Windows portable runtime package...
call npm run portable:package:runtime
set "RESULT=%ERRORLEVEL%"

if not "%RESULT%"=="0" (
  echo.
  echo Packaging failed with exit code %RESULT%.
) else (
  echo.
  echo Package created in dist\releases.
)

if not defined KHY_PACKAGE_NO_PAUSE pause
exit /b %RESULT%
