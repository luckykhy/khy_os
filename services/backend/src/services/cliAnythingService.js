'use strict';

/**
 * CLI-Anything Bridge Service
 *
 * Bridges the CLI-Anything ecosystem into KHY OS:
 * - Registry: fetch/cache/search CLI-Anything's registry.json + public_registry.json
 * - Discovery: scan PATH for installed cli-anything-* commands
 * - Invocation: subprocess call with --json, structured output parsing
 * - Installation: pip/npm/uv dispatch based on registry install_strategy
 * - Registration: auto-register installed CLIs as KHY tools + skills + apps
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');

const CLI_ANYTHING_DIR = path.join(os.homedir(), '.khy', 'cli-anything');
const REGISTRY_CACHE = path.join(CLI_ANYTHING_DIR, 'registry.json');
const PUBLIC_REGISTRY_CACHE = path.join(CLI_ANYTHING_DIR, 'public_registry.json');
const INSTALLED_CACHE = path.join(CLI_ANYTHING_DIR, 'installed.json');
const BUNDLE_DIR = path.join(CLI_ANYTHING_DIR, 'bundle');
const BUNDLE_META = path.join(CLI_ANYTHING_DIR, 'bundle.json');
const REGISTRY_CDN = 'https://hkuds.github.io/CLI-Anything';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Built-in (vendored) registry shipped with KHY — makes search/list and skill
// registration work out of the box with zero network and zero external zip.
const VENDORED_DIR = path.join(__dirname, '..', 'data', 'cliAnythingRegistry');
const VENDORED_REGISTRY = path.join(VENDORED_DIR, 'registry.json');
const VENDORED_PUBLIC = path.join(VENDORED_DIR, 'public_registry.json');
const VENDORED_SKILLS = path.join(VENDORED_DIR, 'skills');

function _ensureDir() {
  if (!fs.existsSync(CLI_ANYTHING_DIR)) {
    fs.mkdirSync(CLI_ANYTHING_DIR, { recursive: true });
  }
}

function _isCacheValid(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return (Date.now() - stat.mtimeMs) < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

// 收敛到 utils/readJsonFileSafe 单一真源(逐字节委托,调用点不变)
const _readJSON = require('../utils/readJsonFileSafe');

function _writeJSON(filePath, data) {
  _ensureDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ── Offline Bundle ──────────────────────────────────────────────────────────

/**
 * Read the offline bundle root recorded by importFromArchive.
 * Returns the absolute path to the extracted CLI-Anything snapshot, or null
 * when no offline bundle has been imported.
 */
function _getBundleRoot() {
  const meta = _readJSON(BUNDLE_META);
  if (meta && meta.bundleRoot && fs.existsSync(meta.bundleRoot)) {
    return meta.bundleRoot;
  }
  return null;
}

/**
 * Locate the directory that holds registry.json within an extracted tree.
 * Handles the common case where the archive wraps everything in a top-level
 * folder (e.g. "CLI-Anything-main/").
 */
function _findRegistryRoot(dir) {
  if (fs.existsSync(path.join(dir, 'registry.json'))) return dir;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const candidate = path.join(dir, ent.name);
    if (fs.existsSync(path.join(candidate, 'registry.json'))) return candidate;
  }
  return null;
}

/**
 * Import a local CLI-Anything snapshot (a .zip file or an already-extracted
 * directory) into the offline cache. Populates the registry caches so search
 * works offline, and records a bundle.json so installs resolve to local
 * agent-harness packages instead of the GitHub remote.
 *
 * @param {string} srcPath  Path to a .zip archive or extracted directory.
 * @param {object} [opts]
 * @returns {{success:boolean, error?:string, bundleRoot?:string, total?:number, harness?:number, public?:number}}
 */
