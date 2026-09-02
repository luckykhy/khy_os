# Khy-OS Quick Setup Script
# Run this in PowerShell for instant configuration

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Khy-OS Global Command Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if profile exists
if (!(Test-Path -Path $PROFILE)) {
    Write-Host "[1/4] Creating PowerShell profile..." -ForegroundColor Yellow
    New-Item -ItemType File -Path $PROFILE -Force | Out-Null
    Write-Host "      Profile created: $PROFILE" -ForegroundColor Green
} else {
    Write-Host "[1/4] PowerShell profile exists" -ForegroundColor Green
}

# Check if khy already configured
$content = Get-Content $PROFILE -ErrorAction SilentlyContinue
if ($content -match 'khy-os|function khy') {
    Write-Host "[2/4] khy command already configured" -ForegroundColor Yellow
    $overwrite = Read-Host "      Overwrite? (y/n)"
    if ($overwrite -ne 'y') {
        Write-Host ""
        Write-Host "Setup cancelled. Use existing configuration." -ForegroundColor Yellow
        Write-Host ""
        exit
    }
}

# Add khy function
Write-Host "[2/4] Adding khy global command..." -ForegroundColor Yellow

# Resolve the entry point from this script's own location, so the generated
# profile points at wherever the user actually cloned khy-os. Hardcoding an
# absolute path here would leak one machine's layout to every user.
$khyEntry = Join-Path $PSScriptRoot 'services\backend\bin\khy.js'
if (!(Test-Path -Path $khyEntry)) {
    Write-Host "      ERROR: khy entry not found at $khyEntry" -ForegroundColor Red
    Write-Host "      Run this script from the khy-os repository root." -ForegroundColor Red
    exit 1
}

$khyFunction = @"

# ========================================
# Khy-OS Global Command
# ========================================
function khy {
    node "$khyEntry" `$args
}
"@

Add-Content -Path $PROFILE -Value $khyFunction
Write-Host "      khy function added" -ForegroundColor Green

# Reload profile
Write-Host "[3/4] Reloading configuration..." -ForegroundColor Yellow
. $PROFILE
Write-Host "      Configuration reloaded" -ForegroundColor Green

# Enable transparent NTFS compression (Windows, best-effort, never fails setup)
Write-Host "[4/4] Enabling NTFS transparent compression..." -ForegroundColor Yellow
$compressScript = Join-Path $PSScriptRoot 'scripts\install\enable-ntfs-compression.ps1'
if (Test-Path -Path $compressScript) {
    & $compressScript -ProjectRoot $PSScriptRoot
} else {
    Write-Host "      Compression helper not found, skipped (files stay uncompressed)" -ForegroundColor DarkGray
}

# Test
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Setup Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Testing..." -ForegroundColor Yellow
try {
    $version = khy --version 2>&1
    Write-Host "khy version: $version" -ForegroundColor Green
    Write-Host ""
    Write-Host "Success! You can now use 'khy' command anywhere!" -ForegroundColor Green
} catch {
    Write-Host "Please restart PowerShell and try: khy --version" -ForegroundColor Yellow
}
Write-Host ""
