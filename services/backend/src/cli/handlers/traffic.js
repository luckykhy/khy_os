'use strict';

/**
 * CLI Handler: `khy traffic` — AI 网关流量监控面板。
 *
 * 子命令：
 *   khy traffic status    查看流量记录统计摘要
 *   khy traffic list      列出最近的流量记录
 *   khy traffic watch     实时 tail 模式（WebSocket 订阅）
 *   khy traffic export    导出 HAR 文件
 *   khy traffic clear     清空记录缓冲区
 *   khy traffic enable    启用捕获
 *   khy traffic disable   暂停捕获
 *   khy traffic detail <id> 查看单条记录详情
 */

const chalk = require('chalk').default || require('chalk');
const { printError, printWarn, printInfo, printTable } = require('../formatters');

// ── 工具函数 ────────────────────────────────────────────────────
function formatTimestamp(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

function formatTokens(t) {
  if (!t) return '—';
  if (t >= 1000000) return `${(t / 1000000).toFixed(1)}M`;
  if (t >= 1000) return `${(t / 1000).toFixed(1)}k`;
  return String(t);
}

function statusGlyph(success, statusCode) {
  if (success) return chalk.green('✓');
  if (statusCode >= 500) return chalk.red('✗');
  if (statusCode >= 400) return chalk.yellow('⚠');
  return chalk.red('✗');
}

function truncate(str, maxLen = 60) {
  if (!str) return '';
  const s = String(str).replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

// ── 子命令实现 ──────────────────────────────────────────────────

function trafficStatus(logger) {
  const stats = logger.getStats();
  console.log(`\n  ${chalk.cyan.bold('流量监控状态')}\n`);
  console.log(`  捕获状态: ${logger.isEnabled() ? chalk.green('● 运行中') : chalk.dim('○ 已暂停')}`);
  console.log(`  缓冲区:   ${stats.bufferedEntries} / ${stats.maxEntries} 条`);
  console.log(`  运行时间: ${formatDuration(stats.uptimeMs)}`);
  console.log(`  ──────────────────────────────────────`);
  console.log(`  总请求数: ${chalk.bold(stats.totalRequests)}`);
  console.log(`  失败数:   ${stats.totalErrors > 0 ? chalk.red(stats.totalErrors) : chalk.green(0)}`);
  console.log(`  输入 tokens: ${formatTokens(stats.totalInputTokens)}`);
  console.log(`  输出 tokens: ${formatTokens(stats.totalOutputTokens)}`);
  console.log(`  平均延迟: ${stats.avgDurationMs}ms`);

  // Provider 维度
  const providers = Object.entries(stats.providers || {});
  if (providers.length > 0) {
    console.log(`\n  ${chalk.cyan('Provider 分布:')}`);
    const rows = providers.map(([name, s]) => [
      name,
      String(s.requests),
      s.errors > 0 ? chalk.red(String(s.errors)) : chalk.green('0'),
      formatTokens(s.inputTokens + s.outputTokens),
      `${s.avgDurationMs}ms`,
    ]);
    printTable(['Provider', '请求', '错误', 'Tokens', '平均延迟'], rows);
  }
}

function trafficList(logger, args) {
  const limit = parseInt(args[0], 10) || 20;
  const entries = logger.query({ limit });

  if (entries.length === 0) {
    printInfo('暂无流量记录。');
    return;
  }

  console.log(`\n  ${chalk.cyan.bold(`最近 ${entries.length} 条流量记录`)}\n`);
  const rows = entries.map((e) => [
    formatTimestamp(e.timestamp),
    statusGlyph(e.success, e.statusCode),
    e.provider,
    e.model.slice(0, 20),
    e.method,
    e.statusCode || '—',
    formatDuration(e.durationMs),
    formatTokens(e.tokenUsage.totalTokens),
    truncate(e.url, 35),
  ]);
  printTable(['时间', ' ', 'Provider', '模型', '方法', '状态', '耗时', 'Tokens', 'URL'], rows);
}

function trafficDetail(logger, id) {
  if (!id) {
    printError('请指定记录 ID：khy traffic detail <id>');
    return;
  }
  const entries = logger.query({ limit: 2000 });
  const entry = entries.find((e) => e.id === id || e.id.startsWith(id));

  if (!entry) {
    printWarn(`未找到记录: ${id}`);
    return;
  }

  console.log(`\n  ${chalk.cyan.bold('流量记录详情')}\n`);
  console.log(`  ID:       ${entry.id}`);
  console.log(`  时间:     ${formatTimestamp(entry.timestamp)}`);
  console.log(`  会话:     ${entry.sessionId}`);
  console.log(`  Provider: ${entry.provider}`);
  console.log(`  模型:     ${entry.model}`);
  console.log(`  适配器:   ${entry.adapterKey}`);
  console.log(`  URL:      ${entry.url}`);
  console.log(`  方法:     ${entry.method}`);
  console.log(`  状态码:   ${entry.statusCode || '—'}`);
  console.log(`  耗时:     ${formatDuration(entry.durationMs)}`);
  console.log(`  成功:     ${entry.success ? chalk.green('是') : chalk.red('否')}`);
  if (entry.errorMessage) {
    console.log(`  错误:     ${chalk.red(entry.errorMessage)}`);
  }
  console.log(`  Tokens:   输入 ${formatTokens(entry.tokenUsage.inputTokens)} / 输出 ${formatTokens(entry.tokenUsage.outputTokens)}`);

  // 请求头
  if (entry.requestHeaders && Object.keys(entry.requestHeaders).length > 0) {
    console.log(`\n  ${chalk.cyan('请求头:')}`);
    for (const [k, v] of Object.entries(entry.requestHeaders)) {
      console.log(`    ${k}: ${v}`);
    }
  }

  // 响应头
  if (entry.responseHeaders && Object.keys(entry.responseHeaders).length > 0) {
    console.log(`\n  ${chalk.cyan('响应头:')}`);
    for (const [k, v] of Object.entries(entry.responseHeaders)) {
      console.log(`    ${k}: ${v}`);
    }
  }

  // 请求体预览
  if (entry.requestBody) {
    console.log(`\n  ${chalk.cyan('请求体:')}`);
    console.log(`    ${chalk.dim(truncate(entry.requestBody, 200))}`);
  }

  // 响应体预览
  if (entry.responseBody) {
    console.log(`\n  ${chalk.cyan('响应体:')}`);
    console.log(`    ${chalk.dim(truncate(entry.responseBody, 200))}`);
  }
}

function trafficExport(logger, args) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const outputPath = args[0] || path.join(os.tmpdir(), `khy-traffic-${Date.now()}.har`);
  const har = logger.exportHAR();

  try {
    fs.writeFileSync(outputPath, JSON.stringify(har, null, 2), 'utf8');
    printInfo(`已导出 ${logger.getStats().bufferedEntries} 条记录到: ${outputPath}`);
  } catch (err) {
    printError(`导出失败: ${err.message}`);
  }
}

function trafficClear(logger) {
  const count = logger.getStats().bufferedEntries;
  logger.clear();
  printInfo(`已清空 ${count} 条流量记录。`);
}

function trafficEnable(logger) {
  logger.setEnabled(true);
  printInfo('流量捕获已启用。');
}

function trafficDisable(logger) {
  logger.setEnabled(false);
  printInfo('流量捕获已暂停。');
}

async function trafficWatch(logger) {
  console.log(`\n  ${chalk.cyan.bold('实时流量监控')}  ${chalk.dim('按 Ctrl-C 退出')}\n`);

  // 开启 watch 模式（全量记录）
  logger.setWatchMode(true);
  console.log(`  ${chalk.green('●')} 已开启 watch 模式：所有请求将被记录\n`);

  let lastSeenId = null;
  let running = true;

  const cleanup = () => {
    running = false;
  };
  process.on('SIGINT', cleanup);

  while (running) {
    const entries = logger.query({ limit: 10 });
    if (entries.length > 0) {
      const newest = entries[0];
      if (newest.id !== lastSeenId) {
        const newEntries = [];
        for (const e of entries) {
          if (e.id === lastSeenId) break;
          newEntries.push(e);
        }
        for (const e of newEntries.reverse()) {
          console.log(
            `  ${formatTimestamp(e.timestamp)} ${statusGlyph(e.success, e.statusCode)} ${chalk.bold(e.provider)} ${e.model} ${chalk.dim(formatDuration(e.durationMs))}`
          );
        }
        lastSeenId = newest.id;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  process.removeListener('SIGINT', cleanup);
  logger.setWatchMode(false);
  console.log('\n  已停止监控，watch 模式已关闭。');
}

// ── 触发配置查看 ────────────────────────────────────────────────
function trafficTrigger() {
  const { getTriggerConfig } = require('../../services/gateway/traffic-integration');
  const cfg = getTriggerConfig();
  console.log(`\n  ${chalk.cyan.bold('流量记录触发策略')}\n`);
  console.log(`  总开关:     ${cfg.enabled ? chalk.green('● 开') : chalk.red('● 关')}  (KHY_TRAFFIC_CAPTURE)`);
  console.log(`  慢请求阈值: ${cfg.slowThresholdMs}ms  (KHY_TRAFFIC_SLOW_MS)`);
  console.log(`  TTFB 阈值:  ${cfg.ttfbThresholdMs}ms  (KHY_TRAFFIC_TTFB_MS)`);
  console.log(`  采样率:     ${(cfg.sampleRate * 100).toFixed(0)}%  (KHY_TRAFFIC_SAMPLE_RATE)`);
  console.log(`  Watchlist:  ${cfg.watchlist.length > 0 ? cfg.watchlist.join(', ') : '(无)'}  (KHY_TRAFFIC_WATCHLIST)`);
  console.log(`  跳健康检查: ${cfg.skipHealthCheck ? '是' : '否'}  (KHY_TRAFFIC_SKIP_HEALTH)`);
  console.log(`  大 token 阈值: ${cfg.largeTokenThreshold}  (KHY_TRAFFIC_LARGE_TOKENS)`);
  console.log(`\n  ${chalk.cyan('触发规则（满足任一即记录）：')}`);
  console.log(`  ✦ 错误请求 (statusCode >= 400 或抛异常)`);
  console.log(`  ✦ 慢请求 (耗时 >= ${cfg.slowThresholdMs}ms)`);
  console.log(`  ✦ 慢首字节 (TTFB >= ${cfg.ttfbThresholdMs}ms)`);
  console.log(`  ✦ Watchlist 中的 provider (${cfg.watchlist.join(', ') || '无'})`);
  console.log(`  ✦ 大 token 请求 (tokens >= ${cfg.largeTokenThreshold})`);
  console.log(`  ✦ 用户 watch 模式 (khy traffic watch)`);
  console.log(`  ✦ 采样模式 (概率 ${(cfg.sampleRate * 100).toFixed(0)}%)`);
  console.log(`\n  ${chalk.cyan('跳过规则：')}`);
  console.log(`  ✗ 健康检查 / 心跳请求`);
  console.log(`  ✗ 总开关关闭时全跳过`);
}

// ── 凭据管理 ────────────────────────────────────────────────────
function credentialStatus() {
  const { credentialHarvester } = require('../../services/gateway/credential-harvester');
  const stats = credentialHarvester.store.getStats();
  console.log(`\n  ${chalk.cyan.bold('凭据审计')}\n`);
  console.log(`  总凭据数: ${stats.total}`);
  if (Object.keys(stats.types).length > 0) {
    console.log(`\n  ${chalk.cyan('按类型:')}`);
    for (const [type, count] of Object.entries(stats.types)) {
      console.log(`    ${type}: ${count}`);
    }
  }
  if (Object.keys(stats.sources).length > 0) {
    console.log(`\n  ${chalk.cyan('按来源:')}`);
    for (const [source, count] of Object.entries(stats.sources)) {
      console.log(`    ${source}: ${count}`);
    }
  }
}

function credentialList(args) {
  const { credentialHarvester, CredentialType } = require('../../services/gateway/credential-harvester');
  const limit = parseInt(args[0], 10) || 20;
  const typeFilter = args[1] || '';

  let credentials = credentialHarvester.store.query({ limit: limit * 2 });
  if (typeFilter) {
    credentials = credentials.filter((c) => c.type === typeFilter);
  }
  credentials = credentials.slice(0, limit);

  if (credentials.length === 0) {
    printInfo('暂无凭据记录。');
    return;
  }

  console.log(`\n  ${chalk.cyan.bold(`最近 ${credentials.length} 条凭据`)}\n`);
  const rows = credentials.map((c) => [
    formatTimestamp(c.timestamp),
    c.type,
    c.source,
    c.name,
    c.prefix,
  ]);
  printTable(['时间', '类型', '来源', '名称', '预览'], rows);
}

function credentialClear() {
  const { credentialHarvester } = require('../../services/gateway/credential-harvester');
  const count = credentialHarvester.store.getStats().total;
  credentialHarvester.store.clear();
  printInfo(`已清空 ${count} 条凭据记录。`);
}

// ── 主入口 ──────────────────────────────────────────────────────
async function handleTraffic(subCommand, args = [], _options = {}) {
  const { trafficLogger } = require('../../services/gateway/traffic-logger');
  const sub = String(subCommand || 'status').toLowerCase();

  switch (sub) {
    case 'status':
    case 'st':
      return trafficStatus(trafficLogger);
    case 'list':
    case 'ls':
      return trafficList(trafficLogger, args);
    case 'detail':
    case 'd':
      return trafficDetail(trafficLogger, args[0]);
    case 'watch':
    case 'w':
      return trafficWatch(trafficLogger);
    case 'export':
    case 'ex':
      return trafficExport(trafficLogger, args);
    case 'clear':
    case 'cls':
      return trafficClear(trafficLogger);
    case 'enable':
    case 'en':
      return trafficEnable(trafficLogger);
    case 'disable':
    case 'dis':
      return trafficDisable(trafficLogger);
    case 'trigger':
    case 'cfg':
    case 'config':
      return trafficTrigger();
    case 'credentials':
    case 'cred':
    case 'cookies':
      return credentialList(args);
    case 'cred-status':
      return credentialStatus();
    case 'cred-clear':
      return credentialClear();
    default:
      printWarn(`未知子命令: ${sub}`);
      printInfo('可用: status | list | detail | watch | export | clear | enable | disable | trigger | credentials | cred-status | cred-clear');
  }
}

module.exports = { handleTraffic };
