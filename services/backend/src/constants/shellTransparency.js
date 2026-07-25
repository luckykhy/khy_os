'use strict';

/**
 * shellTransparency.js — 纯叶子:shell「透明性命令」许可的单一真源。
 *
 * 背景:khy 此前在两处(BashTool 描述 `tools/shellCommand.js` + 系统提示词
 * `constants/prompts.js`)一刀切劝阻 `find/grep/cat/head/tail/sed/awk/echo`,
 * 把「用 cat/grep/find/sed 替代 Read/Grep/Glob/Edit」的**误用**,与「`echo` 叙述、
 * `head`/`tail` 裁剪噪声输出」的**透明性用途**混为一谈。后者恰是 Claude 频繁使用、
 * 提升透明度的做法,且 `echo` 根本没有 dedicated-tool 替代品。本叶子把「禁误用 +
 * 许可透明性」收敛为唯一真源,供工具描述与系统提示词共同引用,避免两处文案漂移。
 *
 * 契约(纯叶子):零 IO、确定性、绝不抛、单一真源、无副作用。
 * 逃生阀 `KHY_SHELL_TRANSPARENCY`(默认 on)。**关闭即字节回退**:
 * `buildToolAvoidanceBlock()` 返回与今天逐字节相同的原始禁令块,
 * `buildTransparencyItem()` 返回 null(调用方据此不向提示词追加任何条目)。
 */

/** 门控:仅当显式置为 0/false/off/no 时关闭,其余(含未设)均开启。 */
function isEnabled() {
  const raw = String(process.env.KHY_SHELL_TRANSPARENCY || 'on').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

// 关闭态:与改动前 `tools/shellCommand.js` 描述中的禁令块逐字节相同(byte-revert 锚)。
const LEGACY_BLOCK = [
  'IMPORTANT: Avoid using this tool to run find, grep, cat, head, tail, sed, awk, or echo commands unless explicitly instructed. Instead, use the appropriate dedicated tool:',
  ' - File search: Use Glob (NOT find or ls)',
  ' - Content search: Use Grep (NOT grep or rg)',
  ' - Read files: Use Read (NOT cat/head/tail)',
  ' - Edit files: Use Edit (NOT sed/awk)',
  ' - Write files: Use Write (NOT echo >/cat <<EOF)',
].join('\n');

// 开启态:保留对「替代 dedicated tool」的禁令,同时显式许可 echo 叙述 / head·tail 裁剪输出。
const TRANSPARENT_BLOCK = [
  "IMPORTANT: Don't reach for the shell to do what a dedicated tool already does — use the dedicated tool instead:",
  ' - File search: Use Glob (NOT find or ls)',
  ' - Content search: Use Grep (NOT grep or rg)',
  " - Read files: Use Read (NOT cat/head/tail/sed to read a file's contents)",
  ' - Edit files: Use Edit (NOT sed/awk)',
  ' - Write files: Use Write (NOT echo >/cat <<EOF)',
  '',
  'TRANSPARENCY (encouraged — this is how you make work visible, like a careful engineer narrating at a shared terminal):',
  ' - Use `echo` to label what you are about to do and to print short status lines. `echo` has no dedicated-tool equivalent; it is narration, not file I/O.',
  ' - Pipe noisy command output through `head`, `tail`, or `wc -l` to surface just the relevant lines (output-shaping, NOT reading a file).',
  ' - Group related read-only checks into one command with `&&`, separated by `echo "=== label ==="` headers, so the user sees each step and its result.',
  ' - Append a per-step success marker so a chain never succeeds silently: `node -c a.js && echo "a OK" && node -c b.js && echo "b OK"` prints "a OK / b OK". This also avoids the "(No output)" trap — a pipeline ending in `| grep x | head` can exit 0 with empty stdout and render as a bare "no output"; an explicit `&& echo "=== label OK ==="` guarantees a visible result.',
  'The "prefer dedicated tools" rule above targets using cat/grep/find/sed to REPLACE Read/Grep/Glob/Edit. It does NOT discourage echo narration or head/tail output-trimming — those improve transparency and are expected.',
].join('\n');

// 系统提示词命令执行段的正向许可单条(开启态追加;关闭态返 null 不追加)。
// 除 echo 叙述 / head·tail 裁剪外,显式教「结构化分节」的规范写法:当一条命令跑多个
// 相关检查时,用 `echo "=== label ==="` 表头把每步分隔开。这与 BashTool 描述里的同款
// 约定(TRANSPARENT_BLOCK)一致,且前端会据此把输出渲染成带标题的分节块(对齐 CC 的
// 结构化展示)。表头形态固定:`===` 空格 label 空格 `===`,单独成行,便于两端稳定解析。
const TRANSPARENCY_ITEM =
  'Make your work visible at the shell the way a careful engineer narrates at a shared terminal: '
  + 'use `echo` to label steps and print short status lines, and pipe noisy output through `head`/`tail`/`wc` '
  + 'to surface just the relevant lines. When one command runs several related checks, separate the steps with '
  + '`echo "=== label ==="` header lines — use that exact shape (`===`, a space, a short label, a space, `===`, '
  + 'alone on its line) so the step is clearly delimited and the frontend can render each section as a titled '
  + 'block for the user. For a chain of checks that would otherwise succeed silently, append a per-step success '
  + 'marker with `&&` — e.g. `node -c a.js && echo "a OK" && node -c b.js && echo "b OK"` prints a clean '
  + '"a OK / b OK" confirmation instead of nothing. This also avoids the "(No output)" trap: a pipeline that '
  + 'ends in a filter or pager (`... | grep x | head`) can exit 0 with empty stdout, which renders as a bare '
  + '"no output" the reader cannot interpret — an explicit `&& echo "=== <label> OK ==="` guarantees a visible, '
  + 'meaningful result for every step. These transparency uses are encouraged — the "prefer dedicated tools" '
  + 'guidance targets replacing Read/Grep/Glob/Edit with cat/grep/find/sed, not narration or output-shaping.';

/**
 * BashTool 描述里的「禁误用 / 许可透明性」块。
 * 开 → 区分误用与透明性用途;关 → 逐字节返回原始禁令块。
 * @returns {string}
 */
function buildToolAvoidanceBlock() {
  return isEnabled() ? TRANSPARENT_BLOCK : LEGACY_BLOCK;
}

/**
 * 系统提示词命令执行段的透明性正向许可单条。关闭态返 null(调用方不追加)。
 * @returns {string|null}
 */
function buildTransparencyItem() {
  return isEnabled() ? TRANSPARENCY_ITEM : null;
}

module.exports = {
  isEnabled,
  buildToolAvoidanceBlock,
  buildTransparencyItem,
  // 暴露常量便于测试断言 byte-revert(只读引用)。
  LEGACY_BLOCK,
  TRANSPARENT_BLOCK,
  TRANSPARENCY_ITEM,
};
