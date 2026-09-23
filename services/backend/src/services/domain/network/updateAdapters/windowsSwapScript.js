'use strict';

/**
 * windowsSwapScript.js — the static PowerShell body for the deferred portable
 * swap/rollback choreography (Windows file-lock workaround).
 *
 * Pure constant split out of portableAdapter.js: every `$ParentPid`/`$Live`/
 * `$Incoming`/`$Backup`/`$Result` here is a PowerShell script *parameter*, not a
 * JS interpolation — the caller binds them on the powershell command line. Kept
 * isolated because it is a distinct concern (a different language) from the JS
 * adapter that spawns it, and to hold portableAdapter.js under the 400-line ceiling.
 */

const SWAP_SCRIPT_BODY = [
  'param([int]$ParentPid, [string]$Live, [string]$Incoming, [string]$Backup, [string]$Result)',
  '$ErrorActionPreference = "Stop"',
  'try { Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue } catch {}',
  'try {',
  '  $LiveExists = Test-Path -LiteralPath $Live',
  '  $BackupExists = Test-Path -LiteralPath $Backup',
  '  if ($LiveExists) {',
  '    if ($BackupExists) { Remove-Item -LiteralPath $Backup -Recurse -Force }',
  '    Move-Item -LiteralPath $Live -Destination $Backup',
  '  } elseif (-not $BackupExists) {',
  '    throw "Neither the active nor backup portable directory exists."',
  '  }',
  '  try { Move-Item -LiteralPath $Incoming -Destination $Live } catch {',
  '    Move-Item -LiteralPath $Backup -Destination $Live',
  '    throw',
  '  }',
  '  @{ success = $true; backup = $Backup; completedAt = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $Result -Encoding UTF8',
  '} catch {',
  '  @{ success = $false; error = $_.Exception.Message; completedAt = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $Result -Encoding UTF8',
  '}',
  'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
].join('\r\n');

module.exports = { SWAP_SCRIPT_BODY };
