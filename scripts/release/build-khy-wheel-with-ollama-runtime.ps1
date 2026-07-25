# @pattern Command, Template Method
Param(
  [Parameter(Mandatory = $true)]
  [string]$OllamaSource,

  [ValidateSet('amd64', 'arm64')]
  [string]$Arch = 'amd64',

  [string[]]$OllamaBuildSteps = @('cpu', 'ollama'),

  [switch]$IncludeDeps,
  [switch]$UsePyPABuild,
  [switch]$KeepWorkDir
)

$ErrorActionPreference = 'Stop'

function Ensure-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing command: $Name"
  }
}

function Resolve-PythonCommand {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    return @{ Cmd = 'py'; Args = @('-3') }
  }
  if (Get-Command python -ErrorAction SilentlyContinue) {
    return @{ Cmd = 'python'; Args = @() }
  }
  throw 'Missing python launcher: expected `py` or `python` in PATH.'
}

function Resolve-AbsolutePath([string]$InputPath) {
  if (Test-Path $InputPath) {
    return (Resolve-Path $InputPath).Path
  }
  throw "Path not found: $InputPath"
}

function Ensure-Path([string]$Path, [string]$Message) {
  if (-not (Test-Path $Path)) {
    throw "$Message`nMissing path: $Path"
  }
}

function Ensure-File([string]$Path, [string]$Message) {
  if (-not (Test-Path $Path -PathType Leaf)) {
    throw "$Message`nMissing file: $Path"
  }
}

function Ensure-Directory([string]$Path, [string]$Message) {
  if (-not (Test-Path $Path -PathType Container)) {
    throw "$Message`nMissing directory: $Path"
  }
}

function Resolve-OllamaDistArch([string]$SourceArch) {
  switch ($SourceArch.ToLowerInvariant()) {
    'amd64' { return 'amd64' }
    'arm64' { return 'arm64' }
    default { throw "Unsupported architecture: $SourceArch" }
  }
}

function Test-OllamaRuntimeRoot([string]$CandidatePath) {
  if (-not (Test-Path $CandidatePath -PathType Container)) { return $false }
  $exe = Join-Path $CandidatePath 'ollama.exe'
  $lib = Join-Path $CandidatePath 'lib/ollama'
  return (Test-Path $exe -PathType Leaf) -and (Test-Path $lib -PathType Container)
}

function Find-OllamaRuntimeRoot([string]$BaseDir, [string]$DistArch) {
  $candidates = @(
    (Join-Path $BaseDir ("dist/windows-{0}" -f $DistArch)),
    (Join-Path $BaseDir ("windows-{0}" -f $DistArch)),
    $BaseDir
  )

  foreach ($c in $candidates) {
    if (Test-OllamaRuntimeRoot $c) { return $c }
  }

  # Fallback: recursively locate ollama.exe and verify sibling lib/ollama.
  $exeHits = Get-ChildItem -Path $BaseDir -Filter 'ollama.exe' -Recurse -File -ErrorAction SilentlyContinue
  foreach ($hit in $exeHits) {
    $root = $hit.DirectoryName
    if (Test-OllamaRuntimeRoot $root) { return $root }
  }

  return $null
}

$Py = Resolve-PythonCommand

$Root = Resolve-Path (Join-Path $PSScriptRoot '..' '..')
$BuildWheelScript = Join-Path $Root 'scripts/release/build-platform-wheel.ps1'
Ensure-File $BuildWheelScript 'Missing wheel build helper script.'

