'use strict';

/**
 * verdict.js — `khy verdict` command handler: 看 khyos 对「最近一次 khy 改动」的判定。
 *
 * 这是「khy 被改动时不一声不吭」反馈通道的人面出口。后台常驻 watcher
 * (services/changeWatchService)在其它 AI / 人改动 khy 源码后跑机器校验并落盘一条
 * verdict;本命令把它读出来展示,或在没有 daemon 常驻时手动跑一次。
 *
 * Usage:
 *   khy verdict [show]     展示最近一次改动判定（对 / 不对 / 无法判断 + 原因）
 *   khy verdict check      立刻侦测当前改动并判定一次（无需 daemon 常驻）
 *   khy verdict --json     机器可读输出
 *
 * 判定本身收在纯叶子 changeWatchVerdict;本处只做 IO（读落盘记录 / 触发一次 checkOnce）与渲染。
 */

const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const { printInfo, printWarn, printError, printSuccess } = require('../formatters');

/**
 * 把 verdict 标签染色 + 加 emoji。纯函数、确定性,可直接单测。
 * @param {string} verdict - 'correct' | 'incorrect' | 'uncertain'
 * @returns {string}
 */
function formatVerdict(verdict) {
  switch (String(verdict || '').toLowerCase()) {
    case 'correct': return chalk.green('✅ 改动通过（correct）');
    case 'incorrect': return chalk.red('❌ 改动不对（incorrect）');
    case 'uncertain': return chalk.yellow('❓ 无法判断（uncertain）');
    default: return chalk.gray('— 暂无判定');
  }
}

/**
 * 渲染一条 verdict 记录到多行文本。纯函数(不打印),可单测。
 * @param {Object|null} rec  changeWatchService 落盘的记录
 * @returns {string[]} 行数组
 */
function renderRecord(rec) {
  if (!rec || typeof rec !== 'object') {
    return ['暂无改动判定记录（watcher 尚未侦测到 khy 源码改动，或后台未常驻）。'];
  }
  const lines = [];
  lines.push(formatVerdict(rec.verdict));
  const files = Array.isArray(rec.files) ? rec.files : [];
  if (files.length) lines.push(`改动文件: ${files.slice(0, 10).join('、')}${files.length > 10 ? ` 等 ${files.length} 个` : ''}`);
  for (const f of Array.isArray(rec.failures) ? rec.failures.slice(0, 8) : []) lines.push(chalk.red(`  ✗ ${f}`));
  for (const w of Array.isArray(rec.warnings) ? rec.warnings.slice(0, 6) : []) lines.push(chalk.yellow(`  ⚠ ${w}`));
  if (rec.consumed === false && rec.verdict === 'incorrect') {
    lines.push(chalk.dim('（此判定尚未反馈给 AI；下一轮对话会主动告知。）'));
  }
  return lines;
}

function _printHelp() {
  printInfo('khy verdict — khyos 对「最近一次 khy 改动」对不对的主动判定');
  printInfo('  khy verdict [show]              展示最近一次改动判定');
  printInfo('  khy verdict check               立刻侦测当前改动并判定一次（无需 daemon 常驻）');
  printInfo('  khy verdict --json              机器可读输出');
  printInfo('  khy verdict emit [--format ...] 取出待反馈供**其它 AI 工具**消费（代码级、零 LLM）');
  printInfo('      --format text|json|claude-hook   text=指令纯文本(默认)；claude-hook=Claude Code UserPromptSubmit 钩子 JSON');
  printInfo('      --consumer <id>                  消费者标识（每个工具用各自 ID，各自恰好拿到一次）');
  printInfo('      --peek                           只看不确认（不标记已消费）');
}

/**
 * `khy verdict emit` —— 把「最近一次 khy 改动」的代码级反馈以可被**其它 AI 工具**直接消费的形态
 * 打印到 stdout。这是「确保其他 ai 工具能正确拿到并使用」的标准出口:把它接成 Claude Code 的
 * UserPromptSubmit 钩子(`--format claude-hook`)或任意工具的上下文注入(`--format text`),khyos
 * 的反馈就会被代码级地灌入对方提示词 —— 全程零 LLM。多消费者按 `--consumer` 各自记账,互不抢占。
 * 总是退出 0(无待反馈 → 空输出 / 空对象),可安全长期挂作钩子。
 */
function emitFeedback(options = {}, service) {
  const consumer = String(options.consumer || 'external').trim() || 'external';
  const format = String(options.format || 'text').toLowerCase();
  const peek = !!options.peek;

  let fb = null;
  try {
    fb = peek ? service.pendingFor(consumer) : service.consumePendingInjection(consumer);
  } catch { fb = null; }

  if (format === 'json') {
    let source = null;
    try { source = service.getStorePath ? service.getStorePath() : null; } catch { source = null; }
    const out = fb
      ? {
          schemaVersion: fb.schemaVersion || 'khy-change-watch/1',
          pending: true, consumer, verdict: fb.verdict, reason: fb.reason,
          text: fb.text || fb.display, directive: fb.directive,
          files: fb.files || [], failures: fb.failures || [], warnings: fb.warnings || [],
          source,
        }
      : { schemaVersion: 'khy-change-watch/1', pending: false, consumer };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }

  if (format === 'claude-hook') {
    // Claude Code UserPromptSubmit 钩子契约:stdout 的 additionalContext 会被注入对话上下文。
    const ctx = fb ? String(fb.directive || fb.text || '') : '';
    const out = ctx
      ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } }
      : {};
    process.stdout.write(JSON.stringify(out) + '\n');
    return 0;
  }

  // text(默认):直接打印可注入的指令文本,无待反馈则空输出。
  if (fb && (fb.directive || fb.text)) process.stdout.write(String(fb.directive || fb.text) + '\n');
  return 0;
}

/**
 * @param {string|null} subCommand
 * @param {string[]} args
 * @param {object} options  flat parsed flags
 * @param {object} [deps]   { service } 可注入便于测试
 */
async function handleVerdict(subCommand, args = [], options = {}, deps = {}) {
  const sub = String(subCommand || 'show').toLowerCase();
  if (sub === 'help' || options.help) { _printHelp(); return 0; }

  const service = deps.service || require('../../services/changeWatchService');

  if (sub === 'emit') {
    return emitFeedback(options, service);
  }

  if (sub === 'check') {
    let result = null;
    try { result = await service.checkOnce(); } catch (e) {
      printError(`改动校验失败: ${e && e.message ? e.message : e}`);
      return 1;
    }
    if (!result || result.changed === false) {
      printInfo('未侦测到新的 khy 源码改动（工作树自上次以来未变，或改动已判定过）。');
    }
    // 落盘后回落到 show 渲染最新记录。
  }

  if (sub === 'watch') {
    // 一次性提示：常驻由 daemon 负责，这里仅引导。
    printInfo('后台常驻 watcher 由守护进程负责（khy daemon start）。如需手动跑一次用：khy verdict check');
  }

  let rec = null;
  try { rec = service.getLatestVerdict(); } catch { rec = null; }

  if (options.json) {
    process.stdout.write(JSON.stringify(rec || { verdict: null }, null, 2) + '\n');
    return 0;
  }

  const lines = renderRecord(rec);
  for (const l of lines) printInfo(l);
  return 0;
}

module.exports = { handleVerdict, formatVerdict, renderRecord, emitFeedback };
