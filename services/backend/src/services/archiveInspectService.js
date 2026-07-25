'use strict';

/**
 * archiveInspectService.js — 薄 I/O 层:安全地「列出压缩包目录 + 内存窥探小文本条目」。
 *
 * 与 archiveManifestPolicy(纯叶子)分工:
 *  - 叶子:什么算压缩包 / 用哪种策略 / 哪些条目值得窥探 / 清单怎么呈现(单一真源、零 I/O)。
 *  - 本层:真正打开压缩包列条目、按叶子的选择窥探条目内容。lazy-require zip/tar 库,绝不抛。
 *
 * 安全:只**列目录 / 内存读取**条目内容,绝不把任何条目落盘解压 → 无 zip-slip 路径穿越写入;
 * 窥探条目数 / 每条字节 / 总字符均由叶子上限约束 → 防 zip-bomb 在读取侧炸内存。
 * 整个压缩包尺寸超上限则只尝试列目录(zip 列中央目录极廉价),tar 同步读取受 MAX_ARCHIVE_BYTES 守护。
 *
 * 全部返回结构化结果(success/entries/totalEntries/truncated/peeks/error),由调用方喂给叶子的
 * buildArchiveManifest 生成提示词块。任何异常都被吞掉并以 {success:false,error} 形式诚实上报。
 */

const fs = require('fs');
const policy = require('./archiveManifestPolicy');

// 单个压缩包尺寸守护(tar 同步路径会整体读取;zip 仅读中央目录,但仍设上限防极端)。
const MAX_ARCHIVE_BYTES = Math.max(
  1024 * 1024,
  parseInt(String(process.env.KHY_ARCHIVE_MAX_BYTES || '209715200'), 10) || 209715200 // 200 MB
);
// 列出条目的硬上限(防超大归档列表本身吃内存;远高于清单展示上限)。
const MAX_LIST_ENTRIES = Math.max(
  100,
  parseInt(String(process.env.KHY_ARCHIVE_MAX_LIST_ENTRIES || '2000'), 10) || 2000
);

function _statSafe(filePath) {
  try { return fs.statSync(filePath); } catch { return null; }
}

function _bufferToText(buf, maxChars) {
  try {
    if (!buf || !buf.length) return '';
    // 二进制嗅探:头部出现 NUL 字节 → 视为二进制,不窥探。
    const head = buf.subarray(0, Math.min(buf.length, 1024));
    if (head.includes(0)) return '';
    const text = buf.toString('utf-8');
    const normalized = String(text).replace(/\r\n/g, '\n');
    return normalized.length > maxChars ? normalized.slice(0, maxChars) : normalized;
  } catch {
    return '';
  }
}

async function _inspectZip(filePath, env) {
  let StreamZip;
  try { StreamZip = require('node-stream-zip'); } catch { return { success: false, error: 'zip 列表库不可用' }; }
  let zip = null;
  try {
    zip = new StreamZip.async({ file: filePath });
    const entriesMap = await zip.entries();
    const all = Object.values(entriesMap || {}).map((e) => ({
      name: String(e.name || ''),
      size: Number(e.size || 0) || 0,
      isDirectory: !!e.isDirectory,
    }));
    const fileEntries = all.filter((e) => !e.isDirectory);
    const totalEntries = fileEntries.length;
    const listed = fileEntries.slice(0, MAX_LIST_ENTRIES);

    const peeks = [];
    const peekTargets = policy.selectPeekEntries(fileEntries, { env });
    const maxChars = policy.peekMaxChars(env);
    for (const target of peekTargets) {
      try {
        const buf = await zip.entryData(target.name);
        const text = _bufferToText(buf, maxChars);
        if (text) peeks.push({ name: target.name, text });
      } catch { /* 单条窥探失败不影响整体 */ }
    }
    return { success: true, entries: listed, totalEntries, truncated: totalEntries > listed.length, peeks };
  } catch (err) {
    return { success: false, error: `zip 列表失败: ${(err && err.message) || 'unknown'}` };
  } finally {
    if (zip) { try { await zip.close(); } catch { /* ignore */ } }
  }
}

