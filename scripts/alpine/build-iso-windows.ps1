# @pattern Command, Template Method
Param(
    [string]$Output = "",
    [switch]$NoCache
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
    Write-Host "[FAIL] $Message" -ForegroundColor Red
    exit 1
}

function Info([string]$Message) {
    Write-Host "[INFO] $Message" -ForegroundColor Cyan
}

function Ok([string]$Message) {
    Write-Host "[OK]   $Message" -ForegroundColor Green
}

function Resolve-OutputPath([string]$Candidate, [string]$ProjectRoot) {
    if ([string]::IsNullOrWhiteSpace($Candidate)) {
        return (Join-Path $ProjectRoot "dist\khy-os.iso")
    }

    if ([System.IO.Path]::IsPathRooted($Candidate)) {
        return [System.IO.Path]::GetFullPath($Candidate)
    }

    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Candidate))
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail "Docker is required. Install Docker Desktop first."
}

try {
    docker info | Out-Null
} catch {
    Fail "Docker daemon is not running."
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
$Output = Resolve-OutputPath -Candidate $Output -ProjectRoot $RootDir

$OutDir = Split-Path -Parent $Output
$OutName = Split-Path -Leaf $Output

if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = (Get-Location).Path
    $Output = Join-Path $OutDir $OutName
}

if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

$OutDirAbs = (Resolve-Path $OutDir).Path
$ImageTag = "khy-iso-builder:latest"
$Dockerfile = Join-Path $RootDir "scripts\alpine\Dockerfile.iso-builder"

$BuildArgs = @("build", "-t", $ImageTag, "-f", $Dockerfile, $RootDir)
if ($NoCache) {
    $BuildArgs = @("build", "--no-cache", "-t", $ImageTag, "-f", $Dockerfile, $RootDir)
}

Info "Building Docker image ($ImageTag)..."
docker @BuildArgs
if ($LASTEXITCODE -ne 0) {
    Fail "Docker image build failed."
}

Info "Running ISO build container..."
$Volume = "{0}:/out" -f $OutDirAbs
$RunArgs = @(
    "run", "--rm", "--privileged",
    "-v", $Volume,
    $ImageTag,
    "--output", "/out/$OutName"
)

docker @RunArgs
if ($LASTEXITCODE -ne 0) {
    Fail "ISO build container failed."
}

if (-not (Test-Path -LiteralPath $Output)) {
    Fail "ISO build failed: output not found at $Output"
}

$IsoSize = (Get-Item -LiteralPath $Output).Length
$IsoSizeMB = [math]::Round($IsoSize / 1MB, 2)
Ok "ISO built: $Output ($IsoSizeMB MB)"
