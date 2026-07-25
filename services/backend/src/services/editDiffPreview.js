'use strict';

/**
 * editDiffPreview — 为「待批准的写入类工具调用」计算一份写入前的
 * `{beforeContent, afterContent}` 差异预览,**决不触盘**(不写文件)。
 *
 * 背景(goal「让 khy 的 TUI 拥有 CC 一样的真 code 生产能力」):
 *   Claude Code 在批准编辑前,把红/绿 diff 直接画进授权框里 —— 用户先看清将要写入的
 *   改动,再决定允许/拒绝。khy 的经典(非 Ink)审批路径其实早就构造了 diffInfo 传给
 *   permissionPromptPort;但**默认 UI**——Ink TUI 的 PermissionsPrompt——走的是
 *   onControlRequest 通道,只收到原始 params,**从不渲染 diff**。于是在 `default`
 *   权限模式下,用户是在「看不到 diff」的情况下盲批文件编辑,只有写入之后才在工具结果里
 *   看到红/绿变化。本叶子补上这条接缝的第一半:把待写入的 before/after 纯计算出来,
 *   供 Ink 审批框复用既有 ToolLines.buildWriteDiffRows / renderDiffRows 渲染。
 *
 * 覆盖的写入工具族(CC 归一名,忽略空白/下划线/连字符大小写):
 *   - Write        → after = params.content(新文件时 before='' → 全绿新增预览)
 *   - Edit         → after = 对现有内容施加 old_string→new_string(replace_all 时全替换)
 *   - MultiEdit    → after = 按序施加 edits[] 里每条 old_string→new_string(经典路径**缺**这个)
 *
 * 纯度与安全:除注入的 readFile(默认 fs.readFileSync)外无副作用;任何异常/无法计算/
 * 无可见改动一律返回 `null`(fail-open 到今日的「无预览」行为),决不抛、决不写盘。
 * 门控 KHY_EDIT_DIFF_PREVIEW(默认开,off/0/false/no → CANON 逐字节回退:不计算预览 →
 * Ink 审批框不新增任何渲染,与今日字节等价)。
 */

const { isFlagEnabled } = require('./flagRegistry');

/** CC 归一:小写并去空白/下划线/连字符,让 `Write`/`write_file`/`Edit File` 等归到同一名。 */
function _norm(name) {
  return String(name == null ? '' : name).toLowerCase().replace(/[\s_-]/g, '');
}

const WRITE_TOOLS = new Set(['write', 'writefile', 'createfile']);
const EDIT_TOOLS = new Set(['edit', 'editfile']);
const MULTIEDIT_TOOLS = new Set(['multiedit', 'multieditfile']);

/**
 * 门控查询。未登记/异常 → 保守放行(true),与 flagRegistry 语义一致。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEditDiffPreviewEnabled(env = process.env) {
  try { return isFlagEnabled('KHY_EDIT_DIFF_PREVIEW', env); }
  catch { return true; }
}

/**
 * 本叶子认作「写入类」的工具名集合(归一后),供守卫测试锁死不漂移。
 * @returns {string[]}
 */
function editDiffPreviewToolNames() {
  return [...WRITE_TOOLS, ...EDIT_TOOLS, ...MULTIEDIT_TOOLS];
}

/**
 * 施加一次 old→new 替换到内容上。纯函数。
 *   - oldStr 为空 → null(不猜「在开头插入 / 建新文件」这种歧义语义,宁可无预览)
 *   - 内容不含 oldStr → null(该编辑无法定位 → 不渲染可能出错的预览)
 *   - replace_all → 全部替换;否则仅首次出现。
 * @returns {string|null}
 */
function _applyEdit(content, oldStr, newStr, replaceAll) {
  if (typeof content !== 'string') return null;
  const oldS = oldStr == null ? '' : String(oldStr);
  const newS = newStr == null ? '' : String(newStr);
  if (oldS === '') return null;
  if (!content.includes(oldS)) return null;
  if (replaceAll === true) return content.split(oldS).join(newS);
  const i = content.indexOf(oldS);
  return content.slice(0, i) + newS + content.slice(i + oldS.length);
}

/**
 * 为待批准的写入类工具调用计算 diff 预览(写入前,决不触盘)。
 *
 * @param {string} toolName - 工具名(Write/Edit/MultiEdit,归一处理)
 * @param {object} input    - 工具参数(file_path/content 或 old_string/new_string 或 edits[])
 * @param {object} [opts]   - { env?, readFile?(path)->string }
 * @returns {{beforeContent:string, afterContent:string, filePath:string}|null}
 */
function computeEditDiffPreview(toolName, input, opts = {}) {
  try {
    const o = opts || {};
    const env = o.env || process.env;
    if (!isEditDiffPreviewEnabled(env)) return null;

    const params = (input && typeof input === 'object') ? input : {};
    const name = _norm(toolName);
    const isWrite = WRITE_TOOLS.has(name);
    const isEdit = EDIT_TOOLS.has(name);
    const isMulti = MULTIEDIT_TOOLS.has(name);
    if (!isWrite && !isEdit && !isMulti) return null;

    const filePath = params.file_path || params.filePath || params.path || '';
    if (!filePath || typeof filePath !== 'string') return null;

    const readFile = typeof o.readFile === 'function'
      ? o.readFile
      : (p) => require('fs').readFileSync(p, 'utf8');

    let before = '';
    let existed = true;
    try {
      const raw = readFile(filePath);
      before = typeof raw === 'string' ? raw : '';
    } catch { before = ''; existed = false; }

    let after = null;

    if (isWrite) {
      // Write:after 即 params.content(新文件时 before='' → 全绿新增)。
      const content = params.content;
      if (typeof content !== 'string') return null;
      after = content;
    } else if (isEdit) {
      // Edit:对现有文件内容施加单次 old→new。不存在的文件无从编辑 → 无预览。
      if (!existed) return null;
      const oldStr = params.old_string != null ? params.old_string : params.oldString;
      const newStr = params.new_string != null ? params.new_string : params.newString;
      const replaceAll = params.replace_all === true || params.replaceAll === true;
      after = _applyEdit(before, oldStr, newStr, replaceAll);
      if (after == null) return null;
    } else {
      // MultiEdit:按序施加 edits[]。任一条无法定位 → 整体放弃预览(与「原子」语义一致)。
      if (!existed) return null;
      const edits = Array.isArray(params.edits) ? params.edits : null;
      if (!edits || !edits.length) return null;
      let cur = before;
      for (const e of edits) {
        if (!e || typeof e !== 'object') return null;
        const oldStr = e.old_string != null ? e.old_string : e.oldString;
        const newStr = e.new_string != null ? e.new_string : e.newString;
        const replaceAll = e.replace_all === true || e.replaceAll === true;
        const next = _applyEdit(cur, oldStr, newStr, replaceAll);
        if (next == null) return null;
        cur = next;
      }
      after = cur;
    }

    if (typeof after !== 'string') return null;
    if (before === after) return null; // 无可见改动 → 不渲染

    return { beforeContent: before, afterContent: after, filePath: String(filePath) };
  } catch {
    return null;
  }
}

module.exports = {
  isEditDiffPreviewEnabled,
  computeEditDiffPreview,
  editDiffPreviewToolNames,
  // 内部纯函数导出便于单测。
  _applyEdit,
  _norm,
};
