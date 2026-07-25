'use strict';

/**
 * Context Factory — produces isolated PluginContext instances for each plugin.
 *
 * Each plugin receives its own context with:
 * - Scoped command/tool registries (all registrations are tracked for cleanup)
 * - Isolated storage namespace
 * - Sandboxed HTTP (if permissions allow)
 * - Scoped logger (prefixed with plugin name)
 */

const path = require('path');
const fs = require('fs');
const { getDataHome } = require('../utils/dataHome');

function getPluginsHome() {
  if (process.env.KHY_PLUGIN_HOME && process.env.KHY_PLUGIN_HOME.trim()) {
    return process.env.KHY_PLUGIN_HOME.trim();
  }
  return path.join(getDataHome(), 'plugins');
}

/**
 * Create the context factory function.
 *
 * @param {object} opts
 * @param {object} opts.commandRegistry - Host CommandRegistry
 * @param {object} opts.toolRegistry - Host ToolRegistry (from tools/index.js)
 * @param {object} opts.aiGateway - Host AI Gateway instance
 * @param {object} opts.logger - Host logger
 * @param {string} opts.hostVersion - Host version string
 * @param {object} [opts.eventBus] - Shared event bus
 * @param {object} [opts.database] - Database access provider
 * @returns {Function} (manifest, entry) → PluginContext
 */
