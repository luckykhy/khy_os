/**
 * CLI Handler: `khy trace` — 轨迹溯源查看器（DESIGN-ARCH-047 PHASE 5）。
 *
 * 同一份结构化记录（JSONL 顶层 `_khyTrace` + sidecar 防篡改哈希链），人读投影：
 *   khy trace                回放最近一条会话的轨迹（溯源字形 + 矛盾标记 + 链状态）
 *   khy trace list           列出全部会话 + 各自链完整性
 *   khy trace show [session] 回放指定会话（缺省=最近）
 *   khy trace verify [session] 只跑链校验，报 intact / broken @ #K
 *
 * 防呆（方案 §3 PHASE 5）：
 *   - 纯**只读**：绝不改 transcript / 链文件。
 *   - 未知 session 友好报错，不崩。
 *   - 链缺失仍渲染（`chain: unavailable`），不因无链而失败。
 *   - 遵 gatewayLogLease 可见性约束：被隔离（quarantined）的条目**只展示标签、不回显原文**，
 *     避免把注入 payload 二次呈现给人。
 */
'use strict';

const chalk = require('chalk').default || require('chalk');
const {
  printError, printWarn, printInfo, printTable,
} = require('../formatters');

const sessionPersistence = require('../../services/sessionPersistence');
const projection = require('../../services/trajectoryProvenance/traceProjection');
const { TRUST } = require('../../services/trajectoryProvenance/khyTrace');
const { generateTitle } = require('../../services/sessionTitleService');

/** 绝对时间戳 → 本地「MM-DD HH:mm」短格式；无时间回退 '—'。 */
function formatWhen(ts) {
  const n = Number(ts) || 0;
  if (!n) return '—';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 轨迹的人读标签:优先用户设定的标题;缺省时从首条用户消息派生一个
 * 「看得出在做什么」的分类标签(复用 sessionTitleService 的意图启发式),
 * 二者皆无才回退占位符。
 */
function trajectoryLabel(s) {
  const t = (s.title || '').trim();
  if (t && t !== '(untitled)') return t.slice(0, 28);
  if (s.firstUserMessage) {
    const derived = generateTitle(s.firstUserMessage);
    if (derived && derived !== 'New Conversation') return derived.slice(0, 28);
  }
  return '(未命名)';
}

/** 给字形上色：verified 绿 / claimed 黄 / quarantined 红。 */
function colorGlyph(trust, glyph) {
  if (trust === TRUST.VERIFIED) return chalk.green(glyph);
  if (trust === TRUST.CLAIMED) return chalk.yellow(glyph);
  if (trust === TRUST.QUARANTINED) return chalk.red(glyph);
  return chalk.dim(glyph);
}

/** 链状态页脚上色（intact 绿 / broken 红 / unavailable 灰）。 */
function colorChainStatus(status) {
  const line = projection.chainStatusLine(status);
  if (!status || status.available === false) return chalk.dim(line);
  return status.ok ? chalk.green(line) : chalk.red(line);
}

/** 取一条记录的内容预览（单行截断）；隔离条目不回显原文。 */
function contentPreview(entry, trust) {
  if (trust === TRUST.QUARANTINED) return chalk.dim('[内容已隔离，不予回显]');
  let raw = entry && entry.content;
  if (raw == null) return '';
  if (typeof raw !== 'string') {
    try { raw = JSON.stringify(raw); } catch { raw = String(raw); }
  }
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? oneLine.slice(0, 59) + '…' : oneLine;
}

/** 解析目标 sessionId：显式参数优先，否则取最近一条会话。 */
function resolveSessionId(arg) {
  if (arg) return String(arg);
  const sessions = sessionPersistence.listPersistedSessions({ limit: 1 });
  return sessions.length ? sessions[0].sessionId : null;
}

/** `khy trace list` — 列出会话 + 链完整性。 */
function traceList() {
  const sessions = sessionPersistence.listPersistedSessions({ limit: 50 });
  if (!sessions.length) {
    printInfo('暂无持久化会话。');
    return;
  }

  console.log(`\n  ${chalk.cyan.bold('轨迹会话列表')}\n`);
  const rows = sessions.map((s) => {
    const status = sessionPersistence.verifyTraceChain(s.sessionId);
    let chainCell;
    if (!status || status.available === false) chainCell = chalk.dim('无链');
    else if (status.ok) chainCell = chalk.green(`完整(${status.length})`);
    else chainCell = chalk.red(`断链@#${status.brokenAt}`);
    return [
      s.sessionId.slice(0, 8),
      formatWhen(s.updatedAt || s.createdAt),
      trajectoryLabel(s),
      s.model || '-',
      String(s.messageCount || 0),
      chainCell,
    ];
  });
  printTable(['会话 ID', '时间', '在做什么', '模型', '条数', '链'], rows);
  printInfo('回放某会话：khy trace show <会话ID>（缺省回放最近一条）。');
}

/** `khy trace show [session]` / 缺省 — 回放整条轨迹 + 链状态。 */
function traceShow(arg) {
  const sessionId = resolveSessionId(arg);
  if (!sessionId) {
    printWarn('未找到任何会话可回放。');
    return;
  }

  const chain = sessionPersistence.buildConversationChain(sessionId);
  if (!chain.length) {
    printError(`会话不存在或为空: ${sessionId}`);
    printInfo('用 `khy trace list` 查看可用会话。');
    return;
  }

  console.log(`\n  ${chalk.cyan.bold('轨迹回放')}  ${chalk.dim(sessionId)}\n`);

  chain.forEach((entry, i) => {
    const row = projection.replayRow(entry, i);
    const glyph = colorGlyph(row.trust, row.glyph);
    const idx = chalk.dim('#' + String(i).padEnd(3));
    const kind = chalk.dim(`[${row.kind || '-'}]`);
    const who = row.trust === TRUST.VERIFIED ? chalk.green(row.label) : chalk.yellow(row.label);
    console.log(`  ${idx} ${glyph} ${who}  ${kind}  ${chalk.dim(contentPreview(entry, row.trust))}`);
    for (const c of row.contradictions) {
      console.log(`        ${chalk.red(c)}`);
    }
  });

  const status = sessionPersistence.verifyTraceChain(sessionId);
  console.log(`\n  ${colorChainStatus(status)}\n`);
}

/** `khy trace verify [session]` — 只跑链校验。 */
function traceVerify(arg) {
  const sessionId = resolveSessionId(arg);
  if (!sessionId) {
    printWarn('未找到任何会话可校验。');
    return;
  }

  const status = sessionPersistence.verifyTraceChain(sessionId);
  console.log(`\n  ${chalk.cyan.bold('轨迹链校验')}  ${chalk.dim(sessionId)}\n`);
  console.log(`  ${colorChainStatus(status)}\n`);

  if (status && status.available === false) {
    printInfo('该会话无 sidecar 链文件（旧会话或链写入曾失败）；标签与回放仍可用。');
  } else if (status && !status.ok) {
    printWarn('检测到 transcript 或链被事后改动。链是事后审计证据，会话本身仍可重建。');
  }
}

/**
 * Main handler — dispatch `trace` 子命令。
 */
async function handleTrace(subCommand, args = [], _options = {}) {
  const sub = String(subCommand || 'show').toLowerCase();

  if (sub === 'list') return traceList();
  if (sub === 'verify') return traceVerify(args[0]);
  // 'show' 及缺省
  return traceShow(args[0]);
}

module.exports = { handleTrace };
