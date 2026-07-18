# @pattern Command
param(
  [string]$OutputDir = "$env:TEMP\khy\clipboard-img2file",
  [int]$PollMs = 500,
  [int]$KeepFiles = 8,
  [string]$Marker = "KHYClipboardImg2File"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $OutputDir)) {
  New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

if ($PollMs -lt 120) { $PollMs = 120 }
if ($KeepFiles -lt 1) { $KeepFiles = 1 }
if ($KeepFiles -gt 200) { $KeepFiles = 200 }

function Remove-OldScreenshots {
  param(
    [Parameter(Mandatory = $true)][string]$Dir,
    [Parameter(Mandatory = $true)][int]$Keep
  )

  try {
    $files = Get-ChildItem -LiteralPath $Dir -Filter "screenshot_*.png" -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending
    if ($null -eq $files) { return }
    if ($files.Count -le $Keep) { return }

    $files | Select-Object -Skip $Keep | ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    }
  } catch {
    # best effort
  }
}

while ($true) {
  Start-Sleep -Milliseconds $PollMs

  try {
    if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { continue }
    if ([System.Windows.Forms.Clipboard]::ContainsData($Marker)) { continue }

    $image = [System.Windows.Forms.Clipboard]::GetImage()
    if ($null -eq $image) { continue }

    $name = "screenshot_{0}.png" -f (Get-Date -Format "yyyyMMdd_HHmmss_fff")
    $path = Join-Path $OutputDir $name
    $image.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

    # Quote the path for terminals: robust when user profile contains spaces.
    $quotedPath = '"' + $path + '"'

    $data = New-Object System.Windows.Forms.DataObject
    $data.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $quotedPath)
    $data.SetData([System.Windows.Forms.DataFormats]::Text, $quotedPath)
    $data.SetData([System.Windows.Forms.DataFormats]::FileDrop, [string[]]@($path))
    $data.SetImage($image)
    $data.SetData($Marker, "1")
    [System.Windows.Forms.Clipboard]::SetDataObject($data, $true)

    $image.Dispose()
    Remove-OldScreenshots -Dir $OutputDir -Keep $KeepFiles
  } catch [System.Runtime.InteropServices.ExternalException] {
    # Clipboard can be temporarily busy when another process owns it.
    continue
  } catch {
    # Keep daemon alive on unexpected clipboard/provider errors.
    continue
  }
}
