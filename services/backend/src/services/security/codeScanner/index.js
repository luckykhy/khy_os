/**
 * Code Scanner — Extract and scan code blocks from AI responses.
 *
 * Aligned with ANOLISA Agent Sec Core code scanning:
 * - Extracts code blocks (fenced + inline) from AI output
 * - Detects dangerous patterns: shell injection, secret exfil,
 *   SSTI, command substitution, env var access
 * - Returns structured findings with severity classification
 *
 * Cross-platform: works on Linux, macOS, and Windows.
 */

'use strict';

// ─── Dangerous Code Patterns ────────────────────────────────────────────────

// SSOT for ascending severity ranking within the scan pair (this module +
// securityScan). Kept here so the scanner stays free of heavier deps.
const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'];

const SCAN_RULES = [
  // Shell injection
  {
    id: 'SHELL_INJECTION_BACKTICK',
    pattern: /`[^`]*(?:rm|curl|wget|nc|bash|sh|python|perl|ruby)[^`]*`/gi,
    severity: 'high',
    category: 'shell_injection',
    description: 'Command execution via backtick substitution',
  },
  {
    id: 'SHELL_INJECTION_SUBSHELL',
    pattern: /\$\([^)]*(?:rm|curl|wget|nc|bash|sh|python|perl|ruby)[^)]*\)/gi,
    severity: 'high',
    category: 'shell_injection',
    description: 'Command execution via $() subshell',
  },
  {
    id: 'SHELL_PIPE_EXEC',
    pattern: /(?:curl|wget)\s+[^\n]*\|\s*(?:bash|sh|zsh|python|perl|node)/gi,
    severity: 'critical',
    category: 'shell_injection',
    description: 'Remote code download and execution via pipe',
  },
  {
    id: 'EVAL_EXEC',
    pattern: /\b(?:eval|exec|execSync|spawnSync)\s*\(/gi,
    severity: 'medium',
    category: 'shell_injection',
    description: 'Dynamic code evaluation or execution',
  },

  // Secret / credential exfiltration
  {
    id: 'ENV_SECRET_ACCESS',
    pattern: /process\.env\[?\s*['"](?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS|AWS_|OPENAI_|ANTHROPIC_)[^'"]*['"]/gi,
    severity: 'high',
    category: 'secret_exfil',
    description: 'Access to sensitive environment variables',
  },
  {
    id: 'FILE_SECRET_READ',
    pattern: /(?:readFile|readFileSync|open)\s*\(\s*['"](?:\/etc\/shadow|\/etc\/passwd|~?\/?\.ssh\/|~?\/?\.env|~?\/?\.aws\/|~?\/?\.gnupg\/)/gi,
    severity: 'critical',
    category: 'secret_exfil',
    description: 'Reading sensitive system files',
  },
  {
    id: 'HARDCODED_SECRET',
    pattern: /(?:api[_-]?key|secret|token|password|credentials)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{16,}['"]/gi,
    severity: 'medium',
    category: 'secret_exfil',
    description: 'Hardcoded secret or API key in code',
  },

  // Network exfiltration
  {
    id: 'NETWORK_EXFIL',
    pattern: /(?:fetch|axios|http\.request|XMLHttpRequest|net\.connect)\s*\(\s*['"]https?:\/\/(?!localhost|127\.0\.0\.1)/gi,
    severity: 'medium',
    category: 'network_exfil',
    description: 'Outbound HTTP request to external host',
  },
  {
    id: 'REVERSE_SHELL_CODE',
    pattern: /new\s+(?:net\.Socket|WebSocket)\s*\(.*(?:connect|send)/gi,
    severity: 'critical',
    category: 'network_exfil',
    description: 'Potential reverse shell via socket connection',
  },

  // Filesystem destruction
  {
    id: 'FS_RECURSIVE_DELETE',
    pattern: /(?:rmSync|rmdirSync|rm\s+-rf|rimraf)\s*\(\s*['"]\/(?!\w)/gi,
    severity: 'critical',
    category: 'fs_destruction',
    description: 'Recursive filesystem deletion from root',
  },
  {
    id: 'FS_OVERWRITE',
    pattern: /(?:writeFileSync|writeFile)\s*\(\s*['"](?:\/etc\/|\/usr\/|\/bin\/|\/boot\/)/gi,
    severity: 'critical',
    category: 'fs_destruction',
    description: 'Writing to protected system paths',
  },

  // Privilege escalation
  {
    id: 'SUDO_EXEC',
    pattern: /(?:exec|spawn|execSync)\s*\(\s*['"]sudo\b/gi,
    severity: 'high',
    category: 'privilege_escalation',
    description: 'Executing commands with sudo',
  },
  {
    id: 'SETUID_CHANGE',
    pattern: /(?:chmodSync|chmod)\s*\(\s*[^,]+,\s*['"]?(?:4755|2755|6755|u\+s)/gi,
    severity: 'critical',
    category: 'privilege_escalation',
    description: 'Setting setuid/setgid bit on file',
  },

  // SSTI (Server-Side Template Injection)
  {
    id: 'SSTI_PATTERN',
    pattern: /\{\{.*(?:__class__|__builtins__|__import__|__subclasses__).*\}\}/gi,
    severity: 'critical',
    category: 'ssti',
    description: 'Server-side template injection payload',
  },

  // SQL injection
  {
    id: 'SQL_INJECTION_CONCAT',
    pattern: /(?:query|execute|raw)\s*\(\s*['"`](?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b[^'"`]*['"]\s*\+/gi,
    severity: 'high',
    category: 'sql_injection',
    description: 'SQL query with string concatenation (injection risk)',
  },

  // Prototype pollution
  {
    id: 'PROTO_POLLUTION',
    pattern: /\[?\s*['"](?:__proto__|constructor|prototype)['"]\s*\]?\s*[=.]/gi,
    severity: 'high',
    category: 'prototype_pollution',
    description: 'Potential prototype pollution attack',
  },
];

// ─── Code Block Extraction ──────────────────────────────────────────────────

const FENCED_CODE_RE = /```(?:\w+)?\n([\s\S]*?)```/g;
const INLINE_CODE_RE = /`([^`]{10,})`/g;

/**
 * Extract code blocks from text (markdown fenced + inline).
 * @param {string} text - AI response or any text
 * @returns {Array<{ code: string, language: string|null, offset: number }>}
 */
function extractCodeBlocks(text) {
  if (!text || typeof text !== 'string') return [];

  const blocks = [];
  let match;

  // Fenced code blocks
  const fenced = /```(\w+)?\n([\s\S]*?)```/g;
  while ((match = fenced.exec(text)) !== null) {
    blocks.push({
      code: match[2],
      language: match[1] || null,
      offset: match.index,
    });
  }

  // Inline code (only if substantial, >10 chars)
  while ((match = INLINE_CODE_RE.exec(text)) !== null) {
    blocks.push({
      code: match[1],
      language: null,
      offset: match.index,
    });
  }

  return blocks;
}

/**
 * Scan a single code block against all rules.
 * @param {string} code - Code string to scan
 * @returns {Array<{ ruleId: string, severity: string, category: string, description: string, match: string }>}
 */
function scanCode(code) {
  if (!code || typeof code !== 'string') return [];

  const findings = [];
  for (const rule of SCAN_RULES) {
    // Reset regex state (global flag)
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(code)) !== null) {
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        category: rule.category,
        description: rule.description,
        match: match[0].slice(0, 120),
      });
    }
  }
  return findings;
}

/**
 * Scan AI response text: extract code blocks and scan each one.
 * @param {string} text - Full AI response
 * @returns {{ safe: boolean, totalFindings: number, findings: Array, codeBlocks: number, highestSeverity: string|null }}
 */
function scanResponse(text) {
  const blocks = extractCodeBlocks(text);
  const allFindings = [];

  for (const block of blocks) {
    const blockFindings = scanCode(block.code);
    for (const f of blockFindings) {
      allFindings.push({ ...f, language: block.language, offset: block.offset });
    }
  }

  // Also scan the raw text for inline dangerous patterns
  const inlineFindings = scanCode(text);
  for (const f of inlineFindings) {
    // Deduplicate: skip if already found in a code block
    if (!allFindings.some(af => af.ruleId === f.ruleId && af.match === f.match)) {
      allFindings.push(f);
    }
  }

  const severityOrder = SEVERITY_ORDER;
  let highestSeverity = null;
  for (const f of allFindings) {
    if (!highestSeverity || severityOrder.indexOf(f.severity) > severityOrder.indexOf(highestSeverity)) {
      highestSeverity = f.severity;
    }
  }

  return {
    safe: allFindings.length === 0,
    totalFindings: allFindings.length,
    findings: allFindings,
    codeBlocks: blocks.length,
    highestSeverity,
  };
}

module.exports = {
  extractCodeBlocks,
  scanCode,
  scanResponse,
  SCAN_RULES,
  SEVERITY_ORDER,
};
