'use strict';

// [AI-弱模型·照抄] 本文件是**纯叶子**:零 IO、确定性、绝不抛(坏输入返安全默认)、可单测、
//   关闭即字节回退(门控在调用方 promptComposerService 处施加)。判定/文本处理全在叶子里,
//   IO(建临时文件、起编辑器、读回、删除)由服务层做。

/**
 * promptComposer.js — 纯叶子:$EDITOR 长提示词撰写的**文本处理核心**。
 * (移植自 Hermes Agent v0.18.0 /prompt:在编辑器里从容写多行长提示词,再原样发给 Agent。)
 *
 * 拆分理由(照抄 Hermes 的可测性设计):把「起编辑器 + 临时文件」这类副作用留在服务层,
 * 把「拼种子内容 / 剥哨兵行 / 判空」这类纯逻辑收进本叶子 —— 无需真的拉起编辑器即可单测。
 *
 * 哨兵行约定:种子文件顶部写若干以 `#!` 起头的**指引行**(告诉用户怎么用);存回后这些行被剥掉,
 * 只保留用户真正写的正文。`#!` 选它是因为极少出现在自然提示词开头,且与 shebang `#!` 呼应、直观。
 *
 * 纯叶子契约:零 IO(无 fs/net/process/无参 Date)、确定性(同输入→同输出)、绝不抛。
 */

// 指引行/正文分隔的哨兵前缀。存回后凡以此起头的行一律剥除。
const SENTINEL = '#!';

// 种子文件顶部的指引行(不含 SENTINEL 前缀,由 buildComposerSeed 统一加)。中文,面向用户。
const _SEED_GUIDE_LINES = [
  '在下面写你的提示词(支持多行 / Markdown)。写完保存并关闭编辑器即发送。',
  '以 #! 起头的行是说明,不会发送;正文留空则不发送任何内容。',
];

// 收敛到 utils/toStr 单一真源(逐字节委托,调用点不变)
const _str = require('../utils/toStr').toStr;

/**
 * 拼装种子文件内容:顶部若干 `#! ` 指引行 + 空行 + 可选初始正文。纯函数、不抛。
 * @param {string} [initialText] - 命令后附带的初始正文(如 `prompt compose 帮我写...`)
 * @returns {string}
 */
function buildComposerSeed(initialText) {
  const guide = _SEED_GUIDE_LINES.map((l) => `${SENTINEL} ${l}`);
  const body = _str(initialText);
  // 顶部指引 + 空行分隔;有初始正文则接在后面,便于用户在其基础上续写。
  return `${guide.join('\n')}\n\n${body}`;
}

/**
 * 剥离哨兵指引行并归一:按行拆(容 CRLF),丢弃以 SENTINEL 起头的行,其余原样保留,最后整体 trim。
 * 纯函数、绝不抛;坏输入 → 空串。
 * @param {string} raw - 编辑器存回的原始文件内容
 * @returns {string}
 */
function stripComposerSentinels(raw) {
  const s = _str(raw);
  const kept = s.split(/\r?\n/).filter((line) => !line.startsWith(SENTINEL));
  return kept.join('\n').trim();
}

/**
 * 提示词是否为空(trim 后无内容)。纯函数、不抛。用于「空则不发送」判定。
 * @param {string} text
 * @returns {boolean}
 */
function isBlankPrompt(text) {
  return _str(text).trim().length === 0;
}

module.exports = {
  SENTINEL,
  buildComposerSeed,
  stripComposerSentinels,
  isBlankPrompt,
};
