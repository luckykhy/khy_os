'use strict';

/**
 * CLI Handler — Extension marketplace commands.
 *
 * Subcommands:
 *   ext list             — List installed extensions
 *   ext search <query>   — Search the registry
 *   ext install <name>   — Install from registry or URL
 *   ext uninstall <name> — Remove an extension
 *   ext enable <name>    — Enable a disabled extension
 *   ext disable <name>   — Disable without removing
 *   ext update [name]    — Update one or all extensions
 *   ext link <path>      — Link local dir for development
 *   ext new <name>       — Scaffold a new extension project
 *
 * @module handlers/extension
 */

const marketplace = require('../../services/extensionMarketplace');
const { printSuccess, printError, printInfo, printWarn, printTable } = require('../formatters');

async function handleExtension(input, deps) {
  const parts = (input || '').trim().split(/\s+/);
  const subcommand = parts[0] || 'list';
  const args = parts.slice(1);

  switch (subcommand) {
    case 'list':
    case 'ls':
      return _handleList();

    case 'search':
    case 'find':
      return _handleSearch(args.join(' '));

    case 'install':
    case 'add':
      return _handleInstall(args[0], args.slice(1));

    case 'uninstall':
    case 'remove':
    case 'rm':
      return _handleUninstall(args[0]);

    case 'enable':
      return _handleEnable(args[0]);

    case 'disable':
      return _handleDisable(args[0]);

    case 'update':
    case 'upgrade':
      return _handleUpdate(args[0]);

    case 'link':
      return _handleLink(args[0]);

    case 'unlink':
      return _handleUnlink(args[0]);

    case 'new':
    case 'create':
    case 'init':
      return _handleNew(args[0], args.slice(1));

    case 'info':
      return _handleInfo(args[0]);

    case 'help':
    default:
      return _printHelp();
  }
}

// ── Subcommand Handlers ──

function _handleList() {
  const extensions = marketplace.list();

  if (extensions.length === 0) {
    printInfo('No extensions installed. Use "ext search <query>" to find extensions.');
    return;
  }

  const headers = ['Name', 'Version', 'Status', 'Capabilities'];
  const rows = extensions.map((ext) => [
    ext.name,
    ext.version,
    ext.enabled ? 'enabled' : 'disabled',
    (ext.capabilities || []).join(', ') || '-',
  ]);

  printTable(headers, rows);
  printInfo(`${extensions.length} extension(s) installed`);
}

async function _handleSearch(query) {
  if (!query) {
    printWarn('Usage: ext search <query>');
    return;
  }

  printInfo(`Searching registry for "${query}"...`);
  const results = await marketplace.search(query);

  if (results.length === 0) {
    printInfo('No extensions found.');
    return;
  }

  const headers = ['Name', 'Version', 'Description', 'Author'];
  const rows = results.map((r) => [
    r.name,
    r.version || '-',
    (r.description || '').substring(0, 40),
    r.author || '-',
  ]);

  printTable(headers, rows);
  printInfo(`${results.length} result(s). Install with: ext install <name>`);
}

async function _handleInstall(source, extraArgs) {
  if (!source) {
    printWarn('Usage: ext install <name|url|path>');
    return;
  }

  try {
    printInfo(`Installing "${source}"...`);

    let result;
    if (source.startsWith('http') || source.startsWith('/') || source.startsWith('.')) {
      result = marketplace.install(source);
    } else {
      // Try registry first
      result = await marketplace.installFromRegistry(source);
    }

    printSuccess(`Extension "${result.name}" installed successfully`);
    if (result.version) printInfo(`Version: ${result.version}`);
  } catch (err) {
    printError(`Install failed: ${err.message}`);
  }
}

function _handleUninstall(name) {
  if (!name) {
    printWarn('Usage: ext uninstall <name>');
    return;
  }

  try {
    marketplace.uninstall(name);
    printSuccess(`Extension "${name}" uninstalled`);
  } catch (err) {
    printError(`Uninstall failed: ${err.message}`);
  }
}

function _handleEnable(name) {
  if (!name) {
    printWarn('Usage: ext enable <name>');
    return;
  }

  try {
    marketplace.enable(name);
    printSuccess(`Extension "${name}" enabled`);
  } catch (err) {
    printError(`Enable failed: ${err.message}`);
  }
}

function _handleDisable(name) {
  if (!name) {
    printWarn('Usage: ext disable <name>');
    return;
  }

  try {
    marketplace.disable(name);
    printSuccess(`Extension "${name}" disabled`);
  } catch (err) {
    printError(`Disable failed: ${err.message}`);
  }
}

