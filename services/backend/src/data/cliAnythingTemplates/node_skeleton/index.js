#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const pkg = require('../package.json');

const program = new Command();

program
  .name('cli-anything-{{SOFTWARE}}')
  .description('AI agent control for {{SOFTWARE}}')
  .version(pkg.version);

const project = program.command('project').description('Project management');

project
  .command('create')
  .requiredOption('--name <name>', 'Project name')
  .option('--json', 'JSON output')
  .action((opts) => {
    const result = { status: 'success', command: 'project.create', data: { name: opts.name } };
    if (opts.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`Created project: ${opts.name}`);
    }
  });

const session = program.command('session').description('Session management (undo/redo)');

session
  .command('undo')
  .option('--json', 'JSON output')
  .action((opts) => {
    const { SessionManager } = require('./core/session');
    const mgr = SessionManager.getCurrent();
    const result = mgr.undo();
    if (opts.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`Undo: ${result.message || 'done'}`);
    }
  });

session
  .command('redo')
  .option('--json', 'JSON output')
  .action((opts) => {
    const { SessionManager } = require('./core/session');
    const mgr = SessionManager.getCurrent();
    const result = mgr.redo();
    if (opts.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`Redo: ${result.message || 'done'}`);
    }
  });

program.parse();