function _inspectTar(filePath, env) {
  // tar 同步路径整体读取文件 → 受尺寸守护(zip 不受此限,因只读中央目录)。
  const stat = _statSafe(filePath);
  if (stat && stat.size > MAX_ARCHIVE_BYTES) {
    return { success: false, error: `压缩包过大(${stat.size} 字节),跳过列目录` };
  }
  let tar;
  try { tar = require('tar'); } catch { return { success: false, error: 'tar 列表库不可用' }; }
  try {
    const entries = [];
    tar.t({
      file: filePath,
      sync: true,
      onentry(e) {
        if (entries.length >= MAX_LIST_ENTRIES) return;
        const type = String((e && e.type) || '');
        entries.push({
          name: String((e && e.path) || ''),
          size: Number((e && e.size) || 0) || 0,
          isDirectory: type === 'Directory' || type === '5',
        });
      },
    });
    const fileEntries = entries.filter((e) => !e.isDirectory);
    // tar 为 list-only(无内存窥探:node-tar 取条目内容需流式额外解码,刻意保持懒)。
    return {
      success: true,
      entries: fileEntries,
      totalEntries: fileEntries.length,
      truncated: entries.length >= MAX_LIST_ENTRIES,
      peeks: [],
    };
  } catch (err) {
    return { success: false, error: `tar 列表失败: ${(err && err.message) || 'unknown'}` };
  }
}

/**
 * 检视压缩包,返回结构化结果(绝不抛)。门控关 / 非压缩包 → {success:false, skipped:true}。
 * @returns {Promise<{success:boolean, kindToken?:string, name?:string, mimeType?:string,
 *   entries?:Array, totalEntries?:number, truncated?:boolean, peeks?:Array, error?:string, skipped?:boolean}>}
 */
async function inspectArchive(filePath, mimeType, opts = {}) {
  const env = opts.env || process.env;
  try {
    if (!policy.isEnabled(env)) return { success: false, skipped: true };
    if (!filePath) return { success: false, error: '无文件路径' };
    const strategy = policy.archiveStrategyForPath(filePath, env);
    if (!strategy) return { success: false, skipped: true };

    const name = opts.name || require('path').basename(String(filePath));
    const mime = mimeType || policy.mimeForArchive(filePath, env) || 'application/octet-stream';

    if (strategy === 'unsupported') {
      return { success: false, kindToken: 'unsupported', name, mimeType: mime, error: '该压缩格式暂不支持列出内容(支持 .zip / .tar / .tar.gz)' };
    }

    const stat = _statSafe(filePath);
    if (stat && stat.size <= 0) {
      return { success: false, kindToken: strategy, name, mimeType: mime, error: '压缩包为空或无法读取' };
    }

    const result = strategy === 'zip' ? await _inspectZip(filePath, env) : _inspectTar(filePath, env);
    return { ...result, kindToken: strategy, name, mimeType: mime };
  } catch (err) {
    return { success: false, error: `压缩包检视失败: ${(err && err.message) || 'unknown'}` };
  }
}

/**
 * 便捷:检视 + 直接产出提示词清单块(委派叶子格式化)。失败/不支持仍返回诚实清单块。
 * @returns {Promise<string>}  '' 表示门控关 / 非压缩包 / 完全无可呈现内容
 */
async function inspectArchiveToManifest(filePath, mimeType, opts = {}) {
  const env = opts.env || process.env;
  const res = await inspectArchive(filePath, mimeType, opts);
  if (res.skipped) return '';
  return policy.buildArchiveManifest({
    env,
    name: res.name || (filePath ? require('path').basename(String(filePath)) : 'archive'),
    mimeType: res.mimeType || mimeType || 'application/octet-stream',
    entries: res.entries || [],
    totalEntries: res.totalEntries,
    peeks: res.peeks || [],
    error: res.error || '',
  });
}

module.exports = {
  inspectArchive,
  inspectArchiveToManifest,
};
