@echo off
chcp 65001 >nul
REM 一键脚本：等手机 → 装 APK → 启动
REM 前置：在手机上设置 → 开发者选项 → 打开「USB 调试」+「仅充电」模式下插着数据线
REM 关键：手机会弹「允许 USB 调试吗？」→ 勾「始终允许」→ 确定
REM
REM 如果 30 秒没装上，请改用 无线调试（开发者选项 → 无线调试 → 配对）

setlocal
set "ADB=C:\Users\25789\.khyos\android_sdk\platform-tools\adb.exe"
set "APK=D:\Portable\khy-os\apps\khy-mobile\release\khy-mobile-debug.apk"
set "PKG=com.khyos.companion"
set "PKG_MAIN=.MainActivity"

echo === Reset adb ===
"%ADB%" kill-server 2>&1 >nul
"%ADB%" start-server 2>&1 >nul
"%ADB%" devices 2>&1
echo.
echo === Waiting for device (max 90s) ===
echo === Phone: change USB preference to "File transfer (MTP)" ===
echo === Then tap "Allow USB debugging" on the RSA prompt ===

set /a count=0
:loop
set /a count+=1
if %count% gtr 30 goto timeout
"%ADB%" devices 2>&1 | findstr /R "device$" >nul
if not errorlevel 1 (
  echo === [device found at attempt %count%] ===
  goto install
)
echo  [%count%/30] no device yet...
timeout /t 3 /nobreak >nul
goto loop

:install
echo.
"%ADB%" devices
echo.
echo === Installing APK ===
"%ADB%" install -r -t "%APK%"
echo.
echo === Launching ===
"%ADB%" shell am start -n "%PKG%%PKG_MAIN%"
echo.
echo === Done. App "Khy-OS Companion" should appear on phone ===
endlocal
exit /b 0

:timeout
echo.
echo === Timeout: no ADB device after 90s ===
echo === Two paths to fix: ===
echo === 1. Phone: pull notification, tap USB preference, change to MTP ===
echo ===    Then on phone: tap "Allow USB debugging" + check "Always allow" ===
echo ===    Re-run this script ===
echo === 2. Phone: Settings - Developer options - Wireless debugging - enable ===
echo ===    Tap "Pair device with pairing code" - note IP:Port + code ===
echo ===    Tell me: ip, port, code (e.g. "192.168.1.71 37865 123456") ===
endlocal
exit /b 1
