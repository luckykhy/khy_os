'use strict';

/**
 * Cron Command Handler — manage cron-scheduled jobs.
 *
 * Commands:
 *   cron list                          — list all cron jobs
 *   cron add "<cron>" "<prompt>" [opts] — add a new cron job
 *   cron remove <id>                   — remove a cron job
 *   cron enable <id>                   — enable a disabled job
 *   cron disable <id>                  — disable a job
 *   cron status                        — scheduler status + next fire times
 *
 * @module handlers/cron
 */
const chalk = require('chalk').default || require('chalk');
const { printSuccess, printError, printInfo, printTable } = require('../formatters');

async function handleCronCommand(subCommand, args, options) {
  switch (subCommand) {
    case 'list':
    case undefined:
    case '':
      return handleCronList();
    case 'add':
      return handleCronAdd(args, options);
    case 'remove':
    case 'rm':
    case 'delete':
      return handleCronRemove(args[0]);
    case 'enable':
      return handleCronEnable(args[0]);
    case 'disable':
      return handleCronDisable(args[0]);
    case 'status':
      return handleCronStatus();
    case 'help':
    default:
      return _printHelp();
  }
}

// ── Subcommand handlers ──────────────────────────────────────────

function handleCronList() {
  const cron = require('../../services/cronScheduler');
  const jobs = cron.listJobs();

  if (jobs.length === 0) {
    printInfo('No cron jobs configured. Use "cron add" to create one.');
    return;
  }

  console.log('');
  console.log(chalk.bold(`  Cron Jobs (${jobs.length})`));
  console.log('');

  const rows = jobs.map((j) => ({
    ID: j.id,
    Cron: j.cron,
    Prompt: j.prompt.length > 40 ? j.prompt.slice(0, 37) + '...' : j.prompt,
    Channel: j.channel || '-',
    Enabled: j.enabled ? chalk.green('yes') : chalk.dim('no'),
    'Last Run': j.lastRunAt ? new Date(j.lastRunAt).toLocaleString() : '-',
  }));

  printTable(rows);
}

function handleCronAdd(args, options) {
  const cron = require('../../services/cronScheduler');

  // Parse: cron add "*/5 * * * *" "run daily report" --channel slack:general --no-agent
  // args[0] = cron expression, args[1..] = prompt parts
  if (args.length < 2) {
    printError('Usage: cron add "<cron-expression>" "<prompt>" [--channel <ch>] [--no-agent]');
    return;
  }

  const cronExpr = args[0];
  const prompt = args.slice(1).join(' ');

  try {
    const { id, job } = cron.addJob({
      cron: cronExpr,
      prompt,
      channel: options.channel || null,
      noAgent: options.noAgent || options['no-agent'] || false,
      contextFrom: options.contextFrom || options['context-from'] || null,
      maxRuntimeMs: options.timeout ? parseInt(options.timeout, 10) * 1000 : undefined,
    });

    printSuccess(`Cron job created: ${id}`);
    console.log(chalk.dim(`  Schedule : ${job.cron}`));
    console.log(chalk.dim(`  Prompt   : ${job.prompt}`));
    if (job.channel) console.log(chalk.dim(`  Channel  : ${job.channel}`));
    if (job.noAgent) console.log(chalk.dim(`  Mode     : shell-only (noAgent)`));
    console.log('');
  } catch (err) {
    printError(`Failed to add cron job: ${err.message}`);
  }
}

function handleCronRemove(id) {
  if (!id) {
    printError('Usage: cron remove <job-id>');
    return;
  }

  const cron = require('../../services/cronScheduler');
  const ok = cron.removeJob(id);
  if (ok) {
    printSuccess(`Removed cron job: ${id}`);
  } else {
    printError(`Job not found: ${id}`);
  }
}

function handleCronEnable(id) {
  if (!id) {
    printError('Usage: cron enable <job-id>');
    return;
  }

  const cron = require('../../services/cronScheduler');
  const ok = cron.enableJob(id);
  if (ok) {
    printSuccess(`Enabled cron job: ${id}`);
  } else {
    printError(`Job not found: ${id}`);
  }
}

function handleCronDisable(id) {
  if (!id) {
    printError('Usage: cron disable <job-id>');
    return;
  }

  const cron = require('../../services/cronScheduler');
  const ok = cron.disableJob(id);
  if (ok) {
    printSuccess(`Disabled cron job: ${id}`);
  } else {
    printError(`Job not found: ${id}`);
  }
}

function handleCronStatus() {
  const cron = require('../../services/cronScheduler');
  const jobs = cron.listJobs();
  const enabled = jobs.filter((j) => j.enabled);
  const disabled = jobs.filter((j) => !j.enabled);

  console.log('');
  console.log(chalk.bold('  Cron Scheduler Status'));
  console.log('');
  console.log(`  Total jobs   : ${jobs.length}`);
  console.log(`  Enabled      : ${chalk.green(enabled.length)}`);
  console.log(`  Disabled     : ${chalk.dim(disabled.length)}`);
  console.log(`  Tick interval: 60s`);
  console.log(`  Hard timeout : ${cron.DEFAULT_MAX_RUNTIME_MS / 1000}s per job`);
  console.log('');

  if (enabled.length > 0) {
    console.log(chalk.bold('  Active Jobs:'));
    for (const j of enabled) {
      const lastRun = j.lastRunAt ? new Date(j.lastRunAt).toLocaleString() : 'never';
      console.log(`    ${chalk.cyan(j.id)}  ${chalk.dim(j.cron)}  ${j.prompt.slice(0, 40)}  (last: ${lastRun})`);
    }
    console.log('');
  }
}

function _printHelp() {
  console.log('');
  console.log(chalk.bold('  Cron Scheduler — Persistent cron job scheduling'));
  console.log('');
  console.log('  Usage:');
  console.log(chalk.dim('    cron list                                 List all cron jobs'));
  console.log(chalk.dim('    cron add "<cron>" "<prompt>"              Add a new job'));
  console.log(chalk.dim('    cron remove <id>                          Remove a job'));
  console.log(chalk.dim('    cron enable <id>                          Enable a disabled job'));
  console.log(chalk.dim('    cron disable <id>                         Disable a job'));
  console.log(chalk.dim('    cron status                               Scheduler status'));
  console.log('');
  console.log('  Options:');
  console.log(chalk.dim('    --channel <channel>     Deliver results to channel (e.g. slack:general)'));
  console.log(chalk.dim('    --no-agent              Shell-only mode (run prompt as shell command)'));
  console.log(chalk.dim('    --context-from <id>     Chain: inject previous job result into prompt'));
  console.log(chalk.dim('    --timeout <sec>         Per-job timeout in seconds (default: 180)'));
  console.log('');
  console.log('  Examples:');
  console.log(chalk.dim('    cron add "0 9 * * 1-5" "generate daily market report"'));
  console.log(chalk.dim('    cron add "*/30 * * * *" "df -h" --no-agent'));
  console.log(chalk.dim('    cron add "0 8 * * *" "morning briefing" --channel slack:general'));
  console.log('');
}

module.exports = { handleCronCommand };
