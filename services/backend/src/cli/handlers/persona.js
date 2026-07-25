'use strict';

/**
 * Persona Command Handler (C1) — inspect and scaffold the executable Persona.
 *
 * Commands:
 *   persona            — show the resolved persona summary (headings + lines)
 *   persona show       — print the full merged persona text
 *   persona init       — write the default persona.md template (won't overwrite
 *                        unless --force); --dest <file> targets a specific path
 *   persona paths      — list which persona.md files were discovered
 */
const chalk = require('chalk').default || require('chalk');
const { printSuccess, printError, printInfo } = require('../formatters');

async function handlePersonaCommand(subCommand, args, options) {
  const svc = require('../../services/personaService');
  const cwd = process.cwd();

  switch (subCommand) {
    case 'show': {
      const text = svc.loadPersona(cwd);
      if (!text) { printInfo('No persona.md found. Run `khy persona init` to create one.'); return; }
      console.log('');
      console.log(text);
      console.log('');
      return;
    }
    case 'init': {
      const dest = options.dest || options.d || null;
      const force = !!(options.force || options.f);
      const res = svc.scaffold({ dest, force });
      if (res.written) {
        printSuccess(`Persona template written to ${res.dest}`);
        printInfo('Edit it to shape answer strategy, tone, confirmation, red lines, and uncertainty handling.');
      } else {
        printError(`Refusing to overwrite existing ${res.dest}. Use --force to replace it.`);
      }
      return;
    }
    case 'paths': {
      const paths = svc._personaPaths(cwd);
      if (paths.length === 0) { printInfo('No persona.md files discovered.'); return; }
      console.log('');
      console.log(chalk.bold('  Discovered persona files (precedence order):'));
      for (const p of paths) console.log(`  • ${p}`);
      console.log('');
      return;
    }
    default: {
      const summary = svc.summarizePersona(cwd);
      if (!summary.present) {
        printInfo('No persona.md active. Run `khy persona init` to create the default template.');
        return;
      }
      console.log('');
      console.log(chalk.bold('  Active Persona'));
      console.log('');
      for (const sec of summary.sections) {
        console.log(`  ${chalk.cyan(sec.title)}`);
        for (const line of sec.lines) console.log(`    ${chalk.dim(line)}`);
      }
      console.log('');
      printInfo('Full text: khy persona show   |   Edit: khy persona init');
      return;
    }
  }
}

module.exports = { handlePersonaCommand };
