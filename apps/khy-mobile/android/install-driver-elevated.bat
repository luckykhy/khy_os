@echo off
chcp 65001 >nul
REM 安装 Google USB 驱动到驱动存储（必须管理员）
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Not running as admin. Self-elevating...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs -Wait" 
  exit /b %errorlevel%
)

echo === Running as Administrator ===
echo === Adding Google USB driver to driver store ===
pnputil /add-driver "C:\Users\25789\.khyos\android_sdk\extras\google\usb_driver\android_winusb.inf" /install
echo.
echo === Force re-enumeration of HDB device (Android ADB Interface) ===
"C:\Users\25789\.khyos\android_sdk\platform-tools\adb.exe" kill-server
"C:\Users\25789\.khyos\android_sdk\platform-tools\adb.exe" start-server
"C:\Users\25789\.khyos\android_sdk\platform-tools\adb.exe" devices
echo.
echo === After install, on the phone: ===
echo 1. Pull notification panel ===
echo 2. Tap "USB charging this device" notification ===
echo 3. Choose "File transfer (MTP)" or "PTP" ===
echo 4. Tap "Allow USB debugging" on the RSA prompt ===
echo.
pause
