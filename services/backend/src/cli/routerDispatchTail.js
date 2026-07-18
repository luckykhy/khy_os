'use strict';

/**
 * Tail command cluster dispatch (extracted from cli/router.js route()).
 *
 * Owns the contiguous run of case bodies from `habit` through `bridge` — usage-habit, cleanup,
 * memory/khy.md (memory / remember / instructions / gitignore / permissions / add-dir / agents /
 * output-style), auth (login / register / logout), self-awareness (self / whoami / passwd / forgot),
 * and the newer Claude-Code ports (buddy / coordinator / orch / daemon / arena / remote / learn /
 * pr / ci / forge / verdict / evolve / deps / workflow / assistant / ultraplan / ulw-loop / bridge).
 * The case bodies are relocated verbatim (byte-identical) into this sibling leaf; because the leaf
 * lives in the same directory as router.js, every in-body relative require() resolves identically.
 *
 * route() pre-dispatches into dispatchTailCommand before its main switch: a command that matches a
 * tail case is handled here and its result returned; every other command returns the
 * ROUTER_NOT_HANDLED sentinel so route() falls through to its own switch. Because a switch jumps
 * straight to the matching case, an exact-command pre-check is behavior-preserving.
 *
 * The only host binding the moved bodies reference is chk() (the lazy chalk loader), injected via
 * setRouterDispatchTailDeps to avoid a require cycle back into router.js. This leaf runs command
 * handlers that perform IO, so it does NOT self-declare as a pure zero-IO leaf.
 */

const path = require('path');

const ROUTER_NOT_HANDLED = Symbol('router_tail_not_handled');

// Host callback injected via DI (avoid a require cycle back into router.js). chk is a lazy chalk
// loader assigned at router.js module top, before this leaf's setter runs, so the injection is safe.
let chk = null;
function setRouterDispatchTailDeps(deps = {}) {
  if (typeof deps.chk === 'function') chk = deps.chk;
}

