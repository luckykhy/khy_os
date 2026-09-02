$ErrorActionPreference = "Continue"
$phones = Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_339B|Vendor_12d1' }
Write-Host "=== Honor USB devices (Present Only) ==="
$phones | Select-Object Status, Class, FriendlyName, InstanceId | Format-Table -AutoSize -Wrap

Write-Host "=== All errored devices ==="
$errs = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Error' -and $_.Present -eq $true }
$errs | Select-Object Status, Class, FriendlyName, InstanceId | Format-Table -AutoSize -Wrap