$workRoot = Join-Path $Root '.tmp/ollama-runtime-build'
New-Item -Path $workRoot -ItemType Directory -Force | Out-Null
$workDir = Join-Path $workRoot (Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -Path $workDir -ItemType Directory -Force | Out-Null

$sourceResolved = Resolve-AbsolutePath $OllamaSource
$inputRoot = ''

if ([IO.Path]::GetExtension($sourceResolved).ToLowerInvariant() -eq '.zip') {
  Write-Host "[1/5] Extracting Ollama source zip ..." -ForegroundColor Cyan
  $extractDir = Join-Path $workDir 'ollama-src'
  Expand-Archive -Path $sourceResolved -DestinationPath $extractDir -Force
  $dirs = Get-ChildItem -Path $extractDir -Directory
  if ($dirs.Count -eq 1) {
    $inputRoot = $dirs[0].FullName
  } else {
    $rootGuess = Join-Path $extractDir 'ollama-main'
    if (Test-Path $rootGuess -PathType Container) {
      $inputRoot = $rootGuess
    } else {
      $inputRoot = $extractDir
    }
  }
} else {
  $inputRoot = $sourceResolved
}

$distArch = Resolve-OllamaDistArch $Arch
$buildScript = Join-Path $inputRoot 'scripts/build_windows.ps1'
$runtimeRoot = $null

if (Test-Path $buildScript -PathType Leaf) {
  # Source build path requires toolchain.
  Ensure-Command 'go'
  Ensure-Command 'cmake'

  $steps = @()
  $steps += $OllamaBuildSteps
  if ($IncludeDeps -and -not ($steps -contains 'deps')) {
    $steps += 'deps'
  }

  Write-Host "[2/5] Building Ollama runtime from source ..." -ForegroundColor Cyan
  Write-Host ("        source={0}" -f $inputRoot)
  Write-Host ("        steps ={0}" -f ($steps -join ', '))
  Push-Location $inputRoot
  try {
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build_windows.ps1 @steps
    if ($LASTEXITCODE -ne 0) {
      throw "Ollama runtime build failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
  $runtimeRoot = Join-Path $inputRoot ("dist/windows-{0}" -f $distArch)
} else {
  Write-Host "[2/5] Using prebuilt Ollama runtime package ..." -ForegroundColor Cyan
  Write-Host ("        source={0}" -f $inputRoot)
  $runtimeRoot = Find-OllamaRuntimeRoot -BaseDir $inputRoot -DistArch $distArch
  if (-not $runtimeRoot) {
    throw @"
Unable to locate prebuilt Ollama runtime root.
Expected layout (any one):
1) <root>/ollama.exe + <root>/lib/ollama/*
2) <root>/dist/windows-$distArch/ollama.exe + lib/ollama/*
Given source: $inputRoot
"@
  }
}

$runtimeExe = Join-Path $runtimeRoot 'ollama.exe'
$runtimeLib = Join-Path $runtimeRoot 'lib/ollama'
Ensure-File $runtimeExe 'Ollama runtime output is incomplete.'
Ensure-Directory $runtimeLib 'Ollama runtime output is incomplete.'

# Optional warning for obviously minimal / incomplete runtimes.
$ggmlMarkers = Get-ChildItem -Path $runtimeLib -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'ggml|llama|cuda|rocm|vulkan' }
if (-not $ggmlMarkers) {
  Write-Warning "Runtime package may be incomplete: no ggml/llama/cuda/rocm/vulkan markers found under lib/ollama."
}

$khyRunnerBin = Join-Path $Root 'services/backend/bin/ollama-runner/bin'
$khyRunnerLib = Join-Path $Root 'services/backend/bin/ollama-runner/lib/ollama'

Write-Host "[3/5] Syncing runtime into KHY services/backend/bin/ollama-runner ..." -ForegroundColor Cyan
New-Item -Path $khyRunnerBin -ItemType Directory -Force | Out-Null
New-Item -Path $khyRunnerLib -ItemType Directory -Force | Out-Null

# Clean old runtime payload to avoid mixed-version DLL sets.
Get-ChildItem -Path $khyRunnerBin -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path $khyRunnerLib -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Copy-Item -Path $runtimeExe -Destination (Join-Path $khyRunnerBin 'ollama.exe') -Force
Copy-Item -Path (Join-Path $runtimeLib '*') -Destination $khyRunnerLib -Recurse -Force

Write-Host "[4/5] Building KHY platform wheel ..." -ForegroundColor Cyan
Push-Location $Root
try {
  if ($UsePyPABuild) {
    & $BuildWheelScript -UsePyPABuild
  } else {
    & $BuildWheelScript
  }
  if ($LASTEXITCODE -ne 0) {
    throw "KHY wheel build failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

$distDir = Join-Path $Root 'dist'
$wheel = Get-ChildItem -Path $distDir -Filter '*.whl' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$sdist = Get-ChildItem -Path $distDir -Filter '*.tar.gz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1

Write-Host "[5/5] Done." -ForegroundColor Green
if ($wheel) {
  Write-Host ("Wheel : {0}" -f $wheel.FullName)
}
if ($sdist) {
  Write-Host ("Sdist : {0}" -f $sdist.FullName)
}

if (-not $KeepWorkDir) {
  Remove-Item -Path $workDir -Recurse -Force -ErrorAction SilentlyContinue
} else {
  Write-Host ("WorkDir: {0}" -f $workDir) -ForegroundColor Yellow
}
