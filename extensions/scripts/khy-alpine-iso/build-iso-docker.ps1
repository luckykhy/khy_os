# @pattern Command, Template Method
# build-iso-docker.ps1 — Build KHY OS ISO via Docker on Windows
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File extensions\scripts\khy-alpine-iso\build-iso-docker.ps1
#
# Requires: Docker Desktop for Windows

$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path "$PSScriptRoot\..\..").Path
$OutputDir = Join-Path $RootDir "dist"
$OutputFile = Join-Path $OutputDir "khy-os.iso"
$ImageTag = "khy-iso-builder:latest"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error "Docker is required. Install Docker Desktop first."
    exit 1
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Write-Host "[INFO]  Building Docker image ($ImageTag)..." -ForegroundColor Cyan
docker build -t $ImageTag -f "$RootDir\extensions\scripts\khy-alpine-iso\Dockerfile.iso-builder" $RootDir
if ($LASTEXITCODE -ne 0) { Write-Error "Docker build failed"; exit 1 }

Write-Host "[INFO]  Running ISO build inside container..." -ForegroundColor Cyan
docker run --rm --privileged -v "${OutputDir}:/out" $ImageTag --output "/out/khy-os.iso"
if ($LASTEXITCODE -ne 0) { Write-Error "ISO build failed"; exit 1 }

if (Test-Path $OutputFile) {
    $size = (Get-Item $OutputFile).Length / 1MB
    Write-Host "[OK]    ISO built: $OutputFile ($([math]::Round($size, 1)) MB)" -ForegroundColor Green
    Write-Host ""
    Write-Host "[INFO]  Import into VMware or VirtualBox to test." -ForegroundColor Cyan
} else {
    Write-Error "ISO build failed — output file not found"
}
