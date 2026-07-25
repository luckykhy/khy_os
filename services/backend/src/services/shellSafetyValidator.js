'use strict';

/**
 * shellSafetyValidator.js — Multi-layer shell command safety validation.
 *
 * Ported from OpenClaw's bash-tools.exec.ts + command-analysis/risks.ts.
 * Provides defense-in-depth for shell command execution:
 *
 *   Layer 1: Command carrier recursive unwrapping (sudo, env, bash -c, eval)
 *   Layer 2: Interpreter script detection (Python, Node.js)
 *   Layer 3: Shell bleed prevention ($VAR injection in scripts)
 *   Layer 4: Complex syntax detection (pipes, subshells, process substitution)
 *   Layer 5: Inline eval detection (python -c, node -e, awk, sed, etc.)
 *
 * Cycle guard prevents infinite recursion on circular wrapper patterns.
 */

// ── Constants ──────────────────────────────────────────────────────

const COMMAND_CARRIERS = new Set(['sudo', 'doas', 'env', 'command', 'builtin', 'exec']);
const POSIX_SHELLS = new Set(['bash', 'dash', 'fish', 'ksh', 'sh', 'zsh', 'ash']);
const SOURCE_BUILTINS = new Set(['.', 'source']);
const SHELL_KEYWORDS = new Set(['if', 'then', 'do', 'elif', 'else', 'while', 'until', 'time']);

const DISPATCH_WRAPPERS = new Set([
  'arch', 'caffeinate', 'chrt', 'ionice', 'nice', 'nohup',
  'sandbox-exec', 'script', 'setsid', 'stdbuf', 'taskset',
  'time', 'timeout', 'xcrun',
]);
const MAX_UNWRAP_DEPTH = 32;

// Interpreter inline eval specs
const INTERPRETER_EVAL_SPECS = [
  { names: ['python', 'python2', 'python3', 'pypy', 'pypy3'], flags: new Set(['-c']) },
  { names: ['node', 'nodejs', 'bun', 'deno'], flags: new Set(['-e', '--eval', '-p', '--print']) },
  { names: ['ruby'], flags: new Set(['-e']) },
  { names: ['perl'], flags: new Set(['-e', '-E']) },
  { names: ['php'], flags: new Set(['-r']) },
  { names: ['lua'], flags: new Set(['-e']) },
  { names: ['awk', 'gawk', 'mawk', 'nawk'], flags: new Set(['-e', '--source']) },
  { names: ['sed', 'gsed'], flags: new Set(['-e']) },
  { names: ['osascript'], flags: new Set(['-e']) },
];

// Regex patterns
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;
const SHELL_VAR_INJECTION_RE = /\$[A-Z_][A-Z0-9_]{1,}/g;
const PYTHON_RE = /^python(?:3(?:\.\d+)?)?$/i;

// ── Shell Argument Splitting ──────────────────────────────────────

/**
 * Split a command string into argv, respecting quotes.
 * Returns null if quotes are unbalanced.
 *
 * @param {string} cmd
 * @returns {string[]|null}
 */
function splitShellArgs(cmd) {
  const tokens = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else buf += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else buf += ch;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (/\s/.test(ch)) {
      if (buf.length > 0) { tokens.push(buf); buf = ''; }
      continue;
    }
    buf += ch;
  }

  if (inSingle || inDouble) return null;
  if (buf.length > 0) tokens.push(buf);
  return tokens;
}

// ── Layer 1: Command Carrier Unwrapping ──────────────────────────

/**
 * Normalize executable name (strip path, lowercase, remove .exe).
 */
function normalizeExe(token) {
  if (!token) return '';
  const base = token.split(/[/\\]/).pop() || '';
  const lower = base.toLowerCase();
  return lower.endsWith('.exe') ? lower.slice(0, -4) : lower;
}

/**
 * Strip leading environment variable assignments.
 */
function stripEnvAssignments(argv) {
  let i = 0;
  while (i < argv.length && ENV_ASSIGNMENT_RE.test(argv[i])) i++;
  return i > 0 ? argv.slice(i) : argv;
}

/**
 * Recursively unwrap command carriers to find the effective command.
 * Handles: sudo, doas, env, command, builtin, exec, bash -c, dispatch wrappers.
 *
 * @param {string[]} argv
 * @param {Set<string>} [seen] - Cycle guard
 * @returns {{ effective: string[], wrappers: string[], payloads: string[] }}
 */
