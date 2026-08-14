@echo off
chcp 65001 >nul
echo.
echo ======================================
echo   Õï¶Ï Claude ÊÊÅäÆ÷¼ì²âÎÊÌâ
echo ======================================
echo.

cd /d "%~dp0services\backend"

echo [1/5] ¼ì²é claude ÃüÁîÊÇ·ñ´æÔÚ...
where claude >nul 2>&1
if %errorlevel% equ 0 (
    echo 
iconv: diagnose-gateway.bat:14:9: cannot convert
