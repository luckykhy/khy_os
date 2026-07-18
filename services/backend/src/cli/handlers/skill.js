/**
 * Skill Command Handler — manage and execute skills.
 *
 * Commands:
 *   skill list              — list all available skills (builtin + installed + remote)
 *   skill install <id>      — install a skill from the registry
 *   skill add <repo> [--skill <name>] — fetch & install a skill from an external repo (GitHub etc.)
 *   skill uninstall <id>    — remove an installed skill
 *   skill search <keyword>  — search remote skills
 *   skill run <id> [args]   — manually run a skill
 *   skill learn npm <pkg> [fn] — learn a skill from an npm package
 *   skill learn github <url>   — learn patterns from a GitHub repo
 *   skill learn workflow "<seq>" — create workflow skill from command sequence
 *   skill learned            — list all learned skills
 *   skill forget <id>        — remove a learned skill
 *   skill suggest            — show learning suggestions
 *   skill stats              — show learning statistics
 */
const chalk = require('chalk').default || require('chalk');
const { printSuccess, printError, printInfo, printTable, withSpinner } = require('../formatters');

async function handleSkillCommand(subCommand, args, options) {
  switch (subCommand) {
    case 'list':
      await handleSkillList(options);
      break;
    case 'install':
      await handleSkillInstall(args[0]);
      break;
    case 'add':
      await handleSkillAdd(args[0], options);
      break;
    case 'uninstall':
      await handleSkillUninstall(args[0]);
      break;
    case 'search':
      await handleSkillSearch(args.join(' '));
      break;
    case 'run':
      await handleSkillRun(args[0], args.slice(1), options);
      break;
    case 'learn':
      await handleSkillLearn(args, options);
      break;
    case 'learned':
      await handleSkillLearned();
      break;
    case 'journey':
      await handleSkillJourney();
      break;
    case 'forget':
      await handleSkillForget(args[0]);
      break;
    case 'suggest':
      await handleSkillSuggest();
      break;
    case 'stats':
      await handleSkillStats();
      break;
    case 'curator':
      await handleSkillCurator(args, options);
      break;
    case 'pin':
      await handleSkillPin(args[0]);
      break;
    case 'unpin':
      await handleSkillUnpin(args[0]);
      break;
    case 'archive':
      await handleSkillArchive(args[0]);
      break;
    case 'restore':
      await handleSkillRestore(args[0]);
      break;
    case 'enable':
      await handleSkillEnable(args[0], true);
      break;
    case 'disable':
      await handleSkillEnable(args[0], false);
      break;
    case 'import':
      await handleSkillImport(args[0], options);
      break;
    case 'export':
      await handleSkillExport(args[0], options);
      break;
    default:
      await handleSkillList(options);
      break;
  }
}

async function handleSkillList(options) {
  const skillRegistry = require('../../services/skillRegistry');
  const refresh = options.refresh || options.r;
  const skills = await skillRegistry.listSkills({ refresh });

  if (skills.length === 0) {
    printInfo('没有可用的 skill');
    return;
  }

  console.log('');
  console.log(chalk.bold('  📦 可用 Skills'));
  console.log('');

  const sourceLabel = { builtin: chalk.green('内置'), installed: chalk.cyan('已安装'), remote: chalk.yellow('远程') };

  const skillState = require('../../services/skillStateService');
  const headers = ['触发器', '名称', '描述', '来源', '状态'];
  const rows = skills.map(s => [
    chalk.white(s.trigger || '-'),
    s.name || s.id,
    chalk.dim(s.description || ''),
    sourceLabel[s.source] || s.source,
    skillState.isEnabled(s.name || s.id) ? chalk.green('启用') : chalk.red('禁用'),
  ]);

  printTable(headers, rows);

  console.log('');
  printInfo('使用方法: 直接输入触发器 (如 /analyze 茅台)');
  printInfo('安装远程 skill: skill install <id>');
}

async function handleSkillInstall(skillId) {
  if (!skillId) {
    printError('请指定要安装的 skill ID');
    printInfo('用法: skill install <id>');
    return;
  }

  const skillRegistry = require('../../services/skillRegistry');

  await withSpinner(`正在安装 skill: ${skillId}`, async () => {
    await skillRegistry.installSkill(skillId);
  });

  printSuccess(`Skill "${skillId}" 安装成功`);
  printInfo('使用触发器或 skill run 命令执行');
}

