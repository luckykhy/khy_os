'use strict';

/**
 * Release source-hygiene guard — pure core, zero IO (thin-CLI pattern of
 * check-duplication.js: all filesystem/git IO lives in the CLI wrapper).
 *
 * Answers one question before a release ships: does anything tracked look like
 * a leaked credential, a tracked .env, an unreviewed symlink target, or a
 * LICENSE that drifted from its pinned hash? Findings are advisory data for the
 * release executor; they are never auto-"fixed".
 *
 * Conclusion borrowed (idea grade, proposal 2026-09-18-tier1-minimax-code #3)
 * from the general practice of pre-open-source inventories; exemption policy is
 * deliberately strict: file + exact value only, never whole directories.
 */

const SECRET_PATTERNS = Object.freeze([
  ['provider-key', /\bsk-[A-Za-z0-9_-]{16,}\b/],
  ['github-token', /\bghp_[A-Za-z0-9]{36}\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['private-key-block', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['jwt-bearer', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
]);

const ENV_TRACKED_PATTERN = /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/;
const ENV_TEMPLATE_SUFFIXES = ['.example', '.template', '.sample', '.tpl'];

function scanContent(filePath, content) {
  const findings = [];
  if (typeof content !== 'string' || !content) return findings;
  for (const [name, pattern] of SECRET_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      findings.push({
        code: 'secret-shape',
        pattern: name,
        file: filePath,
        value: match[0],
        message: `${filePath} 命中 ${name} 形态（${match[0].slice(0, 8)}…），发布前须人工确认为假值或加豁免`,
      });
    }
  }
  return findings;
}

function isTrackedEnvFile(relPath) {
  if (!ENV_TRACKED_PATTERN.test(relPath)) return false;
  return !ENV_TEMPLATE_SUFFIXES.some((suffix) => relPath.endsWith(suffix));
}

function evaluateLicensePin({ exists, sha256, pinned }) {
  if (!exists) return { code: 'license-missing', message: '仓库根无 LICENSE 文件（SOURCING-001 已知缺口，发布须书面确认许可）' };
  if (!pinned) return { code: 'license-unpinned', message: '存在 LICENSE 但无哈希锚定，请先固定 sha256', sha256 };
  if (sha256 !== pinned) return { code: 'license-drift', message: `LICENSE 哈希漂移：期望 ${pinned.slice(0, 12)}…，实测 ${sha256.slice(0, 12)}…`, sha256 };
  return { code: 'license-pinned', message: 'LICENSE 与锚定哈希一致', sha256 };
}

// Exemption = exact file + exact matched value. Directory-wide or pattern-wide
// grants are rejected by design (they hide future leaks).
function matchExemption(exemptions, filePath, value) {
  return (exemptions || []).some(
    (entry) => entry && entry.file === filePath && entry.match === value,
  );
}

module.exports = {
  SECRET_PATTERNS,
  scanContent,
  isTrackedEnvFile,
  evaluateLicensePin,
  matchExemption,
};