function unwrapCommand(argv, seen) {
  if (!seen) seen = new Set();
  const key = argv.join('\0');
  if (seen.has(key) || seen.size >= MAX_UNWRAP_DEPTH) {
    return { effective: argv, wrappers: [], payloads: [argv.join(' ')] };
  }
  seen.add(key);

  const stripped = stripEnvAssignments(argv);
  if (stripped.length === 0) return { effective: argv, wrappers: [], payloads: [] };

  const exe = normalizeExe(stripped[0]);
  const args = stripped.slice(1);
  const payloads = [stripped.join(' ')];

  // Dispatch wrappers (time, nice, timeout, etc.)
  if (DISPATCH_WRAPPERS.has(exe)) {
    // Simple unwrap: skip wrapper and its options
    const inner = _unwrapDispatchWrapper(exe, args);
    if (inner && inner.length > 0) {
      const deeper = unwrapCommand(inner, seen);
      return {
        effective: deeper.effective,
        wrappers: [exe, ...deeper.wrappers],
        payloads: [...payloads, ...deeper.payloads],
      };
    }
  }

  // Command carriers: sudo, doas, env, command, builtin, exec
  if (COMMAND_CARRIERS.has(exe)) {
    const carried = _resolveCarrier(exe, args);
    if (carried && carried.length > 0) {
      const deeper = unwrapCommand(carried, seen);
      return {
        effective: deeper.effective,
        wrappers: [exe, ...deeper.wrappers],
        payloads: [...payloads, ...deeper.payloads],
      };
    }
  }

  // Shell wrappers: bash -c "..."
  if (POSIX_SHELLS.has(exe)) {
    const shellPayload = _extractShellPayload(args);
    if (shellPayload) {
      const innerArgv = splitShellArgs(shellPayload);
      if (innerArgv && innerArgv.length > 0) {
        const deeper = unwrapCommand(innerArgv, seen);
        return {
          effective: deeper.effective,
          wrappers: [exe, ...deeper.wrappers],
          payloads: [...payloads, shellPayload, ...deeper.payloads],
        };
      }
      return {
        effective: stripped,
        wrappers: [exe],
        payloads: [...payloads, shellPayload],
      };
    }
  }

  return { effective: stripped, wrappers: [], payloads };
}

function _resolveCarrier(exe, args) {
  if (exe === 'env') return _resolveEnvCarrier(args);
  if (exe === 'sudo' || exe === 'doas') return _resolveSudoCarrier(args);
  // command, builtin, exec: next arg is the command
  if (args.length > 0 && !args[0].startsWith('-')) return args;
  return null;
}

function _resolveEnvCarrier(args) {
  let i = 0;
  const optsWithValue = new Set(['-C', '-P', '-S', '-s', '-u', '--chdir', '--unset', '--split-string']);
  const standalone = new Set(['-0', '-i', '--ignore-environment', '--null']);
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') { i++; break; }
    if (ENV_ASSIGNMENT_RE.test(arg)) { i++; continue; }
    if (standalone.has(arg)) { i++; continue; }
    if (optsWithValue.has(arg)) { i += 2; continue; }
    if (arg.startsWith('-')) { i++; continue; }
    break;
  }
  return i < args.length ? args.slice(i) : null;
}

function _resolveSudoCarrier(args) {
  const optsWithValue = new Set(['-C', '-D', '-g', '-h', '-p', '-R', '-T', '-U', '-u',
    '--chdir', '--chroot', '--close-from', '--group', '--host', '--user']);
  const standalone = new Set(['-A', '-B', '-b', '-E', '-H', '-i', '-k', '-N', '-n', '-P', '-S', '-s']);
  const nonExec = new Set(['-K', '-l', '-V', '-v', '-e', '--edit', '--help', '--list', '--version']);
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') { i++; break; }
    if (nonExec.has(arg)) return null; // Not executing a command
    if (optsWithValue.has(arg)) { i += 2; continue; }
    if (standalone.has(arg)) { i++; continue; }
    if (arg.startsWith('-')) { i++; continue; }
    break;
  }
  return i < args.length ? args.slice(i) : null;
}

