'use strict';

/**
 * commentGuidance.js
 *
 * 「教 Khyos 写代码时,什么地方该写什么样的注释」的**确定性引擎**(单一真源)。
 *
 * 把「注释规范」这套方法论从「讲给模型听的提示词」下沉成可复算的代码:给定一个代码位置的
 * 上下文(语言 / 作用域 / 是否导出 / 是否非显然),确定性地判定**该处属于哪一层注释、是否
 * 必需、应写什么**;并对一段源码做**只读审计**,指出缺失/冗余/可疑的注释。模型据此落笔或
 * 复检,而不是凭感觉。
 *
 * 纯叶子:无 I/O、无随机、无副作用。只接收字符串/上下文,返回结构化判定——文件读取等副作用
 * 留给上层工具(CommentGuidanceTool)。
 *
 * 设计要点:
 *  - 注释**分层**(不是「写不写」的二元):file-header / api-doc / inline-why / todo / none。
 *    每层有明确的「该写什么」与「不该写什么」,避免「到处堆注释」或「关键处不写」。
 *  - 镜像本仓库自身的「房子风格」:文件头块注释(用途 + 职责 + 纯叶子/单源 + 门控 env + 与
 *    兄弟件关系)、导出符号的 JSDoc/docstring(意图/契约 + @param/@returns)、行内注释解释
 *    **为什么**而非**做什么**(陷阱 / 不变量 / 单位 / 取舍)。
 *  - 审计**零假阳性优先**:只报可判定的结构性问题(文件头缺失 / 导出符号无文档 / 整段被注释
 *    掉的代码 / 无上下文的 TODO);「冗余注释(复述代码)」这类需要语义判断的,只在指令里
 *    提醒,不在审计里硬判,以免误伤。覆盖边界明确不夸大。
 *
 * 与既有件的关系(同「教学方法论 → 确定性引擎」族,正交):
 *  - weipuxiezuo —— 学术降重引擎;projectBlueprint —— 按类型建项目;本件 —— 注释规范。
 *  - god-component 守卫讲「一文件一职责」(结构);本件讲「写好该文件的注释」(可读性)。
 */

// ─── 注释分层(单一真源)─────────────────────────────────────────────────────
// 每一层:what(该写什么)/ avoid(不该写什么)/ where(放在哪)。
const COMMENT_LAYERS = Object.freeze({
  'file-header': {
    title: '文件头注释',
    where: '文件顶部(shebang / "use strict" 之后)',
    what: '本文件的用途、职责边界、关键取舍;若是纯叶子/单源/有 env 门控请点明;与相邻文件的关系',
    avoid: '不要逐行罗列实现;不要写与代码会漂移的细节',
  },
  'api-doc': {
    title: '接口文档注释(函数/方法/类)',
    where: '被注释符号的正上方(JSDoc /** */ / Python docstring / Doxygen)',
    what: '意图与契约(它保证什么)、参数、返回值、抛出/副作用、非显然的前置条件',
    avoid: '不要复述函数名已说清的内容;参数显然时不必逐字解释',
  },
  'inline-why': {
    title: '行内「为什么」注释',
    where: '令人意外的那一行的正上方',
    what: '解释**为什么**这么做:取舍、绕过某个 bug 的原因、不变量、单位、边界处理、陷阱',
    avoid: '不要解释**做了什么**(代码已经说了);不要 `i++ // 自增 i` 这种复述',
  },
  'todo': {
    title: '待办注释',
    where: '相关代码处',
    what: '可执行的待办:做什么、为什么留、(可选)负责人/关联项;让别人能接手',
    avoid: '不要只写 `// TODO 修一下` 这种无上下文的占位',
  },
  'none': {
    title: '不写注释',
    where: '自解释的代码处',
    what: '什么都不写——清晰的命名 + 直白的控制流本身就是文档',
    avoid: '不要用注释复述显而易见的代码,冗余注释会随代码漂移成噪声/误导',
  },
});

