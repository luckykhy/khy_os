'use strict';

/**
 * Companion (AgentFS) command handler — manage file-driven, git-versioned agents.
 *
 * `companion` (中文 别名: 同伴 / 数字同伴) is intentionally distinct from the
 * existing `agent` command (which is the trading-prediction / sub-agent runner):
 * here a "companion" is a full agent whose persona / principles / memory / skills
 * live in one git-versioned directory under `~/.khy/agents/<id>/`.
 *
 * Subcommands:
 *   companion create <name> [--id <id>] [--desc <text>] [--model <id>]
 *   companion list
 *   companion show <id> [--level L0|L1|L2]   (default L0 — demonstrates layering)
 *   companion history <id> [--limit <n>]
 *   companion path <id>
 *   companion assets <id>                    (five-asset model view)
 *   companion receipts <id> [--limit <n>]    (this companion's action receipts)
 *   companion heartbeat [status|run|reset]   (declarative HEARTBEAT.md patrol)
 */

const chalk = require('chalk').default || require('chalk');
const { printSuccess, printError, printInfo, printTable, displayWidth } = require('../formatters');

function _usage() {
  printInfo('用法:');
  printInfo('  khy companion create <name> [--id <id>] [--desc <文本>] [--model <id>]');
  printInfo('  khy companion list');
  printInfo('  khy companion show <id> [--level L0|L1|L2]');
  printInfo('  khy companion history <id> [--limit <n>]');
  printInfo('  khy companion path <id>');
  printInfo('  khy companion assets <id>   # 五类资产视图 (Persona/Playbook/Memory/Tool Body/Receipts)');
  printInfo('  khy companion receipts <id> [--limit <n>]  # 该同伴的行动回执');
  printInfo('  khy companion use <id>      # 设为当前激活同伴（注入系统提示词）');
  printInfo('  khy companion unuse         # 取消激活');
  printInfo('  khy companion active        # 查看当前激活同伴');
  printInfo('  khy companion heartbeat [status|run|reset]  # 声明式巡检（HEARTBEAT.md，只提醒不执行）');
}

