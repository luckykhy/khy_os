'use strict';

/**
 * skillThreatScanner.js — pure leaf: static threat scan of source text BEFORE it
 * becomes a reusable skill via `/learn` (skillLearningService.learnFrom*).
 *
 * Reference: Hermes Agent v0.18.0 `tools/skills_guard.py`. Hermes scans externally
 * authored skills before install using a category-tagged threat-pattern table and
 * derives a verdict (safe / caution / dangerous) from finding severity. Khy-OS
 * `/learn` distills a skill deterministically from an arbitrary directory or web
 * page (see skillSourceDistiller), so that same untrusted text must be screened for
 * secret exfiltration, prompt injection, destructive commands, persistence, reverse
 * shells, and obfuscation before it is persisted as a skill and re-loaded every
 * session.
 *
 * PURE-LEAF CONTRACT: zero IO (no fs, no network, no require of IO modules),
 * deterministic (same input → byte-identical output), NEVER throws. All source
 * reading / persistence / the block decision live in the caller
 * (skillLearningService). This leaf only classifies text. Gated upstream by
 * KHY_LEARN_SOURCE_THREAT_SCAN (parent KHY_LEARN_FROM_SOURCE).
 *
 * Honest boundary (mirrors Hermes SECURITY.md): a denylist over source strings is
 * a review aid, NOT an isolation boundary. It reduces the blast radius of an
 * obviously-hostile source; it does not make running arbitrary distilled skills
 * safe. The real boundary is a human reading the source.
 */

// Severity → verdict ranking. Only critical/high drive the verdict; medium/low
// are informational (surfaced as warnings, never blocking) — matching Hermes
// _determine_verdict: any critical → dangerous, else any high → caution, else safe.
const _VERDICT_SAFE = 'safe';
const _VERDICT_CAUTION = 'caution';
const _VERDICT_DANGEROUS = 'dangerous';

const _SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

// Zero-width / invisible unicode used to smuggle hidden instructions past a human
// reviewer. Presence in skill source is high severity on its own.
const _INVISIBLE_CHARS = [
  '​', // zero-width space
  '‌', // zero-width non-joiner
  '‍', // zero-width joiner
  '⁠', // word joiner
  '﻿', // BOM / zero-width no-break space
];