function importFromArchive(srcPath, opts = {}) {
  if (!srcPath) {
    return { success: false, error: '未提供路径。用法: app cli-import <zip或目录>' };
  }
  const resolved = path.resolve(srcPath);
  if (!fs.existsSync(resolved)) {
    return { success: false, error: `路径不存在: ${resolved}` };
  }
  _ensureDir();

  let extractedRoot;
  const stat = fs.statSync(resolved);

  if (stat.isDirectory()) {
    // Use the directory in place — no copy needed.
    extractedRoot = _findRegistryRoot(resolved);
    if (!extractedRoot) {
      return { success: false, error: `目录中未找到 registry.json: ${resolved}` };
    }
  } else if (resolved.toLowerCase().endsWith('.zip')) {
    // Extract into the offline bundle directory.
    try {
      fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
    } catch { /* ok */ }
    fs.mkdirSync(BUNDLE_DIR, { recursive: true });
    try {
      execFileSync('unzip', ['-o', '-q', resolved, '-d', BUNDLE_DIR], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120000,
      });
    } catch (err) {
      return { success: false, error: `解压失败 (需要系统 unzip): ${err.message}` };
    }
    extractedRoot = _findRegistryRoot(BUNDLE_DIR);
    if (!extractedRoot) {
      return { success: false, error: '压缩包中未找到 registry.json' };
    }
  } else {
    return { success: false, error: '仅支持 .zip 文件或已解压目录' };
  }

  // Copy registry files into the existing cache locations.
  const harness = _readJSON(path.join(extractedRoot, 'registry.json'));
  if (!harness) {
    return { success: false, error: 'registry.json 解析失败' };
  }
  _writeJSON(REGISTRY_CACHE, harness);

  let pub = _readJSON(path.join(extractedRoot, 'public_registry.json'));
  if (pub) _writeJSON(PUBLIC_REGISTRY_CACHE, pub);

  const harnessCount = Array.isArray(harness.clis) ? harness.clis.length : 0;
  const publicCount = pub && Array.isArray(pub.clis) ? pub.clis.length : 0;

  _writeJSON(BUNDLE_META, {
    bundleRoot: extractedRoot,
    importedFrom: resolved,
    cliCount: harnessCount + publicCount,
  });

  return {
    success: true,
    bundleRoot: extractedRoot,
    total: harnessCount + publicCount,
    harness: harnessCount,
    public: publicCount,
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────

function _fetchURL(url) {
  try {
    return execSync(`curl -sL --max-time 15 "${url}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 20000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Resolve one registry source with this precedence:
 *   1. valid (fresh) user cache — populated by import/sync
 *   2. CDN refresh — only attempted when `force` (e.g. `cli-sync`), so normal
 *      use never blocks on the network
 *   3. any existing cache, even if stale
 *   4. built-in vendored copy shipped with KHY (offline, zero-config)
 */
function _resolveRegistry(cacheFile, cdnFile, vendoredFile, force) {
  if (!force && _isCacheValid(cacheFile)) {
    return { data: _readJSON(cacheFile), fromCache: true };
  }
  if (force) {
    const raw = _fetchURL(`${REGISTRY_CDN}/${cdnFile}`);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        _writeJSON(cacheFile, parsed);
        return { data: parsed, fromCache: false };
      } catch { /* invalid JSON — fall through to fallbacks */ }
    }
  }
  const cached = _readJSON(cacheFile);
  if (cached) return { data: cached, fromCache: true };

  const vendored = _readJSON(vendoredFile);
  if (vendored) return { data: vendored, fromCache: false };

  return { data: null, fromCache: false };
}

function fetchRegistry(force = false) {
  _ensureDir();
  const harness = _resolveRegistry(REGISTRY_CACHE, 'registry.json', VENDORED_REGISTRY, force);
  const pub = _resolveRegistry(PUBLIC_REGISTRY_CACHE, 'public_registry.json', VENDORED_PUBLIC, force);
  return {
    harness: harness.data,
    public: pub.data,
    fromCache: harness.fromCache && pub.fromCache,
  };
}

function _getAllCLIs() {
  const reg = fetchRegistry();
  const all = [];

  if (reg.harness && Array.isArray(reg.harness.clis)) {
    for (const cli of reg.harness.clis) {
      all.push({ ...cli, _source: 'harness' });
    }
  }
  if (reg.public && Array.isArray(reg.public.clis)) {
    for (const cli of reg.public.clis) {
      all.push({ ...cli, _source: 'public' });
    }
  }

  return all;
}

function searchRegistry(query) {
  if (!query) return [];
  const q = query.toLowerCase();
  const all = _getAllCLIs();

  return all
    .map((cli) => {
      let score = 0;
      const name = (cli.name || '').toLowerCase();
      const displayName = (cli.display_name || '').toLowerCase();
      const desc = (cli.description || '').toLowerCase();
      const category = (cli.category || '').toLowerCase();
      const tags = (cli.tags || []).map(t => t.toLowerCase());

      if (name === q) score += 100;
      else if (name.includes(q)) score += 60;
      if (displayName.includes(q)) score += 40;
      if (desc.includes(q)) score += 20;
      if (category.includes(q)) score += 15;
      if (tags.some(t => t.includes(q) || q.includes(t))) score += 30;

      return { ...cli, _score: score };
    })
    .filter(c => c._score > 0)
    .sort((a, b) => b._score - a._score);
}

function getRegistryStats() {
  const all = _getAllCLIs();
  const categories = {};
  for (const cli of all) {
    const cat = cli.category || 'other';
    categories[cat] = (categories[cat] || 0) + 1;
  }
  return {
    total: all.length,
    harness: all.filter(c => c._source === 'harness').length,
    public: all.filter(c => c._source === 'public').length,
    categories,
  };
}

// ── Discovery ─────────────────────────────────────────────────────────────────

function _which(cmd) {
  const { searchExecutable } = require('../tools/platformUtils');
  return searchExecutable(cmd);
}

function _getVersion(cmd) {
  try {
    const { execFileSync } = require('child_process');
    return execFileSync(cmd, ['--version'], {
      encoding: 'utf-8', timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n')[0].trim();
  } catch {
    return 'unknown';
  }
}

function _getHelp(cmd) {
  try {
    const { execFileSync } = require('child_process');
    return execFileSync(cmd, ['--help'], {
      encoding: 'utf-8', timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function _parseCommandGroups(helpOutput) {
  const groups = [];
  const lines = (helpOutput || '').split('\n');
  for (const line of lines) {
    const match = line.match(/^\s{2,4}(\w[\w-]*)\s{2,}/);
    if (match) groups.push(match[1]);
  }
  return groups;
}

function discoverInstalled() {
  const all = _getAllCLIs();
  const installed = [];

  for (const cli of all) {
    const entryPoint = cli.entry_point || `cli-anything-${cli.name}`;
    const binPath = _which(entryPoint);
    if (binPath) {
      const version = _getVersion(entryPoint);
      const helpOutput = _getHelp(entryPoint);
      installed.push({
        name: cli.name,
        displayName: cli.display_name || cli.name,
        entryPoint,
        binPath,
        version,
        description: cli.description || '',
        category: cli.category || 'other',
        commandGroups: _parseCommandGroups(helpOutput),
        helpOutput,
        _source: cli._source,
        skillMd: cli.skill_md || null,
        installCmd: cli.install_cmd || null,
      });
    }
  }

  // Also scan PATH for any cli-anything-* not in registry
  try {
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    const seen = new Set(installed.map(i => i.entryPoint));
    for (const dir of pathDirs) {
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (f.startsWith('cli-anything-') && !seen.has(f)) {
            const binPath = path.join(dir, f);
            const name = f.replace('cli-anything-', '');
            seen.add(f);
            installed.push({
              name,
              displayName: name,
              entryPoint: f,
              binPath,
              version: _getVersion(f),
              description: '',
              category: 'unknown',
              commandGroups: _parseCommandGroups(_getHelp(f)),
              helpOutput: '',
              _source: 'local',
              skillMd: null,
              installCmd: null,
            });
          }
        }
      } catch { /* dir not readable */ }
    }
  } catch { /* PATH scan failed */ }

  _writeJSON(INSTALLED_CACHE, { updatedAt: new Date().toISOString(), clis: installed });
  return installed;
}

function getInstalledCLIs() {
  const cached = _readJSON(INSTALLED_CACHE);
  if (cached && cached.clis) return cached.clis;
  return discoverInstalled();
}

// ── Invocation ────────────────────────────────────────────────────────────────

function invokeCommand(cliName, args = [], opts = {}) {
  const entryPoint = cliName.startsWith('cli-anything-') ? cliName : `cli-anything-${cliName}`;
  const timeout = opts.timeout || 60000;
  const useJson = opts.json !== false;

  const fullArgs = [...args];
  if (useJson && !fullArgs.includes('--json')) {
    fullArgs.push('--json');
  }

  try {
    const output = execFileSync(entryPoint, fullArgs, {
      encoding: 'utf-8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });

    if (useJson) {
      try {
        return { success: true, data: JSON.parse(output), format: 'json' };
      } catch {
        return { success: true, data: output.trim(), format: 'text' };
      }
    }
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

// ── Installation ──────────────────────────────────────────────────────────────

function installCLI(name, opts = {}) {
  const all = _getAllCLIs();
  const cli = all.find(c => c.name === name || c.display_name === name);

  if (!cli) {
    return { success: false, error: `在注册表中未找到 "${name}"。使用 app cli-search 搜索` };
  }

  const strategy = cli.install_strategy || cli.package_manager || 'pip';
  const installCmd = cli.install_cmd || null;

  try {
    switch (strategy) {
      case 'pip': {
        // Offline-first: if an imported bundle ships this CLI's agent-harness
        // locally, install from the filesystem and skip the GitHub remote.
        const bundleRoot = _getBundleRoot();
        const localHarness = bundleRoot
          ? path.join(bundleRoot, name, 'agent-harness')
          : null;
        let cmd;
        if (localHarness && fs.existsSync(path.join(localHarness, 'setup.py'))) {
          cmd = `pip install "${localHarness}"`;
        } else {
          cmd = installCmd || `pip install git+https://github.com/HKUDS/CLI-Anything.git#subdirectory=${name}/agent-harness`;
        }
        execSync(cmd, { stdio: 'inherit', timeout: 300000 });
        break;
      }
      case 'npm': {
        const pkg = cli.npm_package || `cli-anything-${name}`;
        execSync(`npm install -g ${pkg}`, { stdio: 'inherit', timeout: 120000 });
        break;
      }
      case 'uv': {
        const pkg = cli.uv_package || `cli-anything-${name}`;
        execSync(`uv tool install ${pkg}`, { stdio: 'inherit', timeout: 120000 });
        break;
      }
      case 'bundled': {
        const ep = cli.entry_point || `cli-anything-${name}`;
        if (!_which(ep)) {
          return { success: false, error: `${name} 是 bundled 类型，需要先安装主软件: ${cli.requires || name}` };
        }
        break;
      }
      case 'command': {
        if (installCmd) {
          execSync(installCmd, { stdio: 'inherit', timeout: 300000 });
        } else {
          return { success: false, error: `${name} 缺少 install_cmd 配置` };
        }
        break;
      }
      default:
        return { success: false, error: `不支持的安装策略: ${strategy}` };
    }

    discoverInstalled();
    return { success: true, name, strategy };
  } catch (err) {
    return { success: false, error: `安装 ${name} 失败: ${err.message}` };
  }
}