async function handleSkillUninstall(skillId) {
  if (!skillId) {
    printError('请指定要卸载的 skill ID');
    return;
  }

  const skillRegistry = require('../../services/skillRegistry');
  skillRegistry.uninstallSkill(skillId);
  printSuccess(`Skill "${skillId}" 已卸载`);
}

async function handleSkillSearch(keyword) {
  if (!keyword) {
    printError('请输入搜索关键词');
    return;
  }

  const skillRegistry = require('../../services/skillRegistry');
  const all = await skillRegistry.listSkills({ refresh: true });
  const results = all.filter(s =>
    (s.name && s.name.includes(keyword)) ||
    (s.description && s.description.includes(keyword)) ||
    (s.id && s.id.includes(keyword)) ||
    (s.tags && s.tags.some(t => t.includes(keyword)))
  );

  if (results.length === 0) {
    printInfo(`没有找到匹配 "${keyword}" 的 skill`);
    return;
  }

  console.log('');
  console.log(chalk.bold(`  🔍 搜索结果: "${keyword}"`));
  const headers = ['ID', '名称', '描述'];
  const rows = results.map(s => [s.id, s.name || '-', chalk.dim(s.description || '')]);
  printTable(headers, rows);
}

async function handleSkillRun(skillId, args, options) {
  if (!skillId) {
    printError('请指定 skill ID');
    printInfo('用法: skill run <id> [参数...]');
    return;
  }

  const skillRegistry = require('../../services/skillRegistry');
  try {
    const result = await skillRegistry.executeSkill(skillId, args, { options });
    if (result && result.type === 'ai-prompt') {
      printInfo('Skill 生成了 AI 提示，正在转发...');
      // Return the prompt for AI processing
      return { aiForward: result.prompt };
    }
  } catch (err) {
    printError(`Skill 执行失败: ${err.message}`);
  }
}

// ─── Skill Learning Commands ─────────────────────────────────────────────────

