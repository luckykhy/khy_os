'use strict';

/**
 * platformCapabilities.js — Startup-time platform capability probing.
 *
 * Probes for available tools (git, rg, grep, python, etc.) once at startup
 * and caches results. Consumed by tool fallback logic and system prompt
 * generation to inform the model about available capabilities.
 *
 * Phase R2-5B: Learned from OC's shell detection + CC's cross-platform utils.
 * Dependencies: child_process (execFileSync).
 */

const { searchExecutable } = require('../tools/platformUtils');
const { resolvePlatformLabel } = require('../constants/nodePlatformLabel');

let _probed = false;
const _caps = {
  platform: process.platform,          // 'darwin' | 'linux' | 'win32'
  arch: process.arch,                   // 'arm64' | 'x64' | ...
  shell: null,                          // detected default shell
  hasGit: false,
  hasRg: false,                         // ripgrep
  hasGrep: false,
  hasPython: false,
  pythonBin: null,                      // 'python3' | 'python' | null
  hasNode: true,                        // always true (we're running on it)
  hasBrew: false,                       // macOS package manager
  hasCurl: false,
  hasWget: false,
  hasPbcopy: false,                     // macOS clipboard
  hasXclip: false,                      // Linux clipboard
  hasPwsh: false,                       // PowerShell Core 7+
  hasDocker: false,
};

/**
 * Check if a binary is available via which/where.
 * Delegates to the single cross-platform resolver in platformUtils.
 * @param {string} bin
 * @returns {boolean}
 */
function _hasBin(bin) {
  return searchExecutable(bin) !== null;
}

/**
 * Probe platform capabilities. Runs once, caches results.
 * Non-blocking in terms of errors — every check is best-effort.
 */
function probe() {
  if (_probed) return _caps;
  _probed = true;

  // Shell detection
  if (process.platform === 'win32') {
    _caps.shell = _hasBin('pwsh') ? 'pwsh' : 'powershell';
    _caps.hasPwsh = _hasBin('pwsh');
  } else {
    _caps.shell = process.env.SHELL || '/bin/bash';
  }

  // Tool availability
  _caps.hasGit = _hasBin('git');
  _caps.hasRg = _hasBin('rg');
  _caps.hasGrep = _hasBin('grep');
  _caps.hasCurl = _hasBin('curl');
  _caps.hasWget = _hasBin('wget');
  _caps.hasDocker = _hasBin('docker');

  // Python detection (prefer python3)
  if (_hasBin('python3')) {
    _caps.hasPython = true;
    _caps.pythonBin = 'python3';
  } else if (_hasBin('python')) {
    _caps.hasPython = true;
    _caps.pythonBin = 'python';
  }

  // Platform-specific tools
  if (process.platform === 'darwin') {
    _caps.hasBrew = _hasBin('brew');
    _caps.hasPbcopy = _hasBin('pbcopy');
  } else if (process.platform !== 'win32') {
    _caps.hasXclip = _hasBin('xclip');
  }

  return _caps;
}

/**
 * Get cached capabilities (probes on first call).
 * @returns {typeof _caps}
 */
function getCapabilities() {
  if (!_probed) probe();
  return { ..._caps };
}

/**
 * Build per-OS "optimal path" guidance for the system prompt.
 *
 * This is the capability layer that lets khy genuinely leverage the host OS:
 * each branch names the tools/paths to PREFER on that platform and the
 * assumptions to avoid — grounded in the real capability probe, so a tool is
 * only recommended when it is actually present (no brew advice on a box without
 * brew). It is intentionally GUIDANCE ONLY: it shapes which commands khy reaches
 * for, not the shape of khy's answer (no mandated output markers).
 *
 * The Windows branch deliberately mirrors the long-standing cmd.exe translation
 * rules previously inlined in prompts.getEnvironmentSection() so that behavior is
 * preserved verbatim while the other branches gain symmetric guidance.
 *
 * @param {string} [platformOverride] - force a branch ('win32'|'linux'|'darwin'
 *   |other) instead of the probed platform; for tests only. Tool-presence checks
 *   still reflect the real host, so override the platform of a host whose tools
 *   you do not depend on in the assertion.
 * @returns {string[]} guidance lines (already platform-selected), or [] when the
 *   platform is unrecognized and no generic guidance applies.
 */
