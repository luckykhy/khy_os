@echo off
chcp 65001 >nul 2>&1
set ADB=C:\Users\25789\.khyos\android_sdk\platform-tools\adb.exe

echo === adb devices ===
"%ADB%" devices
echo.

echo === PnP devices (Honor VID_339B) ===
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-PnpDevice -PresentOnly | Where-Object InstanceId -match 'VID_339B' | Select-Object Status, Class, FriendlyName | Format-Table -AutoSize -Wrap" 2>nul
echo.

echo === HDB Interface driver error code ===
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w = Get-WmiObject Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object DeviceID -match 'VID_339B.PID_107D.MI_02'; if ($w) { Write-Host ('  Status: ' + $w.Status + '  ErrorCode: ' + $w.ConfigManagerErrorCode) } else { Write-Host '  HDB Interface not present (phone in charge-only mode?)' }" 2>nul
echo.
echo === Decision tree ===
echo   adb has device     = MTP + RSA allowed + 1click succeeded, look at phone for app
echo   adb empty + HDB 28 = need admin to install HDB driver, OR use wireless debug
echo   adb empty + no HDB = phone in charge-only mode, change to MTP/PTP first
echo.