function _extractShellPayload(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-c') return args[i + 1] || null;
    // Combined flags like -xc
    if (/^-[A-Za-z]+$/.test(arg) && arg.includes('c')) return args[i + 1] || null;
  }
  return null;
}

function _unwrapDispatchWrapper(exe, args) {
  // Simple heuristic: skip flags, return first non-flag argument and rest
  let i = 0;
  const optsWithValue = {
    timeout: new Set(['-k', '--kill-after', '-s', '--signal']),
    nice: new Set(['-n', '--adjustment']),
    stdbuf: new Set(['-i', '-o', '-e']),
  };
  const opts = optsWithValue[exe] || new Set();
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') { i++; break; }
    if (opts.has(arg)) { i += 2; continue; }
    if (arg.startsWith('-')) { i++; continue; }
    break;
  }
  return i < args.length ? args.slice(i) : null;
}

// ── Layer 2: Interpreter Script Detection ────────────────────────

/**
 * Detect if the effective command runs a Python or Node.js script.
 *
 * @param {string[]} argv
 * @returns {{ kind: string, paths: string[] }|null}
 */
function detectInterpreterScript(argv) {
  const stripped = stripEnvAssignments(argv);
  if (stripped.length === 0) return null;

  const exe = normalizeExe(stripped[0]);
  const args = stripped.slice(1);

  if (PYTHON_RE.test(exe)) {
    const script = _findPythonScript(args);
    return script ? { kind: 'python', paths: [script] } : null;
  }
  if (exe === 'node' || exe === 'nodejs') {
    const scripts = _findNodeScripts(args);
    return scripts.length > 0 ? { kind: 'node', paths: scripts } : null;
  }
  return null;
}

function _findPythonScript(args) {
  const skipNext = new Set(['-W', '-X', '-Q', '--check-hash-based-pycs']);
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--') return args[i + 1]?.toLowerCase().endsWith('.py') ? args[i + 1] : null;
    if (t === '-' || t === '-c' || t === '-m') return null;
    if ((t.startsWith('-c') || t.startsWith('-m')) && t.length > 2) return null;
    if (skipNext.has(t)) { i++; continue; }
    if (t.startsWith('-')) continue;
    return t.toLowerCase().endsWith('.py') ? t : null;
  }
  return null;
}

function _findNodeScripts(args) {
  const preloads = [];
  let entry = null;
  let hasInlineEval = false;
  const preloadFlags = new Set(['-r', '--require', '--import']);

  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--') {
      if (!hasInlineEval && !entry && args[i + 1]?.toLowerCase().endsWith('.js')) {
        entry = args[i + 1];
      }
      break;
    }
    if (['-e', '-p', '--eval', '--print'].includes(t) ||
        t.startsWith('--eval=') || t.startsWith('--print=') ||
        ((t.startsWith('-e') || t.startsWith('-p')) && t.length > 2)) {
      hasInlineEval = true;
      if (['-e', '-p', '--eval', '--print'].includes(t)) i++;
      continue;
    }
    if (preloadFlags.has(t)) {
      if (args[i + 1]?.toLowerCase().endsWith('.js')) preloads.push(args[i + 1]);
      i++; continue;
    }
    if (t.startsWith('-')) continue;
    if (!hasInlineEval && !entry && t.toLowerCase().endsWith('.js')) { entry = t; break; }
  }

  const result = [...preloads];
  if (entry) result.push(entry);
  return result;
}

// ── Layer 3: Shell Bleed Prevention ─────────────────────────────

/**
 * Check if a script file contains shell variable references ($VAR).
 * This catches cases where shell environment syntax leaks into interpreted languages.
 *
 * @param {string} content - Script file content
 * @returns {{ hasBleed: boolean, variables: string[] }}
 */
function checkShellBleed(content) {
  if (!content || typeof content !== 'string') return { hasBleed: false, variables: [] };

  SHELL_VAR_INJECTION_RE.lastIndex = 0;
  const variables = [];
  let match;
  while ((match = SHELL_VAR_INJECTION_RE.exec(content)) !== null) {
    if (!variables.includes(match[0])) variables.push(match[0]);
  }

  return { hasBleed: variables.length > 0, variables };
}

// ── Layer 4: Complex Syntax Detection ────────────────────────────

/**
 * Detect complex shell syntax in a command string.
 *
 * @param {string} cmd
 * @returns {{ hasComplexSyntax: boolean, hasPipe: boolean, hasSubshell: boolean, hasProcessSub: boolean, details: string[] }}
 */