function uninstallCLI(name) {
  const installed = getInstalledCLIs();
  const cli = installed.find(c => c.name === name);

  if (!cli) {
    return { success: false, error: `${name} 未安装` };
  }

  try {
    if (cli._source === 'public') {
      try { execSync(`npm uninstall -g cli-anything-${name}`, { stdio: 'pipe', timeout: 30000 }); } catch { /* ok */ }
    }
    execSync(`pip uninstall -y cli-anything-${name}`, { stdio: 'pipe', timeout: 30000 });
    discoverInstalled();
    return { success: true, name };
  } catch (err) {
    return { success: false, error: `卸载 ${name} 失败: ${err.message}` };
  }
}

// ── SKILL.md Parsing ──────────────────────────────────────────────────────────

function parseSkillMD(content) {
  if (!content || typeof content !== 'string') return null;

  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!frontmatterMatch) return { meta: {}, body: content.trim() };

  const yamlRaw = frontmatterMatch[1];
  const body = frontmatterMatch[2].trim();
  const meta = {};

  for (const line of yamlRaw.split('\n')) {
    const m = line.match(/^(\w[\w_-]*):\s*(.+)$/);
    if (m) {
      let value = m[2].trim();
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
      } else if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (/^\d+$/.test(value)) value = parseInt(value, 10);
      meta[m[1]] = value;
    }
  }

  return { meta, body };
}