async function dispatchTailCommand(command, _ctx) {
  const {
    subCommand, args, options, rawCommandToken, parsed, context,
    printError, printHelp, printInfo, printTable, printSuccess, printWarn, withSpinner, chalk,
  } = _ctx;
  switch (command) {
      case 'habit': {
        const habitSvc = require('../services/usageHabitService');

        if (subCommand === 'predict') {
          // Show predicted next commands
          const predictions = habitSvc.predictNextCommands(args.length > 0 ? args : ['help']);
          if (predictions.length === 0) {
            printInfo('暂无预测数据，继续使用系统积累更多习惯');
          } else {
            console.log(chalk.bold('\n  🔮 下一步预测'));
            for (const p of predictions) {
              const conf = Math.round(p.confidence * 100);
              console.log(`  ${chalk.cyan('→')} ${p.command} ${chalk.dim(`(${conf}% 置信度)`)}`);
            }
          }
          console.log('');
          return true;
        }

        // Default: show habit summary
        const summary = habitSvc.getHabitSummary();
        console.log(chalk.bold('\n  📊 使用习惯概况\n'));

        // Time profile
        if (summary.timeProfile.peakHours.length > 0) {
          console.log(`  活跃时段:    ${summary.timeProfile.peakHours.map(h => h + ':00').join(', ')}`);
        }
        console.log(`  平均会话:    ${summary.timeProfile.avgSession}`);
        console.log(`  总会话数:    ${summary.timeProfile.totalSessions}`);

        // Model ranking
        if (summary.modelRanking.length > 0) {
          console.log(chalk.bold('\n  🤖 模型使用排行'));
          for (const m of summary.modelRanking) {
            console.log(`  ${chalk.white(m.model)} — ${m.count} 次, 质量 ${chalk.green(m.quality)}`);
          }
        }

        // IDE usage
        if (summary.ideUsage.length > 0) {
          console.log(chalk.bold('\n  💻 IDE/适配器使用'));
          for (const ide of summary.ideUsage) {
            console.log(`  ${chalk.white(ide.ide)} — ${ide.count} 次`);
          }
        }

        // Top workflows
        if (summary.topWorkflows.length > 0) {
          console.log(chalk.bold('\n  ⚡ 常用工作流'));
          for (const w of summary.topWorkflows) {
            console.log(`  ${chalk.dim(w.workflow)} — ${w.count} 次`);
          }
        }

        // Topic focus
        if (summary.topics.length > 0) {
          console.log(chalk.bold('\n  📈 关注话题'));
          const trendIcon = { rising: '🔺', stable: '➖', declining: '🔻' };
          for (const t of summary.topics) {
            console.log(`  ${trendIcon[t.trend] || '·'} ${t.topic} — ${t.count} 次`);
          }
        }

        // Response preferences
        console.log(chalk.bold('\n  🎯 回复偏好'));
        console.log(`  长度: ${summary.responseStyle.preferredLength}  细节: ${summary.responseStyle.detailLevel}`);
        console.log(`  显示费用: ${summary.responseStyle.showCost ? '是' : '否'}  显示知识: ${summary.responseStyle.showTips ? '是' : '否'}`);

        console.log('');
        printInfo('输入 habit predict <上一个命令> 预测下一步');
        console.log('');
        return true;
      }

      // ── Cleanup ──
      case 'cleanup': {
        const cleanup = require('../services/cleanupService');
        if (subCommand === 'status') {
          const report = cleanup.getStorageReport();
          const last = typeof cleanup.getLastCleanupReport === 'function'
            ? cleanup.getLastCleanupReport()
            : null;
          console.log(chalk.bold('\n  🧹 存储空间使用\n'));
          console.log(`  安全日志:       ${chalk.white(cleanup.humanSize(report.securityLog.size))}`);
          console.log(`  日志归档:       ${chalk.white(cleanup.humanSize(report.securityLogArchives.size))}`);
          console.log(`  成长快照:       ${chalk.white(cleanup.humanSize(report.growthSnapshots.size))} (${report.growthSnapshots.count} 个)`);
          console.log(`  训练数据:       ${chalk.white(cleanup.humanSize(report.trainingData.size))}`);
          console.log(`  遥测导出:       ${chalk.white(cleanup.humanSize(report.telemetry.size))} (${report.telemetry.count} 个)`);
          console.log(`  对话记录:       ${chalk.white(cleanup.humanSize(report.conversations.size))} (${report.conversations.count} 个)`);
          console.log(chalk.dim('  ' + '─'.repeat(30)));
          console.log(`  总计:           ${chalk.bold(report.totalHuman)}`);
          if (last) {
            const triggerLabel = {
              manual: '手动执行',
              startup: '启动预取任务',
              periodic: '周期任务',
            }[String(last.trigger || '')] || String(last.trigger || 'unknown');
            console.log(chalk.bold('\n  最近一次清理\n'));
            console.log(`  触发来源:       ${chalk.white(triggerLabel)}`);
            console.log(`  处理目标:       ${chalk.white(`${last.targetCount || 0}/${last.targetCount || 0}`)} (失败 ${last.failureCount || 0})`);
            console.log(`  执行耗时:       ${chalk.white(`${last.elapsedMs || 0} ms`)}`);
            console.log(`  释放空间:       ${chalk.white(last.freedHuman || '0 B')}`);
            if (Array.isArray(last.targets) && last.targets.length > 0) {
              console.log(chalk.dim('\n  目标进度:'));
              last.targets.forEach((target, idx) => {
                const state = target.ok ? '成功' : '失败';
                const removed = typeof target.removed === 'number' ? `, 删除 ${target.removed} 项` : '';
                const reclaimed = typeof target.bytes === 'number' ? `, 释放 ${cleanup.humanSize(target.bytes)}` : '';
                const errText = target.ok ? '' : `, 错误 ${target.error || 'unknown'}`;
                console.log(`    ${idx + 1}/${last.targets.length} ${target.name}（${state}, ${target.elapsedMs || 0}ms${removed}${reclaimed}${errText}）`);
              });
            }
          }
          console.log(chalk.dim('\n  运行 cleanup 执行清理'));
          console.log('');
        } else {
          printInfo('执行存储清理（阶段 1/1，目标：安全日志、快照、训练数据、遥测、temp、logs、data/cache、ml/data/cache、系统临时目录）');
          const result = cleanup.runCleanup();
          if (result.summary.actions.length === 0) {
            printSuccess('所有数据在限额内，无需清理');
          } else {
            for (const action of result.summary.actions) {
              printSuccess(action);
            }
            printInfo(`释放空间: ${result.summary.freedHuman}`);
          }
          if (result.summary) {
            printInfo(`清理进度: ${result.summary.targetCount || 0}/${result.summary.targetCount || 0}，失败 ${result.summary.failureCount || 0}，耗时 ${result.summary.elapsedMs || 0}ms`);
          }
        }
        return true;
      }

      // ── Memory / khy.md ──
      case 'memory': {
        // /memory distill — periodic memory distillation (Module 3).
        //   /memory distill                 — analyze + report (dry-run, nothing changes)
        //   /memory distill --apply         — ARCHIVE the forget set (reversible)
        //   /memory distill archived        — list archived memories
        //   /memory distill restore [file]  — restore one (or all) archived memories
        if ((args[0] || '').toLowerCase() === 'distill') {
          const distiller = require('../services/memoryEngine/distiller');
          const sub = (args[1] || '').toLowerCase();

          if (sub === 'archived') {
            const archived = distiller.listArchived();
            console.log(chalk.bold('\n  🗄  已归档记忆（可恢复）\n'));
            if (!archived.length) {
              printInfo('归档为空');
            } else {
              for (const rec of archived) {
                console.log(`    - ${rec.filename} ${chalk.dim(`[${rec.reason}] ${rec.detail || ''} @ ${rec.archivedAt || '?'}`)}`);
              }
            }
            console.log('');
            return true;
          }

          if (sub === 'restore') {
            const target = args[2] ? String(args[2]).trim() : null;
            const res = distiller.restore(target ? { filename: target } : {});
            if (res.restored.length) {
              printSuccess(`已恢复 ${res.restored.length} 条记忆: ${res.restored.join(', ')}`);
            } else {
              printInfo('没有可恢复的记忆');
            }
            for (const f of res.failed) printError(`恢复失败 ${f.filename}: ${f.error}`);
            return true;
          }

          // Default: analyze. Apply only with an explicit --apply flag.
          const apply = options.apply === true || options.apply === 'true';
          const out = distiller.distill({ apply });
          console.log(chalk.bold('\n  🧪 记忆蒸馏'));
          console.log(chalk.dim('  忘记 = 归档（可恢复），绝不硬删除；不加 --apply 仅生成报告。\n'));
          console.log('  ' + distiller.formatPlan(out.plan).split('\n').join('\n  '));
          if (out.applied && out.result) {
            console.log('');
            printSuccess(`已归档 ${out.result.archived.length} 条记忆（运行 \`/memory distill restore\` 可恢复）`);
            for (const f of out.result.failed) printError(`归档失败 ${f.filename}: ${f.error}`);
          } else if (out.plan.forget.length) {
            console.log(chalk.dim('\n  这是预览。运行 `/memory distill --apply` 执行归档。'));
          }
          console.log('');
          return true;
        }

        // /memory project — 项目级记忆的人类可读入口 + 可维护 MEMORY.md 契约。
        //   /memory project          — 显示项目记忆目录/契约状态;若缺失则种下 MEMORY.md 契约
        //   /memory project --show   — 同上但额外打印契约种子全文(只读预览)
        if ((args[0] || '').toLowerCase() === 'project' || (args[0] || '').toLowerCase() === 'proj') {
          const memdir = require('../memdir');
          const contract = require('../memdir/projectMemoryContract');
          const ensured = memdir.ensureProjectMemoryIndex(process.cwd());
          const info = memdir.getProjectMemorySummary(process.cwd());
          console.log(chalk.bold('\n  🗂  项目记忆 (Project Memory)\n'));
          if (!contract.isEnabled(process.env)) {
            printInfo('项目记忆已关闭 (KHY_PROJECT_MEMORY=off) — 不创建任何文件。');
          } else if (ensured.created) {
            printSuccess(`已创建项目记忆契约: ${ensured.indexPath}`);
          }
          for (const line of contract.summarizeProjectMemory(info)) printInfo(line);
          if (options.show === true || options.show === 'true') {
            console.log(chalk.dim('\n  ── MEMORY.md 契约种子 ──\n'));
            console.log(contract.buildProjectMemoryIndexContract({
              projectRoot: info.projectRoot, memoryDir: info.memoryDir,
            }));
          } else {
            console.log(chalk.dim('\n  提示: 用 `khy memory project --show` 查看契约全文;直接编辑上面的 MEMORY.md 维护索引。'));
          }
          console.log('');
          return true;
        }

        const instructionSvc = require('../services/instructionFileService');
        const summary = instructionSvc.getInstructionSummary();
        const compatSummary = instructionSvc.getCompatInstructionSummary();
        const LEVEL_LABELS = { global: '全局', project: '项目', directory: '目录' };
        const TYPE_LABELS = { claude: 'CLAUDE', agents: 'AGENTS' };

        console.log(chalk.bold('\n  📋 协作指令文件\n'));
        console.log(chalk.dim('  冲突优先级: khy > claude > agents\n'));
        if (summary.length === 0 && compatSummary.length === 0) {
          printInfo('未找到任何指令文件');
          console.log(chalk.dim(`\n  创建指令文件以定制 AI 行为:`));
          console.log(chalk.dim(`    ~/.khyquant/khy.md    — 全局指令 (所有项目通用)`));
          console.log(chalk.dim(`    <项目>/khy.md         — 项目级指令`));
          console.log(chalk.dim(`    <当前目录>/khy.md     — 目录级指令`));
          console.log(chalk.dim(`    <项目>/CLAUDE.md      — Claude 兼容指令`));
          console.log(chalk.dim(`    <项目>/AGENTS.md      — Agent 兼容指令`));
        } else {
          if (summary.length > 0) {
            console.log(chalk.cyan('  [KHY]'));
            for (const file of summary) {
              const label = LEVEL_LABELS[file.level] || file.level;
              const truncWarning = file.truncated ? chalk.yellow(' (截断)') : '';
              console.log(`    ${chalk.cyan(`[${label}]`)} ${file.path} ${chalk.dim(`(${file.size} 字符)`)}${truncWarning}`);
            }
          }
          if (compatSummary.length > 0) {
            console.log(chalk.cyan('\n  [兼容指令]'));
            for (const file of compatSummary) {
              const label = TYPE_LABELS[file.type] || file.type;
              const truncWarning = file.truncated ? chalk.yellow(' (截断)') : '';
              console.log(`    ${chalk.magenta(`[${label}]`)} ${file.path} ${chalk.dim(`(${file.size} 字符)`)}` + `${truncWarning}`);
            }
          }
          console.log(chalk.dim(`\n  限制: 单文件 ${instructionSvc.MAX_FILE_CHARS} 字符, 合计 ${instructionSvc.MAX_TOTAL_CHARS} 字符`));
        }
        console.log('');
        return true;
      }

      // /remember <note> — explicit memory quick-add (CC `#` alignment). The
      // REPL also accepts a bare `#`-prefixed line; this is the command form.
      //
      // Structured form (Module 2): when --type is given, write a proper
      // frontmatter memory file into the persistent memory dir so the proactive
      // memory engine can rank and surface it later:
      //   /remember --type feedback --name "短标题" [--desc "一行摘要"] <内容>
      case 'remember': {
        const memType = options.type ? String(options.type).trim().toLowerCase() : null;
        if (memType) {
          const memoryEngine = require('../services/memoryEngine');
          const name = (options.name || options.title || '').toString().trim();
          const description = (options.desc || options.description || '').toString().trim();
          const content = args.join(' ').trim();
          if (!name || !content) {
            printInfo('用法: /remember --type <user|feedback|project|reference> --name "标题" [--desc "摘要"] <内容>');
            return true;
          }
          const tier = options.tier ? String(options.tier).trim().toLowerCase() : undefined;
          const res = memoryEngine.addStructuredMemory({ type: memType, name, description, content, tier });
          if (res.success) {
            if (res.ephemeral) {
              printSuccess(`已记入短期会话记忆 [${memType}/short_term]: ${name}（仅本次会话，结束即遗忘）`);
            } else if (res.action === 'skip') {
              printInfo(`记忆未变（正文与既有同名记忆相同，跳过）: ${res.filename}`);
            } else {
              printSuccess(`已写入结构化记忆 [${memType}]: ${res.filename}`);
            }
          } else {
            printError(`记忆未写入: ${res.error}`);
          }
          return true;
        }

        const instr = require('../services/instructionFileService');
        const scope = (options.global || options.g) ? 'global' : 'project';
        const note = args.join(' ').trim();
        if (!note) {
          printInfo('用法: /remember <要记住的内容>   (--global 写入全局 khy.md；--type 写入结构化记忆)');
          return true;
        }
        const res = instr.appendQuickMemory(note, { scope });
        if (res.success) {
          printSuccess(`已记住（${scope === 'global' ? '全局' : '项目'}）: ${res.file}${res.created ? ' (新建)' : ''}`);
        } else {
          printError(`记忆未写入: ${res.error}`);
        }
        return true;
      }

      // /instructions — review queue for the model's proactive khy.md/agent.md
      // writes. Proposals (from SaveInstruction or the auto instruction-candidate
      // branch) land in instructionReviewStore's pending list; the actual write to
      // the instruction file happens ONLY here, on explicit user approval.
      //   /instructions [list]          — list pending proposals
      //   /instructions approve <id>    — write the proposal into its target file
      //   /instructions discard <id>    — drop the proposal without writing
      //   /instructions clear           — drop all pending proposals
      case 'instructions': {
        const store = require('../services/instructionReviewStore');
        const sub = (args[0] || 'list').toLowerCase();

        const printList = () => {
          const pending = store.list();
          if (!pending.length) {
            printInfo('待审核指令文件写入：无。');
            return;
          }
          console.log(chalk.bold(`\n  待审核的指令文件写入（${pending.length} 条）:`));
          for (const e of pending) {
            const where = `${e.target === 'agent' ? 'agent.md' : 'khy.md'}·${e.scope === 'global' ? '全局' : '项目'}`;
            const src = e.source === 'tool' ? '模型工具' : '自动识别';
            console.log(`  ${chalk.cyan(e.id)}  [${where}·${src}] ${String(e.note || '').split('\n')[0].slice(0, 80)}`);
          }
          console.log(chalk.dim('\n  批准写入: /instructions approve <id>   丢弃: /instructions discard <id>\n'));
        };

        if (sub === 'list' || sub === 'ls' || sub === '') {
          printList();
          return true;
        }
        if (sub === 'approve' || sub === 'ok' || sub === 'accept') {
          const id = (args[1] || '').trim();
          if (!id) { printInfo('用法: /instructions approve <id>（先用 /instructions list 查看 id）'); return true; }
          const r = store.approve(id);
          if (r.success) {
            printSuccess(`已写入指令文件: ${r.file}${r.created ? ' (新建)' : ''}`);
          } else {
            printError(`批准失败: ${r.error}`);
          }
          return true;
        }
        if (sub === 'discard' || sub === 'drop' || sub === 'reject') {
          const id = (args[1] || '').trim();
          if (!id) { printInfo('用法: /instructions discard <id>'); return true; }
          const r = store.discard(id);
          if (r.success) printSuccess(`已丢弃候选: ${id}`);
          else printError(`丢弃失败: ${r.error}`);
          return true;
        }
        if (sub === 'clear') {
          const r = store.clear();
          if (r.success) printSuccess('已清空待审核队列。');
          else printError(`清空失败: ${r.error}`);
          return true;
        }
        printInfo('用法: /instructions [list|approve <id>|discard <id>|clear]');
        return true;
      }

      // /gitignore — 生成/维护 .gitignore + 待审核队列(镜像 /instructions 结构)。
      //   /gitignore generate            — 按探测到的技术栈生成/补全 .gitignore(用户显式 → 直接写)
      //   /gitignore add <pattern...>    — 把 pattern 加入待审核队列(approve 后才写)
      //   /gitignore review | list       — 看待审核队列
      //   /gitignore approve <id>        — 批准写入 .gitignore
      //   /gitignore discard <id>        — 丢弃候选
      //   /gitignore clear               — 清空队列
      case 'gitignore': {
        const sub = String(subCommand || args[0] || 'review').toLowerCase();
        const cwd = process.env.KHYQUANT_CWD || process.cwd();
        // subCommand 已由 SUB_COMMANDS 剥离时 args 即余参;否则 args[0] 是 sub,余参从 [1] 起。
        const rest = subCommand ? args : args.slice(1);

        const printList = () => {
          let store;
          try { store = require('../services/gitignoreReviewStore'); } catch { printError('忽略清单队列不可用。'); return; }
          const pending = store.list();
          if (!pending.length) {
            printInfo('待审核的 .gitignore 追加：无。');
            return;
          }
          console.log(chalk.bold(`\n  待审核的 .gitignore 追加（${pending.length} 条）:`));
          for (const e of pending) {
            const src = e.source === 'auto' ? '提交前自检' : '手动';
            const pats = (e.patterns || []).join('、');
            console.log(`  ${chalk.cyan(e.id)}  [${src}] ${pats.slice(0, 80)}`);
          }
          console.log(chalk.dim('\n  批准写入: /gitignore approve <id>   丢弃: /gitignore discard <id>\n'));
        };

        if (sub === 'generate' || sub === 'gen') {
          try {
            const gis = require('../services/gitignoreService');
            const r = gis.generateForProject(cwd);
            if (!r.success) { printError(`生成失败: ${r.error || '未知错误'}`); return true; }
            const stacks = (r.stacks || []).join('、') || '通用';
            if (r.added && r.added.length) {
              printSuccess(`已更新 .gitignore（${r.file}）：新增 ${r.added.length} 条。`);
              printInfo(`技术栈: ${stacks}`);
              console.log(chalk.dim('  ' + r.added.join('\n  ')));
            } else {
              printInfo(`.gitignore 已是最新（技术栈: ${stacks}），无需新增。`);
            }
          } catch (e) {
            printError(`生成失败: ${e.message || String(e)}`);
          }
          return true;
        }
        if (sub === 'add') {
          const patterns = rest.filter(Boolean);
          if (!patterns.length) { printInfo('用法: /gitignore add <pattern> [<pattern> ...]'); return true; }
          try {
            const store = require('../services/gitignoreReviewStore');
            const r = store.enqueue({ patterns, reason: 'manual', source: 'manual', cwd });
            if (r && r.success && !r.skipped) {
              printSuccess(`已加入待审核队列（${r.id}）：${patterns.join('、')}`);
              printInfo('批准写入 .gitignore：/gitignore approve ' + r.id);
            } else if (r && r.skipped) {
              printInfo('这些 pattern 已在待审核队列中，未重复加入。');
            } else {
              printError(`加入失败: ${(r && r.error) || '未知错误'}`);
            }
          } catch (e) {
            printError(`加入失败: ${e.message || String(e)}`);
          }
          return true;
        }
        if (sub === 'review' || sub === 'list' || sub === 'ls' || sub === '') {
          printList();
          return true;
        }
        if (sub === 'approve' || sub === 'ok' || sub === 'accept') {
          const id = (rest[0] || '').trim();
          if (!id) { printInfo('用法: /gitignore approve <id>（先用 /gitignore review 查看 id）'); return true; }
          try {
            const store = require('../services/gitignoreReviewStore');
            const r = store.approve(id, { cwd });
            if (r && r.success) {
              printSuccess(`已写入 .gitignore（${r.file}）：新增 ${(r.added || []).length} 条。`);
            } else {
              printError(`批准失败: ${(r && r.error) || '未知错误'}`);
            }
          } catch (e) {
            printError(`批准失败: ${e.message || String(e)}`);
          }
          return true;
        }
        if (sub === 'discard' || sub === 'drop' || sub === 'reject') {
          const id = (rest[0] || '').trim();
          if (!id) { printInfo('用法: /gitignore discard <id>'); return true; }
          try {
            const store = require('../services/gitignoreReviewStore');
            const r = store.discard(id);
            if (r && r.success) printSuccess(`已丢弃候选: ${id}`);
            else printError(`丢弃失败: ${(r && r.error) || '未知错误'}`);
          } catch (e) {
            printError(`丢弃失败: ${e.message || String(e)}`);
          }
          return true;
        }
        if (sub === 'clear') {
          try {
            const store = require('../services/gitignoreReviewStore');
            const r = store.clear();
            if (r && r.success) printSuccess('已清空待审核队列。');
            else printError(`清空失败: ${(r && r.error) || '未知错误'}`);
          } catch (e) {
            printError(`清空失败: ${e.message || String(e)}`);
          }
          return true;
        }
        printInfo('用法: /gitignore [generate|add <pattern>|review|approve <id>|discard <id>|clear]');
        return true;
      }


      // /permissions — view and edit the fine-grained permission policy
      // (<dataHome>/permissions.json). Backs Module 1 of the permission system.
      //   /permissions                       — show current policy
      //   /permissions init                  — scaffold a conservative default
      //   /permissions default <strategy>    — set the global default
      //   /permissions tool <name> <strategy|clear>
      //   /permissions allow-path <glob> [read|write|delete]
      //   /permissions allow-url <pattern>
      case 'permissions': {
        const policy = require('../services/permissionPolicy');
        const sub = (args[0] || '').toLowerCase();

        const showSummary = () => {
          const s = policy.summarize();
          console.log(chalk.bold('\n  🔐 细粒度权限策略\n'));
          console.log(`    启用: ${s.enabled ? chalk.green('是') : chalk.red('否 (KHY_PERMISSION_POLICY=off)')}`);
          console.log(`    配置文件: ${s.path}`);
          if (!s.exists) {
            console.log(chalk.dim('\n    尚未创建策略文件 → 中间件为无操作（现有权限流程不变）。'));
            console.log(chalk.dim('    运行 `/permissions init` 生成保守默认策略。\n'));
            return;
          }
          const p = s.policy || {};
          console.log(`    默认策略: ${chalk.cyan(p.defaultPolicy)}`);
          const tools = p.tools || {};
          const toolKeys = Object.keys(tools);
          console.log(`    工具覆盖: ${toolKeys.length ? toolKeys.map((k) => `${k}=${tools[k]}`).join(', ') : chalk.dim('（无）')}`);
          const fs2 = p.filesystem || {};
          const allPaths = [].concat(fs2.pathWhitelist || [], fs2.readWhitelist || [], fs2.writeWhitelist || [], fs2.deleteWhitelist || []);
          console.log(`    路径白名单: ${allPaths.length ? allPaths.join(', ') : chalk.dim('（无）')}`);
          console.log(`    URL 白名单: ${(p.network?.urlWhitelist || []).join(', ') || chalk.dim('（无）')}`);
          const ce = p.codeExecution || {};
          console.log(`    允许语言: ${(ce.allowedLanguages || []).join(', ') || chalk.dim('（不限）')}`);
          const lim = ce.limits || {};
          console.log(`    执行限制: cpu=${lim.cpuSeconds || 0}s mem=${lim.memoryMb || 0}MB timeout=${lim.timeoutMs || 0}ms`);
          console.log(`    敏感操作(强制二次确认): ${(p.sensitiveOperations?.requireConfirm || []).join(' · ') || chalk.dim('（无）')}`);
          console.log('');
        };

        const report = (r, okMsg) => {
          if (r && r.success) printSuccess(okMsg);
          else printError(`操作失败: ${(r && r.error) || '未知错误'}`);
        };

        if (!sub) { showSummary(); return true; }
        if (sub === 'init') {
          policy.config.ensurePolicy();
          printSuccess(`已生成默认策略: ${policy.config.getPolicyPath()}`);
          showSummary();
          return true;
        }
        if (sub === 'default') {
          report(policy.setDefaultStrategy(args[1]), `默认策略已设为 ${args[1]}`);
          return true;
        }
        if (sub === 'tool') {
          const name = args[1];
          const strat = (args[2] || '').toLowerCase();
          if (!name) { printInfo('用法: /permissions tool <工具名> <auto|confirm|deny|clear>'); return true; }
          if (strat === 'clear') report(policy.clearToolStrategy(name), `已清除 ${name} 的覆盖策略`);
          else report(policy.setToolStrategy(name, strat), `${name} 策略已设为 ${strat}`);
          return true;
        }
        if (sub === 'allow-path') {
          const glob = args[1];
          const verb = (args[2] || 'all').toLowerCase();
          report(policy.addPathRule(glob, verb), `已加入${verb === 'all' ? '' : verb}路径白名单: ${glob}`);
          return true;
        }
        if (sub === 'allow-url') {
          report(policy.addUrlRule(args[1]), `已加入 URL 白名单: ${args[1]}`);
          return true;
        }
        printInfo('用法: /permissions [init|default <s>|tool <name> <s>|allow-path <glob> [read|write|delete]|allow-url <pattern>]');
        return true;
      }

      // /add-dir <path> — grant the session access to an extra working directory
      // (Claude Code alignment). With no argument, list currently granted dirs.
      case 'add-dir':
      case 'adddir': {
        const addl = require('../services/additionalDirectories');
        const target = args.join(' ').trim();
        if (!target) {
          const dirs = addl.getDirectories();
          if (dirs.length === 0) {
            printInfo('尚未添加额外工作目录。用法: /add-dir <路径>');
          } else {
            printInfo('已授权的额外工作目录:');
            for (const d of dirs) printInfo(`  • ${d}`);
          }
          return true;
        }
        const res = addl.addDirectory(target);
        if (res.success) {
          if (res.alreadyPresent) printInfo(`目录已在授权列表中: ${res.dir}`);
          else printSuccess(`已添加工作目录: ${res.dir}`);
        } else {
          printError(`添加失败: ${res.error}`);
        }
        return true;
      }

      // /agents — list available agent types (built-in + custom from
      // .khy/agents/ and .claude/agents/). Claude Code `/agents` alignment.
      // Read-only: surfaces the agent-definitions registry, which the
      // AgentTool consumes when spawning sub-agents.
      case 'agents': {
        const { getAgentDefinitions } = require('../agents');
        const cwd = process.env.KHYQUANT_CWD || process.cwd();
        const { activeAgents, allAgents, failedFiles } = await getAgentDefinitions(cwd);

        const SOURCE_LABEL = {
          'built-in': '内置',
          plugin: '插件',
          userSettings: '用户',
          projectSettings: '项目',
          policySettings: '托管',
          flagSettings: '命令行',
        };
        const describeTools = (agent) => {
          const { tools, disallowedTools } = agent;
          const hasAllow = Array.isArray(tools) && tools.length > 0;
          const hasDeny = Array.isArray(disallowedTools) && disallowedTools.length > 0;
          if (hasAllow && hasDeny) {
            const deny = new Set(disallowedTools);
            const eff = tools.filter((t) => !deny.has(t));
            return eff.length === 0 ? 'None' : eff.join(', ');
          }
          if (hasAllow) return tools.join(', ');
          if (hasDeny) return `所有工具，除 ${disallowedTools.join(', ')}`;
          return '所有工具';
        };

        printInfo(`可用代理类型 (${activeAgents.length} 个生效 / 共 ${allAgents.length} 个已加载):\n`);
        for (const agent of activeAgents) {
          const src = SOURCE_LABEL[agent.source] || agent.source || '?';
          const model = agent.model ? ` ${chalk.dim(`[${agent.model}]`)}` : '';
          console.log(`  ${chalk.cyan(agent.agentType)} ${chalk.dim(`(${src})`)}${model}`);
          if (agent.whenToUse) console.log(`    ${chalk.dim(agent.whenToUse)}`);
          console.log(`    ${chalk.dim('工具:')} ${describeTools(agent)}`);
        }
        if (failedFiles && failedFiles.length > 0) {
          console.log(chalk.yellow(`\n  ${failedFiles.length} 个代理定义加载失败:`));
          for (const f of failedFiles) console.log(`    ${chalk.yellow('✗')} ${f.path}: ${f.error}`);
        }
        console.log(chalk.dim('\n  自定义代理: 在 .khy/agents/ 或 .claude/agents/ 放置带 frontmatter 的 .md 文件'));
        console.log('');
        return true;
      }

      // /output-style [name|off] — view or switch the AI output style
      // (Claude Code `/output-style` alignment). Built styles live in
      // constants/outputStyles.js; the active one is read from
      // KHY_OUTPUT_STYLE at system-prompt build time, so setting the env here
      // takes effect on the next turn, and persisting to khySettings makes it
      // survive a restart.
      case 'output-style':
      case 'outputstyle': {
        const { BUILT_IN_STYLES, STYLE_OFF_VALUES, isValidStyleName, getActiveOutputStyleName } =
          require('../constants/outputStyles');
        const { _persistStringKhySetting } = require('./repl/khySettings');
        const target = args.join(' ').trim();

        if (!target) {
          const active = getActiveOutputStyleName();
          printInfo('AI 输出风格（Claude Code /output-style 对位）:\n');
          for (const [name, def] of Object.entries(BUILT_IN_STYLES)) {
            const mark = name === active ? chalk.green(' ← 当前') : '';
            console.log(`  ${chalk.cyan(name)}${mark}`);
            const desc = String(def.prompt || '').slice(0, 88);
            console.log(`    ${chalk.dim(desc)}${def.prompt && def.prompt.length > 88 ? '…' : ''}`);
          }
          const offActive = STYLE_OFF_VALUES.includes(active.toLowerCase());
          console.log(`  ${chalk.cyan('off')}${offActive ? chalk.green(' ← 当前') : ''}  ${chalk.dim('关闭风格注入')}`);
          console.log(chalk.dim('\n  用法: /output-style <名称|off>   (自定义: ~/.khy/output-styles/<名称>.md)'));
          console.log('');
          return true;
        }

        if (!isValidStyleName(target)) {
          printError(`未知输出风格: ${target}`);
          printInfo(`可选: ${Object.keys(BUILT_IN_STYLES).join(', ')}, off`);
          return true;
        }

        process.env.KHY_OUTPUT_STYLE = target;
        const persisted = _persistStringKhySetting('outputStyle', target);
        printSuccess(`输出风格已切换为「${target}」，下一轮对话生效。`);
        if (!persisted) printWarn('注意: 未能写入用户设置，重启后将恢复默认。');
        return true;
      }

      // ── Auth Commands ──
      case 'login': {
        const cliAuth = require('../services/cliAuthService');
        const session = cliAuth.checkSession();

        if (session.loggedIn) {
          printInfo(`当前已登录: ${session.username}`);
          printInfo('如需切换账号，请先 /logout 再 /login');
          return true;
        }

        const inquirer = require('inquirer');
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'username',
            message: '用户名:',
            validate: v => v.trim().length > 0 || '请输入用户名',
          },
          { type: 'password', name: 'password', message: '密码:', mask: '*', validate: v => v.length > 0 || '请输入密码' },
        ]);
        const result = await cliAuth.login(answers.username, answers.password);
        if (result.success) {
          printSuccess(`登录成功! 欢迎, ${result.username}`);
        } else {
          printError(result.error);
        }
        return true;
      }

      case 'register': {
        const cliAuth = require('../services/cliAuthService');
        const inquirer = require('inquirer');
        if (cliAuth.isRegistered()) {
          printInfo('本机已有注册账号。如需重置请删除 ~/.khyquant/credentials.json');
          return true;
        }
        const answers = await inquirer.prompt([
          { type: 'input', name: 'username', message: '用户名 (至少 2 字符):', validate: v => v.trim().length >= 2 || '至少 2 个字符' },
          { type: 'password', name: 'password', message: '设置密码 (至少 6 字符):', mask: '*', validate: v => v.length >= 6 || '至少 6 个字符' },
          { type: 'password', name: 'confirm', message: '确认密码:', mask: '*', validate: (v, a) => v === a.password || '两次密码不一致' },
          { type: 'input', name: 'email', message: '邮箱 (可选):', default: '' },
        ]);
        const result = await cliAuth.register(answers.username, answers.password, answers.email || undefined);
        if (result.success) printSuccess(`注册成功! 欢迎, ${result.username}`);
        else printError(result.error);
        return true;
      }

      case 'logout': {
        const cliAuth = require('../services/cliAuthService');
        cliAuth.logout();
        printSuccess('已退出登录');
        printInfo('下次启动时需要重新登录');
        return true;
      }

      // ── Self-Awareness (自知 + 他知) ──
      case 'self': {
        const selfProfileService = require('../services/selfProfile');
        const profile = selfProfileService.getFullProfile({ cwd: process.cwd() });

        if (options.json) {
          console.log(JSON.stringify(selfProfileService.formatForAPI(profile), null, 2));
        } else if (options.brief) {
          console.log('\n  ' + selfProfileService.formatBrief(profile) + '\n');
        } else if (subCommand === 'capabilities') {
          const domains = profile.capabilityDomains || {};
          console.log(chalk.cyan.bold('\n  khy OS 能力域\n'));
          for (const [key, domain] of Object.entries(domains)) {
            console.log(`  ${chalk.bold(domain.summary)}`);
            console.log(`  ${chalk.dim(domain.description)}`);
            if (domain.providers) console.log(`  ${chalk.dim('providers: ' + domain.providers.join(', '))}`);
            if (domain.features) console.log(`  ${chalk.dim('features: ' + (Array.isArray(domain.features) ? domain.features.join(', ') : domain.features))}`);
            if (domain.modes) console.log(`  ${chalk.dim('modes: ' + (Array.isArray(domain.modes) ? domain.modes.join(', ') : domain.modes))}`);
            if (domain.abis) console.log(`  ${chalk.dim('ABIs: ' + domain.abis.join(', '))}`);
            console.log('');
          }
        } else if (subCommand === 'boundaries') {
          console.log(chalk.cyan.bold('\n  khy OS 能力边界\n'));
          (profile.boundaries || []).forEach((b, i) => {
            console.log(`  ${i + 1}. ${chalk.bold(b.short)}`);
            console.log(`     ${chalk.dim(b.detail)}`);
          });
          console.log('');
        } else if (subCommand === 'runtime') {
          const rt = profile.runtime?.runtime || {};
          const gw = profile.runtime?.gateway || {};
          const llm = profile.runtime?.localLLM || {};
          console.log(chalk.cyan.bold('\n  khy OS 运行时状态\n'));
          console.log(`  平台:      ${chalk.white(rt.platform)}`);
          console.log(`  Node:      ${chalk.white(rt.nodeVersion)}`);
          console.log(`  Python:    ${chalk.white(rt.pythonVersion)}`);
          console.log(`  工作目录:  ${chalk.white(rt.cwd)}`);
          console.log(`  通道:      ${chalk.white((gw.currentAdapter || 'auto') + ' / ' + (gw.currentModel || 'auto'))}`);
          console.log(`  本地推理:  ${chalk.white(llm.status + (llm.backend ? ' (' + llm.backend + ')' : ''))}`);
          console.log(`  模式:      ${chalk.white(rt.studyMode ? '学习模式' : '普通模式')}`);
          console.log('');
        } else {
          // Default: full human-readable profile
          console.log('');
          console.log(selfProfileService.formatForHuman(profile));
          console.log('');
        }
        return true;
      }

      case 'whoami': {
        const cliAuth = require('../services/cliAuthService');
        const user = cliAuth.getCurrentUser();
        if (!user) {
          printInfo('当前未登录');
        } else {
          console.log('');
          console.log(chalk.cyan.bold('  👤 当前用户'));
          console.log(chalk.dim('  ' + '─'.repeat(30)));
          console.log(`  用户名:   ${chalk.bold(user.username)}`);
          if (user.email) console.log(`  邮箱:     ${chalk.dim(user.email)}`);
          // 安全时间格式化(门控 KHY_AUTH_DATE_SANE 默认开):无效/缺失值 → 「未知」,
          // 已过期的会话到期追加「(已过期)」,消除「会话到期: Invalid Date」。
          // 门控关 → 逐字节回退旧的 new Date(x).toLocaleString('zh-CN')。
          const authTime = require('../services/authTimeFormat');
          const fmtDate = authTime.isEnabled()
            ? (v, markExpired) => authTime.formatAuthTimestamp(v, { locale: 'zh-CN', markExpired: !!markExpired })
            : (v) => new Date(v).toLocaleString('zh-CN');
          console.log(`  注册时间: ${chalk.dim(fmtDate(user.registeredAt))}`);
          console.log(`  登录时间: ${chalk.dim(fmtDate(user.loginAt))}`);
          console.log(`  会话到期: ${chalk.dim(fmtDate(user.sessionExpires, true))}`);
          console.log('');
        }
        return true;
      }

      case 'passwd': {
        const cliAuth = require('../services/cliAuthService');
        const inquirer = require('inquirer');
        const answers = await inquirer.prompt([
          { type: 'password', name: 'oldPassword', message: '当前密码:', mask: '*', validate: v => v.length > 0 || '请输入当前密码' },
          { type: 'password', name: 'newPassword', message: '新密码 (至少 6 字符):', mask: '*', validate: v => v.length >= 6 || '至少 6 个字符' },
          { type: 'password', name: 'confirm', message: '确认新密码:', mask: '*', validate: (v, a) => v === a.newPassword || '两次密码不一致' },
        ]);
        const result = await cliAuth.changePassword(answers.oldPassword, answers.newPassword);
        if (result.success) printSuccess('密码修改成功');
        else printError(result.error);
        return true;
      }

      case 'forgot': {
        const cliAuth = require('../services/cliAuthService');
        const inquirer = require('inquirer');

        const { method } = await inquirer.prompt([{
          type: 'list',
          name: 'method',
          message: '选择找回方式:',
          choices: [
            { name: '密保问题找回', value: 'security_question' },
            { name: '邮箱验证码找回', value: 'email' },
            { name: '手机验证码找回', value: 'phone' },
          ],
        }]);

        if (method === 'security_question') {
          const { username } = await inquirer.prompt([
            { type: 'input', name: 'username', message: '用户名:', validate: v => v.trim().length > 0 || '请输入用户名' },
          ]);
          const qResult = await cliAuth.getSecurityQuestion(username);
          if (!qResult.success) { printError(qResult.error); return true; }

          printInfo(`密保问题: ${qResult.question}`);
          const recovery = await inquirer.prompt([
            { type: 'input', name: 'answer', message: '密保答案:', validate: v => v.trim().length > 0 || '请输入答案' },
            { type: 'password', name: 'newPassword', message: '新密码 (至少 6 字符):', mask: '*', validate: v => v.length >= 6 || '至少 6 个字符' },
            { type: 'password', name: 'confirm', message: '确认新密码:', mask: '*', validate: (v, a) => v === a.newPassword || '两次密码不一致' },
          ]);
          const resetResult = await cliAuth.resetPasswordWithSecurityAnswer(username, recovery.answer, recovery.newPassword);
          if (resetResult.success) printSuccess('密码重置成功! 请使用新密码登录');
          else printError(resetResult.error);

        } else {
          const label = method === 'phone' ? '手机号' : '邮箱';
          const { target } = await inquirer.prompt([
            { type: 'input', name: 'target', message: `注册时的${label}:`, validate: v => v.trim().length >= 3 || `请输入有效${label}` },
          ]);
          printInfo('正在发送验证码...');
          const sendResult = await cliAuth.requestVerificationCode(method, target);
          if (!sendResult.success) { printError(sendResult.error); return true; }
          printSuccess(sendResult.message);

          const recovery = await inquirer.prompt([
            { type: 'input', name: 'code', message: '验证码:', validate: v => v.trim().length >= 4 || '请输入验证码' },
            { type: 'password', name: 'newPassword', message: '新密码 (至少 6 字符):', mask: '*', validate: v => v.length >= 6 || '至少 6 个字符' },
            { type: 'password', name: 'confirm', message: '确认新密码:', mask: '*', validate: (v, a) => v === a.newPassword || '两次密码不一致' },
          ]);
          const resetResult = await cliAuth.resetPasswordWithVerificationCode(method, target, recovery.code, recovery.newPassword);
          if (resetResult.success) printSuccess('密码重置成功! 请使用新密码登录');
          else printError(resetResult.error);
        }
        return true;
      }

      // ── New Systems (Claude Code ports) ──────────────────────────
      case 'buddy': {
        const { handleBuddyCommand } = require('../buddy');
        await handleBuddyCommand(subCommand, args, options);
        return true;
      }

      case 'coordinator': {
        const coord = require('../coordinator/coordinatorMode');
        if (subCommand === 'on') { coord.activateCoordinatorMode(); printInfo('Coordinator mode activated.'); }
        else if (subCommand === 'off') { coord.deactivateCoordinatorMode(); printInfo('Coordinator mode deactivated.'); }
        else if (subCommand === 'status') { printInfo(`Coordinator mode: ${coord.isCoordinatorMode() ? 'ON' : 'OFF'}`); }
        else if (subCommand === 'board') {
          const taskBoard = require('../coordinator/taskBoard');
          const tasks = taskBoard.listTasks();
          const counts = { pending: 0, claimed: 0, completed: 0, failed: 0 };
          for (const task of tasks) {
            if (Object.prototype.hasOwnProperty.call(counts, task.status)) {
              counts[task.status] += 1;
            }
          }

          console.log(chalk.bold('\n  Coordinator Task Board'));
          console.log(`  Total:     ${tasks.length}`);
          console.log(`  Pending:   ${counts.pending}`);
          console.log(`  Claimed:   ${counts.claimed}`);
          console.log(`  Completed: ${counts.completed}`);
          console.log(`  Failed:    ${counts.failed}`);

          if (tasks.length === 0) {
            printInfo('任务板暂无任务');
          } else {
            console.log('');
            printTable(
              ['ID', '状态', '优先级', '负责人', '描述'],
              tasks.slice(0, 20).map((task) => [
                task.id || '-',
                task.status || '-',
                task.priority || 'medium',
                task.assignee || '-',
                task.description || '-',
              ])
            );
            if (tasks.length > 20) {
              printInfo(`仅显示前 20 条任务，共 ${tasks.length} 条`);
            }
          }
        } else { printInfo('Usage: coordinator [on|off|status|board]'); }
        return true;
      }

      case 'orch':
      case 'orchestrate': {
        const { handleOrchestrate } = require('./handlers/orchestrate');
        return await handleOrchestrate(subCommand, args, options);
      }

      case 'daemon': {
        const { handleDaemon } = require('./handlers/daemon');
        await handleDaemon(subCommand, { chalk: chk(), options });
        return true;
      }

      case 'arena': {
        const { handleArena } = require('./handlers/arena');
        await handleArena(subCommand, { chalk: chk(), options });
        return true;
      }

      case 'moa': {
        const { handleMoa } = require('./handlers/moa');
        // `moa` takes a free-form prompt (not a registered sub-command), so
        // subCommand is null; rebuild the full argument string for the handler.
        const moaInput = [subCommand, ...(args || [])].filter(Boolean).join(' ');
        await handleMoa(moaInput, { chalk: chk(), options });
        return true;
      }

      case 'remote': {
        const { handleRemote } = require('./handlers/remote');
        await handleRemote(subCommand, { chalk: chk(), options });
        return true;
      }

      case 'remotedev':
      case 'rdev': {
        const { handleRemoteDev } = require('./handlers/remotedev');
        await handleRemoteDev(subCommand, args, options);
        return true;
      }

      case 'learn': {
        const { handleLearn } = require('./handlers/learn');
        return handleLearn(subCommand, args);
      }

      case 'pr':
      case 'mr': {
        const { handlePr } = require('./handlers/pr');
        return handlePr(subCommand, args, options);
      }

      case 'ci': {
        const { handleCi } = require('./handlers/ci');
        return handleCi(subCommand, args, options);
      }

      // ── 查找/拉取远端项目(khy forge …):GitHub·Gitee·GitLab 搜索 + clone/pull ──
      case 'forge': {
        const { handleForge } = require('./handlers/forge');
        return handleForge(subCommand, args, options);
      }

      // ── khy 改动反馈(khy verdict …)：看 khyos 对最近一次 khy 改动对不对的判定 ──
      case 'verdict': {
        const { handleVerdict } = require('./handlers/verdict');
        return handleVerdict(subCommand, args, options);
      }

      // ── 自动进化策略(khy evolve …)只读查询可变性分级与联动义务 ──
      case 'evolve':
      case 'evolution': {
        const { handleEvolve } = require('./handlers/evolve');
        return handleEvolve(subCommand, args, options);
      }

      // ── 依赖按需安装(khy deps …)——客户主动驱动「依赖自愈层」按需选版下载安装 ──
      case 'deps':
      case 'dep':
      case 'dependency': {
        const { handleDeps } = require('./handlers/deps');
        return handleDeps(subCommand, args, options);
      }

      // ── 工作流(khy workflow / wf …)──
      // 把已发布的工作流子系统(canonical 解释器 + Coze 导入器)接到命令行:
      // import / list / show / validate / run / rm。复用 Engine A,绝不另造引擎。
      case 'workflow':
      case 'wf': {
        const { handleWorkflow } = require('./handlers/workflow');
        return handleWorkflow(subCommand, args, options);
      }

      case 'assistant':
      case 'brief': {
        const { handleAssistantCommand } = require('./handlers/assistant');
        const sub = command === 'brief' ? 'brief' : subCommand;
        await handleAssistantCommand(sub, args, options);
        return true;
      }

      case 'ultraplan': {
        const { handleUltraplanCommand, handleUltraplanStatus } = require('./handlers/ultraplan');
        if (subCommand === 'status' || subCommand === 'list') {
          await handleUltraplanStatus();
        } else {
          await handleUltraplanCommand(args, options);
        }
        return true;
      }

      case 'ulw-loop': {
        const task = args.join(' ').trim();
        if (!task) {
          printInfo('用法: /ulw-loop <任务描述>');
          printInfo('示例: /ulw-loop 修复 gateway 重试逻辑并补测试');
          return true;
        }
        return {
          aiForward: `ultrawork\n\n${task}`,
        };
      }

      case 'bridge': {
        const bridgeSrv = require('../bridge/bridgeServer');
        if (subCommand === 'start') {
          const info = await bridgeSrv.startBridgeServer();
          if (info && info.port > 0) {
            printInfo(`Bridge started: ${info.url}`);
          }
        }
        else if (subCommand === 'stop') { await bridgeSrv.stopBridgeServer(); }
        else if (subCommand === 'status') { bridgeSrv.printStatus(); }
        else if (subCommand === 'token') { bridgeSrv.printToken(); }
        else if (subCommand === 'nginx') {
          const nginxOpts = {};
          // Parse optional flags: --prefix /path --port 80 --server-name example.com --ssl --cert /path --key /path
          for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if ((a === '--prefix' || a === '-p') && args[i + 1]) nginxOpts.locationPrefix = args[++i];
            else if ((a === '--port' || a === '--listen') && args[i + 1]) nginxOpts.listenPort = parseInt(args[++i], 10);
            else if ((a === '--server-name' || a === '--host') && args[i + 1]) nginxOpts.serverName = args[++i];
            else if (a === '--ssl') nginxOpts.ssl = true;
            else if (a === '--cert' && args[i + 1]) nginxOpts.certPath = args[++i];
            else if (a === '--key' && args[i + 1]) nginxOpts.keyPath = args[++i];
          }
          bridgeSrv.printNginxConfig(nginxOpts);
        }
        else { printInfo('Usage: bridge [start|stop|status|token|nginx]'); }
        return true;
      }
      default: return ROUTER_NOT_HANDLED;
    }
}

module.exports = { dispatchTailCommand, setRouterDispatchTailDeps, ROUTER_NOT_HANDLED };