// ─── 各语言的注释语法(单一真源)──────────────────────────────────────────────
const LANGUAGE_SYNTAX = Object.freeze({
  js: { line: '//', blockOpen: '/**', blockLine: ' *', blockClose: ' */', doc: 'JSDoc', exportRe: true },
  ts: { line: '//', blockOpen: '/**', blockLine: ' *', blockClose: ' */', doc: 'JSDoc (TSDoc)', exportRe: true },
  python: { line: '#', blockOpen: '"""', blockLine: '', blockClose: '"""', doc: 'docstring', exportRe: false },
  c: { line: '//', blockOpen: '/**', blockLine: ' *', blockClose: ' */', doc: 'Doxygen', exportRe: false },
  go: { line: '//', blockOpen: '//', blockLine: '//', blockClose: '//', doc: 'godoc', exportRe: false },
  java: { line: '//', blockOpen: '/**', blockLine: ' *', blockClose: ' */', doc: 'Javadoc', exportRe: false },
});

const KNOWN_LANGS = Object.freeze({
  js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'ts', typescript: 'ts', tsx: 'ts',
  py: 'python', python: 'python',
  c: 'c', h: 'c', cpp: 'c', cc: 'c', cxx: 'c', hpp: 'c',
  go: 'go', java: 'java',
});

function normalizeLang(lang) {
  const k = String(lang || '').trim().toLowerCase().replace(/^\./, '');
  return KNOWN_LANGS[k] || 'js';
}

/**
 * 由文件扩展名/路径推断语言(供工具读文件时用)。
 * @param {string} pathOrExt
 * @returns {string} 归一化语言键
 */
