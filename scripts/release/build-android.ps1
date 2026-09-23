#!/usr/bin/env pwsh
# khy-os Android signed-release builder (PowerShell, cross-platform).
#
# Builds the khy-os mobile app (apps/khy-os-client-app, Flutter) into a signed
# release APK + AAB, verifies the signature, and copies both into
# ./dist/android with a SHA-256 manifest.
#
# Signing precedence (handled by android/app/build.gradle):
#   1. KHY_ANDROID_* env vars (CI/CD)
#   2. android/key.properties (local dev, gitignored)
#   3. debug keystore fallback (build never breaks, but NOT Play-store-ready)
#
# Why a separate script (not part of publish-dual.sh): Android is a THIRD
# distribution channel with its own toolchain (JDK + Android SDK + Flutter +
# gradle). Wedging it into the pip/npm audit gate would let a missing Android
# SDK abort a perfectly good pip/npm publish. This script is fail-soft: a
# missing toolchain prints actionable guidance and exits non-zero without
# touching the dual-channel artifacts.
#
# Usage:
#   powershell -File scripts/release/build-android.ps1
#   powershell -File scripts/release/build-android.ps1 -AabOnly
#   powershell -File scripts/release/build-android.ps1 -ApkOnly
#   powershell -File scripts/release/build-android.ps1 -SkipBuild
#   $env:KHY_ANDROID_STORE_FILE='...' ; ... ; powershell -File scripts/release/build-android.ps1
#
# Notes (single-maintainer cheat sheet):
#   Local:    .\scripts\release\build-android.ps1
#   Artifacts: dist/android/app-release.apk + app-release.aab + SHA256SUMS.txt
#   If the script WARNS "DEBUG-signed": no release credentials were found;
#     the output is NOT Play-store-ready. Check android/key.properties or set
#     the KHY_ANDROID_* env vars, then re-run.

[CmdletBinding()]
param(
  [switch]$AabOnly,
  [switch]$ApkOnly,
  [switch]$SkipVerify,
  [switch]$SkipBuild,
  [string]$OutputDir,
  [string]$DistDir
)

$ErrorActionPreference = 'Stop'
# scripts/release/ -> up two levels = repo root.
$root = (Get-Item $PSScriptRoot).Parent.Parent.FullName
$appDir = Join-Path $root 'apps\khy-os-client-app'
$androidDir = Join-Path $appDir 'android'
$keyProps = Join-Path $androidDir 'key.properties'

if (-not $DistDir) { $DistDir = Join-Path $root 'dist\android' }
if (-not $OutputDir) { $OutputDir = $DistDir }

Write-Host ""
Write-Host "=== Locating Android toolchain ==="

function Say-Info([string]$m) { Write-Host "[INFO]  $m" -ForegroundColor Cyan }
function Say-Ok([string]$m) { Write-Host "[OK]    $m" -ForegroundColor Green }
function Say-Warn([string]$m) { Write-Host "[WARN]  $m" -ForegroundColor Yellow }
function Say-Fail([string]$m) {
  Write-Host "[FAIL]  $m" -ForegroundColor Red
  exit 1
}

# Run a native .bat/.exe and surface its real exit code. Native tool output
# (flutter/gradle warnings) goes to stderr and, under PowerShell's
# $ErrorActionPreference='Stop', would otherwise throw a NativeCommandError on
# benign warning text. Capture combined output via a child process that writes
# to a temp file, echo it, and read the child's real exit code. Returns ONLY
# the exit code; the captured output is written to $script:LastToolOutput for
# inspection on failure.
function Invoke-Tool([string[]]$cmd, [string]$workDir = '') {
  $exe = $cmd[0]
  $argStr = if ($cmd.Length -gt 1) { $cmd[1..($cmd.Length - 1)] -join ' ' } else { '' }
  $tmpOut = [System.IO.Path]::GetTempFileName()
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = $argStr
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $psi.CreateNoWindow = $true
  if ($workDir) { $psi.WorkingDirectory = $workDir }
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  $proc.Start() | Out-Null
  $stdoutTxt = $proc.StandardOutput.ReadToEnd()
  $stderrTxt = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  $code = $proc.ExitCode
  $script:LastToolOutput = ($stdoutTxt + "`n" + $stderrTxt).Trim()
  Remove-Item $tmpOut -ErrorAction SilentlyContinue
  if ($script:LastToolOutput) { Write-Host $script:LastToolOutput }
  return $code
}