async function _handleUpdate(name) {
  try {
    if (name) {
      printInfo(`Updating "${name}"...`);
      const result = await marketplace.updateExtension(name);
      printSuccess(`Updated "${result.name}" from ${result.oldVersion} to ${result.newVersion}`);
    } else {
      printInfo('Checking for updates...');
      const updates = await marketplace.checkUpdates();
      const available = updates.filter((u) => u.updateAvailable);

      if (available.length === 0) {
        printSuccess('All extensions are up to date');
        return;
      }

      printInfo(`${available.length} update(s) available:`);
      for (const u of available) {
        printInfo(`  ${u.name}: ${u.currentVersion} → ${u.latestVersion}`);
      }

      // Update all
      for (const u of available) {
        try {
          await marketplace.updateExtension(u.name);
          printSuccess(`Updated "${u.name}"`);
        } catch (err) {
          printError(`Failed to update "${u.name}": ${err.message}`);
        }
      }
    }
  } catch (err) {
    printError(`Update failed: ${err.message}`);
  }
}

function _handleLink(dir) {
  if (!dir) {
    printWarn('Usage: ext link <directory>');
    return;
  }

  try {
    const result = marketplace.link(dir);
    printSuccess(`Linked "${result.name}" from ${dir}`);
  } catch (err) {
    printError(`Link failed: ${err.message}`);
  }
}

function _handleUnlink(name) {
  if (!name) {
    printWarn('Usage: ext unlink <name>');
    return;
  }

  try {
    marketplace.unlink(name);
    printSuccess(`Unlinked "${name}"`);
  } catch (err) {
    printError(`Unlink failed: ${err.message}`);
  }
}

function _handleNew(name, extraArgs) {
  if (!name) {
    printWarn('Usage: ext new <name> [--capabilities skill,mcp-server]');
    return;
  }

  const opts = {};
  const capIdx = extraArgs.indexOf('--capabilities');
  if (capIdx >= 0 && extraArgs[capIdx + 1]) {
    opts.capabilities = extraArgs[capIdx + 1].split(',');
  }

  try {
    const result = marketplace.scaffold(name, process.cwd(), opts);
    printSuccess(`Extension "${name}" created at ${result.path}`);
    printInfo('Files created:');
    result.files.forEach((f) => printInfo(`  ${f}`));
    printInfo('');
    printInfo('Next steps:');
    printInfo(`  cd ${name}`);
    printInfo('  npm install');
    printInfo('  khy ext link .');
  } catch (err) {
    printError(`Scaffold failed: ${err.message}`);
  }
}

async function _handleInfo(name) {
  if (!name) {
    printWarn('Usage: ext info <name>');
    return;
  }

  // Check local first
  const installed = marketplace.list().find((e) => e.name === name);
  if (installed) {
    printInfo(`${installed.name} v${installed.version} (installed)`);
    printInfo(`  Status: ${installed.enabled ? 'enabled' : 'disabled'}`);
    printInfo(`  Capabilities: ${(installed.capabilities || []).join(', ') || 'none'}`);
    printInfo(`  Path: ${installed.path}`);
    if (installed.description) printInfo(`  Description: ${installed.description}`);
    return;
  }

  // Try registry
  printInfo(`Fetching info for "${name}"...`);
  const info = await marketplace.getInfo(name);
  if (!info) {
    printWarn(`Extension "${name}" not found`);
    return;
  }

  printInfo(`${info.name} v${info.version || info.latestVersion || '?'}`);
  if (info.description) printInfo(`  Description: ${info.description}`);
  if (info.author) printInfo(`  Author: ${info.author}`);
  if (info.downloads) printInfo(`  Downloads: ${info.downloads}`);
  if (info.repository) printInfo(`  Repository: ${info.repository}`);
  printInfo('');
  printInfo(`Install: ext install ${name}`);
}

function _printHelp() {
  const lines = [
    '',
    '  Extension Manager',
    '  ─────────────────',
    '',
    '  ext list              List installed extensions',
    '  ext search <query>    Search the registry',
    '  ext install <name>    Install from registry, URL, or path',
    '  ext uninstall <name>  Remove an extension',
    '  ext enable <name>     Enable a disabled extension',
    '  ext disable <name>    Disable without removing',
    '  ext update [name]     Update one or all extensions',
    '  ext info <name>       Show extension details',
    '  ext link <path>       Link local dir for development',
    '  ext unlink <name>     Remove a linked extension',
    '  ext new <name>        Scaffold a new extension project',
    '',
    '  Options:',
    '    --capabilities skill,mcp-server    (for ext new)',
    '',
  ];
  console.log(lines.join('\n'));
}

module.exports = { handleExtension };
