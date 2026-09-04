# win-uia-tree.ps1 — khy-os Windows UI Automation tree extractor (DESIGN-ARCH-056).
#
# Emits a compact JSON array of the *visible* UI elements inside the focused
# window, one object per element:
#     { role, name, value, x, y, w, h, enabled }
# Coordinates are absolute screen pixels (BoundingRectangle), so the caller can
# derive a click center directly.
#
# Extracted from the previously inline-concatenated PowerShell string in
# backendRegistry.js: keeping it as a real .ps1 file avoids rebuilding the whole
# script on every inspect call and makes the UIA logic maintainable/testable.
#
# Self-window filter (-SelfPids "pid1,pid2,..."): if the focused window's owning
# process is one of the supplied PIDs (the khy terminal itself), emit a single
# sentinel {"__khySelfWindow":true,"name":...,"processId":...} instead of the
# window's elements, so the caller can skip/warn rather than scraping its own
# terminal UI.
#
# This script contains NO interpolated user data — it takes only numeric PIDs
# via a typed parameter, so it is injection-safe by construction.

param(
  [string]$SelfPids = '',
  [switch]$Desktop
)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$scope = $root

# Resolve the focused element and walk up to its owning Window so we scope the
# descendant scan to just that window (not the entire desktop).
try {
  $fe = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($fe) {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $cur = $fe
    while ($cur -ne $null -and $cur.Current.ControlType -ne [System.Windows.Automation.ControlType]::Window) {
      $cur = $walker.GetParent($cur)
    }
    if ($cur -ne $null) { $scope = $cur }
  }
} catch {}

# Self-window filter: if the focused window belongs to the khy terminal itself,
# emit a sentinel and bail out (do not scrape our own terminal's elements).
if ($SelfPids -and $scope -ne $root) {
  try {
    $pidList = @()
    foreach ($p in ($SelfPids -split ',')) {
      $n = 0
      if ([int]::TryParse($p.Trim(), [ref]$n)) { $pidList += $n }
    }
    if ($pidList.Count -gt 0) {
      $wpid = $scope.Current.ProcessId
      if ($pidList -contains $wpid) {
        $wname = $scope.Current.Name
        [pscustomobject]@{ __khySelfWindow = $true; name = $wname; processId = $wpid } | ConvertTo-Json -Compress
        exit 0
      }
    }
  } catch {}
}

# Collect visible (on-screen) descendants with a positive bounding rectangle.
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsOffscreenProperty, $false)
$els = $scope.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
$out = @()
foreach ($e in $els) {
  try {
    $r = $e.Current.BoundingRectangle
    if ($r.Width -le 0 -or $r.Height -le 0) { continue }
    $out += [pscustomobject]@{
      role = $e.Current.ControlType.ProgrammaticName
      name = $e.Current.Name
      value = ''
      x = [int]$r.X
      y = [int]$r.Y
      w = [int]$r.Width
      h = [int]$r.Height
      enabled = $e.Current.IsEnabled
    }
  } catch {}
}
$out | ConvertTo-Json -Compress