$ErrorActionPreference = 'Stop'

# ── Flutter ───────────────────────────────────────────────────────────────────
$flutter = $env:FLUTTER
if (-not $flutter) {
  $cands = @(
    'D:\Portable\Tools\flutter\bin\flutter.bat',
    (Join-Path $HOME 'flutter\bin\flutter.bat')
  )
  $cmd = Get-Command flutter -ErrorAction SilentlyContinue
  if ($cmd) { $cands += $cmd.Source }
  foreach ($c in $cands) {
    if ($c -and (Test-Path $c)) { $flutter = $c; break }
  }
}
if (-not $flutter -or -not (Test-Path $flutter)) {
  Say-Fail "flutter not found. Set \$FLUTTER to the flutter executable, or add it to PATH."
}
Say-Ok "flutter: $flutter"

# ── JAVA_HOME ────────────────────────────────────────────────────────────────
if (-not $env:JAVA_HOME) {
  $jks = @(
    'D:\Portable\Tools\jdk-21.0.12.1+1',
    (Join-Path $HOME 'jdk-21')
  )
  foreach ($j in $jks) { if (Test-Path $j) { $env:JAVA_HOME = $j; break } }
}
if (-not $env:JAVA_HOME) {
  Say-Fail "JAVA_HOME not set and no JDK found. Set JAVA_HOME to a JDK 17+ install."
}
Say-Ok "JAVA_HOME: $($env:JAVA_HOME)"

# ── Android SDK ──────────────────────────────────────────────────────────────
$sdk = $env:ANDROID_SDK_ROOT
if (-not $sdk) { $sdk = $env:ANDROID_HOME }
if (-not $sdk) {
  $sdkCands = @(
    'D:\Portable\Tools\android-sdk',
    (Join-Path $HOME '.khyos\android_sdk')
  )
  foreach ($s in $sdkCands) { if (Test-Path $s) { $sdk = $s; break } }
}
if (-not $sdk -or -not (Test-Path $sdk)) {
  Say-Fail "Android SDK not found. Set ANDROID_SDK_ROOT to the SDK root."
}
$env:ANDROID_SDK_ROOT = $sdk
Say-Ok "ANDROID_SDK_ROOT: $sdk"

# apksigner: prefer the NEWEST build-tools that has it (newer apksigner
# understands v2/v3 signatures; older ones can fail to report them).
$apksigner = $null
$apksignerVer = ''
foreach ($bt in @('36.0.0','35.0.0','34.0.0')) {
  $exe = Join-Path $sdk "build-tools\$bt\apksigner.bat"
  if (Test-Path $exe) { $apksigner = $exe; $apksignerVer = $bt; break }
}

# ── Signing source detection ────────────────────────────────────────────────
function Read-Prop([string]$key) {
  if (Test-Path $keyProps) {
    $line = Select-String -Path $keyProps -Pattern "^$key=" | Select-Object -First 1
    if ($line) { return ($line.Line -replace "^$key=",'').Trim() }
  }
  return ''
}

$relStoreFile = if ($env:KHY_ANDROID_STORE_FILE) { $env:KHY_ANDROID_STORE_FILE } else { Read-Prop 'storeFile' }
$relStorePass = if ($env:KHY_ANDROID_STORE_PASSWORD) { $env:KHY_ANDROID_STORE_PASSWORD } else { Read-Prop 'storePassword' }
$relKeyAlias = if ($env:KHY_ANDROID_KEY_ALIAS) { $env:KHY_ANDROID_KEY_ALIAS } else { Read-Prop 'keyAlias' }
$relKeyPass = if ($env:KHY_ANDROID_KEY_PASSWORD) { $env:KHY_ANDROID_KEY_PASSWORD } else { Read-Prop 'keyPassword' }

