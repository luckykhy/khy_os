'use strict';

/**
 * khyAnythingProxy — instant "proxy onboarding" for any local open-source
 * project. Given a project directory, it detects the build system and entry
 * points (reusing cliAnythingGenerator's detectors), derives a whitelist of
 * runnable commands, persists the proxy, and registers it as a KHY tool + app
 * so the agent can invoke the project's entry points via subprocess — with no
 * AI generation and no install.
 *
 * For high-quality semantic wrapping, callers use the `--deep` path which
 * forwards to the 7-stage generator instead (handled by the CLI layer).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const gen = require('./cliAnythingGenerator');

const PROXY_DIR = path.join(os.homedir(), '.khy', 'khyanything');
const PROXIES_FILE = path.join(PROXY_DIR, 'proxies.json');

function _ensureDir() {
  if (!fs.existsSync(PROXY_DIR)) fs.mkdirSync(PROXY_DIR, { recursive: true });
}

function _readProxies() {
  try {
    const data = JSON.parse(fs.readFileSync(PROXIES_FILE, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function _writeProxies(list) {
  _ensureDir();
  fs.writeFileSync(PROXIES_FILE, JSON.stringify(list, null, 2));
}

function _kebab(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';
}

// ── Command detection (build a runnable whitelist) ───────────────────────────

function _detectNpmCommands(dir) {
  const out = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    if (pkg.scripts) {
      for (const s of Object.keys(pkg.scripts)) {
        out.push({ command: _kebab(s), kind: 'npm-script', script: s });
      }
    }
    if (pkg.bin) {
      const bins = typeof pkg.bin === 'string' ? { [pkg.name || 'bin']: pkg.bin } : pkg.bin;
      for (const [k, v] of Object.entries(bins)) {
        out.push({ command: _kebab(k), kind: 'node-bin', file: v });
      }
    }
  } catch { /* no/invalid package.json */ }
  return out;
}

function _detectMakeTargets(dir) {
  const out = [];
  try {
    const mk = fs.readFileSync(path.join(dir, 'Makefile'), 'utf-8');
    const re = /^([a-zA-Z0-9][a-zA-Z0-9_.-]*)\s*:(?!=)/gm;
    const seen = new Set();
    let m;
    while ((m = re.exec(mk))) {
      const t = m[1];
      if (t === '.PHONY' || seen.has(t)) continue;
      seen.add(t);
      out.push({ command: _kebab(t), kind: 'make', target: t });
    }
  } catch { /* no Makefile */ }
  return out;
}

function _detectPythonCommands(dir, entryPoints) {
  const out = [];
  for (const e of entryPoints || []) {
    if (/\.py$/.test(e)) {
      out.push({ command: _kebab(e.replace(/\.py$/, '')), kind: 'python', file: e });
    }
  }
  return out;
}

