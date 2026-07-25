# @pattern Command
param(
  [Parameter(Mandatory = $true)]
  [string]$Version,

  [string]$PackageName = 'khy-os',
  [string]$IndexUrl = '',
  [string]$OwnerSecret = 'khy2026',
  [string]$WorkRoot = "$env:USERPROFILE\khy-release-work",

  [string]$PrivateRepo = 'git@github.com:Program-master-leader/KHY-OS.git',
  [string]$PublicRepo = 'git@github.com:Program-master-leader/khy_os.git',

  [switch]$SkipPublicDocTrim
)

$ErrorActionPreference = 'Stop'

function Ensure-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing command: $Name"
  }
}

function Ensure-GitIdentity {
  $userName = (git config --global user.name)
  $userEmail = (git config --global user.email)
  if (-not $userName -or -not $userEmail) {
    throw 'Please set git identity first: git config --global user.name "<name>" && git config --global user.email "<email>"'
  }
}

function Copy-DirectoryContent([string]$Source, [string]$Destination) {
  New-Item -Path $Destination -ItemType Directory -Force | Out-Null
  Copy-Item -Path (Join-Path $Source '*') -Destination $Destination -Recurse -Force
}

function Ensure-RequiredDirs([string]$RepoDir) {
  $required = @(
    'services/backend/models',
    'services/backend/ml/models',
    'apps/ai-frontend/node_modules',
    'platform/packages/shared/logs'
  )

  foreach ($rel in $required) {
    $full = Join-Path $RepoDir $rel
    New-Item -Path $full -ItemType Directory -Force | Out-Null
    $keep = Join-Path $full '.gitkeep'
    if (-not (Test-Path $keep)) {
      New-Item -Path $keep -ItemType File -Force | Out-Null
    }
  }
}

function Trim-PublicDocs([string]$RepoDir) {
  $cliGuide = Join-Path $RepoDir 'docs/指南/khy-os-用户指南-仅cli.md'
  if (-not (Test-Path $cliGuide)) {
    throw "Missing required public guide: $cliGuide"
  }

  $docsRoot = Join-Path $RepoDir 'docs'
  $tmpRoot = Join-Path $RepoDir '.tmp_public_docs'
  New-Item -Path (Join-Path $tmpRoot '指南') -ItemType Directory -Force | Out-Null

  Copy-Item -Path $cliGuide -Destination (Join-Path $tmpRoot '指南/khy-os-用户指南-仅cli.md') -Force

  Remove-Item -Path $docsRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -Path (Join-Path $docsRoot '指南') -ItemType Directory -Force | Out-Null

  @(
    '# KHY OS 文档（公开 CLI 版）',
    '',
    '- 用户指南（仅 CLI）: `docs/指南/khy-os-用户指南-仅cli.md`',
    '',
    '本公开文档集仅保留安装与 CLI 使用说明。'
  ) | Set-Content -Path (Join-Path $docsRoot '索引.md') -Encoding UTF8

  Copy-Item -Path (Join-Path $tmpRoot '指南/khy-os-用户指南-仅cli.md') -Destination (Join-Path $docsRoot '指南/khy-os-用户指南-仅cli.md') -Force

  Remove-Item -Path $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
}

function Init-Commit-Push(
  [string]$RepoDir,
  [string]$Branch,
  [string]$Tag,
  [string]$RemoteUrl,
  [string]$CommitMessage
) {
  Push-Location $RepoDir
  try {
    git init | Out-Null
    git checkout -b $Branch | Out-Null
    git add -A
    git commit -m $CommitMessage | Out-Null
    git remote add origin $RemoteUrl
    git push -u origin $Branch
    git tag -a $Tag -m $Tag
    git push origin $Tag
  } finally {
    Pop-Location
  }
}

Ensure-Command 'python'
Ensure-Command 'git'
Ensure-Command 'khy'
Ensure-GitIdentity

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runRoot = Join-Path $WorkRoot ("run-{0}-{1}" -f $Version, $stamp)
$exportDir = Join-Path $runRoot 'export'
$extractDir = Join-Path $runRoot 'extract'
$privateDir = Join-Path $runRoot 'repo-private'
$publicDir = Join-Path $runRoot 'repo-public'

New-Item -Path $exportDir -ItemType Directory -Force | Out-Null
New-Item -Path $extractDir -ItemType Directory -Force | Out-Null

Write-Host "Installing $PackageName==$Version ..."
python -m pip install --upgrade pip
if ([string]::IsNullOrWhiteSpace($IndexUrl)) {
  python -m pip install --upgrade "$PackageName==$Version"
} else {
  python -m pip install --upgrade --index-url $IndexUrl "$PackageName==$Version"
}

Write-Host 'Exporting origin code bundle ...'
khy publish origin-code --secret $OwnerSecret --out $exportDir

$zip = Get-ChildItem -Path $exportDir -Filter '*.zip' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $zip) {
  throw "No zip bundle found in $exportDir"
}

Expand-Archive -Path $zip.FullName -DestinationPath $extractDir -Force
$srcRoot = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1
if (-not $srcRoot) {
  throw "No extracted source folder found in $extractDir"
}

Write-Host 'Preparing private repository content ...'
Copy-DirectoryContent -Source $srcRoot.FullName -Destination $privateDir
Ensure-RequiredDirs -RepoDir $privateDir

Write-Host 'Preparing public repository content ...'
Copy-DirectoryContent -Source $srcRoot.FullName -Destination $publicDir
Ensure-RequiredDirs -RepoDir $publicDir
if (-not $SkipPublicDocTrim) {
  Trim-PublicDocs -RepoDir $publicDir
}

$privateBranch = "release/private-v$Version"
$publicBranch = "release/public-v$Version"
$privateTag = "v$Version-private"
$publicTag = "v$Version-public"

Write-Host "Pushing private repo: $PrivateRepo"
Init-Commit-Push `
  -RepoDir $privateDir `
  -Branch $privateBranch `
  -Tag $privateTag `
  -RemoteUrl $PrivateRepo `
  -CommitMessage "release: private v$Version"

Write-Host "Pushing public repo: $PublicRepo"
Init-Commit-Push `
  -RepoDir $publicDir `
  -Branch $publicBranch `
  -Tag $publicTag `
  -RemoteUrl $PublicRepo `
  -CommitMessage "release: public v$Version (CLI docs only)"

Write-Host ''
Write-Host 'Done.'
Write-Host "Private branch/tag: $privateBranch / $privateTag"
Write-Host "Public branch/tag : $publicBranch / $publicTag"
Write-Host "Workspace: $runRoot"
