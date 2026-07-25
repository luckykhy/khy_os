# @pattern Command
Param(
    [string]$Output = "dist\khy-os.iso",
    [int]$MinimumFreeGB = 15
)

$ErrorActionPreference = "Stop"

$Passes = New-Object System.Collections.Generic.List[string]
$Warnings = New-Object System.Collections.Generic.List[string]
$Failures = New-Object System.Collections.Generic.List[string]

function Info([string]$Message) {
    Write-Host "[INFO] $Message" -ForegroundColor Cyan
}

function Add-Pass([string]$Message) {
    $Passes.Add($Message)
    Write-Host "[OK]   $Message" -ForegroundColor Green
}

function Add-Warn([string]$Message) {
    $Warnings.Add($Message)
    Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Add-Fail([string]$Message) {
    $Failures.Add($Message)
    Write-Host "[FAIL] $Message" -ForegroundColor Red
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

Info "KHY OS Windows ISO preflight"

if ($env:OS -ne "Windows_NT") {
    Add-Fail "This script must run on Windows (Windows_NT)."
}

if ($PSVersionTable.PSVersion.Major -ge 5) {
    Add-Pass "PowerShell version: $($PSVersionTable.PSVersion)"
} else {
    Add-Fail "PowerShell 5+ is required."
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
$OutputPath = Resolve-OutputPath -Candidate $Output -ProjectRoot $RootDir
$OutDir = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

$RequiredFiles = @(
    (Join-Path $RootDir "scripts\alpine\build-iso-windows.ps1"),
    (Join-Path $RootDir "scripts\alpine\Dockerfile.iso-builder"),
    (Join-Path $RootDir "scripts\alpine\build-khy-os-iso.sh"),
    (Join-Path $RootDir "alpine\etc\init.d\khy-os-backend"),
    (Join-Path $RootDir "alpine\etc\init.d\khy-os-console")
)

$MissingFiles = @($RequiredFiles | Where-Object { -not (Test-Path -LiteralPath $_) })
if ($MissingFiles.Count -eq 0) {
    Add-Pass "Required build files exist."
} else {
    Add-Fail "Missing build files: $($MissingFiles -join ', ')"
}

$DockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if (-not $DockerCmd) {
    Add-Fail "Docker command not found. Install Docker Desktop."
} else {
    Add-Pass "Docker command found: $($DockerCmd.Source)"

    try {
        docker info | Out-Null
        Add-Pass "Docker daemon is running."
    } catch {
        Add-Fail "Docker daemon is not running. Start Docker Desktop first."
    }

    try {
        $ServerVersion = (docker version --format '{{.Server.Version}}' 2>$null).Trim()
        if ([string]::IsNullOrWhiteSpace($ServerVersion)) {
            Add-Warn "Unable to read Docker server version."
        } else {
            Add-Pass "Docker server version: $ServerVersion"
        }
    } catch {
        Add-Warn "Unable to query Docker server version."
    }
}

$WslCmd = Get-Command wsl -ErrorAction SilentlyContinue
if (-not $WslCmd) {
    Add-Warn "WSL command not found. Docker Desktop may still work with Hyper-V mode, but WSL2 backend is recommended."
} else {
    try {
        $WslVersionOutput = (wsl --version 2>$null)
        if ($LASTEXITCODE -eq 0 -and $WslVersionOutput) {
            Add-Pass "WSL is available."
        } else {
            Add-Warn "WSL is installed but version info is unavailable."
        }
    } catch {
        Add-Warn "Unable to read WSL status."
    }
}

try {
    $System = Get-CimInstance Win32_ComputerSystem
    if ($System.HypervisorPresent) {
        Add-Pass "Hypervisor support detected."
    } else {
        Add-Warn "HypervisorPresent is false. Confirm virtualization is enabled in BIOS/UEFI."
    }
} catch {
    Add-Warn "Unable to query hypervisor status."
}

try {
    $OutDrive = Get-Item -LiteralPath $OutDir
    $DriveName = $OutDrive.PSDrive.Name
    $DriveInfo = Get-PSDrive -Name $DriveName
    $FreeGB = [math]::Round($DriveInfo.Free / 1GB, 2)
    if ($FreeGB -ge $MinimumFreeGB) {
        Add-Pass "Free space on drive $DriveName`: $FreeGB GB (>= $MinimumFreeGB GB)."
    } else {
        Add-Fail "Free space on drive $DriveName is only $FreeGB GB (< $MinimumFreeGB GB)."
    }
} catch {
    Add-Warn "Unable to check free disk space for output path."
}

Info "Output ISO path: $OutputPath"

Write-Host ""
Write-Host "Summary" -ForegroundColor Cyan
Write-Host "  Pass   : $($Passes.Count)"
Write-Host "  Warning: $($Warnings.Count)"
Write-Host "  Fail   : $($Failures.Count)"

if ($Failures.Count -gt 0) {
    Write-Host ""
    Write-Host "Preflight failed. Fix failures before running ISO build." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Preflight passed. Next command:" -ForegroundColor Green
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\alpine\build-iso-windows.ps1 -Output $OutputPath"
exit 0