async function handleSkillLearn(args, options) {
  const learner = require('../../services/skillLearningService');

  if (args.length === 0) {
    printError('请指定学习来源');
    console.log('');
    printInfo('用法:');
    console.log(chalk.dim('  skill learn npm <包名> [函数名]  — 从 npm 包学习'));
    console.log(chalk.dim('  skill learn github <仓库URL>     — 从 GitHub 仓库学习'));
    console.log(chalk.dim('  skill learn dir <目录路径>       — 从本地目录提炼技能'));
    console.log(chalk.dim('  skill learn url <网址>           — 从网页提炼技能'));
    console.log(chalk.dim('  skill learn workflow "<命令序列>" — 从命令序列创建工作流'));
    return;
  }

  const source = args[0].toLowerCase();

  switch (source) {
    case 'npm': {
      const packageName = args[1];
      if (!packageName) {
        printError('请指定 npm 包名');
        return;
      }
      const functionName = args[2];

      if (functionName) {
        // Learn a specific function
        const skillName = args[3] || functionName;
        const result = learner.learnFromPackage(packageName, functionName, skillName);
        printSuccess(`已学习: ${result.name} (from ${packageName}.${functionName})`);
        printInfo(`Skill ID: ${result.id}`);
        printInfo(`文件: ${result.filePath}`);
      } else {
        // Discover what's available
        const discoveries = await learner.discoverFromNpm(packageName);
        if (discoveries.length === 0) {
          printInfo(`${packageName} 中未发现可学习的函数`);
          return;
        }

        console.log('');
        console.log(chalk.bold(`  📦 ${packageName} 可学习内容:`));
        console.log('');
        for (const d of discoveries) {
          if (d.adaptable) {
            console.log(`  ${chalk.green('●')} ${d.name} — ${chalk.dim(d.type)}`);
          } else {
            console.log(`  ${chalk.yellow('○')} ${d.name} — ${chalk.dim('需先安装: ' + d.installCmd)}`);
          }
        }
        console.log('');
        printInfo('学习指定函数: skill learn npm <包名> <函数名>');
      }
      break;
    }

    case 'github': {
      const repoUrl = args[1];
      if (!repoUrl) {
        printError('请指定 GitHub 仓库地址');
        return;
      }
      const result = await learner.learnFromGitHub(repoUrl, options);
      printSuccess(`已加入学习队列: ${result.repo}`);
      printInfo(result.message);
      break;
    }

    case 'dir':
    case 'directory': {
      const dirPath = args[1];
      if (!dirPath) {
        printError('请指定目录路径');
        printInfo('用法: skill learn dir <目录路径>');
        return;
      }
      const result = learner.learnFromDirectory(dirPath, options);
      if (!result.ok) {
        printError(result.error || result.message || '学习失败');
        return;
      }
      printSuccess(`已从目录学习: ${result.name}`);
      printInfo(`描述: ${result.description}`);
      printInfo(`Skill ID: ${result.id}  提炼命令 ${result.commandCount} 条 / 章节 ${result.headingCount} 个`);
      if (result.filePath) printInfo(`文件: ${result.filePath}`);
      break;
    }

    case 'url':
    case 'web': {
      const url = args[1];
      if (!url) {
        printError('请指定网址');
        printInfo('用法: skill learn url <网址>');
        return;
      }
      const result = await learner.learnFromUrl(url, options);
      if (!result.ok) {
        printError(result.error || result.message || '学习失败');
        return;
      }
      printSuccess(`已从网页学习: ${result.name}`);
      printInfo(`描述: ${result.description}`);
      printInfo(`Skill ID: ${result.id}  提炼命令 ${result.commandCount} 条 / 章节 ${result.headingCount} 个`);
      if (result.filePath) printInfo(`文件: ${result.filePath}`);
      break;
    }

    case 'workflow': {
      const sequenceStr = args.slice(1).join(' ').replace(/^["']|["']$/g, '');
      if (!sequenceStr) {
        printError('请指定命令序列');
        printInfo('用法: skill learn workflow "quote sh600519 → backtest sh600519"');
        return;
      }
      const commands = sequenceStr.split(/\s*[→→>]\s*/);
      if (commands.length < 2) {
        printError('工作流至少需要 2 个步骤');
        return;
      }
      const name = options.name || `自动流程-${commands[0]}`;
      const result = learner.learnWorkflow(name, commands, options.desc);
      printSuccess(`已学习工作流: ${result.name}`);
      printInfo(`Skill ID: ${result.id}`);
      printInfo(`步骤: ${commands.join(' → ')}`);
      break;
    }

    default:
      printError(`未知学习来源: ${source}`);
      printInfo('支持: npm, github, dir, url, workflow');
      break;
  }
}

async function handleSkillLearned() {
  const learner = require('../../services/skillLearningService');
  const skills = learner.getLearnedSkills();

  if (skills.length === 0) {
    printInfo('还没有学习过任何 skill');
    printInfo('使用 skill learn 开始学习，或使用 skill suggest 查看建议');
    return;
  }

  console.log('');
  console.log(chalk.bold(`  🧠 已学习的 Skills (${skills.length})`));
  console.log('');

  const categoryIcons = {
    indicator: '📈',
    strategy: '🎯',
    workflow: '⚡',
    reference: '📚',
  };

  for (const skill of skills) {
    const icon = categoryIcons[skill.category] || '📦';
    const source = chalk.dim(`[${skill.source}]`);
    const date = skill.learnedAt ? chalk.dim(skill.learnedAt.slice(0, 10)) : '';
    console.log(`  ${icon} ${chalk.white(skill.name)} ${source} ${date}`);
    console.log(`     ${chalk.dim(skill.description || '')}`);
    console.log(`     ID: ${chalk.cyan(skill.id)}`);
  }

  console.log('');
  printInfo('删除: skill forget <id>');
}

async function handleSkillJourney() {
  const learner = require('../../services/skillLearningService');
  const result = learner.getSkillJourney();

  if (result && result.disabled) {
    printInfo(result.message || 'skill journey 已禁用');
    return;
  }
  if (!result || !result.ok) {
    printError('无法构建学习轨迹');
    return;
  }
  if (!result.entries || result.entries.length === 0) {
    printInfo('还没有任何学习轨迹');
    printInfo('使用 skill learn 学习技能,或积累记忆后再查看');
    return;
  }

  console.log('');
  console.log(chalk.bold('  🧩 学习轨迹 (Journey)'));
  console.log('');

  const kindStyle = {
    skill: { icon: '📚', color: chalk.cyan, label: '技能' },
    memory: { icon: '🧠', color: chalk.magenta, label: '记忆' },
  };

  for (const e of result.entries) {
    const style = kindStyle[e.kind] || { icon: '📦', color: chalk.white, label: e.kind };
    const day = e.date ? chalk.dim(e.date.slice(0, 10)) : chalk.dim('——————');
    console.log(`  ${day}  ${style.icon} ${style.color(`[${style.label}]`)} ${chalk.white(e.title)}`);
    if (e.description) console.log(`              ${chalk.dim(e.description)}`);
  }

  const s = result.summary || {};
  console.log('');
  printInfo(`共 ${s.total || 0} 项 · 技能 ${s.skillCount || 0} · 记忆 ${s.memoryCount || 0}`);
}

async function handleSkillForget(skillId) {
  if (!skillId) {
    printError('请指定要遗忘的 skill ID');
    printInfo('用法: skill forget <id>');
    printInfo('查看已学习: skill learned');
    return;
  }

  const learner = require('../../services/skillLearningService');
  const removed = learner.forgetSkill(skillId);
  if (removed) {
    printSuccess(`已遗忘 skill: ${skillId}`);
  } else {
    printError(`未找到 skill: ${skillId}`);
  }
}

async function handleSkillSuggest() {
  const learner = require('../../services/skillLearningService');
  const suggestions = learner.getSuggestedLearning();

  if (suggestions.length === 0) {
    printInfo('暂无学习建议');
    printInfo('继续使用系统，系统会根据你的使用习惯推荐技能');
    return;
  }

  console.log('');
  console.log(chalk.bold('  💡 学习建议'));
  console.log('');

  for (const s of suggestions) {
    const icon = s.type === 'workflow' ? '⚡' : s.type === 'package' ? '📦' : '🎯';
    console.log(`  ${icon} ${chalk.white(s.name)}`);
    console.log(`     ${chalk.dim(s.reason)}`);
    console.log(`     ${chalk.cyan('→')} ${chalk.dim(s.action)}`);
    console.log('');
  }
}

async function handleSkillStats() {
  const learner = require('../../services/skillLearningService');
  const stats = learner.getLearningStats();

  console.log('');
  console.log(chalk.bold('  📊 技能学习统计'));
  console.log('');
  console.log(`  已学习技能:    ${chalk.bold(stats.totalSkills)}`);
  console.log(`  交互模式记录:  ${chalk.bold(stats.patternCount)}`);
  console.log(`  待学习工作流:  ${chalk.bold(stats.suggestedWorkflows)}`);
  console.log(`  发现源数量:    ${chalk.bold(stats.discoverySources)}`);

  if (Object.keys(stats.byCategory).length > 0) {
    console.log('');
    console.log(chalk.dim('  按类别:'));
    for (const [cat, count] of Object.entries(stats.byCategory)) {
      console.log(`    ${cat}: ${count}`);
    }
  }

  if (Object.keys(stats.bySource).length > 0) {
    console.log('');
    console.log(chalk.dim('  按来源:'));
    for (const [src, count] of Object.entries(stats.bySource)) {
      console.log(`    ${src}: ${count}`);
    }
  }

  console.log('');
}

// ─── Curator / Lifecycle Commands ────────────────────────────────────────────

async function handleSkillCurator(args, options) {
  const curator = require('../../services/skillCuratorService');
  const skillModule = require('../../skills');
  const sub = (args[0] || 'status').toLowerCase();

  if (sub === 'status') {
    const allSkills = await skillModule.discoverAllSkills();
    const status = curator.getCuratorStatus(allSkills);
    console.log('');
    console.log(chalk.bold('  🌱 Skill Curator Status'));
    console.log('');
    console.log(`  Active:   ${chalk.green(status.active)}`);
    console.log(`  Stale:    ${chalk.yellow(status.stale)}`);
    console.log(`  Archived: ${chalk.dim(status.archived)}`);
    if (status.pinned.length > 0) {
      console.log(`  Pinned:   ${status.pinned.join(', ')}`);
    }
    if (status.staleList.length > 0) {
      console.log('');
      console.log(chalk.yellow('  Stale skills:'));
      for (const name of status.staleList) {
        const usage = curator.getSkillUsage(name);
        console.log(`    ${name} — ${chalk.dim(`used ${usage?.use_count || 0}x, last: ${usage?.last_activity_at?.slice(0, 10) || 'unknown'}`)}`);
      }
    }
    console.log('');
  } else if (sub === 'run') {
    const allSkills = await skillModule.discoverAllSkills();
    const result = curator.runCurator(allSkills);
    printInfo(result.summary);
  } else {
    printError(`Unknown curator sub-command: ${sub}`);
    printInfo('Usage: skill curator [status|run]');
  }
}

async function handleSkillPin(name) {
  if (!name) { printError('Usage: skill pin <name>'); return; }
  const curator = require('../../services/skillCuratorService');
  if (curator.pinSkill(name)) {
    printSuccess(`Skill "${name}" pinned (exempt from auto-archive).`);
  } else {
    printError(`Skill "${name}" not found in usage records. Use it at least once first.`);
  }
}

async function handleSkillUnpin(name) {
  if (!name) { printError('Usage: skill unpin <name>'); return; }
  const curator = require('../../services/skillCuratorService');
  if (curator.unpinSkill(name)) {
    printSuccess(`Skill "${name}" unpinned.`);
  } else {
    printError(`Skill "${name}" not found in usage records.`);
  }
}

async function handleSkillArchive(name) {
  if (!name) { printError('Usage: skill archive <name>'); return; }
  const skillModule = require('../../skills');
  const skill = skillModule.findSkill(name);
  if (!skill) { printError(`Skill "${name}" not found.`); return; }
  const curator = require('../../services/skillCuratorService');
  if (curator.archiveSkill(skill)) {
    printSuccess(`Skill "${name}" archived to .archive/.`);
  } else {
    printError(`Cannot archive "${name}" (built-in or not in user dir).`);
  }
}

async function handleSkillRestore(name) {
  if (!name) { printError('Usage: skill restore <name>'); return; }
  const curator = require('../../services/skillCuratorService');
  if (curator.restoreSkill(name)) {
    printSuccess(`Skill "${name}" restored from archive.`);
  } else {
    printError(`Skill "${name}" not found in archive.`);
  }
}

// ─── Enable / Disable (A2) ───────────────────────────────────────────────────

async function handleSkillEnable(name, enabled) {
  if (!name) {
    printError(`Usage: skill ${enabled ? 'enable' : 'disable'} <name>`);
    return;
  }
  const skillModule = require('../../skills');
  const skill = skillModule.findSkill(name);
  if (!skill) { printError(`Skill "${name}" not found.`); return; }

  const state = require('../../services/skillStateService');
  state.setEnabled(skill.name, enabled);
  if (enabled) {
    printSuccess(`Skill "${skill.name}" enabled.`);
  } else {
    printSuccess(`Skill "${skill.name}" disabled (hidden from the model and refuses execution).`);
  }
}

// ─── Add from external ecosystem (GitHub etc.) ────────────────────────────────

async function handleSkillAdd(source, options) {
  if (!source) {
    printError('用法:skill add <owner/repo | https://github.com/… | git@…> [--skill <名称>]');
    printInfo('从外部仓库(对齐 npx skills add)拉取一个 skill 并安装到 khy 的 skills 目录。');
    return;
  }
  const installer = require('../../services/skillInstallService');
  const skill = options && (options.skill || options.s);
  try {
    const result = await withSpinner(`Fetching skill from: ${source}`, async () =>
      installer.addFromSource(source, { skill: skill ? String(skill) : undefined }));
    printSuccess(`Skill "${result.name}" installed to ${result.dest}`);
    if (result.subdir) printInfo(`Source: ${result.source}${result.ref ? `@${result.ref}` : ''} (${result.subdir})`);
    else printInfo(`Source: ${result.source}${result.ref ? `@${result.ref}` : ''}`);
    printInfo('It is enabled by default and discoverable now. Use `skill list` to verify, `skill disable <name>` to turn it off.');
  } catch (err) {
    printError(`Add failed: ${err.message}`);
  }
}

// ─── Import / Export (A3) ─────────────────────────────────────────────────────

async function handleSkillImport(srcPath, options) {
  if (!srcPath) {
    printError('Usage: skill import <path>  (a .md file, a skill folder, or a .zip)');
    return;
  }
  const pkg = require('../../services/skillPackageService');
  try {
    const result = await withSpinner(`Importing skill from: ${srcPath}`, async () =>
      pkg.importSkill(srcPath, options || {}));
    printSuccess(`Skill "${result.name}" imported to ${result.dest}`);
    printInfo('It is enabled by default. Use `skill disable <name>` to turn it off.');
  } catch (err) {
    printError(`Import failed: ${err.message}`);
  }
}

async function handleSkillExport(name, options) {
  if (!name) {
    printError('Usage: skill export <name> [--dest <dir>] [--format folder|md]');
    return;
  }
  const pkg = require('../../services/skillPackageService');
  const format = options.format || 'folder';
  const dest = options.dest || options.d || process.cwd();
  try {
    const result = await pkg.exportSkill(name, dest, { format });
    printSuccess(`Skill "${name}" exported (${format}) to ${result.dest}`);
  } catch (err) {
    printError(`Export failed: ${err.message}`);
  }
}

module.exports = { handleSkillCommand };