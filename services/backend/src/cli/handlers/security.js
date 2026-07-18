/**
 * Security, monitor, and services CLI handlers.
 */
const chalk = (() => {
  const m = require('chalk');
  return m.default || m;
})();
const { printSuccess, printError, printInfo, printWarn } = require('../formatters');

// ─── security ───────────────────────────────────────────────────────────────

async function handleSecurity(subCommand, args, options) {
  const secSvc = require('../../services/securityGuardService');

  if (subCommand === 'scan') {
    console.log(chalk.bold('\n  🛡️ 安全扫描...\n'));
    const result = secSvc.scanForThreats();
    if (result.clean) {
      printSuccess('扫描完成 — 未发现威胁');
    } else {
      printError(`发现 ${result.threats.length} 个威胁!`);
      for (const t of result.threats) {
        const icon = t.severity === 'critical' ? '🔴' : t.severity === 'high' ? '🟠' : '🟡';
        console.log(`  ${icon} [${t.severity}] ${t.detail}`);
        if (t.action) console.log(chalk.dim(`     修复: ${t.action}`));
      }
    }
    if (result.recommendations.length > 0) {
      console.log(chalk.bold('\n  📋 安全建议'));
      for (const r of result.recommendations) {
        console.log(chalk.dim(`  • ${r.detail}`));
      }
    }
    console.log('');
    return;
  }

  if (subCommand === 'monitor') {
    secSvc.startSecurityMonitor();
    printSuccess('后台安全监控已启动 (每 10 分钟扫描一次)');
    printInfo('异常事件记录到 ~/.khyquant/security.log');
    return;
  }

  if (subCommand === 'integrity') {
    const result = secSvc.checkProcessIntegrity();
    console.log(chalk.bold('\n  🔍 进程完整性检查\n'));
    console.log(`  当前 PID:     ${result.pid}`);
    console.log(`  子进程数:     ${result.childCount}`);
    console.log(`  可疑进程:     ${result.suspicious.length}`);
    if (result.clean) {
      printSuccess('进程完整性正常');
    } else {
      printError('发现可疑子进程:');
      for (const s of result.suspicious) {
        console.log(`    PID ${s.pid}: ${s.cmd}`);
      }
    }
    console.log('');
    return;
  }

  if (subCommand === 'status') {
    const stats = secSvc.getSecurityStats();
    console.log(chalk.bold('\n  🛡️ 安全状态\n'));
    console.log(`  总拦截事件: ${stats.totalEvents}`);
    console.log(`  24h 内:     ${stats.last24h}`);
    if (stats.byType && Object.keys(stats.byType).length > 0) {
      console.log(chalk.dim('\n  按类型:'));
      for (const [type, count] of Object.entries(stats.byType)) {
        console.log(`    ${type}: ${count}`);
      }
    }
    // Show permission profile
    try {
      const permStore = require('../../services/permissionStore');
      console.log(`\n  权限模式:   ${chalk.cyan(permStore.getProfile())}`);
      console.log(`  已授权工具: ${permStore.getApprovedTools().length}`);
      console.log(`  已拒绝工具: ${permStore.getDeniedTools().length}`);
    } catch { /* permissionStore not available */ }
    console.log('');
    return;
  }

  if (subCommand === 'profile') {
    const permStore = require('../../services/permissionStore');
    const profileName = args[0];
    if (profileName) {
      try {
        permStore.setProfile(profileName);
        // Also sync dangerous mode with yolo profile
        const toolCalling = require('../../services/toolCalling');
        if (profileName === 'yolo') {
          toolCalling.enableDangerousMode();
          toolCalling.acknowledgeDangerousMode();
        } else {
          toolCalling.disableDangerousMode();
        }
        printSuccess(`权限模式已设置为: ${profileName}`);
        const desc = { strict: '所有工具需确认', normal: '安全工具自动放行', acceptEdits: '自动放行文件编辑，shell/危险操作仍需确认', yolo: '全部自动放行' };
        printInfo(desc[profileName] || '');
      } catch (err) {
        printError(err.message);
      }
    } else {
      const current = permStore.getProfile();
      console.log(chalk.bold('\n  🔒 权限模式\n'));
      for (const p of permStore.VALID_PROFILES) {
        const marker = p === current ? chalk.green(' ← 当前') : '';
        const desc = { strict: '所有工具需确认 (最安全)', normal: '安全工具自动放行 (默认)', acceptEdits: '自动放行文件编辑，shell/危险仍确认', yolo: '全部自动放行 (等同 --dangerous)' };
        console.log(`  ${p === current ? chalk.green('●') : chalk.dim('○')} ${chalk.bold(p)}  ${chalk.dim(desc[p])}${marker}`);
      }
      console.log(chalk.dim('\n  用法: security profile <strict|normal|acceptEdits|yolo>\n'));
    }
    return;
  }

  if (subCommand === 'audit') {
    const auditLog = require('../../services/auditLog');
    const toolFilter = options.tool || null;
    const limit = parseInt(options.limit) || 20;
    const entries = auditLog.queryAuditLog({ tool: toolFilter, limit });

    console.log(chalk.bold('\n  📋 工具执行审计日志\n'));
    if (entries.length === 0) {
      printInfo('暂无审计记录');
    } else {
      for (const e of entries) {
        const icon = e.result?.success ? chalk.green('✓') : chalk.red('✗');
        const time = new Date(e.timestamp).toLocaleString('zh-CN');
        const elapsed = e.elapsed ? chalk.dim(`${e.elapsed}ms`) : '';
        console.log(`  ${icon} ${chalk.dim(time)} ${chalk.cyan(e.tool)} ${elapsed} ${chalk.dim(`[${e.permission}]`)}`);
      }
      // Show stats summary
      const stats = auditLog.getAuditStats();
      console.log(chalk.dim(`\n  总计 ${stats.totalCalls} 次调用 · ${stats.errorCount} 次失败 · ${stats.deniedCount} 次拒绝 · 平均 ${stats.avgElapsed}ms`));
    }
    console.log('');
    return;
  }

  if (subCommand === 'permissions') {
    const permStore = require('../../services/permissionStore');
    const rules = permStore.getAllRules();
    console.log(chalk.bold('\n  🔑 权限规则\n'));
    console.log(`  当前模式: ${chalk.cyan(rules.profile)}`);

    const persistent = Object.entries(rules.persistent);
    if (persistent.length > 0) {
      console.log(chalk.bold('\n  持久规则:'));
      for (const [name, rule] of persistent) {
        const icon = rule.decision === 'allow' ? chalk.green('✓') : chalk.red('✗');
        console.log(`  ${icon} ${name} — ${rule.decision} (${rule.scope})${rule.migrated ? chalk.dim(' [已迁移]') : ''}`);
      }
    }
    if (rules.sessionApproved.length > 0) {
      console.log(chalk.bold('\n  会话授权:'));
      for (const name of rules.sessionApproved) {
        console.log(`  ${chalk.green('✓')} ${name}`);
      }
    }
    if (rules.sessionDenied.length > 0) {
      console.log(chalk.bold('\n  会话拒绝:'));
      for (const name of rules.sessionDenied) {
        console.log(`  ${chalk.red('✗')} ${name}`);
      }
    }
    if (persistent.length === 0 && rules.sessionApproved.length === 0 && rules.sessionDenied.length === 0) {
      printInfo('暂无自定义规则，使用默认模式');
    }
    console.log('');
    return;
  }

  if (subCommand === 'approvals') {
    const ledger = require('../../services/approvalLedger');
    if ((args[0] || '').toLowerCase() === 'reset') {
      ledger.reset();
      printSuccess('已清空自动审批账本');
      console.log('');
      return;
    }
    const { enabled, threshold, entries } = ledger.getLedger();
    console.log(chalk.bold('\n  🤝 学习型自动审批\n'));
    console.log(`  开关: ${enabled ? chalk.green('on') : chalk.dim('off（默认，需 KHY_AUTO_APPROVE=on 开启）')}`);
    console.log(`  阈值: ${chalk.cyan(threshold)} 次（仅 safe/低风险、非破坏性、零拒绝可学习放行；高/关键永不自动）`);
    const rows = Object.entries(entries);
    if (rows.length === 0) {
      printInfo('暂无审批历史');
    } else {
      console.log(chalk.bold('\n  审批历史:'));
      for (const [key, e] of rows) {
        const mark = e.autoEligible ? chalk.green('⚡自动') : chalk.dim('需确认');
        const risk = e.lastRisk ? chalk.dim(`[${e.lastRisk}]`) : '';
        console.log(`  ${mark} ${key} ${risk} — 批准 ${chalk.green(e.allowCount || 0)} · 拒绝 ${chalk.red(e.denyCount || 0)}`);
      }
    }
    console.log('');
    return;
  }

  // Default: quick scan
  console.log(chalk.bold('\n  🛡️ 安全防护\n'));
  console.log('  security scan          — 完整安全扫描 (挖矿/木马/可疑进程)');
  console.log('  security monitor       — 启动后台监控 (每10分钟自动扫描)');
  console.log('  security integrity     — 进程完整性检查');
  console.log('  security status        — 查看拦截统计');
  console.log('  security profile <p>   — 设置权限模式 (strict/normal/acceptEdits/yolo)');
  console.log('  security audit         — 查看工具执行审计日志');
  console.log('  security permissions   — 查看当前权限规则');
  console.log('  security approvals     — 查看学习型自动审批账本 (reset 清空)');
  console.log('');
  // Run quick integrity check
  const integrity = secSvc.checkProcessIntegrity();
  if (integrity.clean) {
    printSuccess('快速检查: 进程完整性正常');
  } else {
    printError(`快速检查: 发现 ${integrity.suspicious.length} 个可疑进程`);
  }
  console.log('');
}

