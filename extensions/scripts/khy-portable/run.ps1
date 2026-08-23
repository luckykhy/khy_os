#Requires -Version 5.1
<#
.SYNOPSIS
    Khy-OS portable development launcher for Windows.
.DESCRIPTION
    Resolves the project from this script, provisions a verified Node runtime
    under .khy/node, and keeps runtime state and package caches in the project.
.PARAMETER Command
    npm script to run, or install/shell (default: dev).
.PARAMETER Workspace
    Optional npm workspace name.
.PARAMETER RuntimeRoot
    Optional directory containing node.exe or a provisioned Node tree.
.PARAMETER NodeVersion
    Exact Node.js version (default: 22.12.0).
#>
param(
    [string]$Command = "dev",
    [string]$Workspace = "",
    [string]$RuntimeRoot = "",
    [string]$NodeVersion = "22.12.0"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$DataHome = Join-Path $ProjectRoot ".khy"
$NodeHome = Join-Path $DataHome "node"
$VersionRoot = Join-Path $NodeHome "v$($NodeVersion.TrimStart('v'))"
$NodeVersion = $NodeVersion.TrimStart('v')
$AssetStem = "node-v$NodeVersion-win-x64"
$AssetName = "$AssetStem.zip"

function Test-NodeRuntime([string]$Directory) {
    if (-not $Directory) { return $false }
    $Executable = Join-Path $Directory "node.exe"
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $false }
    try {
        $Reported = (& $Executable --version 2>$null).Trim()
        return $Reported -eq "v$NodeVersion"
    }
    catch { return $false }
}

function Find-NodeRuntime {
    $Candidates = @()
    if ($RuntimeRoot) {
        $Candidates += $RuntimeRoot
        $Candidates += (Join-Path $RuntimeRoot $AssetStem)
        $Candidates += (Join-Path (Join-Path $RuntimeRoot "node") "v$NodeVersion\$AssetStem")
    }
    $Candidates += (Join-Path $VersionRoot $AssetStem)
    $Candidates += $VersionRoot
    foreach ($Candidate in $Candidates) {
        if (Test-NodeRuntime $Candidate) { return $Candidate }
    }
    return $null
}

function Install-NodeRuntime {
    New-Item -ItemType Directory -Path $VersionRoot -Force | Out-Null
    $TempRoot = Join-Path $DataHome "tmp\node-download"
    New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
    $Archive = Join-Path $TempRoot $AssetName
    $SumsFile = Join-Path $TempRoot "SHASUMS256.txt"
    $BaseUrl = "https://nodejs.org/dist/v$NodeVersion"

    Write-Host "  Downloading Node.js v$NodeVersion..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri "$BaseUrl/$AssetName" -OutFile $Archive -UseBasicParsing
    Invoke-WebRequest -Uri "$BaseUrl/SHASUMS256.txt" -OutFile $SumsFile -UseBasicParsing

    $ExpectedLine = Get-Content -LiteralPath $SumsFile | Where-Object {
        $_ -match "^[0-9a-fA-F]{64}\s+\*?$([regex]::Escape($AssetName))$"
    } | Select-Object -First 1
    if (-not $ExpectedLine) { throw "Node checksum entry missing for $AssetName" }
    $Expected = ($ExpectedLine -split '\s+')[0].ToLowerInvariant()
    $Actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) { throw "Node archive SHA-256 mismatch" }

    $Extracted = Join-Path $VersionRoot $AssetStem
    if (Test-Path -LiteralPath $Extracted) {
        Remove-Item -LiteralPath $Extracted -Recurse -Force -Confirm:$false
    }
    Expand-Archive -LiteralPath $Archive -DestinationPath $VersionRoot -Force
    Remove-Item -LiteralPath $Archive, $SumsFile -Force -Confirm:$false
    if (-not (Test-NodeRuntime $Extracted)) {
        throw "Provisioned Node runtime did not report v$NodeVersion"
    }
    return $Extracted
}

function Install-Dependencies([string]$NodeDir) {
    Write-Host "[dependencies] npm install --install-links" -ForegroundColor Yellow
    Push-Location $ProjectRoot
    try {
        & (Join-Path $NodeDir "npm.cmd") install --install-links
        if ($LASTEXITCODE -ne 0) { throw "npm install exited with code $LASTEXITCODE" }
    }
    finally { Pop-Location }
}

Write-Host "[portable] Starting Khy-OS from $ProjectRoot" -ForegroundColor Cyan
$NodeDir = Find-NodeRuntime
if (-not $NodeDir) { $NodeDir = Install-NodeRuntime }
Write-Host "  Node runtime: $NodeDir" -ForegroundColor DarkGray

New-Item -ItemType Directory -Path $DataHome -Force | Out-Null
$env:KHY_PORTABLE_ROOT = $ProjectRoot
$env:KHYQUANT_PORTABLE_ROOT = $ProjectRoot
$env:KHY_OS_ROOT = $ProjectRoot
$env:KHY_DATA_HOME = $DataHome
$env:KHY_PROJECT_DATA_HOME = $DataHome
$env:KHYQUANT_DATA_HOME = $DataHome
$env:KHY_LOG_HOME = Join-Path $DataHome "logs"
$env:KHY_TEMP_HOME = Join-Path $DataHome "tmp"
$env:npm_config_cache = Join-Path $DataHome "cache\npm"
$env:PIP_CACHE_DIR = Join-Path $DataHome "cache\pip"
$env:PATH = "$NodeDir;$env:PATH"

if ((Test-Path -LiteralPath (Join-Path $ProjectRoot "package.json")) -and
    -not (Test-Path -LiteralPath (Join-Path $ProjectRoot "node_modules"))) {
    Install-Dependencies $NodeDir
}

Push-Location $ProjectRoot
try {
    switch ($Command) {
        "shell" {
            Write-Host "[shell] Portable Node environment active. Type exit to return." -ForegroundColor Cyan
            powershell.exe -NoExit -Command "Set-Location -LiteralPath '$($ProjectRoot.Replace("'", "''"))'"
        }
        "install" { Install-Dependencies $NodeDir }
        default {
            $Arguments = @("run", $Command)
            if ($Workspace) { $Arguments += "--workspace=$Workspace" }
            & (Join-Path $NodeDir "npm.cmd") @Arguments
            exit $LASTEXITCODE
        }
    }
}
finally { Pop-Location }
