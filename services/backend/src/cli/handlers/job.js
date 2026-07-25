'use strict';

/**
 * handlers/job.js — `/job` template-jobs command (Claude Code `/job` alignment).
 *
 * A "template job" instantiates a reusable markdown template (from a
 * `templates/` directory) into a durable job under <dataHome>/jobs/<id>, and
 * lets the user append replies / inspect status. This mirrors CC's `/job`
 * (list | new | reply | status) which khy previously lacked — khy had `/cron`
 * (scheduled prompts) and `/tasks` (runtime tasks) but no template→job concept.
 *
 * Subcommands:
 *   /job                     → usage
 *   /job list                → list available templates
 *   /job new <tpl> [args...]  → create a job from a template
 *   /job jobs                → list created jobs
 *   /job status <id>         → show one job's state
 *   /job reply <id> <text>   → append a reply to a job
 *
 * Gate KHY_TEMPLATE_JOBS (default on; 0/false/off/no/disable/disabled → prints a
 * disabled notice and does nothing, so the command is a no-op escape valve).
 * fail-soft: every path is wrapped; the handler never throws.
 *
 * @module handlers/job
 */
const chalk = require('chalk').default || require('chalk');
const { printInfo, printWarn, printSuccess, printError } = require('../formatters');
const templatesApi = require('../../jobs/jobTemplates');
const store = require('../../jobs/jobStore');

const OFF_WORDS = ['0', 'false', 'off', 'no', 'disable', 'disabled'];

/** Whether template jobs are enabled (gate KHY_TEMPLATE_JOBS, default on). */
function templateJobsEnabled(env = process.env) {
  const v = env.KHY_TEMPLATE_JOBS;
  if (v === undefined) return true;
  return !OFF_WORDS.includes(String(v).trim().toLowerCase());
}

function _newJobId() {
  try { return require('crypto').randomUUID().slice(0, 8); }
  catch { return require('crypto').randomBytes(4).toString('hex'); }
}

function _printUsage() {
  printInfo('模板任务 /job — 从 markdown 模板实例化可复现的任务');
  console.log('');
  console.log('  /job list                 列出可用模板');
  console.log('  /job new <模板> [参数...]   从模板创建一个任务');
  console.log('  /job jobs                 列出已创建的任务');
  console.log('  /job status <任务ID>       查看某个任务的状态');
  console.log('  /job reply <任务ID> <文本>  给任务追加一条回复');
  console.log('');
  console.log(chalk.gray('  模板 = <项目>/.khy/templates/*.md 或 ~/.khy/templates/*.md'));
  console.log(chalk.gray('  任务 = ~/.khy/jobs/<ID>/（state.json + template.md + input.txt + replies.jsonl）'));
}

function _handleList() {
  const templates = templatesApi.listTemplates();
  if (!templates.length) {
    printInfo('未找到任何模板。');
    console.log(chalk.gray('  把 .md 文件放到 <项目>/.khy/templates/ 或 ~/.khy/templates/ 即可。'));
    return;
  }
  printInfo(`找到 ${templates.length} 个模板：`);
  console.log('');
  for (const t of templates) {
    console.log(`  ${chalk.cyan(t.name)}`);
    console.log(`    ${t.description}`);
    console.log(chalk.gray(`    路径: ${t.filePath}`));
    console.log('');
  }
}

function _handleNew(args) {
  const templateName = args[0];
  if (!templateName) {
    printWarn('用法: /job new <模板> [参数...]');
    return;
  }
  const template = templatesApi.loadTemplate(templateName);
  if (!template) {
    printError(`未找到模板: ${templateName}`);
    const all = templatesApi.listTemplates();
    if (all.length) {
      console.log('可用模板:');
      for (const t of all) console.log(`  ${t.name}`);
    } else {
      console.log(chalk.gray('  （templates/ 目录里还没有任何 .md 模板）'));
    }
    return;
  }

  const jobId = _newJobId();
  const inputText = args.slice(1).join(' ');
  const rawContent = `---\n${Object.entries(template.frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n${template.content}`;

  const dir = store.createJob(jobId, templateName, rawContent, inputText, args.slice(1));
  printSuccess(`已创建任务: ${jobId}`);
  console.log(`  模板: ${templateName}`);
  console.log(chalk.gray(`  目录: ${dir}`));
  if (inputText) console.log(`  输入: ${inputText}`);
}

function _handleJobs() {
  const jobs = store.listJobs();
  if (!jobs.length) {
    printInfo('还没有创建任何任务。用 /job new <模板> 创建一个。');
    return;
  }
  printInfo(`共 ${jobs.length} 个任务：`);
  console.log('');
  for (const j of jobs) {
    console.log(`  ${chalk.cyan(j.jobId)}  ${chalk.gray(j.templateName)}  [${j.status}]`);
    console.log(chalk.gray(`    创建: ${j.createdAt}  更新: ${j.updatedAt}`));
  }
}

function _handleStatus(args) {
  const jobId = args[0];
  if (!jobId) {
    printWarn('用法: /job status <任务ID>');
    return;
  }
  const state = store.readJobState(jobId);
  if (!state) {
    printError(`未找到任务: ${jobId}`);
    return;
  }
  printInfo(`任务: ${state.jobId}`);
  console.log(`  模板: ${state.templateName}`);
  console.log(`  状态: ${state.status}`);
  console.log(`  创建: ${state.createdAt}`);
  console.log(`  更新: ${state.updatedAt}`);
  console.log(`  参数: ${(state.args || []).join(' ') || '(无)'}`);
  console.log(chalk.gray(`  目录: ${store.getJobDir(jobId)}`));
}

function _handleReply(args) {
  const jobId = args[0];
  const text = args.slice(1).join(' ');
  if (!jobId || !text) {
    printWarn('用法: /job reply <任务ID> <文本>');
    return;
  }
  if (!store.readJobState(jobId)) {
    printError(`未找到任务: ${jobId}`);
    return;
  }
  if (store.appendJobReply(jobId, text)) {
    printSuccess(`已给任务 ${jobId} 追加回复`);
    console.log(chalk.gray(`  目录: ${store.getJobDir(jobId)}`));
  } else {
    printError(`追加回复失败: ${jobId}`);
  }
}

/**
 * @param {string} subCommand  first positional token (the subcommand)
 * @param {string[]} args      remaining positional args
 * @param {object} [options]
 */
async function handleJob(subCommand, args = [], _options = {}) {
  if (!templateJobsEnabled()) {
    printWarn('模板任务功能已通过 KHY_TEMPLATE_JOBS 关闭。');
    return true;
  }
  try {
    switch (subCommand) {
      case undefined:
      case null:
      case '':
      case 'help':
        _printUsage();
        break;
      case 'list':
        _handleList();
        break;
      case 'new':
        _handleNew(args);
        break;
      case 'jobs':
      case 'ls':
        _handleJobs();
        break;
      case 'status':
        _handleStatus(args);
        break;
      case 'reply':
        _handleReply(args);
        break;
      default:
        printWarn(`未知的 /job 子命令: ${subCommand}`);
        _printUsage();
    }
  } catch (err) {
    // fail-soft: never let a template-job error break the REPL/TUI.
    printError(`/job 执行出错: ${err && err.message ? err.message : String(err)}`);
  }
  return true;
}

module.exports = { handleJob, templateJobsEnabled };
