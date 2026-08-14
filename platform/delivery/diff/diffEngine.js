/**
 * DiffEngine — cross-platform content consistency checker.
 *
 * Checks: R1 semantic consistency, R2 truncation, R3 format compliance,
 *         R4 link validity, R5 sensitive info leak, R6 platform features.
 */

const crypto = require('crypto');

// ── Sensitive data patterns ─────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  { pattern: /xoxb-[A-Za-z0-9-]+/g, label: 'Slack Bot Token' },
  { pattern: /sk-[A-Za-z0-9-]+/g, label: 'OpenAI Secret Key' },
  { pattern: /ghp_[A-Za-z0-9]{36}/g, label: 'GitHub Personal Access Token' },
  { pattern: /Bearer\s+[A-Za-z0-9\-_.]+/gi, label: 'Bearer Token' },
  { pattern: /api[_-]?key['":\s]+['"]?[A-Za-z0-9]{16,}/gi, label: 'API Key' },
  { pattern: /password['":\s]+['"]?[^'"]{4,}/gi, label: 'Password' },
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi, label: 'Private Key' },
];

// ── Platform limits ─────────────────────────────────────────────────────

const PLATFORM_LIMITS = {
  slack: { maxMessageLength: 40000, maxBlocks: 50, maxSegmentLength: 3500 },
  notion: { maxBlocks: 100 },
  markdown: { maxFileSize: 10 * 1024 * 1024 }, // 10MB
  webhook: { maxPayloadSize: 10 * 1024 * 1024 },
  email: { maxAttachmentSize: 25 * 1024 * 1024 },
};

// ── Core checker ────────────────────────────────────────────────────────

class DiffEngine {
  constructor(logger = console) {
    this.logger = logger;
  }

  /**
   * Run all checks against a set of deliveries.
   * @param {object} input — { task_id, content_source, deliveries[] }
   * @returns {DiffReport}
   */
  check(input) {
    const issues = [];
    const signatures = {};

    // Compute content signatures
    for (const delivery of input.deliveries) {
      const content = delivery.rendered_content || '';
      signatures[delivery.platform] = this._hash(content);
    }

    // R1: Semantic consistency
    issues.push(...this._checkR1SemanticConsistency(input));

    // R2: Truncation
    issues.push(...this._checkR2Truncation(input));

    // R3: Format compliance
    issues.push(...this._checkR3FormatCompliance(input));

    // R4: Link validity
    issues.push(...this._checkR4Links(input));

    // R5: Sensitive info leak
    issues.push(...this._checkR5SensitiveInfo(input));

    // R6: Platform features
    issues.push(...this._checkR6PlatformFeatures(input));

    // Determine overall status
    const criticalCount = issues.filter((i) => i.severity === 'critical').length;
    const highCount = issues.filter((i) => i.severity === 'high').length;
    let overallStatus = 'pass';
    if (criticalCount > 0 || highCount >= 2) overallStatus = 'fail';
    else if (issues.some((i) => i.severity === 'high' || i.severity === 'medium')) overallStatus = 'warn';

    let recommendation = 'continue';
    if (overallStatus === 'fail') recommendation = 'abort';
    else if (overallStatus === 'warn') recommendation = 'fix_and_retry';

    return {
      task_id: input.task_id,
      overall_status: overallStatus,
      checked_at: new Date().toISOString(),
      summary: {
        total_checks: issues.length,
        passed: issues.filter((i) => i.severity === 'low').length,
        warnings: issues.filter((i) => i.severity === 'medium').length,
        failures: issues.filter((i) => i.severity === 'critical' || i.severity === 'high').length,
      },
      issues,
      signatures,
      recommendation,
    };
  }

  // ── R1: Semantic Consistency ──────────────────────────────────────────

