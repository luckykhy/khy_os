# Force-rescan and probe for Honor device enumeration
$ErrorActionPreference = "Continue"

Write-Host "=== Probe state ==="
$dev = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_339B&PID_107D&MI_02' }
if ($dev) {
  Write-Host "HDB Interface found: Status=$($dev.Status) Problem=$($dev.Problem)"
  Write-Host "Class: $($dev.Class) FriendlyName: $($dev.FriendlyName)"
  $err = Get-WmiObject Win32_PnPEntity | Where-Object { $_.DeviceID -eq $dev.InstanceId }
  if ($err) {
    Write-Host "ConfigManagerErrorCode: $($err.ConfigManagerErrorCode)"
    Write-Host "Status: $($err.Status)"
  }
} else {
  Write-Host "HDB Interface not enumerated."
}

# Try to find any newly-enumerated Android devices
$all = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_339B|USB\VID_0E8D' }
Write-Host "=== All Honor/Huawei USB devices ==="
$all | Select-Object Status, Class, FriendlyName, InstanceId | Format-Table -AutoSize -Wrap