async function handleCompanion(subCommand, args, options = {}) {
  const svc = require('../../services/agentFs/agentFsService');

  switch (subCommand) {
    case 'create': {
      const name = (args.join(' ') || options.name || '').trim();
      if (!name) { printError('缺少名称。用法: khy companion create <name> [--id <id>]'); return true; }
      try {
        const res = svc.createAgent({
          name,
          id: options.id ? String(options.id).trim() : undefined,
          description: options.desc || options.description || '',
          model: options.model || '',
          createdAt: new Date().toISOString(),
        });
        printSuccess(`已创建 companion: ${res.manifest.name} (${res.id})`);
        printInfo(`目录: ${res.dir}`);
        printInfo(res.versioned ? '已 git 初始化并提交首个快照。' : '已创建文件（git 不可用 → 未版本化）。');
        printInfo(`下一步: 编辑 persona.md / principles.md，或 \`khy companion show ${res.id} --level L2\``);
      } catch (err) {
        printError(err.message || String(err));
      }
      return true;
    }

    case 'list': {
      const agents = svc.listAgents();
      if (agents.length === 0) {
        printInfo('还没有 companion。用 `khy companion create <name>` 创建一个。');
        return true;
      }
      console.log(chalk.bold('\n  🤝 数字同伴 (AgentFS)\n'));
      const activeId = svc.getActiveAgentId();
      printTable(
        ['', 'ID', 'Name', 'Model', 'Description'],
        agents.map(a => [
          a.id === activeId ? '●' : '',
          a.id, a.name || '', a.model || '-', (a.description || '').slice(0, 48),
        ]),
      );
      if (activeId) console.log(chalk.dim(`  ● = 当前激活同伴 (${activeId})`));
      console.log('');
      return true;
    }

    case 'show': {
      const id = args[0];
      if (!id) { printError('缺少 id。用法: khy companion show <id> [--level L0|L1|L2]'); return true; }
      const level = String(options.level || 'L0').toUpperCase();
      try {
        const view = svc.loadLayered(id, level);
        console.log('');
        console.log(chalk.dim(`# ${view.level} · ${view.bytes} bytes`));
        console.log(view.text);
        return true;
      } catch (err) {
        printError(err.message || String(err));
        return true;
      }
    }

    case 'history': {
      const id = args[0];
      if (!id) { printError('缺少 id。用法: khy companion history <id>'); return true; }
      try {
        const limit = options.limit ? parseInt(options.limit, 10) : 50;
        const log = svc.history(id, { limit });
        if (log.length === 0) {
          printInfo('没有版本历史（git 不可用，或尚无提交）。');
          return true;
        }
        console.log(chalk.bold(`\n  🕑 ${id} 版本历史\n`));
        for (const c of log) {
          console.log('  ' + chalk.yellow(c.hash) + '  ' + chalk.dim(c.subject));
        }
        console.log('');
        return true;
      } catch (err) {
        printError(err.message || String(err));
        return true;
      }
    }

    case 'path': {
      const id = args[0];
      if (!id) { printError('缺少 id。用法: khy companion path <id>'); return true; }
      const agent = svc.getAgent(id);
      if (!agent) { printError(`agent 不存在: ${id}`); return true; }
      console.log(agent.dir);
      return true;
    }

    case 'assets': {
      const id = args[0];
      if (!id) { printError('缺少 id。用法: khy companion assets <id>'); return true; }
      try {
        const rcpt = require('../../services/receiptService');
        const assets = svc.describeAssets(id, {
          countReceipts: (cid) => rcpt.listReceipts({ companionId: cid, limit: 1000 }).length,
        });
        const agent = svc.getAgent(id);
        console.log(chalk.bold(`\n  🧬 ${agent ? agent.manifest.name : id} 五类资产\n`));
        // Pad labels by display width to the widest label: labels mix ASCII +
        // full-width CJK (e.g. "Persona（人格）"=13 cols vs "Tool Body（工具身体）"
        // =21 cols), so a fixed padEnd(char-count) leaves the summary ragged.
        const labelGutter = assets.reduce((m, a) => Math.max(m, displayWidth(a.label)), 0);
        const padLabel = (s) => s + ' '.repeat(Math.max(0, labelGutter - displayWidth(s)));
        for (const a of assets) {
          const mark = a.present ? chalk.green('✅') : chalk.dim('—');
          console.log(`  ${mark} ${chalk.bold(padLabel(a.label))} ${chalk.dim(a.summary)}`);
          for (const f of (a.files || [])) {
            console.log(chalk.dim(`        ${f.rel}  (${f.bytes}B)`));
          }
        }
        console.log('');
        return true;
      } catch (err) {
        printError(err.message || String(err));
        return true;
      }
    }

    case 'receipts': {
      const id = args[0];
      if (!id) { printError('缺少 id。用法: khy companion receipts <id> [--limit <n>]'); return true; }
      if (!svc.getAgent(id)) { printError(`agent 不存在: ${id}`); return true; }
      try {
        const limit = options.limit ? parseInt(options.limit, 10) : 20;
        const rcpt = require('../../services/receiptService');
        const rows = rcpt.listReceipts({ companionId: id, limit });
        if (rows.length === 0) {
          printInfo(`${id} 还没有行动回执。激活它（companion use ${id}）后产生的对话会记入。`);
          return true;
        }
        console.log(chalk.bold(`\n  🧾 ${id} 行动回执\n`));
        for (const r of rows) {
          const risk = r.maxRisk && r.maxRisk !== 'safe' ? chalk.yellow(` [${r.maxRisk}]`) : '';
          console.log('  ' + chalk.yellow(r.id) + chalk.dim(`  ${r.status} · ${r.tools} 工具`) + risk);
          if (r.goal) console.log(`     ${chalk.dim(r.goal)}`);
        }
        console.log('');
        return true;
      } catch (err) {
        printError(err.message || String(err));
        return true;
      }
    }

    case 'use': {
      const id = args[0];
      if (!id) { printError('缺少 id。用法: khy companion use <id>'); return true; }
      try {
        svc.setActiveAgent(id);
        printSuccess(`已激活同伴: ${id}`);
        printInfo('其人格 / 红线 / 记忆将注入后续对话的系统提示词。`khy companion unuse` 取消。');
      } catch (err) {
        printError(err.message || String(err));
      }
      return true;
    }

    case 'unuse': {
      svc.clearActiveAgent();
      printSuccess('已取消激活同伴。');
      return true;
    }

    case 'active': {
      const id = svc.getActiveAgentId();
      if (!id) { printInfo('当前没有激活的同伴。`khy companion use <id>` 激活一个。'); return true; }
      const agent = svc.getAgent(id);
      printInfo(`当前激活: ${agent ? agent.manifest.name : ''} (${id})`);
      return true;
    }

    case 'heartbeat': {
      const hb = require('../../services/heartbeatService');
      const action = (args[0] || 'status').toLowerCase();
      const globalOn = String(process.env.KHY_HEARTBEAT || 'on').trim().toLowerCase() !== 'off';

      if (action === 'reset') {
        hb.reset();
        printSuccess('已清空心跳去重账本。');
        return true;
      }

      const id = svc.getActiveAgentId();
      if (!id) { printInfo('当前没有激活的同伴。`khy companion use <id>` 激活一个再巡检。'); return true; }
      const md = svc.readAsset(id, svc.ASSET_FILES.heartbeat) || '';
      const list = hb.parseChecklist(md);

      console.log(chalk.bold(`\n  💓 ${id} 心跳巡检 (HEARTBEAT.md)\n`));
      console.log(`  开关: ${globalOn ? chalk.green('on') : chalk.dim('off (KHY_HEARTBEAT=off)')}`);
      console.log(`  清单: ${list.enabled ? chalk.green('已启用') : chalk.dim('未启用（留空或全为注释 → 静默）')}`);
      if (list.sources.length) {
        console.log(chalk.bold('\n  数据源:'));
        for (const s of list.sources) console.log(`    - ${s}`);
      }
      if (list.criteria.length) {
        console.log(chalk.bold('\n  判断标准:'));
        for (const c of list.criteria) console.log(`    - ${c}`);
      }

      if (action === 'run') {
        // dry-run：无真实探针 → 空 findings，演示静默/通知二态。真实数据源探针留后续。
        const res = hb.patrol({ companionId: id, findings: [] });
        const pill = res.status === 'notify' ? chalk.yellow('● 有事 (notify)') : chalk.green('● 静默 (silent)');
        console.log(chalk.bold('\n  巡检结果: ') + pill + chalk.dim(res.reason ? `  (${res.reason})` : ''));
        console.log(chalk.dim('  说明: 心跳只提醒，任何操作仍走审批；当前为 dry-run（未接入真实数据源探针）。'));
      } else {
        const events = hb.getEvents();
        const n = Object.keys(events.events || {}).length;
        console.log(chalk.dim(`\n  去重账本: ${n} 个事件键（24h 窗口内不重复提醒）`));
        console.log(chalk.dim('  `companion heartbeat run` 跑一次巡检；`reset` 清空去重账本。'));
      }
      console.log('');
      return true;
    }

    default:
      if (subCommand) printError(`未知子命令: companion ${subCommand}`);
      _usage();
      return true;
  }
}

module.exports = { handleCompanion };