// ─────────────────────────────────────────────────────────────────────────────
// HOW-TO-EXTEND (copy-paste recipe — no code reading required):
//   To add a new threat check, append ONE tuple to _THREAT_PATTERNS below:
//     [ /your-regex/i, 'stable_pattern_id', 'severity', 'category', 'one-line description' ]
//   • severity : 'critical' | 'high' | 'medium' | 'low'
//       - critical → source verdict becomes 'dangerous' (blocks persist by default)
//       - high     → source verdict becomes 'caution'   (warns, still persists)
//       - medium/low → informational only (never blocks, never warns to caution)
//   • category : free label for grouping in reports, e.g. 'exfiltration',
//       'injection', 'destructive', 'persistence', 'network', 'obfuscation'.
//   • Use a CASE-INSENSITIVE regex ( /.../i ). Keep pattern_id stable & unique
//       (tests and reports key off it). Do NOT use the global 'g' flag — this
//       leaf calls .test()/.match() per line and a sticky/global regex would
//       carry lastIndex state across calls and break determinism.
//   That's it. runThreatScan() picks it up automatically; add one test asserting
//   a matching line trips it and a benign line does not.
// ─────────────────────────────────────────────────────────────────────────────
const _THREAT_PATTERNS = [
  // ── Exfiltration: shell / HTTP leaking secret env vars ──
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    'env_exfil_curl', 'critical', 'exfiltration',
    'curl command interpolating a secret environment variable'],
  [/wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    'env_exfil_wget', 'critical', 'exfiltration',
    'wget command interpolating a secret environment variable'],
  [/fetch\s*\([^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|API)/i,
    'env_exfil_fetch', 'critical', 'exfiltration',
    'fetch() call interpolating a secret environment variable'],
  [/(?:https?|requests|axios)\.(get|post|put|patch)\s*\([^\n]*(KEY|TOKEN|SECRET|PASSWORD)/i,
    'env_exfil_http_lib', 'critical', 'exfiltration',
    'HTTP client call carrying a secret variable'],

  // ── Exfiltration: reading credential stores ──
  [/(\$HOME|~)\/\.ssh/i, 'ssh_dir_access', 'high', 'exfiltration',
    'references the user SSH directory'],
  [/(\$HOME|~)\/\.aws/i, 'aws_dir_access', 'high', 'exfiltration',
    'references the user AWS credentials directory'],
  [/(\$HOME|~)\/\.gnupg/i, 'gpg_dir_access', 'high', 'exfiltration',
    'references the user GPG keyring'],
  [/(\$HOME|~)\/\.kube/i, 'kube_dir_access', 'high', 'exfiltration',
    'references the Kubernetes config directory'],
  [/(\$HOME|~)\/\.docker/i, 'docker_dir_access', 'high', 'exfiltration',
    'references the Docker config (may hold registry creds)'],
  // Match `cat <secrets-file>` (reading) but NOT `cat > file` / `cat >> file`,
  // which WRITE a file (e.g. a setup doc telling the user to author their own
  // .env). Writing your own config is the opposite of exfiltrating secrets.
  [/cat\s+(?!>)[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i,
    'read_secrets_file', 'critical', 'exfiltration',
    'reads a known secrets file'],

  // ── Exfiltration: programmatic env access ──
  [/printenv|env\s*\|/i, 'dump_all_env', 'high', 'exfiltration',
    'dumps all environment variables'],
  [/os\.(environ|getenv)[^\n]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i,
    'python_env_secret', 'critical', 'exfiltration',
    'reads a secret via os.environ / os.getenv'],
  [/process\.env\[[^\]]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i,
    'node_env_secret', 'critical', 'exfiltration',
    'reads a secret via process.env[...]'],

  // ── Exfiltration: DNS, staging, markdown ──
  [/\b(dig|nslookup|host)\s+[^\n]*\$/i, 'dns_exfil', 'critical', 'exfiltration',
    'DNS lookup with variable interpolation (possible DNS exfiltration)'],
  [/>\s*\/tmp\/[^\s]*\s*&&\s*(curl|wget|nc|python)/i, 'tmp_staging', 'critical', 'exfiltration',
    'writes to /tmp then exfiltrates'],
  [/!\[[^\]]*\]\(https?:\/\/[^)]*\$\{?/i, 'md_image_exfil', 'high', 'exfiltration',
    'markdown image URL with variable interpolation (image-based exfil)'],

  // ── Prompt injection ──
  [/ignore\s+(?:\w+\s+)*(previous|all|above|prior)\s+instructions/i,
    'prompt_injection_ignore', 'critical', 'injection',
    'prompt injection: ignore previous instructions'],
  [/disregard\s+(?:\w+\s+)*(your|all|any)\s+(?:\w+\s+)*(instructions|rules|guidelines)/i,
    'disregard_rules', 'critical', 'injection',
    'instructs the agent to disregard its rules'],
  [/do\s+not\s+(?:\w+\s+)*tell\s+(?:\w+\s+)*the\s+user/i,
    'deception_hide', 'critical', 'injection',
    'instructs the agent to hide information from the user'],
  [/(system|initial)\s+(?:\w+\s+)*prompt\s+(?:\w+\s+)*override/i,
    'sys_prompt_override', 'critical', 'injection',
    'attempts to override the system prompt'],
  [/output\s+(?:\w+\s+)*(system|initial)\s+prompt/i,
    'leak_system_prompt', 'high', 'injection',
    'attempts to extract the system prompt'],
  [/you\s+are\s+(?:\w+\s+)*now\s+/i, 'role_hijack', 'high', 'injection',
    "attempts to override the agent's role"],
  [/<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i,
    'html_comment_injection', 'high', 'injection',
    'hidden instructions inside an HTML comment'],

  // ── Destructive operations ──
  [/rm\s+-rf\s+\//i, 'destructive_root_rm', 'critical', 'destructive',
    'recursive delete from root'],
  [/rm\s+(-[^\s]*)?r[^\n]*(\$HOME|~)|\brmdir\s+[^\n]*(\$HOME|~)/i,
    'destructive_home_rm', 'critical', 'destructive',
    'recursive delete targeting the home directory'],
  [/>\s*\/etc\//i, 'system_overwrite', 'critical', 'destructive',
    'overwrites a system configuration file'],
  [/\bmkfs\b/i, 'format_filesystem', 'critical', 'destructive',
    'formats a filesystem'],
  [/\bdd\s+[^\n]*if=[^\n]*of=\/dev\//i, 'disk_overwrite', 'critical', 'destructive',
    'raw disk write operation'],
  [/chmod\s+777/i, 'insecure_perms', 'medium', 'destructive',
    'sets world-writable permissions'],

  // ── Persistence ──
  [/authorized_keys/i, 'ssh_backdoor', 'critical', 'persistence',
    'modifies SSH authorized_keys'],
  [/\/etc\/sudoers|visudo/i, 'sudoers_mod', 'critical', 'persistence',
    'modifies sudoers (privilege escalation)'],
  [/\bcrontab\b/i, 'persistence_cron', 'medium', 'persistence',
    'modifies cron jobs'],
  [/\.(bashrc|zshrc|profile|bash_profile|zprofile|zlogin)\b/i, 'shell_rc_mod', 'medium', 'persistence',
    'references a shell startup file'],
  [/systemctl\s+(enable|start)|LaunchAgents|LaunchDaemons/i, 'service_persistence', 'medium', 'persistence',
    'references OS service persistence'],

  // ── Network: reverse shells and tunnels ──
  [/\bnc\s+-[lp]|ncat\s+-[lp]|\bsocat\b/i, 'reverse_shell', 'critical', 'network',
    'potential reverse shell listener'],
  [/\/bin\/(ba)?sh\s+-i\b[^\n]*\/dev\/tcp\//i, 'bash_reverse_shell', 'critical', 'network',
    'bash interactive reverse shell via /dev/tcp'],
  [/>&?\s*\/dev\/tcp\//i, 'dev_tcp_redirect', 'critical', 'network',
    'redirect to /dev/tcp (reverse shell channel)'],
  [/python[23]?\s+-c\s+["']import\s+socket/i, 'python_socket_oneliner', 'critical', 'network',
    'Python one-liner socket connection (likely reverse shell)'],
  [/\bngrok\b|\blocaltunnel\b|\bserveo\b|\bcloudflared\b/i, 'tunnel_service', 'high', 'network',
    'uses a tunneling service for external access'],
  [/webhook\.site|requestbin\.com|pipedream\.net|hookbin\.com/i, 'exfil_service', 'high', 'network',
    'references a known exfiltration / webhook-testing service'],

  // ── Obfuscation: encoding and eval ──
  [/base64\s+(-d|--decode)\s*\|/i, 'base64_decode_pipe', 'high', 'obfuscation',
    'base64 decodes and pipes to execution'],
  [/echo\s+[^\n]*\|\s*(bash|sh|python|perl|ruby|node)/i, 'echo_pipe_exec', 'critical', 'obfuscation',
    'echo piped to an interpreter for execution'],
  [/\beval\s*\(\s*["']/i, 'eval_string', 'high', 'obfuscation',
    'eval() with a string argument'],

  // ── Supply chain: pipe remote script straight into a shell ──
  [/(curl|wget)\s+[^\n]*\|\s*(sudo\s+)?(bash|sh|python[23]?)/i, 'pipe_remote_to_shell', 'critical', 'supply_chain',
    'pipes a remotely-fetched script directly into a shell'],
];

function _str(s) { return String(s == null ? '' : s); }

/**
 * Scan source text line-by-line against _THREAT_PATTERNS + invisible-char check.
 * Findings are deduplicated by (patternId, line) and returned in a deterministic
 * order (pattern-table order, then line number) so the same input always yields a
 * byte-identical finding list.
 * @param {string} text
 * @returns {Array<{patternId,severity,category,line,match,description}>}
 */
function _collectFindings(text) {
  const findings = [];
  const src = _str(text);
  if (!src) return findings;
  const lines = src.split('\n');
  const seen = new Set(); // `${patternId}:${lineNo}` dedup

  for (const [regex, patternId, severity, category, description] of _THREAT_PATTERNS) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const m = regex.exec(line);
      if (!m) continue;
      const lineNo = i + 1;
      const key = `${patternId}:${lineNo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        patternId,
        severity,
        category,
        line: lineNo,
        match: _str(m[0]).slice(0, 120),
        description,
      });
    }
  }

  // Invisible / zero-width unicode — hidden-instruction smuggling.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const ch of _INVISIBLE_CHARS) {
      if (line.indexOf(ch) === -1) continue;
      const lineNo = i + 1;
      const key = `invisible_unicode:${lineNo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        patternId: 'invisible_unicode',
        severity: 'high',
        category: 'injection',
        line: lineNo,
        match: '<zero-width/invisible unicode>',
        description: 'contains invisible unicode (possible hidden-instruction smuggling)',
      });
      break; // one finding per line is enough
    }
  }

  return findings;
}

/**
 * Derive the overall verdict from findings (mirrors Hermes _determine_verdict):
 * any critical → 'dangerous'; else any high → 'caution'; else 'safe'
 * (medium/low alone are informational, never blocking).
 */
function deriveVerdict(findings) {
  const list = Array.isArray(findings) ? findings : [];
  if (list.length === 0) return _VERDICT_SAFE;
  if (list.some((f) => f && f.severity === 'critical')) return _VERDICT_DANGEROUS;
  if (list.some((f) => f && f.severity === 'high')) return _VERDICT_CAUTION;
  return _VERDICT_SAFE;
}

/**
 * Build a short human-readable one-line summary of the scan.
 */
function _buildSummary(sourceRef, verdict, findings) {
  const n = Array.isArray(findings) ? findings.length : 0;
  const ref = _str(sourceRef) || 'source';
  if (verdict === _VERDICT_SAFE && n === 0) {
    return `扫描 ${ref}：无威胁模式命中（safe）`;
  }
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    if (f && counts[f.severity] != null) counts[f.severity] += 1;
  }
  const parts = [];
  if (counts.critical) parts.push(`${counts.critical} critical`);
  if (counts.high) parts.push(`${counts.high} high`);
  if (counts.medium) parts.push(`${counts.medium} medium`);
  if (counts.low) parts.push(`${counts.low} low`);
  return `扫描 ${ref}：verdict=${verdict}，命中 ${n} 项（${parts.join('，')}）`;
}

/**
 * Full deterministic scan of one source's text.
 * @param {string} text  the combined source text about to become a skill.
 * @param {{sourceRef?:string}} [options]
 * @returns {{ok:true, verdict:string, findings:Array, summary:string, counts:object}}
 *          NEVER throws; on internal error returns a fail-soft 'safe' result
 *          (the guard must not block learning because the scanner itself broke —
 *          the caller decides blocking; a broken scanner should not become a DoS).
 */
function runThreatScan(text, options = {}) {
  try {
    const findings = _collectFindings(text);
    // Stable order: severity (critical→low), then table order preserved by push.
    findings.sort((a, b) => {
      const sa = _SEVERITY_ORDER[a.severity] == null ? 4 : _SEVERITY_ORDER[a.severity];
      const sb = _SEVERITY_ORDER[b.severity] == null ? 4 : _SEVERITY_ORDER[b.severity];
      if (sa !== sb) return sa - sb;
      return a.line - b.line;
    });
    const verdict = deriveVerdict(findings);
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings) {
      if (counts[f.severity] != null) counts[f.severity] += 1;
    }
    return {
      ok: true,
      verdict,
      findings,
      counts,
      summary: _buildSummary(options && options.sourceRef, verdict, findings),
    };
  } catch (_err) {
    // Fail-soft: scanner internal error must not block learning. Bias to 'safe'.
    return {
      ok: true,
      verdict: _VERDICT_SAFE,
      findings: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
      summary: 'threat-scan-error (fail-soft: treated as safe)',
    };
  }
}