  _checkR1SemanticConsistency(input) {
    const issues = [];
    const deliveries = input.deliveries.filter((d) => d.result?.success);

    if (deliveries.length < 2) return issues;

    // Extract key entities: numbers, dates, URLs
    const entityPattern = /(\d+\.?\d*)|(\d{4}-\d{2}-\d{2})|(https?:\/\/[^\s]+)/g;

    const allEntities = deliveries.map((d) => {
      const text = d.rendered_content || '';
      const entities = new Set();
      let match;
      while ((match = entityPattern.exec(text)) !== null) {
        entities.add(match[0]);
      }
      return { platform: d.platform, entities };
    });

    // Compare each pair
    for (let i = 0; i < allEntities.length; i++) {
      for (let j = i + 1; j < allEntities.length; j++) {
        const a = allEntities[i];
        const b = allEntities[j];
        const onlyInA = [...a.entities].filter((e) => !b.entities.has(e));
        const onlyInB = [...b.entities].filter((e) => !a.entities.has(e));

        if (onlyInA.length > 0 || onlyInB.length > 0) {
          issues.push({
            severity: 'critical',
            rule: 'R1',
            platforms: [a.platform, b.platform],
            description: `Semantic mismatch between ${a.platform} and ${b.platform}: ` +
              `only in ${a.platform}: ${onlyInA.join(', ')}; ` +
              `only in ${b.platform}: ${onlyInB.join(', ')}`,
            suggestion: 'Review source content and ensure all key entities are present in all platforms.',
            auto_fixable: false,
          });
        }
      }
    }

    return issues;
  }

  // ── R2: Truncation ────────────────────────────────────────────────────

  _checkR2Truncation(input) {
    const issues = [];

    for (const delivery of input.deliveries) {
      if (!delivery.result?.success) continue;
      const platform = delivery.platform;
      const content = delivery.rendered_content || '';
      const limits = PLATFORM_LIMITS[platform];

      if (!limits) continue;

      if (limits.maxMessageLength && content.length > limits.maxMessageLength) {
        issues.push({
          severity: 'high',
          rule: 'R2',
          platform,
          description: `Content length (${content.length}) exceeds platform limit (${limits.maxMessageLength} chars).`,
          suggestion: `Split message into segments of max ${limits.maxSegmentLength || limits.maxMessageLength} chars.`,
          auto_fixable: true,
          auto_fix: { action: 'resend_with_truncation', params: { max_segment_length: limits.maxSegmentLength || 3500 } },
        });
      }

      if (limits.maxBlocks) {
        const blockCount = (delivery.rendered_blocks || []).length;
        if (blockCount > limits.maxBlocks) {
          issues.push({
            severity: 'high',
            rule: 'R2',
            platform,
            description: `Block count (${blockCount}) exceeds platform limit (${limits.maxBlocks}).`,
            suggestion: `Reduce blocks to under ${limits.maxBlocks} or split into multiple pages.`,
            auto_fixable: true,
            auto_fix: { action: 'resend_with_truncation', params: { max_blocks: limits.maxBlocks } },
          });
        }
      }

      if (limits.maxFileSize) {
        const fileSize = delivery.result?.size_bytes || 0;
        if (fileSize > limits.maxFileSize) {
          issues.push({
            severity: 'high',
            rule: 'R2',
            platform,
            description: `File size (${fileSize} bytes) exceeds limit (${limits.maxFileSize} bytes).`,
            suggestion: 'Compress content or split into multiple files.',
            auto_fixable: false,
          });
        }
      }
    }

    return issues;
  }

  // ── R3: Format Compliance ─────────────────────────────────────────────

