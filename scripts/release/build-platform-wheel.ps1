# @pattern Command, Template Method
Param(
  [switch]$UsePyPABuild
)

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..' '..')
Set-Location $Root

function Resolve-PythonCommand {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    return @{ Cmd = 'py'; Args = @('-3') }
  }
  if (Get-Command python -ErrorAction SilentlyContinue) {
    return @{ Cmd = 'python'; Args = @() }
  }
  throw 'Missing python launcher: expected `py` or `python` in PATH.'
}

$Py = Resolve-PythonCommand

if (Test-Path dist) { Remove-Item dist -Recurse -Force }
if (Test-Path build) { Remove-Item build -Recurse -Force }
if (Test-Path khy_os.egg-info) { Remove-Item khy_os.egg-info -Recurse -Force }

# Default path is offline-friendly and avoids isolated build env dependency resolution.
& $Py.Cmd @($Py.Args + @('setup.py', 'sdist', 'bdist_wheel'))

if ($UsePyPABuild) {
  if (Test-Path dist) { Remove-Item dist -Recurse -Force }
  if (Test-Path build) { Remove-Item build -Recurse -Force }
  if (Test-Path khy_os.egg-info) { Remove-Item khy_os.egg-info -Recurse -Force }
  & $Py.Cmd @($Py.Args + @('-m', 'build', '--no-isolation', '--sdist', '--wheel'))
}

Write-Host "`nBuilt artifacts:" -ForegroundColor Cyan
Get-ChildItem dist | Select-Object Name, Length, LastWriteTime
