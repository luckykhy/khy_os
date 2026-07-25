'use strict';

/**
 * shellChainStyle.js — 纯叶子:PowerShell 感知的「命令串接」措辞单一真源。
 *
 * 背景:khy 在多处教模型「用 `&&` 串接命令」(BashTool 描述、系统提示词 Windows
 * 规则块、platformCapabilities 分支指引)。但 **Windows PowerShell 5.1 不支持
 * `&&`/`||`**(仅 PowerShell 7+ 支持)——所以当用户在 PowerShell 里运行 khy 建议的
 * `pip install x && khy --version` 时会报「'&&' 不是有效语句分隔符」。本叶子把「据
 * 目标 shell 选择串接措辞」收敛为唯一真源:目标是 PowerShell 家族时,改用 `;`(顺序)
 * 与 `if ($?) { next }`(仅成功才继续),并注明 `&&` 需要 PowerShell 7+;其余 shell
 * (cmd/bash/sh)逐字节沿用今天的 `&&` 文案。
 *
 * 目标 shell 的判定(仅读 env,零 IO):
 *   1. 显式覆盖 `KHY_SHELL`(powershell|pwsh|cmd|bash|sh)——用户拍板,最高优先。
 *   2. `COMSPEC` 以 powershell.exe / pwsh.exe 结尾 → PowerShell 家族。
 *   3. 否则未知(返回 null)——调用方在 Windows 语境里兜底为 cmd(即 legacy `&&`)。
 * 这样默认 Windows(COMSPEC=cmd、未设 KHY_SHELL)逐字节回退,零行为漂移。
 *
 * 契约(纯叶子):零 IO、确定性、绝不抛、单一真源、无副作用。
 * 逃生阀 `KHY_POWERSHELL_CHAIN_STYLE`(默认 on)。**关闭即字节回退**:所有构建器
 * 返回与改动前逐字节相同的 cmd/bash 文案,`parseExecOverride()` 返回 null(不改
 * khy 实际 spawn 的 shell)。
 */

