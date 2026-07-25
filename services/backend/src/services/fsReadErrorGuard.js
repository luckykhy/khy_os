'use strict';

/**
 * fsReadErrorGuard.js — 「读文件出现 illegal 提示」的确定式友好化(纯叶子)。
 *
 * 症状取证:`Read`/`readFile` 经 claudeCompat.TOOL_ALIASES 归一到**遗留**扁平工具
 * `tools/readFile.js`——它对目录 `fs.readFileSync` 会抛
 * `EISDIR: illegal operation on a directory, read`,catch 原样返 `err.message`,
 * 于是用户看到裸露的「illegal operation」。守卫的 `FileReadTool` 有 isDirectory 友好
 * 提示但因路由到遗留工具而成死码。
 *
 * 本叶子给遗留读工具补两件事(同时也可复用到 FileReadTool 保持一致):
 *  1. `directoryReadMessage(p, env)` —— 读前 isDirectory 命中时的**友好中文提示**
 *     (「这是一个目录,不能当文件读」+ 指向 ListDir),取代抛 EISDIR。
 *  2. `humanizeReadError(err, p, env)` —— catch 里把常见 fs errno(EISDIR/EACCES/
 *     ENOENT/ENOTDIR/EILSEQ/ELOOP/EMFILE/ENAMETOOLONG)翻成一句人话,**保留 errno
 *     码于括号内**以便 grep 与既有断言。未识别的 err → 原样 `err.message`。
 *
 * 纯叶子契约:零 I/O(不碰 fs,只读传入的 stat/err 对象)、无随机、绝不抛、
 * 门控 `KHY_FS_ERROR_HUMANIZE` 默认开(off ∈ {0,false,off,no})→**逐字节回退**
 * 历史行为(directoryReadMessage 返 null 让调用方照旧抛;humanizeReadError 返
 * 原始 err.message)。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

function isEnabled(env) {
  const raw = env && env.KHY_FS_ERROR_HUMANIZE;
  if (raw === undefined || raw === null || raw === '') return true;
  return !_FALSY.has(String(raw).trim().toLowerCase());
}

// errno → 一句中文人话。保留 code 于句尾括号,便于 grep / 既有断言 / 排障。
const _ERRNO_TEXT = Object.freeze({
  EISDIR: '这是一个目录,不能当作文件读取;若想查看里面有什么,请用 ListDir 工具或 `ls` 列目录',
  ENOENT: '文件或路径不存在,请核对路径拼写与大小写',
  EACCES: '没有读取该文件的权限;请检查文件权限或换一个可访问的路径',
  EPERM: '操作不被允许(权限受限);请检查文件权限',
  ENOTDIR: '路径中间某一段不是目录(把文件当目录用了),请核对路径',
  ELOOP: '符号链接层级过深或成环,无法解析该路径',
  EMFILE: '打开的文件句柄过多,系统资源暂时耗尽,请稍后重试',
  ENFILE: '系统级文件句柄耗尽,请稍后重试',
  ENAMETOOLONG: '路径名过长,超出系统上限',
  EILSEQ: '文件内容不是有效的文本编码,可能是二进制文件',
});

/**
 * 读前目录守卫:命中目录时返回友好提示串;门控关或非目录 → null(调用方照旧)。
 * @param {string} p 已解析路径(仅用于回显,不做 I/O)
 * @param {object} env
 * @returns {string|null}
 */
function directoryReadMessage(p, env) {
  try {
    if (!isEnabled(env)) return null;
    const shown = p == null ? '' : String(p);
    return `这是一个目录,不能当作文件读取:${shown}。若想查看里面有什么,请用 ListDir 工具或 \`ls\` 列目录。(EISDIR)`;
  } catch {
    return null;
  }
}

/**
 * catch 里的 errno 人话化。识别到已知 code → 「<人话>(<CODE>)」;
 * 否则 / 门控关 → 原始 err.message(逐字节回退)。绝不抛。
 * @param {Error} err
 * @param {string} [p]
 * @param {object} [env]
 * @returns {string}
 */
function humanizeReadError(err, p, env) {
  try {
    const raw = err && err.message ? String(err.message) : String(err);
    if (!isEnabled(env)) return raw;
    const code = err && err.code ? String(err.code) : '';
    const text = _ERRNO_TEXT[code];
    if (!text) return raw;
    const shown = p == null ? '' : String(p);
    const tail = shown ? `:${shown}` : '';
    return `${text}${tail}。(${code})`;
  } catch {
    try { return err && err.message ? String(err.message) : String(err); } catch { return 'read failed'; }
  }
}

module.exports = {
  isEnabled,
  directoryReadMessage,
  humanizeReadError,
  _ERRNO_TEXT,
};
