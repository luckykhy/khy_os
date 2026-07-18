const { BaseTool } = require('../_baseTool');

/**
 * KhySelfTool — agent 的自省工具:按需查询「我有哪些功能 + 我装在哪 + 我的源码在哪」。
 *
 * goal「khy 要清楚知道自己有什么功能、装在哪里,不要调用自身功能找不到、搜索自身文件
 * 也找不到,让 khyos 的自知更加清晰」的**主动查询面**。系统提示已推送截断的自知概览
 * (selfProfile.formatForSystemPrompt),本工具补**可查询**面:当 agent 想确认某个具体
 * 命令、列某类全部命令、或按名搜索命令、或确认自身绝对源码路径时,直接调用本工具,而不是
 * 猜命令名 / 到用户 cwd 里瞎找自己的文件。
 *
 * 三个 action:
 *   - commands  列/搜命令目录(消费 commandCatalog SSOT;query 关键词过滤 cmd/label/desc)
 *   - location  返回安装根 / 自身源码目录(绝对路径)/ 数据主目录 / 安装类型
 *   - all(默认) location + commands 概览一并返回
 *
 * 只读、并发安全、绝不抛(内部失败 → success:false + error,不影响会话)。
 */
class KhySelfTool extends BaseTool {
  static toolName = 'KhySelf';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['khy_self', 'self_info', 'whoami_khy', 'khy_where', 'self_locate'];
  static searchHint = 'khy self introspection what commands do I have where am I installed find my own source files install location command catalog';

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `Introspect khy itself — what commands/features it has and where it is installed.

Use this when you need to:
- Find which slash/router commands exist before invoking one (don't guess names).
- Search khy's own command catalog by keyword (e.g. "gateway", "model").
- Learn the ABSOLUTE path to khy's own source dir so you can Grep/Glob/Read your own code
  (those tools accept absolute paths outside the user's working directory).
- Report where khy is installed (install root, data home, install kind: npm/pip/dev).

action:
  "commands" — list or search the command catalog (use "query" to filter).
  "location" — install root, own source dir, data homes, install kind.
  "self_audit" — khyos's self-assessed known issues (the self-audit report:
      each issue's severity, current status, and mitigation module). Use this to
      answer "what are khyos's biggest problems / your limitations" from ground truth.
  "all" (default) — location + a command overview.

Returns structured data; do not confuse khy's own source dir with the user's project cwd.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['commands', 'location', 'self_audit', 'all'],
          description: 'What to introspect. Default "all".',
        },
        query: {
          type: 'string',
          description: 'When action includes commands: filter by keyword across command name/label/description.',
        },
      },
    };
  }

  _loadLocation() {
    try {
      const selfProfile = require('../../services/selfProfile');
      if (typeof selfProfile.getInstallLocation === 'function') {
        return selfProfile.getInstallLocation();
      }
    } catch { /* fall through */ }
    return null;
  }

  _loadCatalog() {
    try {
      const cc = require('../../services/commandCatalog/commandCatalog');
      if (typeof cc.buildCommandCatalog === 'function') {
        return cc.buildCommandCatalog();
      }
    } catch { /* fall through */ }
    return null;
  }

  _loadSelfAudit() {
    try {
      const sar = require('../../services/selfAuditRegistry');
      if (typeof sar.summarize === 'function') {
        return sar.summarize({ env: process.env });
      }
    } catch { /* fall through */ }
    return null;
  }

  _filterCatalog(catalog, query) {
    const q = String(query || '').trim().toLowerCase();
    const cats = Array.isArray(catalog && catalog.categories) ? catalog.categories : [];
    const out = [];
    let matched = 0;
    for (const cat of cats) {
      if (!cat || typeof cat !== 'object') continue;
      const cmds = Array.isArray(cat.commands) ? cat.commands : [];
      const kept = q
        ? cmds.filter(c => {
          const hay = `${c.cmd || ''} ${c.label || ''} ${c.name || ''} ${c.desc || ''}`.toLowerCase();
          return hay.includes(q);
        })
        : cmds;
      if (kept.length === 0) continue;
      matched += kept.length;
      out.push({
        key: cat.key,
        label: cat.label,
        commands: kept.map(c => ({
          cmd: c.cmd,
          label: c.label || '',
          desc: c.desc || '',
          route: c.route || '',
        })),
      });
    }
    return { categories: out, matched };
  }

  async execute(params = {}) {
    const action = ['commands', 'location', 'self_audit', 'all'].includes(params.action) ? params.action : 'all';
    const result = { success: true, action };

    try {
      if (action === 'self_audit' || action === 'all') {
        const audit = this._loadSelfAudit();
        if (audit) {
          result.selfAudit = {
            reportedTotal: audit.meta && audit.meta.reportedTotal,
            trackedInCode: audit.meta && audit.meta.trackedInCode,
            untracked: (audit.meta && audit.meta.untracked) || [],
            note: audit.meta && audit.meta.note,
            issues: audit.items || [],
          };
        } else if (action === 'self_audit') {
          result.selfAudit = null;
        }
      }

      if (action === 'location' || action === 'all') {
        const loc = this._loadLocation();
        if (loc) {
          result.location = {
            installRoot: loc.appRoot || '',
            selfSourceDir: loc.selfSrcDir || '',
            installKind: loc.installKind || 'dev',
            dataHome: loc.dataHome || '',
            projectDataHome: loc.projectDataHome || '',
            baseHome: loc.baseHome || '',
            hint: loc.selfSrcDir
              ? `To read/search khy's own code, pass this ABSOLUTE path to Grep/Glob/Read: ${loc.selfSrcDir}`
              : 'Self source dir unresolved.',
          };
        } else {
          result.location = null;
        }
      }

      if (action === 'commands' || action === 'all') {
        const catalog = this._loadCatalog();
        if (catalog) {
          const { categories, matched } = this._filterCatalog(catalog, params.query);
          result.commands = {
            total: catalog.total || 0,
            matched,
            query: params.query ? String(params.query) : null,
            categories,
            note: 'These are khy\'s own slash/router commands. Full browsable index: /features (TUI) or GET /api/commands.',
          };
        } else {
          result.commands = null;
        }
      }

      // Honest empty-signal: if nothing resolved, say so instead of a silent blank.
      if (action === 'self_audit' && (result.selfAudit === null || result.selfAudit === undefined)) {
        return { success: false, action, error: 'khy self-audit unavailable (selfAuditRegistry not resolvable in this context).' };
      }
      if (result.location === null && (action === 'location' || action === 'all')
        && (result.commands === null || result.commands === undefined)) {
        return { success: false, action, error: 'khy self-introspection unavailable (selfProfile/commandCatalog not resolvable in this context).' };
      }

      return result;
    } catch (err) {
      return { success: false, action, error: `KhySelf introspection failed: ${err && err.message ? err.message : String(err)}` };
    }
  }
}

module.exports = KhySelfTool;