function branchGuidance(platformOverride) {
  if (!_probed) probe();
  const p = platformOverride || _caps.platform;
  const have = (cond, line) => (cond ? [line] : []);

  if (p === 'win32') {
    // Preserve the exact Windows rules khy has always injected — but PowerShell-aware:
    // when the target shell is a PowerShell family (KHY_SHELL override / COMSPEC →
    // powershell·pwsh) the chain rule teaches `;`/`if ($?)` instead of `&&` (PS 5.1
    // has no `&&`). Default cmd context is byte-identical to before. fail-soft.
    let winRuleLines;
    try {
      winRuleLines = require('../constants/shellChainStyle').windowsRuleLines(process.env);
    } catch {
      winRuleLines = [
        'You are running on Windows. Shell commands execute via cmd.exe. You MUST:',
        '- Use `mkdir` without `-p` flag (cmd.exe mkdir creates intermediate dirs automatically)',
        '- Use `type` instead of `cat`, `dir` instead of `ls`, `copy` instead of `cp`, `move` instead of `mv`, `del` instead of `rm`',
        '- Use `2>NUL` instead of `2>/dev/null`',
        '- Use backslash `\\` for paths or quoted forward slash paths',
        '- Use `&&` to chain commands (same as bash)',
        '- Do NOT use bash-only syntax: `$()`, `|&`, `{..}`, process substitution, heredoc',
        '- For multi-line file creation, use PowerShell `Set-Content` or the Write tool instead of `cat <<EOF`',
        '- Prefer using the Write/Edit tools for file creation instead of shell redirects',
      ];
    }
    return [
      '## Windows Platform Rules (CRITICAL)',
      ...winRuleLines,
      '',
      '## Windows Optimal Path',
      `- Prefer ${_caps.hasPwsh ? 'PowerShell 7 (pwsh)' : 'PowerShell'} for structured/system tasks; cmd.exe for simple chaining.`,
      '- Native strengths: Windows service management (sc / Get-Service), registry, Office automation, .exe packaging.',
      ...have(_hasBin('wsl'), '- WSL is available — use it for Linux-only toolchains when a native Windows path does not exist.'),
      '- Avoid: assuming bash/zsh is present; never use `sudo`.',
    ];
  }

  if (p === 'linux') {
    const pkg = _hasBin('apt-get') ? 'apt'
      : _hasBin('dnf') ? 'dnf'
        : _hasBin('yum') ? 'yum'
          : _hasBin('pacman') ? 'pacman' : null;
    return [
      '## Linux Optimal Path',
      '- Prefer bash for shell work; POSIX coreutils (ls/cat/cp/mv/rm, grep, sed, awk) are the native path.',
      ...have(_hasBin('systemctl'), '- Service orchestration: use `systemctl` for units; `journalctl` for log analysis.'),
      ...have(!!pkg, `- Package management: use \`${pkg}\` (the detected package manager).`),
      ...have(_hasBin('crontab'), '- Scheduling: use `cron`/`crontab` for recurring jobs.'),
      ...have(_caps.hasDocker, '- Containerization/isolation: `docker` is available.'),
      '- Native strengths: service orchestration, containerized deploys, package management, permission/log analysis.',
      '- Avoid: assuming a GUI is present; do not use Windows registry operations or `systemctl` syntax unavailable here.',
    ];
  }

  if (p === 'darwin') {
    return [
      '## macOS Optimal Path',
      '- Prefer zsh/bash; BSD coreutils differ subtly from GNU (e.g. `sed -i`, `date` flags) — account for that.',
      '- Service management: use `launchctl` (launchd), not `systemctl`.',
      ...have(_caps.hasBrew, '- Package management: use Homebrew (`brew` / `brew services`).'),
      ...have(_hasBin('xcrun') || _hasBin('xcodebuild'), '- Build/sign: Xcode toolchain (`xcrun`, `xcodebuild`, `codesign`) is available.'),
      ...have(_caps.hasPbcopy, '- Clipboard: `pbcopy`/`pbpaste`.'),
      '- Native strengths: app signing, dmg packaging, AppleScript automation, Xcode toolchain.',
      '- Avoid: assuming `systemctl`; do not use Windows service management.',
    ];
  }

  // Unrecognized platform → cross-platform generic guidance only.
  const generic = [
    '## Cross-Platform Path (unrecognized OS)',
    '- Platform fingerprint is unknown; prefer portable tooling and do not assume OS-specific commands.',
  ];
  if (_caps.hasPython) generic.push(`- Use ${_caps.pythonBin} for portable scripting.`);
  generic.push('- Use Node.js (already present) and, where available, Docker / generic REST APIs for portability.');
  return generic;
}

/**
 * Generate a one-line summary for system prompts.
 * @returns {string}
 */
function toSystemPromptLine() {
  if (!_probed) probe();
  const tools = [];
  if (_caps.hasGit) tools.push('git');
  if (_caps.hasRg) tools.push('rg');
  if (_caps.hasPython) tools.push(_caps.pythonBin);
  if (_caps.hasDocker) tools.push('docker');
  if (_caps.hasCurl) tools.push('curl');
  const platform = resolvePlatformLabel(_caps.platform);
  return `Platform: ${platform} ${_caps.arch}, Shell: ${_caps.shell}, Tools: ${tools.join(', ') || 'basic'}`;
}

module.exports = {
  probe,
  getCapabilities,
  toSystemPromptLine,
  branchGuidance,
};