function createContextFactory(opts) {
  const {
    commandRegistry,
    toolRegistry,
    aiGateway,
    logger: hostLogger,
    hostVersion,
    eventBus: sharedEventBus,
    database,
  } = opts;

  // Shared event bus (simple in-process EventEmitter-like)
  const _eventBus = sharedEventBus || createEventBus();

  return function contextFactory(manifest, entry) {
    const disposables = entry.disposables;
    const ns = manifest.namespace;
    const permissions = manifest.permissions || {};
    const pluginsHome = getPluginsHome();

    // ─── Commands ─────────────────────────────────────────────────────
    const commands = {
      register(def) {
        // Prefix if not already qualified
        const qualifiedName = def.name.includes('.') ? def.name : `${ns}.${def.name}`;
        const cmdDef = {
          cmd: `/${qualifiedName}`,
          label: def.description || qualifiedName,
          desc: def.description || '',
          route: null,
          flag: null,
          category: def.category || ns,
          // Attach the handler for router dispatch
          _pluginHandler: def.handler,
          _pluginNamespace: ns,
          _aliases: def.aliases,
          _completer: def.completer,
        };
        commandRegistry.register(cmdDef, 'plugin');

        // Register aliases
        if (def.aliases) {
          for (const alias of def.aliases) {
            commandRegistry.register({ ...cmdDef, cmd: `/${alias}` }, 'plugin');
          }
        }

        const disposable = {
          dispose() {
            commandRegistry.unregister(cmdDef.cmd);
            if (def.aliases) {
              for (const alias of def.aliases) {
                commandRegistry.unregister(`/${alias}`);
              }
            }
          }
        };
        disposables.push(disposable);
        return disposable;
      },
      registerGroup(prefix, defs) {
        const disposableList = [];
        for (const def of defs) {
          const d = commands.register({ ...def, name: `${prefix}.${def.name}` });
          disposableList.push(d);
        }
        const groupDisposable = {
          dispose() { for (const d of disposableList) d.dispose(); }
        };
        disposables.push(groupDisposable);
        return groupDisposable;
      },
    };

    // ─── Tools ────────────────────────────────────────────────────────
    const tools = {
      register(def) {
        // Prefix tool name with namespace
        const qualifiedName = def.name.includes('_') && def.name.startsWith(ns)
          ? def.name
          : `${ns}_${def.name}`;

        const toolDef = { ...def, name: qualifiedName, _pluginNamespace: ns };

        // Use host toolRegistry if available, otherwise track internally
        if (toolRegistry && toolRegistry.registerPlugin) {
          toolRegistry.registerPlugin(toolDef);
        }

        const disposable = {
          dispose() {
            if (toolRegistry && toolRegistry.unregisterPlugin) {
              toolRegistry.unregisterPlugin(qualifiedName);
            }
          }
        };
        disposables.push(disposable);
        return disposable;
      },
    };

    // ─── Data Sources ─────────────────────────────────────────────────
    const registeredDataSources = [];
    const dataSources = {
      register(def) {
        registeredDataSources.push(def);
        const disposable = {
          dispose() {
            const i = registeredDataSources.indexOf(def);
            if (i >= 0) registeredDataSources.splice(i, 1);
          }
        };
        disposables.push(disposable);
        return disposable;
      },
    };

    // ─── AI ───────────────────────────────────────────────────────────
    const ai = {
      async generate(prompt, aiOpts = {}) {
        if (!aiGateway) {
          return { text: '[AI not available]', model: 'none', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        try {
          const messages = aiOpts.messages || [{ role: 'user', content: prompt }];
          if (aiOpts.system) {
            messages.unshift({ role: 'system', content: aiOpts.system });
          }
          const result = await aiGateway.chat(messages, {
            temperature: aiOpts.temperature,
            maxTokens: aiOpts.maxTokens,
            model: aiOpts.model,
          });
          return {
            text: result.text || result.content || '',
            model: result.model || 'unknown',
            usage: result.usage || { inputTokens: 0, outputTokens: 0 },
          };
        } catch (err) {
          return { text: `[AI error: ${err.message}]`, model: 'error', usage: { inputTokens: 0, outputTokens: 0 } };
        }
      },
      async *stream(prompt, aiOpts = {}) {
        if (!aiGateway || !aiGateway.chatStream) {
          yield { text: '[AI streaming not available]', done: true };
          return;
        }
        try {
          const messages = aiOpts.messages || [{ role: 'user', content: prompt }];
          if (aiOpts.system) {
            messages.unshift({ role: 'system', content: aiOpts.system });
          }
          const stream = await aiGateway.chatStream(messages, {
            temperature: aiOpts.temperature,
            maxTokens: aiOpts.maxTokens,
            model: aiOpts.model,
          });
          for await (const chunk of stream) {
            yield { text: chunk.text || chunk.content || '', done: false };
          }
          yield { text: '', done: true };
        } catch (err) {
          yield { text: `[Stream error: ${err.message}]`, done: true };
        }
      },
    };

    // ─── Storage (isolated KV per plugin) ─────────────────────────────
    const storageDir = path.join(pluginsHome, ns, 'storage');
    const storage = {
      async get(key) {
        try {
          const filePath = path.join(storageDir, `${key}.json`);
          if (!fs.existsSync(filePath)) return undefined;
          return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch { return undefined; }
      },
      async set(key, value) {
        fs.mkdirSync(storageDir, { recursive: true });
        const filePath = path.join(storageDir, `${key}.json`);
        fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
      },
      async del(key) {
        try {
          const filePath = path.join(storageDir, `${key}.json`);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch {}
      },
      async list(prefix) {
        try {
          if (!fs.existsSync(storageDir)) return [];
          const files = fs.readdirSync(storageDir).filter(f => f.endsWith('.json'));
          const keys = files.map(f => f.slice(0, -5));
          return prefix ? keys.filter(k => k.startsWith(prefix)) : keys;
        } catch { return []; }
      },
    };

    // ─── Config ───────────────────────────────────────────────────────
    const configPath = path.join(pluginsHome, ns, 'config.json');
    let _configCache = null;
    function loadConfig() {
      if (_configCache) return _configCache;
      try {
        if (fs.existsSync(configPath)) {
          _configCache = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } else {
          _configCache = {};
        }
      } catch {
        _configCache = {};
      }
      return _configCache;
    }

    const config = {
      get(key, defaultValue) {
        const c = loadConfig();
        return key in c ? c[key] : defaultValue;
      },
      async set(key, value) {
        const c = loadConfig();
        c[key] = value;
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(c, null, 2));
        _configCache = c;
      },
      getAll() { return { ...loadConfig() }; },
    };

    // ─── Logger (scoped) ──────────────────────────────────────────────
    const prefix = `[plugin:${ns}]`;
    const logger = {
      debug(msg, ...args) { if (hostLogger.debug) hostLogger.debug(`${prefix} ${msg}`, ...args); },
      info(msg, ...args) { if (hostLogger.info) hostLogger.info(`${prefix} ${msg}`, ...args); },
      warn(msg, ...args) { if (hostLogger.warn) hostLogger.warn(`${prefix} ${msg}`, ...args); },
      error(msg, ...args) { if (hostLogger.error) hostLogger.error(`${prefix} ${msg}`, ...args); },
    };

    // ─── Identity ─────────────────────────────────────────────────────
    const identity = { userId: undefined, username: undefined, role: undefined };

    // ─── HTTP (permission-gated) ──────────────────────────────────────
    const http = {
      async fetch(url, init = {}) {
        if (!permissions.network) {
          throw new Error(`Plugin "${ns}" does not have network permission. Add permissions.network: true to manifest.`);
        }
        // Use Node's built-in fetch (Node 18+) or fallback
        const fetchFn = globalThis.fetch || require('node:https').request;
        if (globalThis.fetch) {
          const resp = await globalThis.fetch(url, {
            method: init.method || 'GET',
            headers: init.headers,
            body: init.body,
            signal: init.timeout ? AbortSignal.timeout(init.timeout) : undefined,
          });
          return {
            status: resp.status,
            headers: Object.fromEntries(resp.headers.entries()),
            text: () => resp.text(),
            json: () => resp.json(),
          };
        }
        throw new Error('HTTP fetch not available in this Node.js version');
      },
    };

    // ─── Spawn (permission-gated) ─────────────────────────────────────
    let spawn = undefined;
    if (permissions.spawn) {
      const { spawn: nodeSpawn } = require('child_process');
      spawn = (cmd, args, spawnOpts = {}) => {
        const proc = nodeSpawn(cmd, args, {
          cwd: spawnOpts.cwd || process.cwd(),
          env: { ...process.env, ...(spawnOpts.env || {}) },
          timeout: spawnOpts.timeout,
        });
        return {
          stdout: (async function* () {
            for await (const chunk of proc.stdout) yield chunk.toString();
          })(),
          stderr: (async function* () {
            for await (const chunk of proc.stderr) yield chunk.toString();
          })(),
          exitCode: new Promise(resolve => proc.on('close', resolve)),
          kill() { require('../tools/platformUtils').safeKill(proc); },
        };
      };
    }

    // ─── Host Info ────────────────────────────────────────────────────
    const host = {
      version: hostVersion,
      capabilities: [
        'ai.generate',
        'ai.stream',
        'commands.register',
        'tools.register',
        'storage.kv',
        'config',
        'events',
        ...(permissions.network ? ['http'] : []),
        ...(permissions.spawn ? ['spawn'] : []),
        ...(permissions.database ? ['database'] : []),
      ],
    };

    // ─── Event Bus ────────────────────────────────────────────────────
    const events = {
      on(event, handler) {
        return _eventBus.on(event, handler);
      },
      emit(event, ...args) {
        _eventBus.emit(event, ...args);
      },
    };

    // ─── Database (permission-gated) ──────────────────────────────────
    let databaseAccess = undefined;
    if (permissions.database && database) {
      databaseAccess = database;
    }

    // ─── Assemble Context ─────────────────────────────────────────────
    return {
      commands,
      tools,
      dataSources,
      ai,
      storage,
      config,
      logger,
      identity,
      http,
      spawn,
      host,
      events,
      database: databaseAccess,
    };
  };
}

/**
 * Create a simple in-process event bus.
 */
function createEventBus() {
  const handlers = new Map();
  return {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return {
        dispose() {
          const list = handlers.get(event);
          if (list) {
            const i = list.indexOf(handler);
            if (i >= 0) list.splice(i, 1);
          }
        }
      };
    },
    emit(event, ...args) {
      const list = handlers.get(event) || [];
      for (const h of list) {
        try { h(...args); } catch {}
      }
    },
  };
}

module.exports = { createContextFactory, createEventBus };
