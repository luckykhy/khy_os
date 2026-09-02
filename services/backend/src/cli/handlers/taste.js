'use strict';

/**
 * Taste command handler — khy taste …
 *
 * Mirrors the cmdc taste CLI surface (`npx taste …`) and is wired into
 * router.js as a top-level case. Sub-commands are positional: taste <verb>
 * [args …]. The verb is read from the first positional (subCommand or args[0])
 * so Chinese / alias-style invocations also work.
 *
 *   taste list           list all categories with item counts
 *   taste show [cat]     print every item (cat omitted = all)
 *   taste add <cat> <text>   [--confidence 0.7]
 *   taste bump <text>    [--delta 0.05] [--category cat]
 *   taste drop <text>    [--category cat]
 *   taste learn          mine Claude Code / cmdc / OpenCode / Gemini / YCode /
 *                        Codex / OpenClaw / ZCode session files for taste
 *                        candidates and promote the high-confidence ones.
 *                        Flags:
 *                          --app <id>      limit to one source (claude-code,
 *                                          command-code, opencode, gemini, codex,
 *                                          ycode, openclaw, zcode). Default: all.
 *                          --since <30d|2026-01-01>  time window (default: 30d)
 *                          --max <n>       cap on session files scanned (default 200)
 *                          --confidence <n>  auto-commit floor (default 0.7)
 *                          --dry-run       list candidates without writing
 *   taste lint           validate on-disk structure
 *   taste path           print ~/.khyos/taste
 *   taste section        print the system-prompt section that would be injected
 *
 * `push` / `pull` / `open` are intentionally omitted in this revision — there
 * is no team / remote registry in khy-os today, and we don't want to ship a
 * broken stub. They can land later behind a feature flag.
 */
const path = require('path');
const { spawn } = require('child_process');
const chalk = require('picocolors');
const { printSuccess, printError, printInfo, printWarn } = require('../formatters');

function _verb(parsed) {
  return (parsed.subCommand || parsed.args[0] || '').toLowerCase();
}

function _rest(parsed) {
  return parsed.subCommand ? parsed.args : parsed.args.slice(1);
}

function _parseFlags(rest) {
  // Minimal --key value / --key=value parser for our small surface.
  const opts = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (tok === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      let key;
      let value;
      if (eq >= 0) {
        key = body.slice(0, eq);
        value = body.slice(eq + 1);
      } else {
        key = body;
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          value = next;
          i += 1;
        } else {
          value = true;
        }
      }
      opts[key] = value;
    } else {
      positional.push(tok);
    }
  }
  return { opts, positional };
}