/**
 * Block decision for a scan result (mirrors Hermes should_allow_install intent,
 * adapted: /learn sources are always untrusted "community").
 *   - dangerous : blocked unless force=true
 *   - caution   : allowed, but caller should surface warnings
 *   - safe      : allowed
 * @param {{verdict:string, findings:Array}} scan
 * @param {{force?:boolean}} [options]
 * @returns {{allow:boolean, reason:string}}
 */
function shouldAllowLearn(scan, options = {}) {
  const verdict = scan && scan.verdict ? scan.verdict : _VERDICT_SAFE;
  const force = !!(options && options.force);
  const n = scan && Array.isArray(scan.findings) ? scan.findings.length : 0;
  if (verdict === _VERDICT_DANGEROUS) {
    if (force) {
      return { allow: true, reason: `force 放行（dangerous verdict，${n} 项威胁命中）` };
    }
    return {
      allow: false,
      reason: `已拦截：source 命中危险威胁模式（dangerous，${n} 项）。人工核查源内容后可用 force 显式放行。`,
    };
  }
  if (verdict === _VERDICT_CAUTION) {
    return { allow: true, reason: `放行（caution：${n} 项可疑命中，已附警告）` };
  }
  return { allow: true, reason: 'safe' };
}

module.exports = {
  runThreatScan,
  deriveVerdict,
  shouldAllowLearn,
  _VERDICT_SAFE,
  _VERDICT_CAUTION,
  _VERDICT_DANGEROUS,
  _SEVERITY_ORDER,
  _THREAT_PATTERNS,
  _INVISIBLE_CHARS,
};
