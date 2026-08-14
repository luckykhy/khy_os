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
 *   node scripts/check-agent-rules.js --changed
 *   node scripts/check-agent-rules.js <file-or-dir> [more...]
 *   node scripts/check-agent-rules.js --changed --strict-warnings
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
  const baseRef = String(process.env.GIT_BASE_REF || '').trim();
  if (baseRef) {
    const out = run(`git diff --name-only --diff-filter=ACMR ${baseRef}...HEAD`);
    if (out) return out.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  const staged = run('git diff --name-only --cached --diff-filter=ACMR');
  if (staged) return staged.split('\n').map((s) => s.trim()).filter(Boolean);

  const head = run('git diff --name-only --diff-filter=ACMR HEAD');
  if (head) return head.split('\n').map((s) => s.trim()).filter(Boolean);
  return [];
}

function shouldIgnore(filePath) {
  const parts = filePath.split(path.sep);
  return parts.some((p) => IGNORE_DIRS.has(p));
}

function collectFilesFromTarget(targetPath, out) {
  const full = path.resolve(cwd, targetPath);
  if (!fs.existsSync(full)) return;
  const st = fs.statSync(full);
  if (st.isDirectory()) {
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

function checkFile(relPath, findings) {
  const full = path.resolve(cwd, relPath);
  let text = '';
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    return;
  }
  const lines = text.split(/\r?\n/);
  const skipOpaqueStatusCheck = relPath.replace(/\\/g, '/') === 'scripts/check-agent-rules.js';

  // Normalized relative path for allowlist matching
  const normPath = relPath.replace(/\\/g, '/');
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
          // Allow string concatenation with env/variable port (e.g., 'http://localhost:' + port)
          if (/['"]https?:\/\/(?:localhost|127\.0\.0\.1):\s*['"]?\s*\+/.test(line)) continue;
          if (/['"]https?:\/\/(?:localhost|127\.0\.0\.1):\s*['"]?\s*\+/.test(line)) continue;
          // Allow os.getenv / process.env fallback defaults (single source of truth pattern)
          if (/os\.getenv\(|process\.env\./i.test(line)) continue;

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

  // Rule 3: setTimeout-based timeout/kill detection.
  // Test files are exempt: a `setTimeout(() => resolve(...), 500)` in a test is a
  // fixture simulating a delayed response, not a production task-loop hard-kill.
  // Consistent with Rules 1/1b and the opaque-status rule, which also exempt tests.
  // The gate script itself contains `setTimeout` only inside this detection
  // regex (by design) — exempt it, as we already do for the opaque-status rule.
  const timeoutRegex = /setTimeout\s*\([\s\S]{0,220}?,\s*(\d{3,})\s*\)/g;
  let match;
  while (!isTestFile && !skipOpaqueStatusCheck && (match = timeoutRegex.exec(text)) !== null) {
    const snippet = match[0];
    const snippetWithoutApiName = snippet.replace(/setTimeout/gi, '');
    const timeoutValue = Number(match[1] || 0);
    const hasHardKillSignal = /(\.kill\(|process\.exit)/i.test(snippet);
    // abort() on its own (no .kill) is typically a fetch/request cancellation — less severe
    const hasAbortOnly = /\.abort\(\)/i.test(snippet) && !hasHardKillSignal;
    const start = Math.max(0, match.index - 500);
    const end = Math.min(text.length, match.index + match[0].length + 500);
    const context = text.slice(start, end);
    const isPromiseSleep = /await\s+new\s+Promise\s*\(/i.test(context)
      && /setTimeout\s*\(\s*(?:[A-Za-z_$][\w$]*|resolve)\s*,\s*\d+\s*\)/.test(snippet);
    const isCounterResetTimer = /(?:^|[{\s;])_?[A-Za-z_$][\w$]*(?:Count|Counter)\s*=\s*0\b/.test(snippet)
      && !/(kill|abort|reject|timeout)/i.test(snippetWithoutApiName);
    const isShortUiResetTimer = timeoutValue <= 5000
      && /clearTimeout\(/i.test(context)
      && /(?:count|counter|debounce|cooldown|hint|tip)/i.test(context)
      && !/(kill|abort|reject|timeout)/i.test(snippetWithoutApiName);
    if (timeoutValue < 500) continue;
    if (isPromiseSleep || isCounterResetTimer || isShortUiResetTimer) continue;
    if (!hasHardKillSignal && !hasAbortOnly) {
      // No kill signal — check for warning
      const hasProgressSignal = /lastactivity|heartbeat|progress|idle|renew|touch|update/i.test(snippet);
      const lineNo = text.slice(0, match.index).split(/\r?\n/).length;
      if (!hasProgressSignal) {
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
      continue;
    }

    // Has kill signal — check broader context (±500 chars) for idle/activity patterns
    const hasIdlePattern = /(?:_?reset\s*Idle|_?idle\s*Timer|lastActivity|resetTimer|idleTimeout|idleMs|IDLE_MS|_resetIdle)/i.test(context);
    const hasProgressSignal = /lastactivity|heartbeat|progress|idle|renew|touch|update/i.test(snippet);

    if (hasIdlePattern || hasProgressSignal) continue; // Part of an idle-timeout system

    // Check for short I/O exempt patterns: <10s timeouts on connect/handshake/probe
    const isShortIo = timeoutValue <= 10000 && /(?:handshake|probe|startup|connect|health|auth|fetch|race)/i.test(context);
    // Grace period after SIGTERM → SIGKILL transitions (process cleanup)
    const isGracePeriod = timeoutValue <= 5000 && /SIG(?:TERM|KILL)/i.test(snippet) && /SIG(?:TERM|KILL)/i.test(context);
    // Single-shot fetch/request abort (AbortController pattern) — short I/O exempt
    const isFetchAbort = hasAbortOnly && /(?:controller|abortController|AbortController|fetch\(|request)/i.test(context);
    // reject()-only timeout without process kill (e.g., MCP RPC, promise-based timeout)
    const isRejectOnly = /reject\(/i.test(snippet) && !hasHardKillSignal && !hasAbortOnly;

    if (isShortIo || isGracePeriod || isFetchAbort || isRejectOnly) continue;

    const lineNo = text.slice(0, match.index).split(/\r?\n/).length;
    pushFinding(
      findings,
      'error',
      'no-hard-timeout-kill',
      relPath,
      lineNo,
      'Hard timeout kill detected without activity/progress renewal.',
      snippet.replace(/\s+/g, ' ').slice(0, 180),
    );
  }

  // Rule 4: ANSI scroll-region escape (DECSTBM, `ESC [ top ; bottom r`).
  // Banned in inline CLIs — it pins a scroll margin that corrupts the parent
  // terminal's scrollback. Legitimate only inside a full-screen alternate
  // buffer (`?1049h` / `?47h`), where it is scoped to a private screen and
  // restored on exit. The check script itself names the pattern, so skip it.
  const scrollRegionSkip = relPath.replace(/\\/g, '/') === 'scripts/check-agent-rules.js';
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

function printFindings(findings) {
  if (findings.length === 0) {
    console.log('Agent rule check passed: no violations found.');
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
  console.log(`\nSummary: ${errorCount} error(s), ${warnCount} warning(s).`);
}

function main() {
  const files = gatherFiles();
  if (files.length === 0) {
    console.log('No target files found. Use --changed or pass file/directory paths.');
    process.exit(0);
  }

  const findings = [];
  for (const file of files) checkFile(file, findings);
  printFindings(findings);

  const hasError = findings.some((f) => f.severity === 'error');
  const hasWarn = findings.some((f) => f.severity === 'warning');
  if (hasError || (strictWarnings && hasWarn)) {
    process.exit(1);
  }
}

main();
