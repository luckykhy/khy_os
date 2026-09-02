# Try to use Win32_DeviceInstall API to install the driver (works without UAC in some configs)
$ErrorActionPreference = "Continue"

$infPath = "C:\Users\25789\.khyos\android_sdk\extras\google\usb_driver\android_winusb.inf"

# Create a temporary copy to ensure file is accessible
$tmpInf = "$env:TEMP\android_winusb.inf"
$tmpDriverDir = "$env:TEMP\android_driver"
if (Test-Path $tmpDriverDir) { Remove-Item -Recurse -Force $tmpDriverDir }
New-Item -ItemType Directory -Path $tmpDriverDir | Out-Null
Copy-Item $infPath "$tmpDriverDir\android_winusb.inf"
Copy-Item "C:\Users\25789\.khyos\android_sdk\extras\google\usb_driver\amd64" "$tmpDriverDir\amd64" -Recurse
Copy-Item "C:\Users\25789\.khyos\android_sdk\extras\google\usb_driver\i386" "$tmpDriverDir\i386" -Recurse
Copy-Item "C:\Users\25789\.khyos\android_sdk\extras\google\usb_driver\*.cat" "$tmpDriverDir"

Write-Host "=== Try DiShowDeviceTree ==="
$dev = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_339B&PID_107D&MI_02' }
if ($dev) {
  Write-Host "Found HDB device: Status=$($dev.Status)"
  # Try to install driver for the specific device
  Write-Host "Trying: UpdateDriver for Root\VID_339B&PID_107D&MI_02"
  $pnpUtilArgs = @(
    '/add-driver', "$tmpDriverDir\android_winusb.inf"
  )
  $proc = Start-Process -FilePath "pnputil.exe" -ArgumentList $pnpUtilArgs -NoNewWindow -PassThru -Wait -RedirectStandardOutput "$env:TEMP\pnputil-out.log" -RedirectStandardError "$env:TEMP\pnputil-err.log" -Credential $null -LoadUserProfile -UseNewEnvironment
  Write-Host "pnputil exit: $($proc.ExitCode)"
  Get-Content "$env:TEMP\pnputil-out.log" -ErrorAction SilentlyContinue
  Get-Content "$env:TEMP\pnputil-err.log" -ErrorAction SilentlyContinue
} else {
  Write-Host "HDB device not enumerated."
}
