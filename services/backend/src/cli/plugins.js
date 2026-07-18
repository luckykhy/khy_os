/**
 * User Plugin System — load custom commands from ~/.khyquant/commands/
 *
 * Plugin format (each .js file):
 *
 *   module.exports = {
 *     name: 'mycommand',            // command name
 *     aliases: ['mc', 'wdml'],      // optional aliases (pinyin, etc.)
 *     description: '我的自定义命令',  // shown in help
 *     usage: 'mycommand <arg>',     // usage string
 *     async handler(args, options, context) {
 *       // args: string[]  — positional arguments
 *       // options: object — parsed --key value pairs
 *       // context: { resolve, services, formatters }
 *       //   resolve(name) — resolve symbol name to code
 *       //   services — { klineDataService, backtestEngine, ... }
 *       //   formatters — { printSuccess, printTable, ... }
 *       const { resolve, formatters } = context;
 *       const sym = await resolve(args[0]);
 *       formatters.printSuccess(`Hello from custom command: ${sym.symbol}`);
 *     }
 *   };
 */
const fs = require('fs');
const path = require('path');
const chalk = require('chalk').default || require('chalk');

const os = require('os');
const PLUGINS_DIR = path.join(os.homedir(), '.khyquant', 'commands');

let _plugins = null;

/**
 * Load all user plugins from the commands directory.
 * Returns a Map<commandName, plugin>.
 */
function loadPlugins() {
  if (_plugins) return _plugins;
  _plugins = new Map();

  if (!fs.existsSync(PLUGINS_DIR)) {
    // Create the directory with a README on first run
    try {
      fs.mkdirSync(PLUGINS_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(PLUGINS_DIR, 'README.md'),
        `# khy OS Custom Commands

Place \`.js\` files here to add custom CLI commands.

## Plugin Template

\`\`\`javascript
module.exports = {
  name: 'mycommand',
  aliases: ['mc'],
  description: 'Description shown in help',
  usage: 'mycommand <arg> [--option value]',
  async handler(args, options, context) {
    const { resolve, services, formatters } = context;
    // args[0] = first positional argument
    // options = { key: value } from --key value
    // resolve('茅台') → { symbol: 'sh600519', name: '贵州茅台' }
    // services.klineDataService, services.backtestEngine, etc.
    // formatters.printSuccess(), formatters.printTable(), etc.
    formatters.printSuccess('Hello from ' + args[0]);
  }
};
\`\`\`
`
      );
    } catch { /* permission issues */ }
    return _plugins;
  }

  try {
    const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js'));

    for (const file of files) {
      try {
        const pluginPath = path.join(PLUGINS_DIR, file);
        const plugin = require(pluginPath);

        if (!plugin.name || typeof plugin.handler !== 'function') {
          console.warn(chalk.yellow(`  ⚠ Plugin ${file}: missing 'name' or 'handler', skipped`));
          continue;
        }

        _plugins.set(plugin.name.toLowerCase(), plugin);

        // Register aliases
        if (Array.isArray(plugin.aliases)) {
          for (const alias of plugin.aliases) {
            _plugins.set(alias.toLowerCase(), plugin);
          }
        }
      } catch (err) {
        console.warn(chalk.yellow(`  ⚠ Plugin ${file} load error: ${err.message}`));
      }
    }
  } catch { /* directory read error */ }

  return _plugins;
}

/**
 * Try to execute a user plugin command.
 * @returns {boolean} true if a plugin handled the command
 */
async function tryPlugin(commandName, args, options) {
  const plugins = loadPlugins();
  const plugin = plugins.get(commandName.toLowerCase());
  if (!plugin) return false;

  const { resolveSymbol } = require('./symbolResolver');
  const formatters = require('./formatters');

  // Build context for plugin
  const context = {
    resolve: resolveSymbol,
    formatters,
    services: {},
  };

  // Lazy-load services only when plugin actually needs them
  const serviceProxy = new Proxy({}, {
    get(_, prop) {
      try {
        switch (prop) {
          case 'klineDataService': return new (require('../services/klineDataService'))();
          case 'backtestEngine': return require('../services/backtestEngine');
          case 'marketDataService': return require('../services/marketDataService');
          default: return undefined;
        }
      } catch { return undefined; }
    }
  });
  context.services = serviceProxy;

  try {
    await plugin.handler(args, options, context);
  } catch (err) {
    formatters.printError(`Plugin '${plugin.name}' error: ${err.message}`);
  }
  return true;
}

/**
 * Get all loaded plugins (for help display).
 */
function getPluginList() {
  const plugins = loadPlugins();
  // Deduplicate by plugin.name
  const seen = new Set();
  const list = [];
  for (const [, plugin] of plugins) {
    if (!seen.has(plugin.name)) {
      seen.add(plugin.name);
      list.push(plugin);
    }
  }
  return list;
}

/**
 * Reload plugins (after user adds new ones).
 */
function reloadPlugins() {
  // Clear require cache for plugin files
  if (_plugins) {
    const seen = new Set();
    for (const [, plugin] of _plugins) {
      if (seen.has(plugin.name)) continue;
      seen.add(plugin.name);
      const pluginPath = path.join(PLUGINS_DIR, plugin.name + '.js');
      try {
        delete require.cache[require.resolve(pluginPath)];
      } catch { /* file may have been removed */ }
    }
  }
  _plugins = null;
  return loadPlugins();
}

module.exports = { loadPlugins, tryPlugin, getPluginList, reloadPlugins, PLUGINS_DIR };