$expectSigning = 'debug'
if ($relStoreFile) {
  $absStore = if ([System.IO.Path]::IsPathRooted($relStoreFile)) { $relStoreFile } else { Join-Path $androidDir $relStoreFile }
  if (Test-Path $absStore) {
    $expectSigning = 'release'
    $relStoreFile = $absStore
  } else {
    Say-Warn "release keystore not found at $absStore — the build will fall back to the DEBUG keystore (output NOT Play-store-ready)."
  }
} else {
  Say-Warn "no release signing credentials (env or key.properties) — output will be DEBUG-signed, NOT Play-store-ready."
}

# ── Build ─────────────────────────────────────────────────────────────────────
if (-not $SkipBuild) {
  Write-Host ""
  $buildLabel = if ($ApkOnly) { 'Building release APK' } elseif ($AabOnly) { 'Building release AAB' } else { 'Building release APK + AAB' }
  Write-Host "=== $buildLabel ==="
  if (-not $AabOnly) {
    $code = Invoke-Tool @($flutter, 'build', 'apk', '--release') $appDir
    if ($code -ne 0) { Say-Fail "flutter build apk --release failed (exit $code)" }
  }
  if (-not $ApkOnly) {
    $code = Invoke-Tool @($flutter, 'build', 'appbundle', '--release') $appDir
    if ($code -ne 0) { Say-Fail "flutter build appbundle --release failed (exit $code)" }
  }
  Say-Ok "gradle build complete"
} else {
  Write-Host ""
  Write-Host "=== Skipping build (-SkipBuild) ==="
}

# ── Locate built artifacts ──────────────────────────────────────────────────
function Find-First([string[]]$cands) {
  foreach ($c in $cands) { if (Test-Path $c) { return $c } }
  return $null
}

$apkPath = $null
$aabPath = $null

$apkCandidates = @(
  (Join-Path $appDir 'build\app\outputs\flutter-apk\app-release.apk'),
  (Join-Path $appDir 'build\app\outputs\apk\release\app-release.apk')
)
$aabCandidates = @(
  (Join-Path $appDir 'build\app\outputs\flutter-aab\app-release.aab'),
  (Join-Path $appDir 'build\app\outputs\bundle\release\app-release.aab')
)

if (-not $ApkOnly) {
  $apkPath = Find-First $apkCandidates
  if (-not $apkPath) { Say-Fail ("release APK not found in: {0}" -f ($apkCandidates -join ', ')) }
}
if (-not $AabOnly) {
  $aabPath = Find-First $aabCandidates
  if (-not $aabPath) { Say-Fail ("release AAB not found in: {0}" -f ($aabCandidates -join ', ')) }
}