// ─── monitor ────────────────────────────────────────────────────────────────

async function handleMonitor(subCommand, args, options) {
  const aiMonitor = require('../../services/aiMonitor');

  if (subCommand === 'selfcheck') {
    const selfCheck = require('../../services/baseSelfCheckService');
    const action = (args[0] || 'status').toLowerCase();

    const colorSeverity = (severity) => {
      if (severity === 'critical') return chalk.red(severity);
      if (severity === 'degraded') return chalk.yellow(severity);
      return chalk.green(severity || 'healthy');
    };

    if (action === 'start') {
      const intervalMs = parseInt(
        options.interval || args[1] || process.env.KHY_SELF_CHECK_INTERVAL_MS || '300000',
        10
      );
      const st = selfCheck.start(intervalMs, { runImmediately: true });
      printSuccess(`循环自检已启动，间隔 ${st.intervalMs}ms`);
      if (st.lastResult) {
        printInfo(`最近结果: ${st.lastResult.severity} · score ${st.lastResult.score}`);
      }
      return;
    }

    if (action === 'stop') {
      const st = selfCheck.stop();
      printSuccess('循环自检已停止');
      if (st.lastResult) {
        printInfo(`最后一次: ${st.lastResult.severity} · score ${st.lastResult.score}`);
      }
      return;
    }

    if (action === 'run') {
      printInfo('执行一次底座自检...');
      const report = await selfCheck.runOnce({
        trigger: 'manual',
        forceThreatScan: true,
        forcePluginDoctor: true,
        pluginDoctorDeep: options.deep === true || options.deep === 'true',
      });

      if (report.skipped) {
        printWarn('已有自检任务在运行，跳过本次触发');
        return;
      }

      console.log(chalk.bold('\n  🔁 自检结果\n'));
      console.log(`  严重级别: ${colorSeverity(report.severity)}`);
      console.log(`  评分:     ${report.score}/100`);
      console.log(`  耗时:     ${report.durationMs}ms`);
      console.log(`  问题数:   ${report.issues.length}`);
      const repairCount = Array.isArray(report.repairs) ? report.repairs.length : 0;
      console.log(`  修复数:   ${repairCount}`);
      if (report.issues.length > 0) {
        console.log(chalk.bold('\n  Top Issues:'));
        for (const issue of report.issues.slice(0, 8)) {
          const icon = issue.severity === 'critical'
            ? chalk.red('✗')
            : issue.severity === 'high'
              ? chalk.yellow('!')
              : chalk.dim('•');
          console.log(`  ${icon} [${issue.source}] ${issue.message}`);
        }
      }
      if (repairCount > 0) {
        console.log(chalk.bold('\n  Auto Repairs:'));
        for (const repair of report.repairs.slice(0, 8)) {
          const from = repair.from ? ` ${repair.from}` : '';
          const to = repair.to ? ` -> ${repair.to}` : '';
          const action = repair.action ? `[${repair.action}]` : '[repair]';
          console.log(`  ${chalk.green('✓')} ${action}${from}${to}`);
        }
      }
      console.log('');
      return;
    }

    if (action === 'tail') {
      const n = Math.max(1, parseInt(options.n || args[1] || '10', 10) || 10);
      const logs = selfCheck.tail(n);
      if (logs.length === 0) {
        printInfo('暂无自检日志');
        return;
      }
      console.log(chalk.bold(`\n  🔁 最近 ${logs.length} 条自检记录\n`));
      for (const row of logs) {
        const time = row.timestamp ? new Date(row.timestamp).toLocaleString('zh-CN') : '-';
        const sev = colorSeverity(row.severity || 'unknown');
        const score = Number.isFinite(row.score) ? row.score : '-';
        const issueCount = Number.isFinite(row.issueCount) ? row.issueCount : 0;
        const repairCount = Number.isFinite(row.repairCount) ? row.repairCount : 0;
        const dur = Number.isFinite(row.durationMs) ? `${row.durationMs}ms` : '-';
        console.log(`  ${time}  ${sev}  score=${score}  issues=${issueCount}  repairs=${repairCount}  ${dur}`);
      }
      console.log('');
      return;
    }

    // status (default)
    const st = selfCheck.status();
    console.log(chalk.bold('\n  🔁 底座循环自检\n'));
    console.log(`  运行状态: ${st.running ? chalk.green('running') : chalk.yellow('stopped')}`);
    console.log(`  间隔:     ${st.intervalMs}ms`);
    console.log(`  运行次数: ${st.runCount}`);
    if (st.startedAt) {
      console.log(`  启动时间: ${new Date(st.startedAt).toLocaleString('zh-CN')}`);
    }
    if (st.lastResult) {
      console.log(`  最近级别: ${colorSeverity(st.lastResult.severity)} · score ${st.lastResult.score}`);
      console.log(`  最近时间: ${new Date(st.lastResult.timestamp).toLocaleString('zh-CN')}`);
      console.log(`  最近耗时: ${st.lastResult.durationMs}ms`);
      console.log(`  问题数量: ${st.lastResult.issueCount}`);
      console.log(`  修复数量: ${Number.isFinite(st.lastResult.repairCount) ? st.lastResult.repairCount : 0}`);
    } else {
      console.log(`  最近结果: ${chalk.dim('暂无')}`);
    }
    console.log(`  日志文件: ${st.logFile}`);
    console.log(chalk.dim('\n  用法: monitor selfcheck start|stop|status|run|tail [--interval ms] [--n N] [--deep]\n'));
    return;
  }

  if (subCommand === 'dashboard') {
    // Unified telemetry dashboard
    const telemetry = require('../../services/telemetryService');
    const dashboard = telemetry.createDashboardData();
    console.log(chalk.bold('\n  📊 统一监控仪表盘\n'));
    console.log(`  运行时间:     ${dashboard.summary.uptime}`);
    console.log(`  工具调用:     ${dashboard.counters.tools} (${dashboard.summary.toolCallsPerMinute}/min)`);
    console.log(`  成功率:       ${dashboard.summary.successRate}`);
    console.log(`  平均延迟:     ${dashboard.summary.avgLatency}`);
    console.log(`  智能体运行:   ${dashboard.counters.agents}`);
    console.log(`  服务调用:     ${dashboard.counters.services}`);
    console.log(`  错误数:       ${chalk.red(dashboard.counters.errors)}`);
    console.log(`  内存占用:     ${dashboard.summary.memoryUsed}`);
    if (dashboard.topTools.length > 0) {
      console.log(chalk.bold('\n  热门工具:'));
      for (const t of dashboard.topTools) {
        console.log(`    ${chalk.cyan(t.name)} — ${t.count} 次`);
      }
    }
    console.log('');
    return;
  }

  if (subCommand === 'tools') {
    // Tool execution stats from audit log
    try {
      const auditLog = require('../../services/auditLog');
      const stats = auditLog.getAuditStats();
      console.log(chalk.bold('\n  🔧 工具执行统计\n'));
      console.log(`  总调用: ${stats.totalCalls} · 错误: ${stats.errorCount} · 拒绝: ${stats.deniedCount} · 平均延迟: ${stats.avgElapsed}ms`);
      if (Object.keys(stats.byTool).length > 0) {
        console.log(chalk.bold('\n  按工具:'));
        const sorted = Object.entries(stats.byTool).sort(([, a], [, b]) => b - a);
        for (const [name, count] of sorted.slice(0, 15)) {
          const bar = '█'.repeat(Math.min(20, Math.ceil(count / Math.max(1, sorted[0][1]) * 20)));
          console.log(`    ${chalk.cyan(name.padEnd(20))} ${chalk.green(bar)} ${count}`);
        }
      }
      if (Object.keys(stats.byPermission).length > 0) {
        console.log(chalk.bold('\n  按权限:'));
        for (const [perm, count] of Object.entries(stats.byPermission)) {
          console.log(`    ${perm}: ${count}`);
        }
      }
      console.log('');
    } catch {
      printInfo('审计日志不可用');
    }
    return;
  }

  if (subCommand === 'status' || !subCommand) {
    const stats = aiMonitor.getStats();
    console.log('');
    console.log(`  ${chalk.cyan.bold('AI Monitor 追踪')}`);
    console.log('');
    console.log(`  ${chalk.gray('总请求:')}   ${stats.total}`);
    console.log(`  ${chalk.gray('成功:')}     ${chalk.green(stats.success)}`);
    console.log(`  ${chalk.gray('失败:')}     ${chalk.red(stats.failure)}`);
    console.log(`  ${chalk.gray('成功率:')}   ${stats.successRate}`);
    console.log(`  ${chalk.gray('平均延迟:')} ${stats.avgLatencyMs}ms`);
    console.log(`  ${chalk.gray('缓冲:')}     ${stats.bufferSize}/${stats.maxBufferSize}`);
    if (Object.keys(stats.providers).length > 0) {
      console.log('');
      console.log(chalk.dim('  按 Provider:'));
      for (const [p, s] of Object.entries(stats.providers)) {
        console.log(`    ${p}: ${s.total} req, ${s.successRate}% ok, ${s.avgLatency}ms avg`);
      }
    }
    console.log('');
  } else if (subCommand === 'tail') {
    const recent = aiMonitor.getRecent(10);
    console.log('');
    console.log(`  ${chalk.cyan.bold('最近 AI 请求')}`);
    console.log('');
    for (const t of recent) {
      const icon = t.success ? chalk.green('●') : chalk.red('●');
      const _td = new Date(t.startTime);
      const time = require('../ccFormat').ccBriefTimestampOr(_td.getTime(), Date.now(), _td.toLocaleTimeString());
      console.log(`  ${icon} ${chalk.dim(time)} ${chalk.gray(t.request?.adapter || '?')} ${t.latencyMs ? t.latencyMs + 'ms' : '...'} ${chalk.dim(t.request?.prompt?.slice(0, 50) || '')}`);
    }
    if (recent.length === 0) printInfo('暂无追踪记录');
    console.log('');
  } else if (subCommand === 'clear') {
    aiMonitor.clearTraces();
    printSuccess('追踪记录已清除');
  }
}