function detectComplexSyntax(cmd) {
  if (!cmd) return { hasComplexSyntax: false, hasPipe: false, hasSubshell: false, hasProcessSub: false, details: [] };

  const details = [];
  let inSingle = false, inDouble = false;
  let hasPipe = false, hasSubshell = false, hasProcessSub = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;

    if (ch === '|' && cmd[i + 1] !== '|') { hasPipe = true; details.push('pipe'); }
    if (ch === '|' && cmd[i + 1] === '|') { details.push('or-operator'); i++; }
    if (ch === '&' && cmd[i + 1] === '&') { details.push('and-operator'); i++; }
    if (ch === ';') details.push('semicolon');
    if (ch === '$' && cmd[i + 1] === '(') { hasSubshell = true; details.push('command-substitution'); }
    if (ch === '`') { hasSubshell = true; details.push('backtick-substitution'); }
    if ((ch === '<' || ch === '>') && cmd[i + 1] === '(') { hasProcessSub = true; details.push('process-substitution'); }
  }

  if (cmd.includes('\n') || cmd.includes('\r')) details.push('multiline');

  return {
    hasComplexSyntax: details.length > 0,
    hasPipe,
    hasSubshell,
    hasProcessSub,
    details: [...new Set(details)],
  };
}

// ── Layer 5: Inline Eval Detection ───────────────────────────────

/**
 * Detect if a command uses inline eval (python -c, node -e, etc.).
 *
 * @param {string[]} argv
 * @returns {{ detected: boolean, interpreter: string, flag: string }|null}
 */
function detectInlineEval(argv) {
  if (!argv || argv.length === 0) return null;

  const exe = normalizeExe(argv[0]);
  for (const spec of INTERPRETER_EVAL_SPECS) {
    if (!spec.names.includes(exe)) continue;

    for (let i = 1; i < argv.length; i++) {
      const token = argv[i];
      if (token === '--') break;
      const lower = token.toLowerCase();
      if (spec.flags.has(lower)) {
        return { detected: true, interpreter: exe, flag: lower };
      }
      // Prefix flags like --eval=...
      for (const flag of spec.flags) {
        if (flag.startsWith('--') && lower.startsWith(flag + '=')) {
          return { detected: true, interpreter: exe, flag };
        }
      }
    }
  }

  return null;
}

// ── Builtin Detection ────────────────────────────────────────────

/**
 * Detect dangerous shell builtins in the effective command.
 *
 * @param {string[]} argv
 * @returns {{ kind: string, command: string }|null}
 */
function detectDangerousBuiltin(argv) {
  const exe = normalizeExe(argv[0]);
  if (exe === 'eval') return { kind: 'eval', command: 'eval' };
  if (SOURCE_BUILTINS.has(exe)) return { kind: 'source', command: exe };
  return null;
}

// ── Layer 6: Destructive Command Detection ──────────────────────

/**
 * Destructive command patterns — commands that are hard to reverse.
 * Inspired by Claude Code's bash AST-based destructive command detection.
 */