async function handleTasteCommand(parsed) {
  const taste = require('../../services/tasteService');
  const verb = _verb(parsed);
  const rest = _rest(parsed);
  const { opts, positional } = _parseFlags(rest);
  // The router pre-parses global flags (e.g. --off) into parsed.options.
  // Merge those in so handlers that read from `opts` (like `watch`) see them
  // without depending on the order of rest vs. pre-parsed flags. Pre-parsed
  // values win (the router already validated them) — only fall back to
  // _parseFlags output when the router didn't carry the key.
  const routerOpts = (parsed && parsed.options && typeof parsed.options === 'object') ? parsed.options : {};
  for (const k of Object.keys(routerOpts)) {
    if (routerOpts[k] !== undefined && opts[k] === undefined) {
      opts[k] = routerOpts[k];
    }
  }

  switch (verb) {
    case 'list': {
      const cats = taste.listCategories();
      if (cats.length === 0) {
        printInfo('No taste recorded yet. Add one: khy taste add general "用户偏好中文"');
        // Cross-agent learn hint: only when at least one other agent has
        // session files on disk. We probe without printing anything if
        // nothing's there — keeps the output clean for first-run users.
        try {
          const learner = require('../../services/crossAgentTasteLearner');
          const discovered = learner.discoverSessionFiles();
          if (discovered.length > 0) {
            const apps = Array.from(new Set(discovered.map((d) => d.app))).join(', ');
            console.log('');
            printInfo(`检测到跨 agent 历史 session (${apps}, 共 ${discovered.length} 个文件)。`);
            printInfo('  运行 khy taste learn --dry-run 看看能提炼出哪些偏好。');
          }
        } catch {
          /* taste-learner hint is best-effort */
        }
        return;
      }
      console.log('');
      console.log(chalk.bold('  Taste categories'));
      console.log(chalk.dim('  ' + '─'.repeat(40)));
      for (const c of cats) {
        const total = c.inline + c.overflow;
        const where = c.overflow > 0 ? `${c.inline} inline + ${c.overflow} overflow` : `${c.inline} inline`;
        console.log(`  ${chalk.cyan(c.category.padEnd(16))}  ${chalk.dim(where)}  (${total})`);
      }
      console.log('');
      printInfo('Edit: khy taste add <cat> "<text>"');
      printInfo('Inject: khy taste section');
      return;
    }
    case 'show': {
      const items = taste.readAll({ confidenceFloor: 0 });
      const targetCat = positional[0];
      const filtered = targetCat ? items.filter((i) => i.category === targetCat) : items;
      if (filtered.length === 0) {
        printInfo(targetCat ? `No taste items in "${targetCat}".` : 'No taste recorded yet.');
        return;
      }
      console.log('');
      for (const it of filtered) {
        console.log(
          `  ${chalk.dim(`[${it.category}]`)} ${it.text}  ${chalk.dim(`(c=${it.confidence.toFixed(2)}, ${it.source})`)}`
        );
      }
      console.log('');
      return;
    }
    case 'add': {
      const cat = positional[0];
      const textParts = positional.slice(1);
      if (!cat || textParts.length === 0) {
        printError('用法: khy taste add <category> "<text>"  [--confidence 0.7]');
        return;
      }
      const text = textParts.join(' ');
      const confOpt = opts.confidence;
      const confidence = confOpt === undefined ? undefined : Number(confOpt);
      const result = taste.addPreference({ category: cat, text, confidence });
      if (!result.ok) {
        printError(`添加失败: ${result.error}`);
        return;
      }
      printSuccess(
        `已加入 [${result.category}] (c=${result.confidence.toFixed(2)}, ${result.location})`
      );
      printInfo(`  ${result.text}`);
      return;
    }
    case 'bump': {
      const textParts = positional;
      if (textParts.length === 0) {
        printError('用法: khy taste bump "<text>"  [--delta 0.05] [--category cat]');
        return;
      }
      const text = textParts.join(' ');
      const delta = opts.delta === undefined ? 0.05 : Number(opts.delta);
      const result = taste.adjustConfidence({ text, delta, category: opts.category });
      if (!result.ok) {
        printError(`调整失败: ${result.error}`);
        return;
      }
      printSuccess(`已调整 [${result.category}] → confidence ${result.confidence.toFixed(2)}`);
      return;
    }
    case 'drop':
    case 'rm':
    case 'remove': {
      const textParts = positional;
      if (textParts.length === 0) {
        printError('用法: khy taste drop "<text>"  [--category cat]');
        return;
      }
      const text = textParts.join(' ');
      const result = taste.removePreference({ text, category: opts.category });
      if (!result.ok) {
        printError(`删除失败: ${result.error}`);
        return;
      }
      printSuccess('已删除');
      return;
    }
    case 'watch': {
      const watch = require('../../services/tasteWatchService');
      const wantOn = opts.on === true || opts.on === 'true';
      const wantOff = opts.off === true || opts.off === 'true';
      const wantStatus = opts.status === true || opts.status === 'true';
      const wantReset = opts.reset === true || opts.reset === 'true';

      if (wantOn && wantOff) {
        printError('用法: khy taste watch --on | --off | --status | --reset');
        return;
      }
      if (wantReset) {
        watch.resetSeenCache();
        watch.resetStats();
        printSuccess('已清空 watch 缓存与统计');
        return;
      }
      if (wantOn) {
        watch.setEnabled(true);
        printSuccess('taste watch 已启用 — 每轮 chat 后会自动沉淀偏好到 taste.md');
      } else if (wantOff) {
        watch.setEnabled(false);
        printSuccess('taste watch 已停用');
      } else if (wantStatus) {
        // fall through to default status print
      } else {
        // Bare `khy taste watch` (no flag) is an alias for --on, then prints
        // status. Most users will type this once and want feedback.
        watch.setEnabled(true);
        printSuccess('taste watch 已启用 — 每轮 chat 后会自动沉淀偏好到 taste.md');
      }
      const status = watch.getStatus();
      console.log('');
      console.log(chalk.bold('  taste watch 状态'));
      console.log(chalk.dim('  ' + '─'.repeat(40)));
      console.log(`  ${chalk.cyan('enabled'.padEnd(12))}  ${status.enabled ? chalk.green('true') : chalk.dim('false')}`);
      console.log(`  ${chalk.cyan('observed'.padEnd(12))}  ${status.stats.observedTurns}`);
      console.log(`  ${chalk.cyan('committed'.padEnd(12))}  ${status.stats.committed}`);
      console.log(`  ${chalk.cyan('skippedSeen'.padEnd(12))}  ${status.stats.skippedSeen}`);
      console.log(`  ${chalk.cyan('errors'.padEnd(12))}  ${status.stats.errors}`);
      console.log(`  ${chalk.cyan('stateFile'.padEnd(12))}  ${chalk.dim(status.stateFile)}`);
      console.log(`  ${chalk.cyan('updatedAt'.padEnd(12))}  ${chalk.dim(status.updatedAt)}`);
      console.log('');
      return;
    }
    case 'lint': {
      const report = taste.lint();
      if (report.warnings.length > 0) {
        printWarn(`Warnings (${report.warnings.length}):`);
        for (const w of report.warnings) {
          console.log(`  ${chalk.yellow('!')} ${w}`);
        }
      }
      if (report.errors.length > 0) {
        printError(`Errors (${report.errors.length}):`);
        for (const e of report.errors) {
          console.log(`  ${chalk.red('x')} ${e}`);
        }
        return;
      }
      if (report.warnings.length === 0) {
        printSuccess('taste files are healthy');
      }
      return;
    }
    case 'path': {
      const dir = taste._tasteDir();
      console.log(dir);
      return;
    }
    case 'section': {
      const out = taste.renderTasteSection();
      if (!out) {
        printInfo('No taste section would be injected (no items above the confidence floor).');
        return;
      }
      console.log(out);
      return;
    }
    case 'learn': {
      const learner = require('../../services/crossAgentTasteLearner');
      const app = opts.app || null;
      const apps = app ? [String(app)] : null;
      const dryRun = !!opts['dry-run'] || opts.dryRun === true;
      // --since: support shorthand (30d, 12h, 7d) or absolute (ISO date, ms epoch).
      let sinceMs = null;
      const sinceRaw = opts.since;
      if (sinceRaw) {
        const m = String(sinceRaw).trim().match(/^(\d+)\s*([hdwm])$/i);
        if (m) {
          const n = Number(m[1]);
          const unit = m[2].toLowerCase();
          const now = Date.now();
          const ms =
            unit === 'h'
              ? n * 3600_000
              : unit === 'd'
                ? n * 86_400_000
                : unit === 'w'
                  ? n * 7 * 86_400_000
                  : n * 30 * 86_400_000;
          sinceMs = now - ms;
        } else {
          const parsed = Date.parse(String(sinceRaw));
          if (Number.isFinite(parsed)) {
            sinceMs = parsed;
          } else {
            printError(`无法解析 --since: ${sinceRaw} (示例: 30d / 12h / 2026-01-01)`);
            return;
          }
        }
      }
      const max = Number.isFinite(Number(opts.max)) ? Number(opts.max) : 200;
      const minConf = Number.isFinite(Number(opts.confidence)) ? Number(opts.confidence) : undefined;

      const result = learner.learnFromSessions({
        apps,
        sinceMs,
        maxFiles: max,
        minConfidence: minConf,
        dryRun,
        env: process.env,
      });

      const { scanned, candidates, committed, errors } = result;
      console.log('');
      console.log(chalk.bold('  Taste learn — 跨 agent session 扫描'));
      console.log(chalk.dim('  ' + '─'.repeat(50)));
      const appsHit = Object.entries(scanned.byApp || {})
        .map(([a, n]) => `${a}=${n}`)
        .join(', ') || '(none)';
      console.log(`  ${chalk.cyan('扫描文件')}: ${scanned.files} (${appsHit})`);
      console.log(`  ${chalk.cyan('扫描消息')}: ${scanned.records}`);
      console.log(`  ${chalk.cyan('候选')}:     ${candidates.length} 条`);
      if (candidates.length > 0) {
        for (const c of candidates.slice(0, 20)) {
          console.log(
            `    ${chalk.dim(`[${c.category}]`)} ${c.text}  ${chalk.dim(`(c=${c.confidence.toFixed(2)}, sessions=${c.sessionCount})`)}`
          );
        }
        if (candidates.length > 20) {
          console.log(chalk.dim(`    …还有 ${candidates.length - 20} 条(用 --max / --since 缩小范围)`));
        }
      }
      if (dryRun) {
        console.log(chalk.dim('  --dry-run: 未写入 taste 文件'));
      } else {
        const ok = (committed || []).filter((r) => r && r.ok).length;
        const fail = (committed || []).length - ok;
        console.log(`  ${chalk.cyan('已写入')}:   ${ok} 条(失败 ${fail} 条)`);
        if (fail > 0) {
          for (const r of committed || []) {
            if (r && !r.ok) {
              console.log(`    ${chalk.red('x')} ${r.category || '?'}: ${r.error || 'unknown'}`);
            }
          }
        }
      }
      if ((errors || []).length > 0) {
        console.log(chalk.dim(`  跳过 ${errors.length} 个文件/条目(见下)`));
        for (const e of errors.slice(0, 5)) {
          console.log(`    ${chalk.yellow('!')} ${e.file}: ${e.error}`);
        }
        if (errors.length > 5) {
          console.log(chalk.dim(`    …还有 ${errors.length - 5} 条`));
        }
      }
      console.log('');
      printInfo('查看: khy taste list / khy taste show');
      return;
    }
    case 'open': {
      const dir = taste._tasteDir();
      // Best-effort: try the OS opener, fall back to printing the path.
      try {
        const opener =
          process.platform === 'win32'
            ? `explorer`
            : process.platform === 'darwin'
              ? `open`
              : `xdg-open`;
        spawn(opener, [dir], { detached: true, stdio: 'ignore' }).unref();
        printInfo(`Opening ${dir} …`);
      } catch (e) {
        printWarn(`无法打开文件管理器,目录: ${dir} (${(e && e.message) || 'unknown'})`);
      }
      return;
    }
    case 'help':
    case '':
    case undefined: {
      console.log('');
      console.log(chalk.bold('  khy taste — 用户偏好管理 (cmdc taste 协议)'));
      console.log('');
      console.log('  用法:');
      console.log('    khy taste list                       列出所有分类');
      console.log('    khy taste show [category]            打印条目');
      console.log('    khy taste add <cat> "<text>"         新增一条 [--confidence 0.7]');
      console.log('    khy taste bump "<text>"              调整置信度 [--delta 0.05]');
      console.log('    khy taste drop "<text>"              删除一条');
      console.log('    khy taste learn                      从 Claude Code / cmdc / OpenCode /');
      console.log('                                         Gemini / Codex / YCode / OpenClaw / ZCode');
      console.log('                                         session 提炼偏好');
      console.log('                                         [--app <id>] [--since 30d] [--dry-run]');
      console.log('    khy taste lint                       校验文件结构');
      console.log('    khy taste path                       打印落盘目录');
      console.log('    khy taste section                    打印注入到 system prompt 的片段');
      console.log('    khy taste open                       在文件管理器中打开');
      console.log('    khy taste watch [--on/--off/--status/--reset]');
      console.log('                                         自动沉淀：每轮 chat 出口把');
      console.log('                                         (user, assistant) 喂给启发式，');
      console.log('                                         命中即写 taste.md (off → on)');
      console.log('');
      console.log(`  落盘: ${chalk.dim(taste._tasteDir())}`);
      console.log('');
      return;
    }
    default:
      printError(`未知子命令: ${verb}。运行 \`khy taste help\` 查看用法。`);
  }
}

module.exports = { handleTasteCommand };
