@echo off
chcp 65001 >nul
setlocal
set "ADB=C:\Users\25789\.khyos\android_sdk\platform-tools\adb.exe"
set "APK=D:\Portable\khy-os\apps\khy-mobile\release\khy-mobile-debug.apk"

echo === adb devices ===
"%ADB%" devices
echo.

echo === If empty, on phone: Settings ^> Developer options ^> USB debugging ON ===
echo === Pull notification panel ^> tap USB preference ^> choose File transfer (MTP) ===
echo === Tap "Allow USB debugging" on the RSA fingerprint prompt ===
echo.

echo === Wait 5s ===
timeout /t 5 /nobreak >nul

echo === Reset adb ===
"%ADB%" kill-server
"%ADB%" start-server
timeout /t 2 /nobreak >nul
"%ADB%" devices
echo.

echo === Install debug APK ===
"%ADB%" install -r -t "%APK%"
echo.

echo === Launch app (com.khyos.companion) ===
"%ADB%" shell am start -n com.khyos.companion/.MainActivity
echo.

echo === Done. Look for "Khy-OS Companion" icon on phone ===
endlocal