const DESTRUCTIVE_PATTERNS = [
  // File system destruction
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive|--force)\b/, severity: 'critical', detail: 'Recursive force delete (rm -rf)' },
  { pattern: /\brm\s+-[a-zA-Z]*r\b/, severity: 'warning', detail: 'Recursive delete (rm -r)' },
  { pattern: /\bshred\b/, severity: 'critical', detail: 'Secure file erasure (shred)' },
  { pattern: /\bwipefs\b/, severity: 'critical', detail: 'Filesystem signature wipe' },

  // Disk / partition
  { pattern: /\bmkfs\b/, severity: 'critical', detail: 'Filesystem creation (mkfs) — destroys data' },
  { pattern: /\bdd\s+.*\bif=/, severity: 'critical', detail: 'Direct disk write (dd)' },
  { pattern: /\bfdisk\b/, severity: 'critical', detail: 'Disk partitioning (fdisk)' },
  { pattern: /\bparted\b/, severity: 'warning', detail: 'Partition editor (parted)' },

  // Git destructive
  { pattern: /\bgit\s+push\s+.*--force(?!-with-lease)\b/, severity: 'critical', detail: 'Force push (git push --force) — overwrites remote history' },
  { pattern: /\bgit\s+push\s+.*-f\b/, severity: 'critical', detail: 'Force push (git push -f) — overwrites remote history' },
  { pattern: /\bgit\s+reset\s+--hard\b/, severity: 'critical', detail: 'Hard reset — discards uncommitted changes' },
  { pattern: /\bgit\s+clean\s+.*-f/, severity: 'warning', detail: 'Force clean — removes untracked files' },
  { pattern: /\bgit\s+checkout\s+--\s+\./, severity: 'warning', detail: 'Discard all unstaged changes' },
  { pattern: /\bgit\s+branch\s+-D\b/, severity: 'warning', detail: 'Force delete branch' },
  { pattern: /\bgit\s+stash\s+drop\b/, severity: 'warning', detail: 'Drop stash entry' },
  { pattern: /\bgit\s+rebase\b/, severity: 'info', detail: 'Rebase — rewrites history' },

  // Database
  { pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX)\b/i, severity: 'critical', detail: 'SQL DROP statement — destroys data' },
  { pattern: /\bTRUNCATE\s+TABLE\b/i, severity: 'critical', detail: 'SQL TRUNCATE — removes all rows' },
  { pattern: /\bDELETE\s+FROM\b.*\bWHERE\b/i, severity: 'warning', detail: 'SQL DELETE with WHERE' },
  { pattern: /\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i, severity: 'critical', detail: 'SQL DELETE without WHERE — removes all rows' },

  // Docker
  { pattern: /\bdocker\s+(system\s+prune|container\s+prune|image\s+prune)\b/, severity: 'warning', detail: 'Docker prune — removes unused resources' },
  { pattern: /\bdocker\s+rm\s+-f\b/, severity: 'warning', detail: 'Force remove container' },

  // Package managers (unintentional uninstall)
  { pattern: /\bnpm\s+uninstall\b/, severity: 'info', detail: 'npm uninstall' },
  { pattern: /\bpip\s+uninstall\b/, severity: 'info', detail: 'pip uninstall' },

  // System-level
  { pattern: /\bchmod\s+.*777\b/, severity: 'warning', detail: 'World-writable permissions (chmod 777)' },
  { pattern: /\bchown\s+-R\b/, severity: 'warning', detail: 'Recursive ownership change' },
  { pattern: /\bkillall\b/, severity: 'warning', detail: 'Kill all processes by name' },
  { pattern: /\bkill\s+-9\b/, severity: 'info', detail: 'Force kill (SIGKILL)' },
  { pattern: /\bsystemctl\s+(stop|disable|mask)\b/, severity: 'warning', detail: 'Stopping/disabling system service' },
];