# ── Verify signature ────────────────────────────────────────────────────────
if ($apkPath -and -not $SkipVerify) {
  Write-Host ""
  Write-Host "=== Verifying signature ==="
  if (-not $apksigner) {
    Say-Warn "apksigner not found in $sdk\build-tools — skipping signature check."
  } else {
    $certOut = & $apksigner verify --print-certs $apkPath 2>$null
    # apksigner's "Verifies" line only appears when v1 (JAR) scheme is also
    # used; a v2/v3-only APK still verifies (exit 0) but omits that word.
    # Treat "either Verifies OR a valid signer cert digest" as success.
    $verifies = ($certOut -match 'Verifies') -or ($certOut -match 'Signer #1 certificate SHA-256 digest')
    if (-not $verifies) {
      Say-Fail "APK signature verification failed (apksigner reported no valid signer):`n$certOut"
    }
    $sha256Line = ($certOut | Select-String 'Signer #1 certificate SHA-256 digest' | Select-Object -First 1).Line
    $scheme = if ($certOut -match 'Verified using v2') { 'v2' } elseif ($certOut -match 'Verified using v1') { 'v1' } else { 'unknown' }
    Say-Ok "signature valid ($scheme scheme). ${sha256Line.Trim()}"

    if ($expectSigning -eq 'release' -and $relStoreFile -and (Test-Path $relStoreFile)) {
      $keytool = Join-Path $env:JAVA_HOME 'bin\keytool'
      if (Test-Path $keytool) {
        # keytool prints a blank separator line before "SHA256: ..."; Select-String
        # will grab the first SHA256 match which belongs to the keystore's key.
        $keyShaRaw = & $keytool -list -v -keystore $relStoreFile -storepass $relStorePass 2>$null
        $keyShaLine = ($keyShaRaw | Select-String 'SHA256:' | Select-Object -First 1).Line
        Say-Info "cross-checking APK signer against $relStoreFile (keyAlias=$relKeyAlias)"
        if ($sha256Line -and $keyShaLine) {
          $apkSha = ($sha256Line -replace '.*SHA-256 digest:\s*','').Trim() -replace ':',''
          $keySha = ($keyShaLine -replace '.*SHA256:\s*','').Trim() -replace ':',''
          Say-Info "  APK signer  : $apkSha"
          Say-Info "  keystore key: $keySha"
          if ($apkSha -ne $keySha) {
            Say-Warn "APK signer does NOT match the release keystore ($relStoreFile) — it was signed by a DIFFERENT key. Do not upload to Play."
          } else {
            Say-Ok "APK signer matches the release keystore ($relStoreFile)"
          }
        } else {
          Say-Info "could not cross-check keystore fingerprint (keytool output unavailable) — verifying signature validity only."
        }
      }
    } elseif ($expectSigning -eq 'debug') {
      Say-Warn "output is DEBUG-signed (no release credentials found). This APK is NOT Play-store-ready; regenerate with release credentials for an upload."
    }
  }
}

# ── Collect into dist + SHA-256 manifest ────────────────────────────────────
Write-Host ""
Write-Host "=== Collecting artifacts to $OutputDir ==="
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$manifest = Join-Path $OutputDir 'SHA256SUMS.txt'
Set-Content -Path $manifest -Value '' -Encoding ascii

$artifacts = @()

if ($apkPath) {
  $dest = Join-Path $OutputDir 'app-release.apk'
  Copy-Item -Force $apkPath $dest
  $h = (Get-FileHash -Algorithm SHA256 $dest).Hash
  Add-Content -Path $manifest -Value ("{0}  app-release.apk" -f $h)
  $artifacts += $dest
  Say-Ok "APK -> $dest"
}
if ($aabPath) {
  $dest = Join-Path $OutputDir 'app-release.aab'
  Copy-Item -Force $aabPath $dest
  $h = (Get-FileHash -Algorithm SHA256 $dest).Hash
  Add-Content -Path $manifest -Value ("{0}  app-release.aab" -f $h)
  $artifacts += $dest
  Say-Ok "AAB -> $dest"
}
Say-Ok "SHA-256 manifest: $manifest"

# ── Summary ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Release artifacts ==="
foreach ($f in $artifacts) {
  $size = [math]::Round((Get-Item $f).Length / 1MB, 1)
  $sha = (Get-FileHash -Algorithm SHA256 $f).Hash.Substring(0, 16)
  Write-Host ("  {0,-18} {1,8} MB  sha256 {2}..." -f (Split-Path $f -Leaf), $size, $sha)
}

if ($expectSigning -eq 'debug') {
  Say-Warn "these artifacts are DEBUG-signed (no release keystore was found)."
  Say-Warn "to produce a Play-store-ready package, create android/key.properties + a release keystore, or set KHY_ANDROID_* env vars, then re-run this script."
} else {
  Say-Ok "artifacts are RELEASE-signed and ready for Play upload."
}
Say-Ok "done."
