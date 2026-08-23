@echo off
setlocal EnableExtensions
:: Thin wrapper: portable-setup.bat lives at the repo root, four levels up.
call "%~dp0..\..\..\..\portable-setup.bat" %*
exit /b %ERRORLEVEL%
