#!/usr/bin/env node
/**
 * @pattern Command, Visitor
 */
/**
 * Agent Rule Checker
 *
 * Validates changed files for:
 *  1) hard-coded host:port endpoints
 *  2) opaque generic status strings
 *  3) suspicious hard-timeout kill patterns
 *  4) ANSI scroll-region escapes (DECSTBM) outside full-screen alt-buffer UIs
 *
 * Usage:
 *   node scripts/ci/check-agent-rules.js --changed
 *   node scripts/ci/check-agent-rules.js <file-or-dir> [more...]
 *   node scripts/ci/check-agent-rules.js --changed --strict-warnings
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const cwd = process.cwd();
const args = process.argv.slice(2);
const strictWarnings = args.includes('--strict-warnings');
const changedMode = args.includes('--changed');
const rawTargets = args.filter((a) => !a.startsWith('--'));

const CODE_EXTS = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.tsx', '.vue',
  '.py', '.json', '.yaml', '.yml',
  // Setup scripts ship to users verbatim, so a hardcoded path in one of them
  // (install-khy.ps1 shipped `node D:\Code\...\khy.js`) breaks every install
  // that is not the author's machine. Scanned for Rule 1c.
  '.ps1', '.sh', '.bat', '.cmd',
]);

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.cache',
  '.tmp',
  'coverage',
  'logs',
  // Third-party / generated trees. These hold code this repo does not author and
  // cannot refactor, so every hit in them is unactionable noise. A single
  // unignored Python virtualenv produced 30 `no-hardcoded-endpoint` errors from
  // library docstrings and pinned the whole gate red, which makes the real
  // findings invisible and trains readers to skip the output.
  '.venv',
  'venv',
  'site-packages',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'vendor',
  'third_party',
]);

const HARD_ENDPOINT_PATTERNS = [
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{2,5})?\b/i,
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}\b/i,
  /\bredis:\/\/localhost:\d{2,5}\b/i,
];

// First-party PRODUCTION domains. These must be sourced from
// constants/serviceDefaults.js (the single source of truth) — never hardcoded
// as bare literals in source, or a domain migration / self-hosting silently
// leaves "some modules still pointing at the old host". The loopback patterns
// above never matched these, so production-domain hardcodes used to pass the
// gate entirely. Add new first-party hosts here as they appear.
const PRODUCTION_HOST_PATTERN = /\bkhyquant\.(?:top|com|cn)\b/i;

// Machine-local absolute filesystem paths. Two shapes leak a specific machine's
// layout (or write outside the project) and must never be pinned in source:
//
//  a) A drive-qualified Windows path (`D:\Code\...`, `C:/Users/...`). Whoever
//     committed it hardcoded THEIR checkout; every other user gets a broken
//     path. install-khy.ps1 shipped `node D:\Code\...\khy.js` to all users this
//     way — it must be derived from $PSScriptRoot / __dirname instead.
//
//  b) A computed bare drive root used as a write target — `path.parse(__dirname).root`
//     joined with a directory. This looks dynamic (it follows the install drive)
//     but still writes to `<drive>:\tmp\...`, i.e. OUTSIDE the project, polluting
//     the user's machine. Generated files belong under the resolved output home;
//     use utils/storageRoots.resolveGeneratedFileDir().
const ABS_PATH_PATTERNS = [
  { re: /['"`][A-Za-z]:[\\/]{1,2}(?![\\/])[^'"`\n]{2,}/, kind: 'drive-qualified' },
  { re: /\bpath\.parse\(\s*__(?:dirname|filename)\s*\)\.root\b/, kind: 'drive-root' },
];

// POSIX absolute paths that pin a specific machine's home/user directory.
// Bare `/usr/bin`, `/etc/...` are system-standard and NOT flagged; a personal
// home path is.
const POSIX_HOME_PATH_PATTERN = /['"`]\/(?:home|Users)\/(?!<|\$|\{|%|\w*(?:user|name|USER|NAME)\b)[A-Za-z0-9._-]+\//;

// Well-known Windows system directories used as an env-var fallback
// (`process.env.ProgramFiles || 'C:\\Program Files'`). Unlike a production
// domain — where an env-overridable default silently forks any install that
// lacks the var — these are fixed OS constants, identical on every Windows
// machine, so they leak no per-machine layout and cannot drift. The idiom is
// correct and stays exempt; a path under them that names a USER or a checkout
// still trips the rule, because the pattern requires the segment to end there.
const WINDOWS_SYSTEM_DIR_PATTERN =
  /['"`][A-Za-z]:[\\/]{1,2}(?:Program Files(?: \(x86\))?|ProgramData|Windows|Users|Temp)['"`]/i;


// Rule 3 termination effects. A fixed-duration timer only violates the idle-timeout
// rule if it ENDS work when it fires; see Rule 3 below for why the effect, not the
// timer, is the trigger.
//
// Hard kill: tears down a process (tree). Kill WRAPPERS count — `safeKill(child)`
// ends the child exactly as `child.kill()` does, and matching only `.kill(` let
// five real fixed-timeout child-process kills in comprehensiveDataService.js
// through as low-severity warnings instead of errors.
const HARD_KILL_SIGNALS = [
  /\.kill\s*\(/i,
  /\bprocess\.(?:kill|exit)\s*\(/,
  /\b(?:safeKill|treeKill|killTree|killProcessTree|terminateProcess)\s*\(/i,
  /\btaskkill\b/i,
];

// Soft termination: fails one operation without killing a process.
const SOFT_TERMINATION_SIGNALS = [
  /\.abort\s*\(/i,
  /\breject\s*\(/,
  /\b(?:timedOut|isTimedOut|didTimeout|hasTimedOut|timeoutHit)\s*=\s*true\b/,
];

const GENERIC_STATUS_TOKENS = [
  '正在工作',
  '处理中',
  '尝试连接',
  'loading',
  'processing',
  'connecting',
];

const STATUS_DETAIL_HINTS = [
  /\d+\s*\/\s*\d+/,
  /\d+\s*%/,
  /第\s*\d+\s*次/,
  /\battempt\b/i,
  /\bretry\b/i,
  /:\d{2,5}\b/,
  /\bhost\b/i,
  /\bport\b/i,
  /\bbytes?\b/i,
  /\bkb\b|\bmb\b|\bgb\b/i,
  /节点|记录|条目/,
];

const STATUS_CONTEXT_HINTS = [
  /\bprint(?:Error|Warn|Info|Success|StepLine|StepDetail)\s*\(/,
  /\bconsole\.(?:log|warn|error)\s*\(/,
  /\bemitRuntimeStatus\s*\(/,
  /\bspinner\.(?:setPhase|start)\s*\(/,
  /\bprocess\.(?:stdout|stderr)\.write\s*\(/,
  /\bon(?:Chunk|Status|Wait|Fallback)\s*:/,
  /(?:^|[({,\s])(?:status|message|text|detail|label|title|subtitle)\s*[:=]/i,
];

function run(cmd) {
  try {
    return cp.execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function listChangedFiles() {
  // core.quotePath=false: with the default (true), git renders any non-ASCII path
  // as a double-quoted, octal-escaped string ("docs/_\346\212\245\345\221\212/…").
  // Those never resolve on disk, so every Chinese-named file in this repo was
  // silently dropped from the scan — the gate reported a clean pass on files it
  // had never opened.
  const git = 'git -c core.quotePath=false';
  const baseRef = String(process.env.GIT_BASE_REF || '').trim();
  if (baseRef) {
    const out = run(`${git} diff --name-only --diff-filter=ACMR ${baseRef}...HEAD`);
    if (out) return out.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  const staged = run(`${git} diff --name-only --cached --diff-filter=ACMR`);
  if (staged) return staged.split('\n').map((s) => s.trim()).filter(Boolean);

  const head = run(`${git} diff --name-only --diff-filter=ACMR HEAD`);
  if (head) return head.split('\n').map((s) => s.trim()).filter(Boolean);
  return [];
}

function shouldIgnore(filePath) {
  const parts = filePath.split(path.sep);
  return parts.some((p) => IGNORE_DIRS.has(p));
}

// Paths deliberately left out of the scan, surfaced in the report. Coverage that
// shrinks silently reads as "everything passed" when it never looked.
const scanNotices = [];

function isSubmoduleGitlink(relPath) {
  // Mode 160000 marks a gitlink: a nested repository whose contents belong to
  // that repo and are governed by its own gates. `git diff --name-only` reports a
  // changed submodule as ONE directory path, so recursing into it walked the
  // submodule's untracked, .gitignore'd virtualenv and reported library
  // docstrings as this repo's violations.
  const gitPath = String(relPath).replace(/\\/g, '/');
  if (/^160000\s/m.test(run(`git ls-files -s -- "${gitPath}"`))) return true;
  // Fallback: a nested clone that was never registered as a gitlink still is not
  // this repo's source.
  return fs.existsSync(path.join(path.resolve(cwd, relPath), '.git'));
}

function collectFilesFromTarget(targetPath, out) {
  const full = path.resolve(cwd, targetPath);
  if (!fs.existsSync(full)) {
    scanNotices.push(`missing path, nothing scanned: ${targetPath}`);
    return;
  }
  const st = fs.statSync(full);
  if (st.isDirectory()) {
    const relDir = path.relative(cwd, full);
    // Prune at the directory, not at each leaf file: the old leaf-only filter
    // still walked every entry under node_modules before discarding them.
    if (shouldIgnore(relDir)) return;
    if (isSubmoduleGitlink(targetPath)) {
      scanNotices.push(`skipped submodule (governed by its own repo): ${targetPath}`);
      return;
    }
    const entries = fs.readdirSync(full);
    for (const entry of entries) {
      collectFilesFromTarget(path.join(targetPath, entry), out);
    }
    return;
  }
  const rel = path.relative(cwd, full);
  if (shouldIgnore(rel)) return;
  if (!CODE_EXTS.has(path.extname(rel))) return;
  out.add(rel);
}

function gatherFiles() {
  const out = new Set();
  if (changedMode) {
    for (const rel of listChangedFiles()) {
      collectFilesFromTarget(rel, out);
    }
  }
  for (const t of rawTargets) collectFilesFromTarget(t, out);
  return [...out];
}

function pushFinding(list, severity, rule, file, line, message, snippet) {
  list.push({ severity, rule, file, line, message, snippet });
}

function quotedLiteralsInLine(line) {
  const matches = [];
  const regex = /(['"`])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = regex.exec(line)) !== null) {
    matches.push(m[2]);
  }
  return matches;
}

function hasStatusDetail(text) {
  return STATUS_DETAIL_HINTS.some((re) => re.test(text));
}

function isTestLikePath(normPath = '') {
  return /(?:^|\/)(?:__tests__|tests)\//.test(normPath)
    || /\.(?:test|spec)\.[^.]+$/.test(normPath);
}

function isLikelyUserFacingStatusLine(line = '') {
  const trimmed = String(line || '').trim();
  if (!trimmed) return false;
  if (/^\s*(?:\/\/|\/\*|\*|#)/.test(trimmed)) return false;
  return STATUS_CONTEXT_HINTS.some((re) => re.test(line));
}

// This gate necessarily spells out every pattern it bans, so it must exempt
// itself. Derived from __filename rather than a literal path: the hardcoded
// 'scripts/check-agent-rules.js' silently stopped matching when the gate moved
// into scripts/ci/, and the gate started reporting its own detection regexes as
// violations.
const SELF_BASENAME = path.basename(__filename);

function isSelfScript(normPath) {
  return path.basename(normPath) === SELF_BASENAME;
}

function checkFile(relPath, findings) {
  const full = path.resolve(cwd, relPath);
  let text = '';
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    return;
  }
  const lines = text.split(/\r?\n/);

  // Normalized relative path for allowlist matching
  const normPath = relPath.replace(/\\/g, '/');
  const isSelf = isSelfScript(normPath);
  const skipOpaqueStatusCheck = isSelf;
  const isTestFile = isTestLikePath(normPath);

  // Rule 1: serviceDefaults.js IS the single source of truth — exempt it entirely
  const isSourceOfTruth = normPath.endsWith('constants/serviceDefaults.js');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Test files are exempt: a test that PINS the canonical endpoint is a guard
    // (the opposite of a hidden hardcode), and test code never runs in production
    // so it cannot become a runtime fork. Consistent with Rule 1b and the
    // opaque-status rule below, which already exempt test files.
    if (!isSourceOfTruth && !isTestFile) {
      for (const re of HARD_ENDPOINT_PATTERNS) {
        if (re.test(line)) {
          // Skip lines that are: JSDoc/comments, template literals with ${}, or
          // string interpolation with dynamic port/host variables
          const trimmed = line.trim();
          if (/^\s*(\/\/|\/?\*|\*|#)/.test(trimmed)) continue; // comment line
          if (/\$\{.*\}/.test(line)) continue; // template string with interpolation
          if (/new URL\(/.test(line)) continue; // URL constructor for parsing (not network)
          // Allow printSuccess/printInfo/console.log display lines with dynamic vars
          if (/(?:printSuccess|printInfo|printError|console\.log)\(/.test(line) && /\$\{/.test(line)) continue;
          // Allow user-facing example text in error/help messages (e.g., "例如 127.0.0.1:7890")
          if (/例如|e\.g\.|example|示例/i.test(line)) continue;
          // Allow Chinese "如 <url>" example phrasing (e.g. "本地 SD (如 http://127.0.0.1:7860)")
          if (/如\s*https?:\/\//.test(line)) continue;
          // Allow proxy-config guidance that shows how to export/set a proxy env var
          // (e.g. "export HTTPS_PROXY=http://127.0.0.1:7890") — instruction text, not a runtime fork
          if (/(?:export|set)\s+\w*PROXY\w*\s*=/i.test(line)) continue;
          // Allow string concatenation with an env/variable port (e.g.
          // 'http://localhost:' + port): nothing is pinned there. But NOT when a
          // quoted numeric port is the fallback (`+ (process.env.PORT || '3000')`)
          // — that re-pins the default port in a non-SoT module, so the backend
          // default and this copy silently drift apart. Import the port from
          // constants/serviceDefaults instead.
          if (/['"]https?:\/\/(?:localhost|127\.0\.0\.1):\s*['"]?\s*\+/.test(line)
              && !/\|\|\s*['"]\d{2,5}['"]/.test(line)) continue;
          // A process.env/os.getenv fallback is intentionally not exempt here.
          // Purely dynamic env-based endpoints never match HARD_ENDPOINT_PATTERNS;
          // reaching this branch means the same line still pins a numeric default.

          pushFinding(
            findings,
            'error',
            'no-hardcoded-endpoint',
            relPath,
            lineNo,
            'Hard-coded host:port detected. Use env/discovery-based config.',
            trimmed,
          );
        }
      }
    }

    // Rule 1b: first-party production domain hardcoded as a literal.
    // Exemptions: the source of truth owns the literal; the gate script names
    // the domain by design; test files that PIN the canonical endpoint are a
    // guard (the opposite of a hidden hardcode), not a runtime fork.
    if (!isSourceOfTruth && !skipOpaqueStatusCheck && !isTestFile && PRODUCTION_HOST_PATTERN.test(line)) {
      const trimmed = line.trim();
      const bypass =
        /^\s*(\/\/|\/?\*|\*|#)/.test(trimmed)                                  // comment line
        || /\$\{[^}]*\}/.test(line)                                            // template interpolation
        || /new URL\(/.test(line)                                              // URL parsing, not a literal default
        || /例如|e\.g\.|example|示例|官网|网址|website|文档|docs|@see|http-equiv/i.test(line) // branding / help / example text
        // NOTE: a `process.env.X || 'https://api.khyquant.top'` fallback is NOT
        // bypassed here. An env-overridable default still bakes the production
        // domain into a non-SoT module, so a domain migration silently forks any
        // install without that env var set. The literal belongs ONLY in a
        // constants/serviceDefaults.js (isSourceOfTruth, which skips this whole
        // block); every other file must import it from there. (Previously this
        // clause let business files like skillRegistry.getRegistryEndpoint hide a
        // hardcoded domain behind an env fallback.)
        // Email address (e.g. admin@khyquant.com) is a contact, not a network
        // host — it cannot strand a module on a migrated endpoint. Only bypass
        // when the domain is NOT also used as an http(s) host on the same line.
        || (/[\w.+-]+@khyquant\.(?:top|com|cn)\b/i.test(line)
            && !/https?:\/\/[^\s'"]*khyquant\.(?:top|com|cn)\b/i.test(line))
        // Host / deployment detection: comparing the CURRENT runtime host against
        // a known first-party domain (e.g. `host.includes('khyquant.top')`,
        // `window.location.hostname === 'khyquant.top'`) READS where the code is
        // running to branch behavior — it declares no network target, so a domain
        // migration cannot strand a call at a dead endpoint (worst case a
        // user-overridable UI default is wrong). This is categorically different
        // from a backend-URL literal (which stays flagged above). Only bypass when
        // the domain is an operand of a host probe (a host/hostname/location value
        // fed to .includes/.endsWith/.startsWith/.indexOf/.match or an (in)equality
        // comparison) AND is NOT also written as an http(s):// endpoint on the same
        // line — so a real hardcoded URL can never slip through this clause.
        || (/\b(?:host(?:name)?|location)\b/i.test(line)
            && /\.(?:includes|endsWith|startsWith|indexOf|match)\s*\(|[!=]==?/.test(line)
            && !/https?:\/\/[^\s'"]*khyquant\.(?:top|com|cn)\b/i.test(line));
      if (!bypass) {
        pushFinding(
          findings,
          'error',
          'no-hardcoded-prod-domain',
          relPath,
          lineNo,
          'Hard-coded first-party production domain. Import the endpoint from constants/serviceDefaults.js (or make it env-overridable).',
          trimmed,
        );
      }
    }

    // Rule 1c: machine-local absolute filesystem paths (see ABS_PATH_PATTERNS).
    // Exemptions mirror Rule 1b: comments, examples/help text, and test files
    // that deliberately pin a path as a fixture.
    if (!isSelf && !isTestFile) {
      const trimmed = line.trim();
      const isComment = /^\s*(\/\/|\/?\*|\*|#)/.test(trimmed);
      const isExample = /例如|e\.g\.|example|示例|@see|如\s|placeholder|占位/i.test(line);
      if (!isComment && !isExample) {
        for (const { re, kind } of ABS_PATH_PATTERNS) {
          if (!re.test(line)) continue;
          // A drive-qualified path inside a glob/ignore pattern or a regex that
          // MATCHES paths (rather than declaring one) is a matcher, not a target.
          if (kind === 'drive-qualified' && /\[A-Za-z\]|\\\\?[A-Za-z]:|test\(|match\(|replace\(/.test(line)) break;
          // OS-standard system dir as an env fallback — see WINDOWS_SYSTEM_DIR_PATTERN.
          if (kind === 'drive-qualified' && WINDOWS_SYSTEM_DIR_PATTERN.test(line)) break;
          const exemption = line.match(/khy-allow-abs-path:\s*(.*)$/i);
          if (exemption) {
            if (exemption[1].trim()) break;
            pushFinding(findings, 'error', 'no-hardcoded-abs-path', relPath, lineNo,
              'Absolute-path exemption requires a non-empty reason.', trimmed);
            break;
          }
          pushFinding(
            findings,
            'error',
            'no-hardcoded-abs-path',
            relPath,
            lineNo,
            kind === 'drive-root'
              ? 'Bare drive root used as a write target — this writes outside the project. Use utils/storageRoots.resolveGeneratedFileDir().'
              : 'Machine-local absolute path detected. Derive it from __dirname / $PSScriptRoot or an env var.',
            trimmed,
          );
          break;
        }
        if (POSIX_HOME_PATH_PATTERN.test(line)) {
          pushFinding(
            findings,
            'error',
            'no-hardcoded-abs-path',
            relPath,
            lineNo,
            'Machine-local home path detected. Use os.homedir() or the resolved data home.',
            trimmed,
          );
        }
      }
    }

    if (!skipOpaqueStatusCheck && !isTestFile && isLikelyUserFacingStatusLine(line)) {
      for (const literal of quotedLiteralsInLine(line)) {
        const lower = literal.toLowerCase();
        const hit = GENERIC_STATUS_TOKENS.some((token) => lower.includes(String(token).toLowerCase()));
        if (!hit) continue;
        if (hasStatusDetail(literal)) continue;

        pushFinding(
          findings,
          'warning',
          'no-opaque-status',
          relPath,
          lineNo,
          'Generic status text detected without explicit action/target/progress.',
          line.trim(),
        );
      }
    }
  }

  // Rule 3: fixed-duration timeouts that TERMINATE work without activity renewal.
  //
  // The trigger is the termination EFFECT, not the mere presence of a timer. A
  // timeout that kills, exits, aborts, rejects, or raises a timed-out flag ends
  // work after a fixed wall clock, which is the banned pattern. A timer with no
  // termination effect is not a timeout at all — it is a scheduler (debounce,
  // drain retry, UI linger, poll) and has nothing to renew against. Flagging
  // those produced most of this rule's output and taught readers to ignore it.
  //
  // Test files are exempt: a `setTimeout(() => resolve(...), 500)` in a test is a
  // fixture simulating a delayed response, not a production task-loop hard-kill.
  // Consistent with Rules 1/1b and the opaque-status rule, which also exempt tests.
  // The gate script itself names these patterns by design — exempt it too.
  const timeoutRegex = /setTimeout\s*\([\s\S]{0,220}?,\s*(\d{3,})\s*\)/g;
  let match;
  while (!isTestFile && !isSelf && (match = timeoutRegex.exec(text)) !== null) {
    const snippet = match[0];
    const timeoutValue = Number(match[1] || 0);
    if (timeoutValue < 500) continue;

    const hasHardKillSignal = HARD_KILL_SIGNALS.some((re) => re.test(snippet));
    // abort()/reject() on their own (no process kill) fail one operation rather
    // than tearing down a process tree — same rule, lower severity.
    const hasSoftTermination = !hasHardKillSignal
      && SOFT_TERMINATION_SIGNALS.some((re) => re.test(snippet));
    if (!hasHardKillSignal && !hasSoftTermination) continue; // scheduler, not a timeout

    const start = Math.max(0, match.index - 500);
    const end = Math.min(text.length, match.index + match[0].length + 500);
    const context = text.slice(start, end);

    // Activity renewal usually lives in the enclosing idle-timeout system rather
    // than inside the timer expression itself — the canonical shape here is a
    // `_resetIdle()` helper re-armed from the child's stdout/stderr 'data'
    // handlers. Checking only the 220-char snippet made the gate warn about
    // compliant idle timeouts whose reset helper sat three lines above.
    const hasIdlePattern = /(?:_?reset\s*Idle|_?idle\s*Timer|lastActivity|resetTimer|idleTimeout|idleMs|IDLE_MS|_resetIdle)/i.test(context);
    const hasProgressSignal = /lastactivity|heartbeat|progress|idle|renew|touch|update/i.test(snippet);
    if (hasIdlePattern || hasProgressSignal) continue; // part of an idle-timeout system

    // Bounded single operations, where there is no activity stream to slide
    // against. These checks previously sat AFTER the no-kill branch's
    // warn-and-`continue`, so reject-only timeouts could never reach them —
    // isRejectOnly was dead code and every `Promise.race` deadline warned.
    const isShortIo = timeoutValue <= 10000
      && /(?:handshake|probe|startup|connect|health|auth|fetch|race)/i.test(context);
    // Grace period after SIGTERM → SIGKILL transitions (process cleanup)
    const isGracePeriod = timeoutValue <= 5000
      && /SIG(?:TERM|KILL)/i.test(snippet) && /SIG(?:TERM|KILL)/i.test(context);
    // Single-shot fetch/request abort (AbortController pattern) — short I/O exempt
    const isFetchAbort = hasSoftTermination && /\.abort\s*\(/i.test(snippet)
      && /(?:controller|abortController|AbortController|fetch\(|request)/i.test(context);
    // reject()-only deadline without process kill (e.g. MCP RPC, Promise.race)
    const isRejectOnly = hasSoftTermination && /reject\(/i.test(snippet)
      && !/\.abort\s*\(/i.test(snippet);

    if (isShortIo || isGracePeriod || isFetchAbort || isRejectOnly) continue;

    const lineNo = text.slice(0, match.index).split(/\r?\n/).length;
    if (hasHardKillSignal) {
      pushFinding(
        findings,
        'error',
        'no-hard-timeout-kill',
        relPath,
        lineNo,
        'Hard timeout kill detected without activity/progress renewal.',
        snippet.replace(/\s+/g, ' ').slice(0, 180),
      );
    } else {
      pushFinding(
        findings,
        'warning',
        'timeout-needs-progress-awareness',
        relPath,
        lineNo,
        'Timeout logic appears fixed; prefer sliding/idle timeout with progress checks.',
        snippet.replace(/\s+/g, ' ').slice(0, 180),
      );
    }
  }

  // Rule 4: ANSI scroll-region escape (DECSTBM, `ESC [ top ; bottom r`).
  // Banned in inline CLIs — it pins a scroll margin that corrupts the parent
  // terminal's scrollback. Legitimate only inside a full-screen alternate
  // buffer (`?1049h` / `?47h`), where it is scoped to a private screen and
  // restored on exit. The check script itself names the pattern, so skip it.
  const scrollRegionSkip = isSelf;
  if (!scrollRegionSkip) {
    // Matches the escaped text forms a tool emits (backslash-x1b, -u001b, -033, -e) and a raw ESC byte.
    // Params before the final lowercase `r` are digits/semicolons or
    // interpolation tokens (%d, ${...}). A bare `[...r` with only those is DECSTBM.
    const scrollRegionRegex = /(?:\\x1[bB]|\\u001[bB]|\\033|\\e|\x1b)\[(?:[\d;]|%d|%i|\$\{[^}]*\})*r/;
    // Alternate-buffer usage anywhere in the file marks a full-screen UI where
    // DECSTBM is in-scope — downgrade to a warning for human confirmation.
    const usesAltBuffer = /\?1049[hl]|\?47[hl]/.test(text);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (/^\s*(?:\/\/|\/?\*|\*|#)/.test(trimmed)) continue; // comment line
      if (!scrollRegionRegex.test(line)) continue;
      pushFinding(
        findings,
        usesAltBuffer ? 'warning' : 'error',
        'no-scroll-region',
        relPath,
        i + 1,
        usesAltBuffer
          ? 'Scroll-region escape (DECSTBM) in a file that uses the alternate buffer — confirm it is scoped to the full-screen UI and restored on exit.'
          : 'Scroll-region escape (DECSTBM) detected in an inline context. It corrupts terminal scrollback; confine it to a full-screen alternate buffer (?1049h).',
        trimmed,
      );
    }
  }
}

function printFindings(findings, scannedCount) {
  if (findings.length === 0) {
    console.log(`Agent rule check passed: no violations found (${scannedCount} file(s) scanned).`);
    return;
  }

  for (const f of findings) {
    const prefix = f.severity === 'error' ? 'ERROR' : 'WARN ';
    console.log(`[${prefix}] ${f.rule} ${f.file}:${f.line}`);
    console.log(`  ${f.message}`);
    if (f.snippet) console.log(`  ${f.snippet}`);
  }

  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warnCount = findings.filter((f) => f.severity === 'warning').length;
  console.log(`\nSummary: ${errorCount} error(s), ${warnCount} warning(s) across ${scannedCount} file(s) scanned.`);
}

function main() {
  const files = gatherFiles();
  // Say what was left out. A gate whose coverage shrank (stale path, skipped
  // submodule) otherwise prints the same "passed" line as one that really looked.
  for (const notice of scanNotices) console.log(`[SKIP ] ${notice}`);

  if (files.length === 0) {
    console.log('No target files found. Use --changed or pass file/directory paths.');
    // An explicit target is an assertion that these paths are scannable. If none
    // resolved, the run proved nothing, so it must not read as a pass. A changed
    // set with no code files (docs-only change) is legitimately empty.
    process.exit(rawTargets.length > 0 ? 1 : 0);
  }

  const findings = [];
  for (const file of files) checkFile(file, findings);
  printFindings(findings, files.length);

  const hasError = findings.some((f) => f.severity === 'error');
  const hasWarn = findings.some((f) => f.severity === 'warning');
  if (hasError || (strictWarnings && hasWarn)) {
    process.exit(1);
  }
}

main();
