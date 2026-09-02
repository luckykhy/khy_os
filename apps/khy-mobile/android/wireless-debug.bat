@echo off
chcp 65001 >nul
REM 无线调试一键脚本：用户在手机开发者选项 → 无线调试 → 配对 → 把 (ip port code) 告诉我
REM 或者直接编辑本文件填进去

setlocal
set "ADB=C:\Users\25789\.khyos\android_sdk\platform-tools\adb.exe"
set "APK=D:\Portable\khy-os\apps\khy-mobile\release\khy-mobile-debug.apk"
set "PKG=com.khyos.companion"

REM === 在这里填手机的无线调试信息 ===
REM 例：set "PHONE_IP=192.168.1.71"
set "PHONE_IP="
set "PHONE_PORT=37865"
set "PAIR_CODE="

if "%PHONE_IP%"=="" (
  echo === 缺参数。在手机上：设置 - 开发者选项 - 无线调试 - 打开 - 配对设备 - 记下 IP:Port 和 6 位配对码 ===
  echo.
  set /p PHONE_IP="Phone IP (e.g. 192.168.1.71): "
  set /p PHONE_PORT="Pair port (default 37865): "
  set /p PAIR_CODE="6-digit pair code: "
)

echo.
echo === adb pair %PHONE_IP%:%PHONE_PORT% %PAIR_CODE% ===
"%ADB%" pair %PHONE_IP%:%PHONE_PORT% %PAIR_CODE%
echo.

echo === adb connect %PHONE_IP%:5555 ===
"%ADB%" connect %PHONE_IP%:5555
echo.

echo === devices ===
"%ADB%" devices
echo.

echo === If device shown, install ===
"%ADB%" install -r -t "%APK%"
echo.

echo === Launch ===
"%ADB%" shell am start -n "%PKG%/.MainActivity"
echo.
endlocal
