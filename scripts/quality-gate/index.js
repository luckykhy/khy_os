#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const { REPO_ROOT, parseMode, selectStages, resolveStageCommand } = require('./lib/qualityGateStages');

function writeRecord(action, stage, index, total, mode, extra = '') {
  const suffix = extra ? ` ${extra}` : '';
  process.stdout.write(
    `[quality-gate] action=${action} target=${stage.target} progress=${index + 1}/${total} mode=${mode}${suffix}\n`
  );
}

function run(argv = process.argv, spawn = spawnSync) {
  let mode;
  try {
    mode = parseMode(argv);
  } catch (error) {
    process.stderr.write(`[quality-gate] action=error target=arguments progress=0/0 ${error.message}\n`);
    return 2;
  }

  const stages = selectStages(mode);
  let failed = false;
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    if (failed) {
      writeRecord('skip', stage, index, stages.length, mode, 'reason=previous-failure');
      continue;
    }

    writeRecord('start', stage, index, stages.length, mode);
    const started = process.hrtime.bigint();
    const invocation = resolveStageCommand(stage);
    const result = spawn(invocation.command, invocation.args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    const durationMs = Number((process.hrtime.bigint() - started) / 1000000n);
    const code = result.error ? 1 : result.status ?? 1;
    if (code === 0) {
      writeRecord('pass', stage, index, stages.length, mode, `durationMs=${durationMs}`);
    } else {
      failed = true;
      const reason = result.error ? ` error=${JSON.stringify(result.error.message)}` : '';
      writeRecord('fail', stage, index, stages.length, mode, `code=${code} durationMs=${durationMs}${reason}`);
    }
  }
  return failed ? 1 : 0;
}

if (require.main === module) process.exitCode = run();

module.exports = { run, writeRecord };
