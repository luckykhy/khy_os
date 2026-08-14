/**
 * TemplateRegistry — centralized management of prompt templates.
 *
 * Features:
 * - Load templates from filesystem (prompts/*.prompt.md)
 * - In-memory caching with TTL
 * - Variable interpolation ({{var}} → value)
 * - Template composition (@extends, @include)
 */

const fs = require('fs');
const path = require('path');

class TemplateRegistry {
  /**
   * @param {object} options
   * @param {string} options.templatesDir  — root directory containing prompt templates
   * @param {number} options.cacheTtlMs    — cache TTL in milliseconds (default: 5 min)
   * @param {object} options.variables     — global variables available in all templates
   */
  constructor(options = {}) {
    this.templatesDir = options.templatesDir || path.join(__dirname, 'adapters', 'prompts');
    this.cacheTtlMs = options.cacheTtlMs || 5 * 60 * 1000;
    this.globalVariables = options.variables || {};
    this._cache = new Map(); // name → { content, loadedAt }
  }

  /**
   * Load a template by name. Searches:
   * 1. In-memory cache (if not expired)
   * 2. File system (templatesDir/{name}.prompt.md)
   * 3. Built-in fallback templates
   * @param {string} name — template name (e.g. 'slack', 'notion', 'orchestrator')
   * @returns {string|null} — template content or null if not found
   */
  get(name) {
    // Check cache
    const cached = this._cache.get(name);
    if (cached && Date.now() - cached.loadedAt < this.cacheTtlMs) {
      return cached.content;
    }

    // Try filesystem
    const filePath = path.join(this.templatesDir, `${name}.prompt.md`);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      this._cache.set(name, { content, loadedAt: Date.now() });
      return content;
    }

    // Built-in fallbacks
    const builtin = BUILTIN_TEMPLATES[name];
    if (builtin) {
      this._cache.set(name, { content: builtin, loadedAt: Date.now() });
      return builtin;
    }

    return null;
  }

  /**
   * Get a template with variables interpolated.
   * @param {string} name
   * @param {object} variables — per-call variables (merged with global)
   * @returns {string|null}
   */
  render(name, variables = {}) {
    const template = this.get(name);
    if (!template) return null;
    const vars = { ...this.globalVariables, ...variables };
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
  }

  /**
   * List all available templates.
   * @returns {string[]} — template names
   */
  list() {
    const names = new Set();

    // From filesystem
    try {
      if (fs.existsSync(this.templatesDir)) {
        const files = fs.readdirSync(this.templatesDir).filter((f) => f.endsWith('.prompt.md'));
        for (const f of files) names.add(f.replace(/\.prompt\.md$/, ''));
      }
    } catch {
      // ignore
    }

    // Built-in templates
    for (const name of Object.keys(BUILTIN_TEMPLATES)) names.add(name);

    return [...names].sort();
  }

  /**
   * Invalidate a specific template cache entry.
   */
  invalidate(name) {
    this._cache.delete(name);
  }

  /**
   * Clear all caches.
   */
  clearCache() {
    this._cache.clear();
  }

  /**
   * Add or update a global variable.
   */
  setVariable(key, value) {
    this.globalVariables[key] = value;
  }
}

// ── Built-in fallback templates ─────────────────────────────────────────

const BUILTIN_TEMPLATES = {
  // Generic delivery task prompt (used when no specific template exists)
  'generic-delivery': `# 通用交付 Prompt

你是一个内容投递助手。将以下内容投递到指定平台。

## 输入
- 平台: {{platform}}
- 格式: {{format}}
- 内容: {{content}}

## 要求
1. 遵守目标平台的格式规范
2. 保持内容语义完整
3. 处理长度限制和特殊字符
4. 返回标准化的投递结果 JSON

## 输出
返回投递结果，包含 success, platform, message/detail 字段。`,

  // Error handling template
  'error-handler': `# 错误处理 Prompt

投递过程中发生错误，请分析并建议修复方案。

## 错误信息
{{error_message}}

## 上下文
- 平台: {{platform}}
- 任务 ID: {{task_id}}
- 已重试次数: {{retries}}

## 要求
1. 分析错误原因
2. 判断是否可自动修复
3. 提供修复建议
4. 返回建议动作：retry | skip | abort | manual_fix`,

  // Retry template
  'retry': `# 重试投递 Prompt

上次投递失败，正在重试。

## 上次错误
{{last_error}}

## 重试信息
- 这是第 {{attempt}} 次尝试（最多 {{max_retries}} 次）
- 延迟: {{delay_ms}}ms

## 要求
使用相同的投递参数重试，但考虑上次的错误调整参数。`,
};

module.exports = { TemplateRegistry, BUILTIN_TEMPLATES };
