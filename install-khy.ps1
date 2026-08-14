# Khy-OS Quick Setup Script
# Run this in PowerShell for instant configuration

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Khy-OS Global Command Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if profile exists
if (!(Test-Path -Path $PROFILE)) {
    Write-Host "[1/3] Creating PowerShell profile..." -ForegroundColor Yellow
    New-Item -ItemType File -Path $PROFILE -Force | Out-Null
    Write-Host "      Profile created: $PROFILE" -ForegroundColor Green
} else {
    Write-Host "[1/3] PowerShell profile exists" -ForegroundColor Green
}

# Check if khy already configured
$content = Get-Content $PROFILE -ErrorAction SilentlyContinue
if ($content -match 'khy-os|function khy') {
    Write-Host "[2/3] khy command already configured" -ForegroundColor Yellow
    $overwrite = Read-Host "      Overwrite? (y/n)"
    if ($overwrite -ne 'y') {
        Write-Host ""
        Write-Host "Setup cancelled. Use existing configuration." -ForegroundColor Yellow
        Write-Host ""
        exit
    }
}

# Add khy function
Write-Host "[2/3] Adding khy global command..." -ForegroundColor Yellow
$khyFunction = @"

# ========================================
# Khy-OS Global Command
# ========================================
function khy {
    node C:\khy-os\services\backend\bin\khy.js `$args
}
"@

Add-Content -Path $PROFILE -Value $khyFunction
Write-Host "      khy function added" -ForegroundColor Green

# Reload profile
Write-Host "[3/3] Reloading configuration..." -ForegroundColor Yellow
. $PROFILE
Write-Host "      Configuration reloaded" -ForegroundColor Green

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
