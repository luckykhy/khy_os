param([string]$Name)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$outDir = 'D:\Portable\khy-os\apps\khyos-desktop\docs\zcode-pages'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$w = 1920; $h = 1020
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
$bmp.Save((Join-Path $outDir ($Name + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ('saved ' + $Name + '.png')
