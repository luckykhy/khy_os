'use strict';

/**
 * PluginHotReloadTool — reload a plugin without restarting the server.
 */

const { BaseTool } = require('../_baseTool');
const path = require('path');
const fs = require('fs');

class PluginHotReloadTool extends BaseTool {
  static toolName = 'PluginHotReload';
  static category = 'system';
  static risk = 'medium';
  static aliases = ['plugin_reload', 'reload_plugin'];
  static searchHint = 'plugin hot reload restart';

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return false;
  }

  prompt() {
    return `Reload a user-installed plugin without restarting the server.
Clears the require cache and re-reads plugin files.
Use after installing or updating a plugin to activate changes immediately.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        pluginSlug: {
          type: 'string',
          description: 'Slug of the plugin to reload',
        },
        userId: {
          type: 'string',
          description: 'User ID for per-user plugin context',
        },
      },
      required: ['pluginSlug'],
    };
  }

  async execute(params) {
    try {
      const { pluginSlug } = params;

      if (!pluginSlug || !/^[a-zA-Z0-9_-]+$/.test(pluginSlug)) {
        return { success: false, error: 'Invalid plugin slug' };
      }

      // Try multiple plugin locations
      const os = require('os');
      const candidates = [
        path.join(os.homedir(), '.khyquant', 'plugins', `${pluginSlug}.js`),
        path.join(os.homedir(), '.khy', 'plugins', `${pluginSlug}.js`),
        path.join(process.cwd(), 'plugins', `${pluginSlug}.js`),
      ];

      let pluginPath = null;
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          pluginPath = candidate;
          break;
        }
      }

      if (!pluginPath) {
        return { success: false, error: `Plugin "${pluginSlug}" not found in any plugin directory` };
      }

      // Clear require cache
      const resolvedPath = require.resolve(pluginPath);
      if (require.cache[resolvedPath]) {
        delete require.cache[resolvedPath];
      }

      // Re-require to validate
      let plugin;
      try {
        plugin = require(pluginPath);
      } catch (err) {
        return { success: false, error: `Failed to load plugin: ${err.message}` };
      }

      return {
        success: true,
        message: `Plugin "${pluginSlug}" hot-reloaded successfully`,
        path: pluginPath,
        hasHandler: typeof plugin.handler === 'function',
      };
    } catch (err) {
      return { success: false, error: `Hot reload error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `热加载插件：${input.pluginSlug || ''}`;
  }
}

module.exports = PluginHotReloadTool;
