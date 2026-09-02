@echo off
chcp 65001 >nul
setlocal
set "ADB=C:\Users\25789\.khyos\android_sdk\platform-tools\adb.exe"
set "APK=D:\Portable\khy-os\apps\khy-mobile\release\khy-mobile-debug.apk"
set "PKG=com.khyos.companion"

echo === Watch: waiting for ADB device ===
echo === On phone: pull notification panel, change USB preference to MTP ===
echo === Then tap "Allow USB debugging" + check "Always allow" ===

:loop
"%ADB%" devices | findstr /R "device$" >nul
if not errorlevel 1 (
  echo === [device found] ===
  "%ADB%" devices
  echo === Installing ===
  "%ADB%" install -r -t "%APK%"
  echo === Launching ===
  "%ADB%" shell am start -n %PKG%/.MainActivity
  echo === Done. App should appear in launcher as "Khy-OS Companion" ===
  goto done
)
timeout /t 3 /nobreak >nul
goto loop

:done
endlocal
