'use strict';

/**
 * Bash 命令注释标签 — 忠实移植 Claude Code 的
 * `BashTool/commentLabel.ts` (`extractBashCommentLabel`)。
 *
 * 背景(对齐 CC 后端逻辑):当模型在 bash 命令**首行写 `# 注释`**(非 `#!` shebang)时,
 * 那行注释就是「模型专为人类写的可读标签」——CC 把它当作工具用途的**权威标签**与折叠组
 * ⎿ 提示,优先于任何从命令动词猜出来的描述。Khy 旧逻辑(toolDisplay `_describeToolIntent`)
 * 只按命令动词(git/npm/rm…)猜标签,**忽略了模型自己写的真实意图注释**——而注释才是最真实
 * 的标签(绑模型真实陈述,非启发式猜测)。
 *
 * 纯叶子:零 IO、确定性、绝不抛、门控。门控 `KHY_BASH_COMMENT_LABEL`(默认开);
 * 关 / 首行非 `#` 注释 / 异常 → 返回 undefined,调用方逐字节回退旧动词猜测路径。
 *
 * CC 口径:首行 `.trim()` 后须以 `#` 开头且非 `#!`;剥掉前导 `#`+空白;空标签返 undefined。
 * 显示截断上限对齐 CC MAX_COMMAND_DISPLAY_CHARS = 160(超出截断 + `…`)。
 */

const MAX_LABEL_CHARS = 160; // CC MAX_COMMAND_DISPLAY_CHARS

function _gateOff(env) {
  const v = String((env && env.KHY_BASH_COMMENT_LABEL) || '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

/**
 * 提取首行 `# 注释` 标签。无注释/门控关/异常 → undefined。
 * @param {string} command
 * @param {object} [env]
 * @returns {string|undefined}
 */
function extractBashCommentLabel(command, env) {
  try {
    if (_gateOff(env || (typeof process !== 'undefined' ? process.env : undefined))) return undefined;
    const cmd = String(command == null ? '' : command);
    const nl = cmd.indexOf('\n');
    const firstLine = (nl === -1 ? cmd : cmd.slice(0, nl)).trim();
    if (!firstLine.startsWith('#') || firstLine.startsWith('#!')) return undefined;
    const label = firstLine.replace(/^#+\s*/, '');
    return label || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 提取并按显示上限截断(超 MAX_LABEL_CHARS → 截断 + `…`)。供 UI 直接消费。
 * @param {string} command
 * @param {object} [env]
 * @returns {string|undefined}
 */
function extractBashCommentLabelForDisplay(command, env) {
  const label = extractBashCommentLabel(command, env);
  if (!label) return undefined;
  return label.length > MAX_LABEL_CHARS ? label.slice(0, MAX_LABEL_CHARS) + '…' : label;
}

module.exports = {
  extractBashCommentLabel,
  extractBashCommentLabelForDisplay,
  MAX_LABEL_CHARS,
};
