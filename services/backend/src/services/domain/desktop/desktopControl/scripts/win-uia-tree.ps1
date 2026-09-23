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
# Window targeting (-TargetName "My Window"): scope the scan to that *top-level*
# window resolved from the desktop root. Without it the scan follows
# FocusedElement, which is not the window the caller just activated (SetForegroundWindow
# does not move UIA focus) — so an untargeted inspect silently reads whatever app
# happens to hold focus. When no top-level window matches, emit
# {"__khyTargetNotFound":true,"requested":...} so the caller fails honestly instead
# of handing back another application's elements.
#
# This script contains NO interpolated user data — it takes only numeric PIDs and a
# plain name via typed parameters, so it is injection-safe by construction.

param(
  [string]$SelfPids = '',
  [string]$TargetName = '',
  [switch]$Desktop
)

$ErrorActionPreference = 'SilentlyContinue'

# Emit UTF-8 bytes: PowerShell would otherwise encode redirected stdout with the console code
# page (cp936 on Chinese Windows) and every non-ASCII element name would reach Node as U+FFFD,
# which breaks name-based clickElement() on a Chinese UI. No BOM — it would break JSON.parse.
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}

Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$scope = $root

# Resolve the scan scope. Two mutually exclusive paths:
#  - -TargetName given → bind to that top-level window from the desktop root. This
#    is the honest path: the result can never belong to a different application.
#    A miss emits a sentinel rather than falling back to "whatever has focus".
#  - no target → walk up from FocusedElement to its owning Window (legacy: the
#    scan then covers the window the OS happens to consider focused).
if ($TargetName) {
  $found = $null
  try {
    $nameCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $TargetName)
    $found = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $nameCond)
  } catch {}
  # Substring fallback, matching the window backends (activate/close/list all match
  # by *title*, and the caller's names come from listWindows' MainWindowTitle).
  if (-not $found) {
    try {
      $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($w in $wins) {
        try {
          $wn = $w.Current.Name
          if ($wn -and $wn.IndexOf($TargetName, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $found = $w; break }
        } catch {}
      }
    } catch {}
  }
  if (-not $found) {
    [pscustomobject]@{ __khyTargetNotFound = $true; requested = $TargetName } | ConvertTo-Json -Compress
    exit 0
  }
  $scope = $found
} else {
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
}

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