// ─── services ───────────────────────────────────────────────────────────────

async function handleServices(subCommand, args, options) {
  const registry = require('../../services/serviceRegistry');

  if (subCommand === 'list' || !subCommand) {
    const services = registry.list();
    console.log(chalk.bold(`\n  📦 服务注册表 (${services.length} 个)\n`));
    // Group by category
    const grouped = {};
    for (const svc of services) {
      if (!grouped[svc.category]) grouped[svc.category] = [];
      grouped[svc.category].push(svc);
    }
    for (const [cat, svcs] of Object.entries(grouped).sort()) {
      console.log(chalk.bold(`  [${cat}]`));
      for (const svc of svcs) {
        const status = svc.error ? chalk.red('✗') : svc.loaded ? chalk.green('●') : chalk.dim('○');
        console.log(`    ${status} ${chalk.cyan(svc.name.padEnd(25))} ${chalk.dim(svc.description)}`);
      }
    }
    const st = registry.stats();
    console.log(chalk.dim(`\n  ${st.total} 注册 · ${st.loaded} 已加载 · ${st.errored} 错误\n`));
  } else if (subCommand === 'health') {
    printInfo('正在检查服务健康...');
    const results = await registry.healthCheck();
    console.log(chalk.bold('\n  🏥 服务健康检查\n'));
    for (const r of results) {
      const icon = r.healthy === true ? chalk.green('✓') : r.healthy === false ? chalk.red('✗') : chalk.dim('○');
      const latency = r.latency ? chalk.dim(` (${r.latency}ms)`) : '';
      const note = r.error ? chalk.red(` — ${r.error}`) : (r.note ? chalk.dim(` — ${r.note}`) : '');
      console.log(`  ${icon} ${r.name}${latency}${note}`);
    }
    console.log('');
  }
}

module.exports = { handleSecurity, handleMonitor, handleServices };