/** 门控:仅当显式置为 0/false/off/no 时关闭,其余(含未设)均开启。 */
function isEnabled(env) {
  const raw = String((env || process.env).KHY_POWERSHELL_CHAIN_STYLE || 'on')
    .trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

// KHY_SHELL 显式覆盖 → 归一化 token(与 getShellConfiguration 的 shell 家族对齐)。
function _normalizeOverrideToken(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  if (['powershell', 'powershell.exe', 'windows powershell', 'winps', 'ps'].includes(v)) return 'powershell';
  if (['pwsh', 'pwsh.exe', 'powershell7', 'pwsh7', 'ps7', 'powershell-core'].includes(v)) return 'pwsh';
  if (['cmd', 'cmd.exe', 'command', 'comspec'].includes(v)) return 'cmd';
  if (['bash', 'gitbash', 'git-bash', 'msys', 'mingw'].includes(v)) return 'bash';
  if (['sh', 'posix', 'dash'].includes(v)) return 'sh';
  return null;
}

/**
 * 解析目标 shell 家族(仅供「措辞」用),不触发实际 spawn。
 * @returns {'powershell'|'pwsh'|'cmd'|null}
 */
function resolveFamily(env) {
  const e = env || process.env;
  const override = _normalizeOverrideToken(e.KHY_SHELL);
  if (override === 'powershell' || override === 'pwsh' || override === 'cmd') return override;
  if (override === 'bash' || override === 'sh') return null; // 非 Windows 家族,交由调用方按 posix 处理
  const comspec = String(e.COMSPEC || '').toLowerCase();
  if (comspec.endsWith('powershell.exe')) return 'powershell';
  if (comspec.endsWith('pwsh.exe')) return 'pwsh';
  if (comspec.endsWith('cmd.exe')) return 'cmd';
  return null;
}

/** 目标是否为 PowerShell 家族(且门控开启)。powershell(5.1)与 pwsh(7)都算。 */
function targetsPowerShell(env) {
  if (!isEnabled(env)) return false;
  const fam = resolveFamily(env);
  return fam === 'powershell' || fam === 'pwsh';
}

/**
 * getShellConfiguration 的显式 spawn 覆盖 token(gated)。
 * 让「交互 shell 与自动探测不一致」的用户强制 khy 实际 spawn 指定 shell,从而
 * 让 khy 自身工具调用的串接语法与提示词措辞一致。关闭门控 → 返回 null(不覆盖)。
 * @returns {'powershell'|'pwsh'|'cmd'|'bash'|'sh'|null}
 */
function parseExecOverride(env) {
  if (!isEnabled(env)) return null;
  return _normalizeOverrideToken((env || process.env).KHY_SHELL);
}

// ── Byte-revert 锚:关闭态 / 非 PowerShell 语境逐字节沿用今日文案 ───────────────
const LEGACY_WINDOWS_RULE_LINES = [
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

// PowerShell 家族一致文案(5.1 与 7 都成立:`;`/`if ($?)` 两版通用,`&&` 注明需 7+)。
const POWERSHELL_WINDOWS_RULE_LINES = [
  'You are running on Windows with PowerShell. Shell commands execute via PowerShell. You MUST:',
  '- Create directories with `New-Item -ItemType Directory -Force <path>` (or `mkdir <path>`, which also creates intermediate dirs)',
  '- Native aliases work: `type`/`cat`→Get-Content, `dir`/`ls`→Get-ChildItem, `copy`→Copy-Item, `move`→Move-Item, `del`/`rm`→Remove-Item',
  '- Redirect errors with `2>$null` (NOT `2>/dev/null`, and NOT cmd.exe `2>NUL`)',
  '- Use backslash `\\` for paths or quoted forward slash paths',
  '- Chain commands with `;` to sequence, or `if ($?) { <next> }` to run the next step only when the previous one succeeded. Windows PowerShell 5.1 does NOT support `&&`/`||` — those require PowerShell 7+.',
  '- Do NOT use bash-only syntax: `|&`, `{a,b}` brace expansion, process substitution, heredoc. (`$(...)` subexpressions ARE valid PowerShell.)',
  '- For multi-line file creation, use `Set-Content` / `@"..."@` here-strings or the Write tool instead of `cat <<EOF`',
  '- Prefer using the Write/Edit tools for file creation instead of shell redirects',
];

/**
 * Windows 规则块的「header + 8 条」行数组(不含 `## Windows Platform Rules` 标题,
 * 该标题由调用方保留)。目标为 PowerShell 家族 → PowerShell 版;否则逐字节 legacy。
 * @returns {string[]}
 */
function windowsRuleLines(env) {
  return targetsPowerShell(env)
    ? POWERSHELL_WINDOWS_RULE_LINES.slice()
    : LEGACY_WINDOWS_RULE_LINES.slice();
}

// ── BashTool 描述「When issuing multiple commands」子块 ────────────────────────
const LEGACY_MULTI_COMMAND_LINES = [
  ' - When issuing multiple commands:',
  '   - If independent, make parallel tool calls.',
  "   - If dependent, chain with '&&'.",
  "   - Use ';' only when you don't care if earlier commands fail.",
];

const POWERSHELL_MULTI_COMMAND_LINES = [
  ' - When issuing multiple commands:',
  '   - If independent, make parallel tool calls.',
  '   - If dependent, run them as separate steps, or sequence with `;` and gate on success using `if ($?) { <next> }`.',
  '   - Windows PowerShell 5.1 does NOT support `&&`/`||` (only PowerShell 7+ does); prefer separate steps so a failure stays visible instead of silently continuing.',
];

/**
 * BashTool 描述里「When issuing multiple commands」子块的行数组。
 * 目标为 PowerShell 家族 → PowerShell 版;否则逐字节 legacy(`&&`)。
 * @returns {string[]}
 */
function multiCommandLines(env) {
  return targetsPowerShell(env)
    ? POWERSHELL_MULTI_COMMAND_LINES.slice()
    : LEGACY_MULTI_COMMAND_LINES.slice();
}

module.exports = {
  isEnabled,
  resolveFamily,
  targetsPowerShell,
  parseExecOverride,
  windowsRuleLines,
  multiCommandLines,
  // 暴露常量便于测试断言 byte-revert(只读引用)。
  LEGACY_WINDOWS_RULE_LINES,
  POWERSHELL_WINDOWS_RULE_LINES,
  LEGACY_MULTI_COMMAND_LINES,
  POWERSHELL_MULTI_COMMAND_LINES,
};