// ── Strict destructive patterns (gated: KHY_SHELL_DESTRUCTIVE_FLAG_NORMALIZE) ──
//
// 治理背景:上面的 DESTRUCTIVE_PATTERNS 有 4 条**对 flag 拼写/顺序敏感**的正则,
// 让常见的破坏性拼写悄悄逃过分类,`analyzeCommand` 返回 safe:true:
//   ① rm 关键级只认「r 在 f 之前」的 `-[a-z]*r[a-z]*f`:`rm -fr` / `rm -Rf`(大写)/
//      `rm -rF` / `rm -r -f`(分开写)全部漏判 critical(最危险的洞——递归强删默认放行)。
//   ② dd 只认 `if=`:`dd of=/dev/sda`(反向写盘,同样毁盘)漏判 critical。
//   ③ git clean 用 `\s+.*-f` 中间必须有空格:`git clean -xdf`(合并簇)仍能命中,但
//      `git\s+clean\s+.*-f` 对 `-fdx` 这类也可命中——真正漏的是它把 `--force` 也该覆盖却
//      依赖 `-f` 子串;统一成 `-[a-z]*f` 更稳(与 irreversibleSignatures.js 同型)。
//   ④ chmod 只认八进制 `777`:符号式 `chmod a+rwx` / `chmod o+w`(同样开放 world-write)漏判。
//
// STRICT 变体是原数组的**严格超集**:每条要么等价、要么更宽(多抓真破坏性拼写),
// 绝不比今天更松。门控关 → detectDestructiveCommand 逐字节回退原 DESTRUCTIVE_PATTERNS。
// 与 metaplan/irreversibleSignatures.js 的 order/case-tolerant 正则同族(那是既有先例)。
const DESTRUCTIVE_PATTERNS_STRICT = DESTRUCTIVE_PATTERNS.map((entry) => {
  // rm 关键级:order/case 无关,要求同时出现 r-类 与 f-类 flag(或裸 --recursive/--force)。
  if (entry.detail === 'Recursive force delete (rm -rf)') {
    return { ...entry, pattern: /\brm\b(?:(?=[^\n;&|]*?\s--(?:recursive|force)\b)|(?=[^\n;&|]*?\s-(?:-recursive\b|[a-z]*r))(?=[^\n;&|]*?\s-(?:-force\b|[a-z]*f)))/i };
  }
  // rm 警告级:任何递归 flag(-r / -R / --recursive),case 无关。
  if (entry.detail === 'Recursive delete (rm -r)') {
    return { ...entry, pattern: /\brm\b(?=[^\n;&|]*?\s-(?:-recursive\b|[a-z]*r))/i };
  }
  // dd:if= 或 of= 任一(反向写盘同样毁盘)。
  if (entry.detail === 'Direct disk write (dd)') {
    return { ...entry, pattern: /\bdd\s+.*\b(?:if|of)=/ };
  }
  // git clean:合并簇 -[a-z]*f 或 --force,case 无关(与 irreversibleSignatures 同型)。
  if (entry.detail === 'Force clean — removes untracked files') {
    return { ...entry, pattern: /\bgit\s+clean\b[\s\S]*?(?:-[a-z]*f|--force)/i };
  }
  return entry;
});
// 追加:chmod 符号式 world-writable(八进制 777 那条仍保留于原数组,两者并存)。
// 要求显式 a/o 类 + 含 w 位,故 `chmod +w`(裸)/`chmod u+w`/`chmod g+w`(仅属主/组)不误报。
DESTRUCTIVE_PATTERNS_STRICT.push({
  pattern: /\bchmod\b(?:\s+-[a-zA-Z]+)*\s+[ug]*[ao][ugoa]*\+[rwxXst]*w/i,
  severity: 'warning',
  detail: 'World-writable permissions (chmod a+w / o+w)',
});

/**
 * Select the destructive-pattern table honoring KHY_SHELL_DESTRUCTIVE_FLAG_NORMALIZE.
 * ON (default) → strict superset (closes rm/dd/git-clean/chmod flag-spelling holes).
 * OFF → byte-revert to the original DESTRUCTIVE_PATTERNS. Fail-soft: any error → strict.
 *
 * @param {object} [env]
 * @returns {Array<{pattern: RegExp, severity: string, detail: string}>}
 */
function _selectDestructivePatterns(env = process.env) {
  try {
    const enabled = require('./flagRegistry').isFlagEnabled('KHY_SHELL_DESTRUCTIVE_FLAG_NORMALIZE', env);
    return enabled ? DESTRUCTIVE_PATTERNS_STRICT : DESTRUCTIVE_PATTERNS;
  } catch {
    return DESTRUCTIVE_PATTERNS_STRICT;
  }
}

/**
 * Detect destructive commands in the effective argv and raw command.
 *
 * @param {string[]} argv - Effective command tokens
 * @param {string} rawCommand - Original raw command string
 * @returns {{ severity: string, detail: string } | null}
 */
function detectDestructiveCommand(argv, rawCommand) {
  if (!rawCommand) return null;

  let highestSeverity = null;
  let highestDetail = '';
  const severityOrder = { info: 0, warning: 1, critical: 2 };

  for (const { pattern, severity, detail } of _selectDestructivePatterns()) {
    if (pattern.test(rawCommand)) {
      if (!highestSeverity || severityOrder[severity] > severityOrder[highestSeverity]) {
        highestSeverity = severity;
        highestDetail = detail;
      }
    }
  }

  if (highestSeverity) {
    return { severity: highestSeverity, detail: highestDetail };
  }
  return null;
}

// ── Full Analysis ────────────────────────────────────────────────

/**
 * Perform full safety analysis on a shell command.
 *
 * @param {string} command - Raw command string
 * @returns {CommandSafetyReport}
 */
