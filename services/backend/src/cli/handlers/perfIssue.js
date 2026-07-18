'use strict';

/**
 * perfIssue.js — `/perf-issue` 命令薄壳:生成本会话「性能报告」(token/成本/回合/墙钟),
 * 写到本地数据目录,**不联网、不上传**(对齐 Claude Code 的 perf-issue 的离线本质)。
 *
 * 真正的「背后逻辑」(聚合 + 渲染)在纯叶子 perfReport.js;本薄壳只做 IO:
 *   1. 从 tokenUsageService.getSessionUsage() 取本会话真实 token/成本/逐请求 records;
 *   2. 解析会话 JSONL transcript(经 sessionPersistence.jsonlPathFor)派生回合数/墙钟;
 *   3. 交叶子聚合 + 渲染(md/json/csv);
 *   4. 写到 getDataDir('perf-reports')(绝不硬编码 ~/.claude 等路径),并打印报告 + 落盘路径。
 *
 * **诚实边界(数据模型与 CC 不同)**:CC 的会话 JSONL 内嵌每回合 token 用量且记录每工具耗时;
 * khy 的 JSONL schema 不含用量字段、khy 不记录每工具耗时/缓存命中。故本报告**从 khy 真有的来源
 * 聚合**(tokenUsageService 的会话用量 + transcript 的 role/timestamp),**绝不编造**它不记录的字段。
 *
 * 门控 KHY_PERF_ISSUE 默认开;关 → 命令不接管(字节回退到「无此命令」的历史世界)。
 *
 * 用法:
 *   /perf-issue                 → 当前(最近)会话,markdown 报告
 *   /perf-issue --format=json   → JSON 报告
 *   /perf-issue --format=csv    → CSV(按模型分解)
 *   /perf-issue <sessionId>     → 指定会话
 */

const fs = require('fs');
const path = require('path');
const { printInfo, printError, printWarn } = require('../formatters');
const perfReport = require('../../services/perf/perfReport');

// transcript 读取上限,防超大 JSONL OOM;超过只取尾部(性能视图关注近况)。
const MAX_TRANSCRIPT_LINES = 20000;

const _VALID_FORMATS = new Set(['md', 'json', 'csv']);
const _EXT = { md: 'md', json: 'json', csv: 'csv' };

/** 从参数里解析 --format=,默认 md;非法值回退 md。 */
function _parseFormat(subCommand, args) {
  const all = [subCommand, ...(Array.isArray(args) ? args : [])].filter(Boolean).map(String);
  for (const a of all) {
    const m = /^--format=(.+)$/.exec(a.trim());
    if (m) {
      const f = m[1].trim().toLowerCase();
      return _VALID_FORMATS.has(f) ? f : 'md';
    }
  }
  return 'md';
}

/** 第一个非 --flag 的位置参数 = 显式 sessionId(可空)。 */
function _parseSessionArg(subCommand, args) {
  const all = [subCommand, ...(Array.isArray(args) ? args : [])].filter(Boolean).map(String);
  for (const a of all) {
    const t = a.trim();
    if (t && !t.startsWith('--')) return t;
  }
  return '';
}

/** 解析会话 JSONL → 条目数组(fail-soft:逐行 JSON.parse,坏行跳过;文件不存在 → 空数组)。 */
function _readTranscript(file) {
  let raw;
  try {
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return [];
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  let lines = raw.split('\n');
  if (lines.length > MAX_TRANSCRIPT_LINES) lines = lines.slice(-MAX_TRANSCRIPT_LINES);
  const out = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch {
      // 坏行跳过(诚实:部分写入/截断行不致整份报告失败)。
    }
  }
  return out;
}

/**
 * @param {string} subCommand 第一个位置参数(sessionId 或 --format,可空)
 * @param {string[]} args 其余参数
 * @returns {Promise<boolean>}
 */
async function handlePerfIssue(subCommand, args = [], _options = {}) {
  if (!perfReport.isEnabled(process.env)) {
    printInfo('性能报告功能已关闭(KHY_PERF_ISSUE)。可用 /context 查看上下文占用。');
    return false;
  }

  const format = _parseFormat(subCommand, args);

  // 取本会话 token/成本用量(khy 真实记录源)。fail-soft。
  let sessionUsage = {};
  try {
    const tokenUsageService = require('../../services/tokenUsageService');
    sessionUsage = tokenUsageService.getSessionUsage() || {};
  } catch (e) {
    printWarn(`无法读取会话用量统计:${e && e.message ? e.message : e}`);
  }

  // 解析会话 transcript(回合数/墙钟)。显式 sessionId 优先,否则取最近会话。
  let sessionId = _parseSessionArg(subCommand, args);
  let transcript = [];
  try {
    const sessionPersistence = require('../../services/sessionPersistence');
    if (!sessionId) {
      const recent = sessionPersistence.listPersistedSessions({ limit: 1 }) || [];
      if (recent.length && recent[0] && recent[0].sessionId) sessionId = recent[0].sessionId;
    }
    if (sessionId) {
      const file = sessionPersistence.jsonlPathFor(sessionId);
      transcript = _readTranscript(file);
    }
  } catch (e) {
    printWarn(`无法读取会话 transcript:${e && e.message ? e.message : e}`);
  }

  // 聚合 + 渲染(纯叶子;生成时间由薄壳注入,叶子不调 Date)。
  const stats = perfReport.analyzePerf({ sessionUsage, transcript });
  const generatedAt = new Date().toISOString();
  const report = perfReport.formatPerfReport(stats, format, { sessionId, generatedAt });

  printInfo(report);

  // 落盘到本地数据目录(getDataDir 会创建目录并返回绝对路径;绝不硬编码路径)。
  try {
    const { getDataDir } = require('../../utils/dataHome');
    const dir = getDataDir('perf-reports');
    const stamp = generatedAt.replace(/[:.]/g, '-');
    const idPart = sessionId ? `-${String(sessionId).slice(0, 12)}` : '';
    const fname = `perf-${stamp}${idPart}.${_EXT[format] || 'md'}`;
    const outPath = path.join(dir, fname);
    fs.writeFileSync(outPath, report, 'utf-8');
    printInfo('');
    printInfo(`报告已保存:${outPath}`);
  } catch (e) {
    printError(`保存报告失败:${e && e.message ? e.message : e}`);
  }

  return true;
}

module.exports = { handlePerfIssue, _parseFormat, _parseSessionArg, _readTranscript };
