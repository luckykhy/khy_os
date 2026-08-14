/**
 * MarkdownAdapter — deliver content as Markdown file.
 *
 * Configuration:
 *   markdown.outputDir  — default output directory
 *   markdown.template   — default template name
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BaseAdapter } = require('./baseAdapter');

// ── Template renderer ──────────────────────────────────────────────────

const TEMPLATES = {
  default: (title, content, frontmatter) => {
    let md = '';
    if (frontmatter && Object.keys(frontmatter).length > 0) {
      md += '---\n';
      for (const [k, v] of Object.entries(frontmatter)) {
        const val = Array.isArray(v) ? `[${v.map((x) => `"${x}"`).join(', ')}]` : JSON.stringify(v);
        md += `${k}: ${val}\n`;
      }
      md += '---\n\n';
    }
    if (title) md += `# ${title}\n\n`;
    md += content;
    return md;
  },

  report: (title, content, frontmatter) => {
    let md = '';
    if (frontmatter) {
      md += '---\n';
      for (const [k, v] of Object.entries(frontmatter)) md += `${k}: ${JSON.stringify(v)}\n`;
      md += '---\n\n';
    }
    md += `# ${title || 'Report'}\n\n`;
    md += `> Generated: ${new Date().toISOString()}\n\n`;
    md += '## Summary\n\n';
    // Extract first paragraph as summary
    const firstPara = (content || '').split('\n\n')[0]?.slice(0, 200) || 'No content.';
    md += `${firstPara}\n\n`;
    md += '## Table of Contents\n\n';
    // Auto-generate TOC from headings
    const headings = (content || '').match(/^#{1,3}\s+.+$/gm) || [];
    for (const h of headings) {
      const level = h.match(/^(#+)/)[1].length;
      const text = h.replace(/^#+\s+/, '');
      const indent = '  '.repeat(level - 1);
      md += `${indent}- [${text}](#${slugify(text)})\n`;
    }
    md += '\n---\n\n';
    md += '## Content\n\n' + content;
    return md;
  },

  changelog: (title, content, frontmatter) => {
    const version = frontmatter?.version || 'Unreleased';
    const date = frontmatter?.date || new Date().toISOString().split('T')[0];
    let md = `# Changelog\n\n## [${version}] - ${date}\n\n`;
    md += content || '';
    md += '\n';
    return md;
  },

  readme: (title, content, frontmatter) => {
    let md = `# ${title || 'README'}\n\n`;
    md += '## Description\n\n';
    md += (content || '') + '\n\n';
    md += '## Installation\n\n```bash\nnpm install\n```\n\n';
    md += '## Usage\n\n```bash\nnpm start\n```\n\n';
    md += '## License\n\nMIT\n';
    return md;
  },
};

function slugify(text) {
  return text.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
}

// ── Markdown content formatters ────────────────────────────────────────

function formatStructuredData(data) {
  if (typeof data === 'string') return data;

  if (Array.isArray(data)) {
    if (data.length === 0) return '';
    if (typeof data[0] === 'object' && data[0] !== null) {
      return arrayOfObjectsToTable(data);
    }
    return data.map((item) => `- ${item}`).join('\n');
  }

  if (typeof data === 'object' && data !== null) {
    const lines = Object.entries(data).map(([k, v]) => `- **${k}**: ${formatValue(v)}`);
    return lines.join('\n');
  }

  return String(data);
}

function arrayOfObjectsToTable(arr) {
  if (arr.length === 0) return '';
  const keys = Object.keys(arr[0]);
  if (keys.length > 20) {
    // Too many columns → list format
    return arr.map((row) => `- ${Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(', ')}`).join('\n');
  }
  const header = `| ${keys.join(' | ')} |`;
  const separator = `| ${keys.map(() => '---').join(' | ')} |`;
  const rows = arr.map((row) => `| ${keys.map((k) => String(row[k] ?? '')).join(' | ')} |`);
  return [header, separator, ...rows].join('\n');
}

function formatValue(v) {
  if (v === null || v === undefined) return 'N/A';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ── Adapter ────────────────────────────────────────────────────────────

class MarkdownAdapter extends BaseAdapter {
  constructor(config = {}, logger = console) {
    super(config, logger);
    this._available = true;
  }

  getPlatform() { return 'markdown'; }
  getSupportedFormats() { return ['markdown', 'structured', 'json', 'table']; }

  detect() { return true; }
  validateConfig() { return { valid: true, errors: [], warnings: [] }; }

  async deliver(task) {
    const outputDir = task.output_dir || this.config.outputDir || path.join(process.env.USERPROFILE || process.env.HOME, 'deliveries');
    const templateName = task.template || this.config.template || 'default';

    // Sanitize filename
    let filename = task.filename || `delivery_${Date.now()}.md`;
    filename = filename.replace(/[\/\\:*?"<>|]/g, '_');
    if (!filename.endsWith('.md')) filename += '.md';

    const renderer = TEMPLATES[templateName] || TEMPLATES.default;
    const content = typeof task.content === 'string' ? task.content : formatStructuredData(task.content);
    const frontmatter = task.frontmatter || { generated_at: new Date().toISOString(), platform: 'markdown' };

    try {
      // Ensure directory exists
      fs.mkdirSync(outputDir, { recursive: true });

      const fullPath = path.join(outputDir, filename);
      const rendered = renderer(task.title, content, frontmatter);
      fs.writeFileSync(fullPath, rendered, 'utf-8');

      const stats = fs.statSync(fullPath);
      return this.buildResult(true, {
        filepath: fullPath,
        size_bytes: stats.size,
        lines: rendered.split('\n').length,
        template_used: templateName,
      });
    } catch (err) {
      this.logger.error(`[markdown] Write failed: ${err.message}`);
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        return this.buildResult(false, { error: 'write_permission_denied', message: err.message });
      }
      return this.buildResult(false, { error: 'write_error', message: err.message });
    }
  }
}

module.exports = { MarkdownAdapter, TEMPLATES, formatStructuredData, arrayOfObjectsToTable };