function languageFromPath(pathOrExt) {
  const m = String(pathOrExt || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return normalizeLang(m ? m[1] : pathOrExt);
}

function syntaxFor(lang) {
  return LANGUAGE_SYNTAX[normalizeLang(lang)] || LANGUAGE_SYNTAX.js;
}

// ─── 注释需求分类(教学核心)──────────────────────────────────────────────────
/**
 * 判定某个代码位置「该写哪一层注释」。确定性规则,非随机。
 *
 * @param {object} ctx
 * @param {string} [ctx.lang]                语言
 * @param {('file'|'class'|'function'|'method'|'block'|'statement')} [ctx.scope]  作用域
 * @param {boolean} [ctx.exported]           是否对外导出 / 公开 API
 * @param {boolean} [ctx.nonObvious]         逻辑是否「非显然」(取舍/绕过/不变量/边界)
 * @param {boolean} [ctx.isWorkaround]       是否是绕过某缺陷的写法
 * @param {boolean} [ctx.isTodo]             是否是待办点
 * @param {number}  [ctx.complexity]         粗略复杂度(分支/行数),>=1 视为有内容
 * @returns {{layer:string, required:boolean, syntax:object, guidance:string}}
 */
function classifyCommentNeed(ctx = {}) {
  const lang = normalizeLang(ctx.lang);
  const syntax = syntaxFor(lang);
  const scope = String(ctx.scope || 'statement').toLowerCase();
  const pick = (layer, required) => ({
    layer,
    required,
    syntax,
    guidance: `${COMMENT_LAYERS[layer].title}:${COMMENT_LAYERS[layer].what}(避免:${COMMENT_LAYERS[layer].avoid})`,
  });

  if (ctx.isTodo) return pick('todo', false);
  if (scope === 'file') return pick('file-header', true);
  if (scope === 'class') return pick('api-doc', true);
  if (scope === 'function' || scope === 'method') {
    // 导出/公开 API 必须有接口文档;私有但复杂的也建议写。
    const required = !!ctx.exported;
    if (required || ctx.nonObvious || Number(ctx.complexity) >= 2) return pick('api-doc', required);
    return pick('none', false);
  }
  // 语句/代码块层:只有「非显然 / 绕过缺陷」才需要行内「为什么」注释;否则不写。
  if (ctx.isWorkaround || ctx.nonObvious) return pick('inline-why', !!ctx.isWorkaround);
  return pick('none', false);
}

// ─── 编码提示词指令(注入 coding profile)──────────────────────────────────────
/**
 * 构建注入「编码 profile」的注释规范指令(确定性,简洁)。
 * 与 _codingProfile 同为英文寄存器,方便混排;门控由调用方决定。
 * @returns {string}
 */
function buildCommentGuidanceDirective() {
  return [
    '## Commenting: what comment belongs where',
    'Comment in layers — not "comment everything", not "comment nothing":',
    '- **File header** (top of a new/non-trivial file): one block stating purpose, responsibility boundary, key trade-offs; for a pure/single-source module say so; note env gates and the relationship to sibling files. Do NOT enumerate the implementation line by line.',
    '- **API doc** (exported function/method/class — REQUIRED; private-but-complex — recommended): state intent/contract, params, return, throws/side-effects, non-obvious preconditions. Skip what the name already says.',
    '- **Inline "why"** (directly above a surprising line ONLY): explain the reason — trade-off, the bug being worked around, an invariant, units, an edge case, a gotcha. Explain WHY, never WHAT.',
    '- **TODO**: actionable, with the reason it is deferred (and owner/ticket if known) — never a bare "// TODO fix later".',
    '- **None**: self-explanatory code gets no comment. Never restate code (`i++ // increment i`); a redundant comment rots into noise as the code drifts.',
    'Match the comment density and doc style (JSDoc / docstring / Doxygen) of the surrounding file. When unsure where a comment belongs, prefer a clear name and a short "why" over a long "what".',
  ].join('\n');
}

// ─── 只读审计(零假阳性优先)─────────────────────────────────────────────────
const EXPORT_DECL_RE = /^(?:module\.exports|exports)\b|^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\b/;
const JS_SYMBOL_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>))/;
const PY_DEF_RE = /^(?:def|class)\s+([A-Za-z_]\w*)/;
// 只认「注释正文以标记打头」的惯用形态(// TODO: ...),不匹配散文里顺带提到的 TODO。
const TODO_RE = /^(TODO|FIXME|XXX)\b[:\s]*(.*)$/;
// 各语言注释引导符,用于剥出注释正文后判 TODO 是否打头。
const COMMENT_LEAD_RE = /^(?:\/\/+|#+|\*+|\/\*+)\s*/;
const CODEISH_COMMENT_RE = /[;{}]\s*$|^\s*(?:return|if|for|while|function|const|let|var|else|switch|case|await|import|export)\b|=>|\)\s*\{?\s*$/;

function _isCommentLine(line, syntax) {
  const t = line.trim();
  return t.startsWith(syntax.line) || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#');
}

function _collectExportedNames(lines) {
  // 收集出现在 module.exports / exports.X / export { ... } 里的符号名,用于判定「导出但无文档」。
  const names = new Set();
  const joined = lines.join('\n');
  let m;
  const re = /(?:module\.exports(?:\.([A-Za-z_$][\w$]*))?\s*=|exports\.([A-Za-z_$][\w$]*)\s*=|export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*))/g;
  while ((m = re.exec(joined)) !== null) {
    for (let i = 1; i <= 3; i++) if (m[i]) names.add(m[i]);
  }
  // module.exports = { a, b, c }
  const objExport = joined.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/);
  if (objExport) {
    for (const part of objExport[1].split(',')) {
      const name = part.split(':')[0].trim().replace(/\s+/g, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

/**
 * 对一段源码做只读注释审计。零假阳性优先:只报可判定的结构性问题。
 *
 * @param {object} input
 * @param {string} input.source   源码
 * @param {string} [input.lang]   语言(或交由 path 推断)
 * @param {string} [input.path]   文件路径(用于推断语言)
 * @returns {{
 *   lang:string,
 *   findings:Array<{kind:string,line:number,severity:string,message:string,suggestion:string}>,
 *   summary:{total:number, byKind:object},
 * }}
 */
function auditComments(input = {}) {
  const source = String(input.source || '');
  const lang = input.lang ? normalizeLang(input.lang) : languageFromPath(input.path || '');
  const syntax = syntaxFor(lang);
  const lines = source.split('\n');
  const findings = [];
  const add = (kind, line, severity, message, suggestion) =>
    findings.push({ kind, line, severity, message, suggestion });

  // 1) 文件头缺失:有实际内容(>15 非空行)且(JS)有导出,但首个有效行不是注释。
  const nonBlank = lines.filter((l) => l.trim());
  const firstMeaningful = lines.findIndex((l) => {
    const t = l.trim();
    return t && !t.startsWith('#!') && t !== "'use strict';" && t !== '"use strict";';
  });
  const exportedNames = syntax.exportRe ? _collectExportedNames(lines) : new Set();
  const hasExport = exportedNames.size > 0;
  if (nonBlank.length > 15 && (!syntax.exportRe || hasExport)) {
    const head = firstMeaningful >= 0 ? lines[firstMeaningful].trim() : '';
    if (!head || !_isCommentLine(head, syntax)) {
      add('missing-file-header', firstMeaningful >= 0 ? firstMeaningful + 1 : 1, 'medium',
        '文件缺少头部注释(用途/职责/关系)', `在文件顶部加一段 ${syntax.doc} 块,说明本文件用途、职责边界与关键取舍`);
    }
  }

  // 2) 导出符号无文档 + 3) 整段被注释掉的代码 + 4) 无上下文的 TODO。
  let runStart = -1, runLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // 被注释掉的代码块:连续 >=2 行「以行注释打头且内容像代码」。
    if (trimmed.startsWith(syntax.line)) {
      const body = trimmed.slice(syntax.line.length).trim();
      if (body && CODEISH_COMMENT_RE.test(body)) {
        if (runStart < 0) runStart = i;
        runLen++;
      } else { runStart = -1; runLen = 0; }
    } else {
      if (runLen >= 2) {
        add('commented-out-code', runStart + 1, 'low',
          `疑似被注释掉的代码(连续 ${runLen} 行)`, '删除死代码;版本历史已经保留它,留在源码里只会误导');
      }
      runStart = -1; runLen = 0;
    }

    // 无上下文 TODO:仅当注释正文以 TODO/FIXME/XXX 打头(惯用标记形态),
    // 散文里顺带提到「TODO」不算。
    if (_isCommentLine(trimmed, syntax)) {
      const body = trimmed.replace(COMMENT_LEAD_RE, '');
      const todo = body.match(TODO_RE);
      if (todo) {
        const rest = String(todo[2] || '').trim();
        if (rest.split(/\s+/).filter(Boolean).length < 3) {
          add('vague-todo', i + 1, 'low',
            `${todo[1]} 缺少上下文`, `补上「做什么 / 为什么留 / 谁来跟进」,否则别人无法接手`);
        }
      }
    }

    // 导出符号无文档(仅 JS/TS,基于上一行是否是注释)。
    if (syntax.exportRe) {
      const sym = raw.match(JS_SYMBOL_RE);
      const name = sym && (sym[1] || sym[2] || sym[3]);
      if (name && exportedNames.has(name)) {
        const prev = i > 0 ? lines[i - 1].trim() : '';
        const documented = prev.endsWith('*/') || prev.startsWith('*') || prev.startsWith(syntax.line);
        if (!documented) {
          add('undocumented-export', i + 1, 'high',
            `导出符号 ${name} 缺少接口文档`, `在 ${name} 上方加 ${syntax.doc}:意图/契约 + @param/@returns + 非显然副作用`);
        }
      }
    } else if (lang === 'python') {
      const def = trimmed.match(PY_DEF_RE);
      // 下划线打头的是私有符号(约定),不强制要求 docstring;判符号名而非整行。
      if (def && !def[1].startsWith('_')) {
        // 公开 def/class 的下一非空行应是 docstring。
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const next = j < lines.length ? lines[j].trim() : '';
        if (!next.startsWith('"""') && !next.startsWith("'''")) {
          add('undocumented-export', i + 1, 'high',
            `公开 ${def[1]} 缺少 docstring`, `紧随定义加一段 docstring:意图/契约、参数、返回、异常`);
        }
      }
    }
  }
  if (runLen >= 2) {
    add('commented-out-code', runStart + 1, 'low',
      `疑似被注释掉的代码(连续 ${runLen} 行)`, '删除死代码;版本历史已经保留它,留在源码里只会误导');
  }

  const byKind = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  return { lang, findings, summary: { total: findings.length, byKind } };
}

module.exports = {
  COMMENT_LAYERS,
  LANGUAGE_SYNTAX,
  normalizeLang,
  languageFromPath,
  syntaxFor,
  classifyCommentNeed,
  buildCommentGuidanceDirective,
  auditComments,
};
