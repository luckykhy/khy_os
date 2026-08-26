'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = __dirname;
const INSTALLED_FILE = path.join(ROOT, 'installed.json');
const fallbackSignal = new AbortController().signal;

function readInstalled() {
  try {
    const value = JSON.parse(fs.readFileSync(INSTALLED_FILE, 'utf8'));
    return Array.isArray(value.plugins) ? value.plugins : [];
  } catch {
    return [];
  }
}

function errorResult(error) {
  return { error: error instanceof Error ? error.message : String(error) };
}

function createTool(record, declaration) {
  let modulePromise;
  const load = () => {
    if (!modulePromise) modulePromise = import(pathToFileURL(record.entry).href);
    return modulePromise;
  };
  return {
    name: declaration.name,
    description: declaration.description || '',
    category: declaration.category || 'custom',
    risk: declaration.risk || 'high',
    inputSchema: declaration.inputSchema || { type: 'object', properties: {} },
    isReadOnly: declaration.isReadOnly === true,
    isDestructive: declaration.isDestructive === true,
    isConcurrencySafe: declaration.isConcurrencySafe === true,
    aliases: Array.isArray(declaration.aliases) ? declaration.aliases : [],
    searchHint: declaration.searchHint,
    async execute(args, khyContext) {
      try {
        const mod = await load();
        const tools = mod && Array.isArray(mod.tools) ? mod.tools : [];
        const upstreamName = record.upstreamName || declaration.upstreamName || declaration.name;
        const upstream = tools.find((tool) => tool && tool.name === upstreamName);
        const execute = upstream && (upstream.execute || upstream.handler);
        if (typeof execute !== 'function') {
          return { error: `导入工具 ${upstreamName} 未导出 execute/handler` };
        }
        const exec = {
          name: upstreamName,
          arguments: args,
          agent: 'khy-os',
          signal: khyContext && khyContext.signal instanceof AbortSignal
            ? khyContext.signal
            : fallbackSignal,
          token: `khy-dsh:${upstreamName}`,
        };
        return await execute(args, exec);
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

function buildTools() {
  const tools = [];
  for (const plugin of readInstalled()) {
    if (!plugin || typeof plugin.entry !== 'string' || !Array.isArray(plugin.tools)) continue;
    for (const declaration of plugin.tools) {
      if (!declaration || typeof declaration.name !== 'string' || !declaration.name) continue;
      tools.push(createTool(plugin, declaration));
    }
  }
  return tools;
}

module.exports = { tools: buildTools() };
