/**
 * NotionAdapter — deliver content to Notion via REST API.
 *
 * Configuration:
 *   notion.apiKey  — secret_xxx 或 Bearer token
 *   notion.defaultPageId — 默认父页面 ID
 */

const https = require('https');
const { BaseAdapter } = require('./baseAdapter');

// ── Markdown → Notion blocks converter ─────────────────────────────────

function markdownToBlocks(md) {
  const blocks = [];
  const lines = md.split('\n');
  let inCodeBlock = false;
  let codeLines = [];
  let codeLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code fence
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      if (inCodeBlock) {
        blocks.push({
          type: 'code',
          code: { rich_text: [{ type: 'text', text: codeLines.join('\n') }], language: codeLang || 'plain text' },
        });
        codeLines = [];
        codeLang = '';
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeLang = fenceMatch[1] || 'plain text';
      }
      continue;
    }
    if (inCodeBlock) { codeLines.push(line); continue; }

    // Skip empty lines
    if (!line.trim()) continue;

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].replace(/\*\*(.+?)\*\*/g, '$1');
      blocks.push({
        type: `heading_${level}`,
        [`heading_${level}`]: { rich_text: [{ type: 'text', text }] },
      });
      continue;
    }

    // Quote
    if (line.startsWith('> ')) {
      blocks.push({
        type: 'quote',
        quote: { rich_text: [{ type: 'text', text: line.slice(2) }] },
      });
      continue;
    }

    // Code inline
    if (line.startsWith('    ') || line.startsWith('\t')) {
      blocks.push({
        type: 'code',
        code: { rich_text: [{ type: 'text', text: line.trim() }], language: 'plain text' },
      });
      continue;
    }

    // Bullet list
    if (line.match(/^[-*]\s/)) {
      blocks.push({
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: line.replace(/^[-*]\s/, '') }] },
      });
      continue;
    }

    // Numbered list
    const numMatch = line.match(/^(\d+)\.\s(.+)/);
    if (numMatch) {
      blocks.push({
        type: 'numbered_list_item',
        numbered_list_item: { rich_text: [{ type: 'text', text: numMatch[2] }] },
      });
      continue;
    }

    // Divider
    if (line.match(/^---+$/)) {
      blocks.push({ type: 'divider', divider: {} });
      continue;
    }

    // Table (simple detection)
    if (line.includes('|')) {
      blocks.push({ type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: line }] } });
      continue;
    }

    // Default: paragraph
    blocks.push({ type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: line }] } });
  }

  return blocks;
}

// ── Adapter ────────────────────────────────────────────────────────────

class NotionAdapter extends BaseAdapter {
  constructor(config = {}, logger = console) {
    super(config, logger);
    this._available = null;
  }

  getPlatform() { return 'notion'; }
  getSupportedFormats() { return ['markdown', 'blocks', 'database']; }

  detect() {
    if (this._available !== null) return this._available;
    const key = this.config.apiKey || this.config.notion?.apiKey;
    this._available = !!key;
    return this._available;
  }

  validateConfig() {
    const key = this.config.apiKey || this.config.notion?.apiKey;
    const errors = [];
    if (!key) errors.push('Missing notion.apiKey in config');
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  async deliver(task) {
    const apiKey = this.config.apiKey || this.config.notion?.apiKey;
    const defaultPageId = this.config.defaultPageId || this.config.notion?.defaultPageId;

    // Database mode
    if (task.database_id) {
      return this._createDatabaseEntry(task, apiKey);
    }

    // Page mode
    const parentId = task.parent_page_id || defaultPageId;
    if (!parentId) {
      return this.buildResult(false, {
        error: 'no_parent',
        message: 'No parent_page_id or default page configured.',
      });
    }

    const blocks = markdownToBlocks(task.content || task.text || '');
    const payload = {
      parent: { page_id: parentId },
      properties: {
        title: { title: [{ text: { content: task.title || 'Untitled' } }] },
      },
      children: blocks.slice(0, 100), // Notion limit
    };

    if (task.icon) payload.icon = { type: 'emoji', emoji: task.icon };
    if (task.cover) payload.cover = { type: 'external', external: { url: task.cover } };

    try {
      const page = await this._callNotionAPI('POST', '/v1/pages', payload, apiKey);
      return this.buildResult(true, {
        page_id: page.id,
        url: page.url,
        mode: 'create',
        blocks_created: blocks.length,
        raw: { id: page.id },
      });
    } catch (err) {
      return this.buildResult(false, { error: this._mapError(err.message), message: err.message });
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────

  async _createDatabaseEntry(task, apiKey) {
    const properties = task.properties || {};
    const mappedProperties = {};

    for (const [key, value] of Object.entries(properties)) {
      if (typeof value === 'string') {
        mappedProperties[key] = { title: [{ text: { content: value } }] };
      } else if (Array.isArray(value)) {
        mappedProperties[key] = { multi_select: value.map((v) => ({ name: v })) };
      } else if (typeof value === 'number') {
        mappedProperties[key] = { number: value };
      }
    }

    const payload = {
      parent: { database_id: task.database_id },
      properties: mappedProperties,
    };

    try {
      const page = await this._callNotionAPI('POST', '/v1/pages', payload, apiKey);
      return this.buildResult(true, {
        page_id: page.id,
        url: page.url,
        mode: 'database_entry',
        properties_updated: Object.keys(properties),
      });
    } catch (err) {
      return this.buildResult(false, { error: this._mapError(err.message), message: err.message });
    }
  }

  _callNotionAPI(method, path, body, apiKey) {
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify(body);
      const options = {
        hostname: 'api.notion.com',
        path,
        method,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
        timeout: 30_000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error(`Notion returned invalid JSON: ${data.slice(0, 200)}`)); }
          } else {
            try {
              const err = JSON.parse(data);
              reject(new Error(`Notion ${res.statusCode}: ${err.message || JSON.stringify(err)}`));
            } catch {
              reject(new Error(`Notion HTTP ${res.statusCode}`));
            }
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Notion API timeout')); });
      req.write(bodyStr);
      req.end();
    });
  }

  _mapError(message) {
    const m = message.toLowerCase();
    if (m.includes('not_found')) return 'not_found';
    if (m.includes('unauthorized')) return 'auth_error';
    if (m.includes('validation')) return 'validation_error';
    if (m.includes('rate')) return 'rate_limited';
    if (m.includes('conflict')) return 'conflict';
    return 'unknown_error';
  }
}

module.exports = { NotionAdapter };