function convertToKHYSkill(parsed, cliName) {
  if (!parsed) return null;
  const meta = parsed.meta || {};
  const skillDir = path.join(os.homedir(), '.khy', 'skills', `cli-anything-${cliName}`);

  if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });

  const manifest = {
    name: `cli-anything-${cliName}`,
    description: meta.description || `CLI-Anything ${cliName} tool for AI agent control`,
    trigger: `cli-${cliName}`,
    user_invocable: true,
    tags: Array.isArray(meta.tags) ? meta.tags : ['cli-anything', cliName],
    aliases: [`cli${cliName}`, cliName],
    source: 'cli-anything',
  };

  const prompt = parsed.body || `You have access to the cli-anything-${cliName} command-line tool.\nUse it with --json flag for structured output.\nRun \`cli-anything-${cliName} --help\` to see available commands.`;

  fs.writeFileSync(path.join(skillDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(skillDir, 'prompt.md'), prompt);

  return { skillDir, manifest };
}

// ── Auto-Registration Bridge ──────────────────────────────────────────────────

function registerAllAsKHYTools() {
  const installed = discoverInstalled();
  const results = { tools: 0, skills: 0, apps: 0, errors: [] };

  for (const cli of installed) {
    try {
      // Register as KHY app
      try {
        const appRegistry = require('./appRegistry');
        appRegistry.register({
          name: `cli-anything-${cli.name}`,
          version: cli.version || '1.0.0',
          description: cli.description,
          entry: cli.entryPoint,
          runtime: 'external',
          source: 'cli-anything',
          commands: cli.commandGroups.map(g => `cli-${cli.name}-${g}`),
        });
        results.apps++;
      } catch (e) {
        results.errors.push(`app ${cli.name}: ${e.message}`);
      }

      // Convert SKILL.md to KHY skill
      if (cli.skillMd) {
        try {
          const skillPath = _findSkillMD(cli);
          if (skillPath) {
            const content = fs.readFileSync(skillPath, 'utf-8');
            const parsed = parseSkillMD(content);
            convertToKHYSkill(parsed, cli.name);
            results.skills++;
          }
        } catch (e) {
          results.errors.push(`skill ${cli.name}: ${e.message}`);
        }
      }

      // Dynamic tool registration
      try {
        const toolDef = _buildToolDef(cli);
        const tools = require('../tools');
        if (typeof tools.register === 'function') {
          tools.register(toolDef);
          results.tools++;
        }
      } catch (e) {
        results.errors.push(`tool ${cli.name}: ${e.message}`);
      }

    } catch (e) {
      results.errors.push(`${cli.name}: ${e.message}`);
    }
  }

  return results;
}

