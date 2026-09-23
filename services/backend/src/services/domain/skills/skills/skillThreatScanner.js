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
 * The literal threat-pattern table + severity vocabulary live in the sibling pure
 * leaf `skillThreatPatterns.js` (re-required here by the SAME identifiers, so the
 * public surface exported below stays byte-identical to before the split).
 *
 * Honest boundary (mirrors Hermes SECURITY.md): a denylist over source strings is
 * a review aid, NOT an isolation boundary. It reduces the blast radius of an
 * obviously-hostile source; it does not make running arbitrary distilled skills
 * safe. The real boundary is a human reading the source.
 */

const {
  _VERDICT_SAFE,
  _VERDICT_CAUTION,
  _VERDICT_DANGEROUS,
  _SEVERITY_ORDER,
  _INVISIBLE_CHARS,
  _THREAT_PATTERNS,
} = require('./skillThreatPatterns');

function _str(s) {
  return String(s == null ? '' : s);
}

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
  if (!src) {
    return findings;
  }
  const lines = src.split('\n');
  const seen = new Set(); // `${patternId}:${lineNo}` dedup

  for (const [regex, patternId, severity, category, description] of _THREAT_PATTERNS) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const m = regex.exec(line);
      if (!m) {
        continue;
      }
      const lineNo = i + 1;
      const key = `${patternId}:${lineNo}`;
      if (seen.has(key)) {
        continue;
      }
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
      if (line.indexOf(ch) === -1) {
        continue;
      }
      const lineNo = i + 1;
      const key = `invisible_unicode:${lineNo}`;
      if (seen.has(key)) {
        continue;
      }
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
  if (list.length === 0) {
    return _VERDICT_SAFE;
  }
  if (list.some((f) => f && f.severity === 'critical')) {
    return _VERDICT_DANGEROUS;
  }
  if (list.some((f) => f && f.severity === 'high')) {
    return _VERDICT_CAUTION;
  }
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
    if (f && counts[f.severity] != null) {
      counts[f.severity] += 1;
    }
  }
  const parts = [];
  if (counts.critical) {
    parts.push(`${counts.critical} critical`);
  }
  if (counts.high) {
    parts.push(`${counts.high} high`);
  }
  if (counts.medium) {
    parts.push(`${counts.medium} medium`);
  }
  if (counts.low) {
    parts.push(`${counts.low} low`);
  }
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
      if (sa !== sb) {
        return sa - sb;
      }
      return a.line - b.line;
    });
    const verdict = deriveVerdict(findings);
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings) {
      if (counts[f.severity] != null) {
        counts[f.severity] += 1;
      }
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
