@echo off
chcp 65001 >nul
setlocal
set "INF=C:\Users\25789\.khyos\android_sdk\extras\google\usb_driver\android_winusb.inf"
set "DRIVER_DIR=C:\Users\25789\.khyos\android_sdk\extras\google\usb_driver"

echo === This will ask for Administrator permission to install Google USB driver ===
echo === Path: %INF% ===
echo.

REM Run pnputil elevated
powershell -NoProfile -Command "Start-Process -FilePath 'pnputil.exe' -ArgumentList '/add-driver', '%INF%', '/install' -Verb RunAs -Wait -PassThru | Out-Null" 2>&1

echo === Driver added to store (or denied). Now restart adb server ===
"C:\Users\25789\.khyos\android_sdk\platform-tools\adb.exe" kill-server 2>&1
"C:\Users\25789\.khyos\android_sdk\platform-tools\adb.exe" start-server 2>&1
"C:\Users\25789\.khyos\android_sdk\platform-tools\adb.exe" devices 2>&1

echo.
echo === If empty, on phone: pull notification panel, tap USB preference, choose MTP ===
echo === Then tap "Allow USB debugging" ===
echo.
echo === Or run device-watch.bat to auto-install when device appears ===
endlocal