  _checkR3FormatCompliance(input) {
    const issues = [];

    for (const delivery of input.deliveries) {
      if (!delivery.result?.success) continue;
      const platform = delivery.platform;
      const content = delivery.rendered_content || '';

      if (platform === 'slack') {
        // Slack should use blocks, not just plain text
        if (!delivery.rendered_blocks && content.length > 100) {
          issues.push({
            severity: 'medium',
            rule: 'R3',
            platform,
            description: 'Slack message uses plain text instead of Block Kit.',
            suggestion: 'Use Block Kit sections for richer formatting.',
            auto_fixable: true,
            auto_fix: { action: 'resend_with_correction', params: { use_blocks: true } },
          });
        }
      }

      if (platform === 'notion') {
        // Notion should use proper block types
        const invalidBlocks = (delivery.rendered_blocks || []).filter(
          (b) => !['heading_1', 'heading_2', 'heading_3', 'paragraph', 'code', 'bulleted_list_item', 'numbered_list_item', 'quote', 'divider'].includes(b.type)
        );
        if (invalidBlocks.length > 0) {
          issues.push({
            severity: 'medium',
            rule: 'R3',
            platform,
            description: `Notion contains ${invalidBlocks.length} invalid block types: ${invalidBlocks.map((b) => b.type).join(', ')}`,
            suggestion: 'Replace invalid blocks with supported Notion block types.',
            auto_fixable: false,
          });
        }
      }

      if (platform === 'markdown') {
        if (delivery.result?.filepath && !delivery.result.filepath.endsWith('.md')) {
          issues.push({
            severity: 'medium',
            rule: 'R3',
            platform,
            description: `Markdown file does not have .md extension: ${delivery.result.filepath}`,
            suggestion: 'Rename file to have .md extension.',
            auto_fixable: true,
            auto_fix: { action: 'resend_with_correction', params: { fix_extension: true } },
          });
        }
      }
    }

    return issues;
  }

  // ── R4: Link Validity ─────────────────────────────────────────────────

  _checkR4Links(input) {
    const issues = [];
    const urlPattern = /https?:\/\/[^\s)"'>]+/g;

    for (const delivery of input.deliveries) {
      if (!delivery.result?.success) continue;
      const content = delivery.rendered_content || '';
      const urls = content.match(urlPattern) || [];

      for (const rawUrl of urls) {
        const url = rawUrl.replace(/[.,;:!?)\]}]+$/, ''); // strip trailing punctuation
        if (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('0.0.0.0')) {
          issues.push({
            severity: 'medium',
            rule: 'R4',
            platform: delivery.platform,
            description: `Internal URL detected in ${delivery.platform}: ${url}`,
            suggestion: 'Internal URLs are not accessible to external recipients.',
            auto_fixable: false,
          });
        }
      }
    }

    return issues;
  }

  // ── R5: Sensitive Info Leak ───────────────────────────────────────────

  _checkR5SensitiveInfo(input) {
    const issues = [];

    for (const delivery of input.deliveries) {
      if (!delivery.result?.success) continue;
      const content = delivery.rendered_content || '';

      for (const { pattern, label } of SENSITIVE_PATTERNS) {
        const matches = content.match(pattern);
        if (matches && matches.length > 0) {
          issues.push({
            severity: 'critical',
            rule: 'R5',
            platform: delivery.platform,
            description: `${label} leaked in ${delivery.platform}: ${matches.length} occurrence(s) of ${label}`,
            suggestion: `Remove or redact ${label} before delivering to ${delivery.platform}.`,
            auto_fixable: true,
            auto_fix: { action: 'redact_and_resend', params: { pattern: pattern.source, label } },
          });
        }
      }
    }

    return issues;
  }

  // ── R6: Platform Features ─────────────────────────────────────────────

  _checkR6PlatformFeatures(input) {
    const issues = [];

    for (const delivery of input.deliveries) {
      if (!delivery.result?.success) continue;
      const platform = delivery.platform;
      const content = delivery.rendered_content || '';

      if (platform === 'slack' && !content.includes(':') && content.length > 50) {
        issues.push({
          severity: 'low',
          rule: 'R6',
          platform,
          description: 'Slack message could benefit from emoji for visual emphasis.',
          suggestion: 'Add relevant emoji (e.g., :rocket:, :white_check_mark:) to improve readability.',
          auto_fixable: false,
        });
      }

      if (platform === 'notion' && !delivery.rendered_blocks?.some((b) => b.type?.startsWith('heading_'))) {
        issues.push({
          severity: 'low',
          rule: 'R6',
          platform,
          description: 'Notion page lacks heading structure.',
          suggestion: 'Add heading_1 / heading_2 blocks to improve page navigation.',
          auto_fixable: false,
        });
      }
    }

    return issues;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  _hash(text) {
    return crypto.createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 16);
  }
}

module.exports = { DiffEngine };