function _findSkillMD(cli) {
  // Search common locations for SKILL.md
  const candidates = [];

  // Python package location
  try {
    const pkgPath = execSync(
      `python3 -c "import cli_anything.${cli.name}; import os; print(os.path.dirname(cli_anything.${cli.name}.__file__))"`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    if (pkgPath) {
      candidates.push(path.join(pkgPath, 'skills', 'SKILL.md'));
    }
  } catch { /* ok */ }

  // Local clone
  candidates.push(
    path.join(CLI_ANYTHING_DIR, 'generated', cli.name, 'skills', 'SKILL.md'),
    path.join(os.homedir(), '.khy', 'skills', `cli-anything-${cli.name}`, 'SKILL.md'),
  );

  // Built-in vendored SKILL.md shipped with KHY (offline, zero-config)
  candidates.push(
    path.join(VENDORED_SKILLS, `cli-anything-${cli.name}`, 'SKILL.md'),
  );

  // Offline bundle (imported via importFromArchive)
  const bundleRoot = _getBundleRoot();
  if (bundleRoot) {
    candidates.push(
      path.join(bundleRoot, 'skills', `cli-anything-${cli.name}`, 'SKILL.md'),
      path.join(bundleRoot, cli.name, 'agent-harness', 'SKILL.md'),
    );
    // Fallback: first *.md inside the local agent-harness.
    try {
      const harnessDir = path.join(bundleRoot, cli.name, 'agent-harness');
      const md = fs.readdirSync(harnessDir).find(f => f.toLowerCase().endsWith('.md'));
      if (md) candidates.push(path.join(harnessDir, md));
    } catch { /* ok */ }
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function _buildToolDef(cli) {
  const { defineTool } = require('../tools/_baseTool');

  return defineTool({
    name: `khyanything__${cli.name}`,
    description: `${cli.displayName || cli.name}: ${cli.description || 'KHYanything tool'}. Available commands: ${cli.commandGroups.join(', ') || 'use --help'}`,
    category: 'execution',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: `Command to execute (one of: ${cli.commandGroups.join(', ') || 'see --help'})`,
        },
        args: {
          type: 'string',
          description: 'Additional arguments for the command',
        },
      },
      required: ['command'],
    },
    async execute({ command, args }) {
      const argList = [command];
      if (args) argList.push(...args.split(/\s+/).filter(Boolean));
      return invokeCommand(cli.name, argList);
    },
  });
}

module.exports = {
  fetchRegistry,
  importFromArchive,
  searchRegistry,
  getRegistryStats,
  discoverInstalled,
  getInstalledCLIs,
  invokeCommand,
  installCLI,
  uninstallCLI,
  parseSkillMD,
  convertToKHYSkill,
  registerAllAsKHYTools,
  CLI_ANYTHING_DIR,
};