function analyzeCommand(command) {
  const argv = splitShellArgs(command);
  if (!argv || argv.length === 0) {
    return { safe: true, command, risks: [], wrappers: [], effective: command };
  }

  const risks = [];

  // Layer 1: Unwrap carriers
  const { effective, wrappers, payloads } = unwrapCommand(argv);
  const effectiveCmd = effective.join(' ');

  // Layer 2: Interpreter detection
  const script = detectInterpreterScript(effective);
  if (script) {
    risks.push({
      type: 'interpreter_script',
      severity: 'info',
      detail: `${script.kind} script: ${script.paths.join(', ')}`,
    });
  }

  // Layer 4: Complex syntax
  const syntax = detectComplexSyntax(command);
  if (syntax.hasComplexSyntax) {
    risks.push({
      type: 'complex_syntax',
      severity: syntax.hasSubshell || syntax.hasProcessSub ? 'warning' : 'info',
      detail: `Complex syntax detected: ${syntax.details.join(', ')}`,
    });
  }

  // Layer 5: Inline eval
  const inlineEval = detectInlineEval(effective);
  if (inlineEval) {
    risks.push({
      type: 'inline_eval',
      severity: 'warning',
      detail: `Inline eval: ${inlineEval.interpreter} ${inlineEval.flag}`,
    });
  }

  // Carrier inline eval (through wrappers)
  for (const payload of payloads) {
    const innerArgv = splitShellArgs(payload);
    if (innerArgv) {
      const nestedEval = detectInlineEval(innerArgv);
      if (nestedEval && nestedEval.interpreter !== (inlineEval?.interpreter)) {
        risks.push({
          type: 'carrier_inline_eval',
          severity: 'critical',
          detail: `Nested eval through carrier: ${nestedEval.interpreter} ${nestedEval.flag}`,
        });
      }
    }
  }

  // Dangerous builtins
  const builtin = detectDangerousBuiltin(effective);
  if (builtin) {
    risks.push({
      type: 'dangerous_builtin',
      severity: builtin.kind === 'eval' ? 'critical' : 'warning',
      detail: `Shell builtin: ${builtin.command}`,
    });
  }

  // Layer 6: Destructive command detection (inspired by Claude Code's bash AST parsing)
  const destructive = detectDestructiveCommand(effective, command);
  if (destructive) {
    risks.push({
      type: 'destructive_command',
      severity: destructive.severity,
      detail: destructive.detail,
    });
  }

  // Deep nesting
  if (wrappers.length >= 3) {
    risks.push({
      type: 'deep_nesting',
      severity: 'warning',
      detail: `${wrappers.length} layers of command wrapping: ${wrappers.join(' → ')}`,
    });
  }

  // Layer 7: Fetch-and-execute guard — 「取来即执行」供应链签名(curl … | sh、base64 -d | bash、
  // bash -c "$(curl …)"、bash <(curl …))。静态无法证明安全 → fail-closed 升为 critical,由本
  // validator 的 block 路径接管。门控 KHY_FETCH_EXEC_GUARD 默认开;关 → buildFetchExecuteRisks 返
  // [] → risks 零增量 → maxSeverity 不变 → 字节回退到旧行为。fail-soft:守卫任何异常都不打断分析。
  try {
    const { buildFetchExecuteRisks } = require('./fetchExecuteGuard');
    for (const r of buildFetchExecuteRisks(command)) {
      risks.push({ type: r.type, severity: r.severity, detail: r.detail });
    }
  } catch { /* fail-soft: 守卫绝不破坏既有分析路径 */ }

  const maxSeverity = risks.reduce((max, r) => {
    const order = { info: 0, warning: 1, critical: 2 };
    return order[r.severity] > order[max] ? r.severity : max;
  }, 'info');

  return {
    safe: maxSeverity !== 'critical',
    command,
    effective: effectiveCmd,
    wrappers,
    risks,
    maxSeverity,
    hasCommandSubstitution: syntax.hasSubshell || false,
  };
}

module.exports = {
  analyzeCommand,
  unwrapCommand,
  detectInterpreterScript,
  checkShellBleed,
  detectComplexSyntax,
  detectInlineEval,
  detectDangerousBuiltin,
  detectDestructiveCommand,
  splitShellArgs,
  normalizeExe,
  COMMAND_CARRIERS,
  POSIX_SHELLS,
  INTERPRETER_EVAL_SPECS,
  DESTRUCTIVE_PATTERNS,
  DESTRUCTIVE_PATTERNS_STRICT,
  _selectDestructivePatterns,
};
