'use strict';

const fs = require('fs');
const path = require('path');
const { BaseTool } = require('../_baseTool');
const cg = require('../../services/commentGuidance');
const wmg = require('../../services/weakModelGuidance');

/**
 * CommentGuidanceTool — 「什么地方该写什么样的注释」的确定性教学/审计工具。
 *
 * 用户要求:教 Khyos 做项目、写代码时,什么地方该写什么样的注释。本工具是
 * commentGuidance 引擎对模型的出口:
 *   · guide   —— 注释分层规范(file-header / api-doc / inline-why / todo / none),
 *                每层「该写什么 / 不该写什么 / 放在哪」+ 当前语言的 doc 风格;
 *   · audit   —— 对一段源码(直接给 source,或给 path 读取)做**只读**注释审计,
 *                零假阳性地指出:文件头缺失 / 导出符号无文档 / 整段死代码 / 裸 TODO。
 *
 * 用法:写新文件前 view='guide' 看「哪该写什么注释」→ 落笔 → view='audit' 复检。
 * 取代「把注释规范讲给模型听」的做法——判据可复算,不靠感觉。
 *
 * 只读、并发安全:只做纯文本分析与(可选)只读文件读取,不写盘、不联网。
 */
class CommentGuidanceTool extends BaseTool {
  static toolName = 'CommentGuidance';
  static category = 'analysis';
  static risk = 'safe';
  static aliases = ['comments', 'comment_audit', 'comment_guide', 'doc_audit'];
  static searchHint = '注释 规范 文档 docstring JSDoc 该写什么注释 注释审计 死代码 TODO 文件头 接口文档';

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return [
      '注释规范教学 + 注释审计引擎(确定性,非提示词)。',
      '回答「什么地方该写什么样的注释」,并对源码做只读审计。',
      'view:',
      "  · 'guide'  —— 注释分层规范:file-header(文件头) / api-doc(接口文档) / inline-why(行内为什么) / todo / none,",
      '               每层该写什么、不该写什么、放在哪 + 当前语言的 doc 风格(JSDoc/docstring/Doxygen);',
      "  · 'audit'  —— 给 source(或 path 读文件)做注释审计,零假阳性地报:",
      '               missing-file-header / undocumented-export / commented-out-code / vague-todo;',
      "  · 'full'   —— guide + audit(默认,需提供 source 或 path)。",
      "  · 'weak-model' —— 弱/陌生模型改 khyos 前的**就地护栏 + 示范引导**:各高危位点(工具漏斗 /",
      '               PreToolUse 硬底 / EXEC_APPROVED 戳 / 门控注册表 / 纯叶子写法 / 接线 / 工具自述)',
      '               该守什么不变量、最容易犯什么错、照抄哪个文件。改动前先查此项。',
      '用法:写新文件前用 guide 看「哪该写什么」→ 落笔 → 用 audit 复检。引擎不替你写注释,只给可复算的判据与定位。',
    ].join('\n');
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: '待审计的源码文本(与 path 二选一;两者都给时 source 优先)',
        },
        path: {
          type: 'string',
          description: '待审计的源码文件路径(绝对路径;相对路径按 cwd 解析)。只读读取。',
        },
        lang: {
          type: 'string',
          description: "语言:js/ts/python/c/go/java(缺省由 path 扩展名推断,再缺省按 js)",
        },
        view: {
          type: 'string',
          description: "返回粒度:'full' guide+audit(默认) / 'guide' 仅规范 / 'audit' 仅审计 / 'weak-model' 弱模型就地护栏",
          enum: ['full', 'guide', 'audit', 'weak-model'],
          default: 'full',
        },
      },
      required: [],
    };
  }

  // 弱模型就地护栏出口:与独立的 WeakModelGuidanceTool 同源(都读 weakModelGuidance 叶子),不重复文案。
  // 门控 KHY_WEAK_MODEL_GUIDANCE 关时降级为一条提示,逐字节回退到「无本引擎」。
  _buildWeakModelGuidance() {
    if (!wmg.isEnabled(process.env)) {
      return { enabled: false, note: 'KHY_WEAK_MODEL_GUIDANCE 已关闭:弱模型就地护栏出口已禁用。' };
    }
    return {
      enabled: true,
      directive: wmg.buildWeakModelDirective(),
      sites: wmg.listGuardSites().map(s => ({ ...s, banner: wmg.bannerFor(s.key) })),
      exemplars: wmg.WEAK_MODEL_EXEMPLARS,
      toolCallHint: wmg.toolCallHint(),
    };
  }

  _buildGuide(lang) {
    const syntax = cg.syntaxFor(lang);
    const layers = {};
    for (const [key, v] of Object.entries(cg.COMMENT_LAYERS)) {
      layers[key] = { title: v.title, where: v.where, what: v.what, avoid: v.avoid };
    }
    return {
      lang: cg.normalizeLang(lang),
      docStyle: syntax.doc,
      lineComment: syntax.line,
      layers,
      directive: cg.buildCommentGuidanceDirective(),
    };
  }

  async execute(params = {}) {
    const view = params.view || 'full';

    // guide-only:不需要源码,直接返回分层规范。
    if (view === 'guide') {
      return { success: true, view, guide: this._buildGuide(params.lang) };
    }

    // weak-model:弱/陌生模型改 khyos 前的就地护栏 + 示范引导(不需要源码)。
    if (view === 'weak-model') {
      return { success: true, view, weakModel: this._buildWeakModelGuidance() };
    }

    // audit / full:需要源码——优先 source,否则按 path 只读读取。
    let source = params.source != null ? String(params.source) : '';
    let resolvedPath = '';
    if (!source && params.path) {
      resolvedPath = path.isAbsolute(params.path)
        ? params.path
        : path.resolve(process.cwd(), String(params.path));
      try {
        source = fs.readFileSync(resolvedPath, 'utf8');
      } catch (e) {
        return { success: false, error: `无法读取文件:${resolvedPath}(${e.code || e.message})` };
      }
    }
    if (!source.trim()) {
      return { success: false, error: '没有可审计的源码:请提供 source 或可读的 path' };
    }

    const lang = params.lang || (resolvedPath ? cg.languageFromPath(resolvedPath) : undefined);
    const audit = cg.auditComments({ source, lang, path: resolvedPath || undefined });

    const base = {
      success: true,
      view,
      lang: audit.lang,
      path: resolvedPath || undefined,
      summary: audit.summary,
      findings: audit.findings,
      clean: audit.summary.total === 0,
    };
    if (view === 'audit') return base;

    // full:附上分层规范,便于模型按规范补注释。
    return { ...base, guide: this._buildGuide(audit.lang) };
  }

  getActivityDescription(input) {
    const view = (input && input.view) || 'full';
    if (view === 'guide') return '注释规范查询';
    if (view === 'weak-model') return '弱模型就地护栏查询';
    const where = input && input.path ? `(${path.basename(String(input.path))})` : '';
    return `注释审计${where}`;
  }
}

module.exports = CommentGuidanceTool;
