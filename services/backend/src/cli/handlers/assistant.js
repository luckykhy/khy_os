/**
 * Assistant CLI Handler — commands for KAIROS persistent assistant mode.
 *
 * Commands:
 *   assistant on/off     — Toggle assistant mode
 *   assistant status     — Show current status
 *   assistant dream      — Manually trigger memory consolidation
 *   assistant log        — Show today's daily log
 *   brief                — Morning briefing (today's log summary)
 */
'use strict';

let _chalk;
function chalk() {
  if (_chalk) {
    return _chalk;
  }
  const m = require('chalk');
  _chalk = m.default || m;
  return _chalk;
}

/**
 * Handle /assistant CLI command.
 * @param {string} subCommand - on/off/status/dream/log/brief
 * @param {string[]} args
 * @param {object} options
 * @returns {Promise<boolean>}
 */
async function handleAssistantCommand(subCommand, args, options) {
  const c = chalk();

  // Feature gate
  try {
    const { isEnabled } = require('../../services/featureFlags');
    if (!isEnabled('assistant')) {
      console.log(
        c.gray('Assistant feature is disabled. Set KHY_FEATURE_ASSISTANT=true to enable.')
      );
      return true;
    }
  } catch {
    /* no feature flags */
  }

  const assistant = require('../../assistant');

  switch (subCommand) {
    case 'on':
    case 'activate': {
      assistant.activate();
      console.log(c.green('\n  KAIROS assistant mode activated.'));
      console.log(
        c.gray('  Daily logs will be recorded. Auto-dream will run when conditions are met.\n')
      );
      return true;
    }

    case 'off':
    case 'deactivate': {
      assistant.deactivate();
      console.log(c.yellow('\n  Assistant mode deactivated.\n'));
      return true;
    }

    case 'status': {
      const status = assistant.getStatus();
      console.log(c.bold('\n  KAIROS Assistant Status'));
      console.log(c.gray('  ' + '\u2500'.repeat(35)));
      console.log(`  Mode:       ${status.active ? c.green('ACTIVE') : c.gray('INACTIVE')}`);
      console.log(`  Proactive:  ${status.proactive ? c.green('ON') : c.gray('OFF')}`);
      console.log(`  Log files:  ${c.cyan(status.logCount)}`);
      console.log(`  Last dream: ${c.cyan(status.lastDream)}`);
      console.log(`  Dream need: ${status.dreamNeeded ? c.yellow('YES') : c.gray('No')}`);
      if (status.dreamReason) {
        console.log(`  Reason:     ${c.gray(status.dreamReason)}`);
      }
      console.log('');
      return true;
    }

    case 'dream': {
      console.log(c.cyan('\n  Starting memory consolidation (dream)...\n'));

      let aiModule;
      try {
        aiModule = require('../ai');
      } catch {
        aiModule = null;
      }

      const result = await assistant.runDream(aiModule);
      if (result.success) {
        console.log(c.green('  Dream completed successfully!'));
        console.log(c.gray(`  Phases: ${result.phases.join(' → ')}`));
        if (result.filesCreated.length > 0) {
          console.log(c.gray(`  Files: ${result.filesCreated.join(', ')}`));
        }
      } else {
        console.log(c.red(`  Dream failed: ${result.error}`));
      }
      console.log('');
      return true;
    }

    case 'log': {
      const log = assistant.readTodayLog();
      if (log) {
        console.log(c.bold("\n  Today's Log"));
        console.log(c.gray('  ' + '\u2500'.repeat(35)));
        console.log(log);
      } else {
        console.log(c.gray('\n  No log entries for today.\n'));
      }
      return true;
    }

    case 'brief': {
      const recentLogs = assistant.getRecentLogs(3);
      if (recentLogs.length === 0) {
        console.log(c.gray('\n  No recent activity to summarize.\n'));
        return true;
      }

      console.log(c.bold('\n  Morning Brief'));
      console.log(c.gray('  ' + '\u2500'.repeat(35)));

      for (const { date, content } of recentLogs) {
        console.log(c.cyan(`\n  ${date}`));
        // Show first 5 entries from each day
        const entries = content.split(/^## /m).filter(Boolean).slice(0, 5);
        for (const entry of entries) {
          const firstLine = entry.split('\n')[0].trim();
          if (firstLine) {
            console.log(c.gray(`    \u2022 ${firstLine}`));
          }
        }
      }
      console.log('');
      return true;
    }

    case 'commitment':
    case 'commitments': {
      const ct = require('../../services/commitmentTrack');
      const action = (args[0] || 'list').toLowerCase();
      const idArg = args[1] || '';
      if (action === 'expire') {
        const n = ct.expireOld();
        console.log(c.gray(`\n  已清理 ${n} 条过期承诺。\n`));
        return true;
      }
      if (action === 'sent' || action === 'dismiss') {
        if (!idArg) {
          console.log(c.gray(`用法: assistant commitment ${action} <id 前8位>`));
          return true;
        }
        const all = ct.listCommitments();
        const match = all.find((r) => r.id && r.id.startsWith(idArg));
        if (!match) {
          console.log(c.yellow(`未找到承诺: ${idArg}`));
          return true;
        }
        if (action === 'sent') {
          ct.markSent(match.id);
          console.log(c.green(`\n  已标记「${match.id.slice(0, 8)}」为已发。\n`));
        } else {
          ct.dismiss(match.id);
          console.log(c.gray(`\n  已忽略「${match.id.slice(0, 8)}」。\n`));
        }
        return true;
      }
      const all = ct.listCommitments();
      if (all.length === 0) {
        console.log(c.gray('\n  暂无承诺记录。\n'));
        return true;
      }
      console.log(c.bold('\n  承诺 / 提醒'));
      console.log(c.gray('  ' + '\u2500'.repeat(35)));
      for (const rec of all) {
        const kindLabel =
          {
            event_check_in: '事件回访',
            deadline_check: '截止提醒',
            care_check_in: '关怀回访',
            open_loop: '未闭合事项',
          }[rec.kind] || rec.kind;
        const status = rec.status === 'pending' ? c.yellow('待办') : c.gray(rec.status);
        const due =
          rec.dueWindow && rec.dueWindow.earliestMs
            ? new Date(rec.dueWindow.earliestMs).toLocaleString('zh-CN')
            : '';
        console.log(
          `  ${c.cyan(rec.id.slice(0, 8))} [${kindLabel}] ${status}${due ? ' · ' + due : ''}`
        );
        if (rec.suggestedText) {
          console.log(c.gray(`      ${rec.suggestedText}`));
        }
      }
      console.log('');
      console.log(c.gray('  assistant commitment <id 前8位>   — 标记为已发'));
      console.log(c.gray('  assistant commitment dismiss <id> — 忽略'));
      console.log(c.gray('  assistant commitment expire       — 清理过期'));
      console.log('');
      return true;
    }

    default: {
      const status = assistant.getStatus();
      console.log(c.bold('\n  KAIROS Assistant'));
      console.log(c.gray('  ' + '\u2500'.repeat(35)));
      console.log(`  Status: ${status.active ? c.green('ACTIVE') : c.gray('INACTIVE')}`);
      console.log('');
      console.log(c.gray('  Commands:'));
      console.log(c.gray('    assistant on      — Activate'));
      console.log(c.gray('    assistant off     — Deactivate'));
      console.log(c.gray('    assistant status  — Show status'));
      console.log(c.gray('    assistant dream   — Manual memory consolidation'));
      console.log(c.gray("    assistant log     — View today's log"));
      console.log(c.gray('    brief             — Morning briefing'));
      console.log(
        c.gray(
          '    assistant commitment — 承诺/提醒追踪 (list / sent <id> / dismiss <id> / expire)'
        )
      );
      console.log('');
      return true;
    }
  }
}

module.exports = { handleAssistantCommand };
