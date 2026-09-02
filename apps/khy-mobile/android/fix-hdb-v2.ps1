# Targeted driver install for the specific errored HDB device
$ErrorActionPreference = "Continue"

$infPath = "C:\Users\25789\.khyos\android_sdk\extras\google\usb_driver\android_winusb.inf"
$hdbInstanceId = "USB\VID_339B&PID_107D&MI_02\6&2694CB9C&0&0002"

# Use SetupDi APIs to install the driver specifically for this device
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class DriverInstaller {
  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool SetupDiInstallDevice(IntPtr DeviceInfoSet, IntPtr DeviceInfoData, IntPtr DriverInfoData, UInt32 Flags, out bool NeedReboot);

  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr SetupDiCreateDeviceInfoList(IntPtr ClassGuid, IntPtr HwndParent);

  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr SetupDiGetClassDevs(ref Guid ClassGuid, IntPtr Enumerator, IntPtr HwndParent, UInt32 Flags);

  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr SetupDiOpenDeviceInfo(IntPtr DeviceInfoSet, string DevicePath, IntPtr HwndParent, UInt32 Flags, IntPtr DeviceInfoData);

  [StructLayout(LayoutKind.Sequential)]
  public struct SP_DEVINSTALL_PARAMS {
    public UInt32 cbSize;
    public UInt32 Flags;
    public UInt32 FlagsEx;
    public IntPtr hwndParent;
    public IntPtr InstallMsgHandler;
    public IntPtr InstallMsgHandlerContext;
    public IntPtr FileQueue;
    public IntPtr ClassInstallReserved;
    public IntPtr Reserved;
    public string DriverPath;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct SP_DRVINFO_DATA {
    public UInt32 cbSize;
    public UInt32 DriverType;
    public UInt32 Reserved;
    public string Description;
    public string MfgName;
    public string ProviderName;
    public System.Runtime.InteropServices.ComTypes.FILETIME DriverDate;
    public UInt64 DriverVersion;
  }
}
"@

# Read the INF to extract class GUID
$inf = Get-Content $infPath -Raw
$classMatch = [regex]::Match($inf, '\[Version\][\s\S]*?Class\s*=\s*(\w+)')
Write-Host "INF class: $($classMatch.Groups[1].Value)"

# Get class GUID from setupapi
$hwid = $hdbInstanceId
Write-Host "HDB device: $hwid"
Write-Host "=== Try: devcon-style scan and install ==="

# Method 2: use pnputil with hardware-id-specific install
$output = cmd.exe /c "pnputil /add-driver `"$infPath`" /install" 2>&1
$output | ForEach-Object { Write-Host "  $_" }

# Force rescan
Write-Host "=== Rescanning... ==="
$output = cmd.exe /c "pnputil /scan-devices" 2>&1
$output | ForEach-Object { Write-Host "  $_" }

# Now try devcon-equivalent: disable + re-enable the device
Write-Host "=== Disable + re-enable HDB device ==="
$dev = Get-PnpDevice | Where-Object { $_.InstanceId -eq $hwid }
if ($dev) {
  Write-Host "Before: Status=$($dev.Status)"
  # Use devcon if available
  $devcon = Get-ChildItem -Path "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter "devcon.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($devcon) {
    Write-Host "Found devcon: $($devcon.FullName)"
    & $devcon.FullName disable "@USB\VID_339B&PID_107D&MI_02*" 2>&1
    Start-Sleep -Seconds 2
    & $devcon.FullName enable "@USB\VID_339B&PID_107D&MI_02*" 2>&1
    Start-Sleep -Seconds 3
  } else {
    Write-Host "devcon not found in Windows Kits, trying pnputil restart"
    cmd.exe /c "pnputil /restart-device `"$hwid`"" 2>&1
  }
  $dev2 = Get-PnpDevice -InstanceId $hwid
  Write-Host "After: Status=$($dev2.Status)"
}