function _buildRunSpec(dir, info) {
  const collected = [];
  if (fs.existsSync(path.join(dir, 'package.json'))) collected.push(..._detectNpmCommands(dir));
  if (fs.existsSync(path.join(dir, 'Makefile'))) collected.push(..._detectMakeTargets(dir));
  if (info.language === 'python') collected.push(..._detectPythonCommands(dir, info.entryPoints));

  // Dedup by command name (first wins).
  const seen = new Set();
  const commands = [];
  for (const c of collected) {
    if (seen.has(c.command)) continue;
    seen.add(c.command);
    commands.push(c);
  }
  // Free-form fallback: `run <program> [args...]` executed inside the project dir.
  commands.push({ command: 'run', kind: 'raw' });
  return { commands };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Onboard a local project as an instant proxy.
 * @param {string} projectPath  Absolute or relative path to a local project dir.
 * @param {object} [opts]  { name }
 */
function addProxy(projectPath, opts = {}) {
  if (!projectPath) {
    return { success: false, error: '未提供项目路径。用法: app khy-add <本地项目路径>' };
  }
  const resolved = path.resolve(projectPath);
  if (!fs.existsSync(resolved)) {
    return { success: false, error: `路径不存在: ${resolved}` };
  }
  if (!fs.statSync(resolved).isDirectory()) {
    return { success: false, error: `不是目录: ${resolved}` };
  }

  const info = {
    language: gen._detectLanguage(resolved),
    buildSystem: gen._detectBuildSystem(resolved),
    entryPoints: gen._detectEntryPoints(resolved),
  };
  const runSpec = _buildRunSpec(resolved, info);
  const name = opts.name ? _kebab(opts.name) : _kebab(path.basename(resolved));

  const proxy = {
    name,
    path: resolved,
    language: info.language,
    buildSystem: info.buildSystem,
    entryPoints: info.entryPoints,
    runSpec,
    addedAt: new Date().toISOString(),
  };

  const list = _readProxies().filter(p => p.name !== name);
  list.push(proxy);
  _writeProxies(list);

  const registered = _registerProxyArtifacts(proxy);

  return {
    success: true,
    name,
    path: resolved,
    language: info.language,
    buildSystem: info.buildSystem,
    entryPoints: info.entryPoints,
    commands: runSpec.commands.map(c => c.command),
    registered,
  };
}

function listProxies() {
  return _readProxies();
}

function removeProxy(name) {
  const list = _readProxies();
  const idx = list.findIndex(p => p.name === name);
  if (idx < 0) return { success: false, error: `代理未找到: ${name}` };
  list.splice(idx, 1);
  _writeProxies(list);
  try { require('./appRegistry').unregister(`khyanything-${name}`); } catch { /* ok */ }
  return { success: true, name };
}

/**
 * Execute a whitelisted command of a registered proxy via subprocess.
 * Returns the same shape as cliAnythingService.invokeCommand.
 */
function invokeProxy(name, command, args = [], opts = {}) {
  const proxy = _readProxies().find(p => p.name === name);
  if (!proxy) return { success: false, error: `代理未找到: ${name}` };

  const spec = proxy.runSpec.commands.find(c => c.command === command);
  if (!spec) {
    const avail = proxy.runSpec.commands.map(c => c.command).join(', ');
    return { success: false, error: `命令 "${command}" 不在白名单。可用: ${avail}` };
  }

  const timeout = opts.timeout || 120000;
  let bin;
  let finalArgs;
  switch (spec.kind) {
    case 'npm-script':
      bin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      finalArgs = ['run', spec.script, ...(args.length ? ['--', ...args] : [])];
      break;
    case 'node-bin':
      bin = 'node';
      finalArgs = [path.join(proxy.path, spec.file), ...args];
      break;
    case 'make':
      bin = 'make';
      finalArgs = [spec.target, ...args];
      break;
    case 'python':
      bin = process.platform === 'win32' ? 'python' : 'python3';
      finalArgs = [path.join(proxy.path, spec.file), ...args];
      break;
    case 'raw':
    default:
      if (!args.length) {
        return { success: false, error: 'run 命令需要至少一个参数(要执行的程序)' };
      }
      bin = args[0];
      finalArgs = args.slice(1);
      break;
  }

  try {
    const output = execFileSync(bin, finalArgs, {
      cwd: proxy.path,
      encoding: 'utf-8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
    return { success: true, data: output.trim(), format: 'text' };
  } catch (err) {
    return {
      success: false,
      error: err.message || 'command failed',
      stderr: err.stderr ? err.stderr.toString().slice(0, 1000) : '',
      exitCode: err.status || -1,
    };
  }
}

// ── Registration (best-effort; failures are reported, never fatal) ────────────

function _registerProxyArtifacts(proxy) {
  const res = { tool: false, app: false, errors: [] };

  try {
    const appRegistry = require('./appRegistry');
    appRegistry.register({
      name: `khyanything-${proxy.name}`,
      version: '1.0.0',
      description: `Proxy onboarding for ${proxy.name} (${proxy.language}/${proxy.buildSystem})`,
      entry: proxy.path,
      runtime: 'external',
      source: 'khyanything',
      commands: proxy.runSpec.commands.map(c => `khy-${proxy.name}-${c.command}`),
    });
    res.app = true;
  } catch (e) {
    res.errors.push(`app: ${e.message}`);
  }

  try {
    const tools = require('../tools');
    if (typeof tools.register === 'function') {
      tools.register(_buildProxyToolDef(proxy));
      res.tool = true;
    }
  } catch (e) {
    res.errors.push(`tool: ${e.message}`);
  }

  return res;
}

function _buildProxyToolDef(proxy) {
  const cmdList = proxy.runSpec.commands.map(c => c.command).join(', ');
  return {
    name: `khyanything__${proxy.name}`,
    description: `Proxy to local project "${proxy.name}" (${proxy.language}/${proxy.buildSystem}). Available commands: ${cmdList}`,
    category: 'execution',
    risk: 'high',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: `Command to run (one of: ${cmdList})` },
        args: { type: 'string', description: 'Extra arguments passed to the command' },
      },
      required: ['command'],
    },
    async execute({ command, args }) {
      const argList = args ? String(args).split(/\s+/).filter(Boolean) : [];
      return invokeProxy(proxy.name, command, argList);
    },
  };
}

module.exports = {
  addProxy,
  listProxies,
  removeProxy,
  invokeProxy,
  PROXY_DIR,
  PROXIES_FILE,
};
