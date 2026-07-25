/**
 * CLI Handler: plugin development tools
 *
 * Provides a terminal-based plugin authoring experience:
 *   - khy plugin init     — scaffold a new plugin project
 *   - khy plugin dev      — watch mode with hot-reload
 *   - khy plugin doctor   — validate manifest & SDK compatibility
 *   - khy plugin list     — show all discovered plugins and their status
 *   - khy plugin link     — symlink local plugin into discovery path
 *   - khy plugin unlink   — remove symlink
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const { execSync, execFileSync, spawn } = require('child_process');
const chalk = require('chalk').default || require('chalk');
const readline = require('readline');
const { validateManifest } = require('@khy/plugin-sdk');
const { createMockContext } = require('@khy/plugin-sdk/testing');
const { getDataHome } = require('../../utils/dataHome');
const {
  printSuccess, printError, printWarn, printInfo, printTable, withSpinner,
  MASCOT_MINI,
} = require('../formatters');

const PLUGINS_DIR = path.join(getDataHome(), 'plugins');
const LEGACY_PLUGINS_DIR = path.join(os.homedir(), '.khy', 'plugins');
const SDK_VERSION = '1.0.0';

// ── Helpers ──────────────────────────────────────────────────────────────────

// 收敛到 utils/ensureDirSync 单一真源(逐字节委托,调用点不变)
const ensureDir = require('../../utils/ensureDirSync');

function ask(rl, question, defaultValue) {
  return new Promise(resolve => {
    const suffix = defaultValue ? ` (${defaultValue})` : '';
    rl.question(chalk.cyan(`  ${question}${suffix}: `), answer => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function askChoice(rl, question, choices) {
  return new Promise(resolve => {
    console.log(chalk.cyan(`  ${question}`));
    choices.forEach((c, i) => console.log(chalk.white(`    ${i + 1}) ${c}`)));
    rl.question(chalk.cyan('  > '), answer => {
      const idx = parseInt(answer, 10) - 1;
      resolve(choices[idx] || choices[0]);
    });
  });
}

// ── khy plugin init ──────────────────────────────────────────────────────────

async function handlePluginInit(args) {
  console.log('');
  console.log(chalk.bold.blue(`  ${MASCOT_MINI} KHY Plugin Scaffold`));
  console.log(chalk.gray('  ─────────────────────────────────────'));
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // Gather plugin metadata
    const namespace = await ask(rl, 'Plugin namespace (lowercase, ≤12 chars)', '');
    if (!namespace || !/^[a-z][a-z0-9]{0,11}$/.test(namespace)) {
      printError('Namespace must be 1-12 lowercase alphanumeric chars starting with a letter.');
      rl.close();
      return;
    }

    const displayName = await ask(rl, 'Display name (e.g., 量化交易)', namespace);
    const description = await ask(rl, 'Description', `KHY ${displayName} plugin`);
    const author = await ask(rl, 'Author', os.userInfo().username);

    const template = await askChoice(rl, 'Template:', [
      'full (backend + frontend)',
      'backend-only (CLI commands & tools)',
      'frontend-only (Vue views & components)',
    ]);

    const needsNetwork = await ask(rl, 'Needs network access? (y/N)', 'n');
    const needsDatabase = await ask(rl, 'Needs database access? (y/N)', 'n');

    rl.close();

    // Determine output directory
    const pkgName = `khy-${namespace}`;
    let targetDir;

    // If inside a workspace, create under packages/
    const workspaceRoot = findWorkspaceRoot();
    if (workspaceRoot) {
      targetDir = path.join(workspaceRoot, 'packages', pkgName);
    } else {
      targetDir = path.join(process.cwd(), pkgName);
    }

    if (fs.existsSync(targetDir)) {
      printError(`Directory already exists: ${targetDir}`);
      return;
    }

    console.log('');
    await generatePlugin({
      targetDir,
      pkgName,
      namespace,
      displayName,
      description,
      author,
      template,
      permissions: {
        network: needsNetwork.toLowerCase() === 'y',
        database: needsDatabase.toLowerCase() === 'y',
        spawn: false,
      },
    });

    console.log('');
    printSuccess(`Plugin scaffolded at: ${chalk.underline(targetDir)}`);
    console.log('');
    console.log(chalk.white('  Next steps:'));
    console.log(chalk.gray(`    cd ${path.relative(process.cwd(), targetDir)}`));
    if (template.includes('frontend')) {
      console.log(chalk.gray('    npm run dev:frontend    # Start frontend dev server'));
    }
    console.log(chalk.gray('    khy plugin doctor       # Validate your plugin'));
    console.log(chalk.gray('    khy plugin link .       # Link for local development'));
    console.log('');
  } catch (err) {
    rl.close();
    printError(`Scaffold failed: ${err.message}`);
  }
}

async function generatePlugin({ targetDir, pkgName, namespace, displayName, description, author, template, permissions }) {
  const includeBackend = template.includes('full') || template.includes('backend');
  const includeFrontend = template.includes('full') || template.includes('frontend');

  // Root dirs
  ensureDir(targetDir);
  if (includeBackend) ensureDir(path.join(targetDir, 'src', 'commands'));
  if (includeBackend) ensureDir(path.join(targetDir, 'src', 'tools'));
  if (includeFrontend) ensureDir(path.join(targetDir, 'frontend', 'views'));
  if (includeFrontend) ensureDir(path.join(targetDir, 'frontend', 'dev'));

  // ─── package.json ───
  const pkg = {
    name: pkgName,
    version: '0.1.0',
    description,
    author,
    main: includeBackend ? 'src/index.js' : undefined,
    scripts: {},
    khy: {
      displayName,
      engines: { khy: '>=1.0.0' },
      main: includeBackend ? './src/index.js' : undefined,
      namespace,
      permissions,
      sandbox: 'relaxed',
      autoActivate: true,
      contributions: {
        commands: includeBackend
          ? [{ name: `${namespace}.hello`, description: `${displayName} hello command` }]
          : [],
        tools: [],
        dataSources: [],
      },
    },
    peerDependencies: { '@khy/plugin-sdk': '^1.0.0' },
    dependencies: {},
  };

  if (includeFrontend) {
    pkg.scripts['dev:frontend'] = 'cd frontend && npx vite --config vite.config.js';
    pkg.scripts['build:frontend'] = 'cd frontend && npx vite build --config vite.config.js';
  }

  fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  // ─── Backend entry ───
  if (includeBackend) {
    fs.writeFileSync(path.join(targetDir, 'src', 'index.js'), `/**
 * ${displayName} Plugin Entry
 * @implements {import('@khy/plugin-sdk').KhyPlugin}
 */
module.exports = {
  manifest: require('../package.json').khy,

  async activate(ctx) {
    ctx.logger.info('${displayName} plugin activating...');

    // Register commands
    const helloCmd = require('./commands/hello');
    helloCmd(ctx);

    ctx.events.emit('${pkgName}:ready');
    ctx.logger.info('${displayName} plugin ready');
  },

  async deactivate() {
    // Cleanup resources here
  },
};
`);

    fs.writeFileSync(path.join(targetDir, 'src', 'commands', 'hello.js'), `/**
 * Example command: ${namespace}.hello
 */
module.exports = function registerHelloCommand(ctx) {
  ctx.commands.register({
    name: '${namespace}.hello',
    aliases: [],
    description: '${displayName} hello world',
    usage: '${namespace}.hello [name]',
    category: '${namespace}',
    async handler(args, cmdCtx) {
      const name = args.positional[0] || 'World';
      cmdCtx.print(\`Hello, \${name}! From ${displayName} plugin.\`);
      return { success: true };
    },
  });
};
`);
  }

  // ─── Frontend entry ───
  if (includeFrontend) {
    fs.writeFileSync(path.join(targetDir, 'frontend', 'index.js'), `/**
 * ${displayName} Frontend Plugin
 */
export default {
  namespace: '${namespace}',
  displayName: '${displayName}',
  icon: 'Box',

  install(ctx) {
    // Register routes
    ctx.router.addRoute('Layout', {
      path: '${namespace}',
      name: '${namespace.charAt(0).toUpperCase() + namespace.slice(1)}Home',
      component: () => import('./views/Home.vue'),
    });

    // Register menu items
    ctx.addMenuItems([
      { path: '/${namespace}', label: '${displayName}', icon: 'Box', order: 50 },
    ]);
  },
};
`);

    fs.writeFileSync(path.join(targetDir, 'frontend', 'views', 'Home.vue'), `<template>
  <div class="${namespace}-home">
    <h1>${displayName}</h1>
    <p>Plugin ${pkgName} is running.</p>
  </div>
</template>

<script setup>
// Plugin home view
</script>

<style scoped>
.${namespace}-home {
  padding: 24px;
}
</style>
`);

    // Vite config for standalone dev
    fs.writeFileSync(path.join(targetDir, 'frontend', 'vite.config.js'), `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

export default defineConfig({
  plugins: [vue()],
  root: '.',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      '@host': path.resolve(__dirname, '../../../frontend/src'),
    },
  },
  server: {
    port: ${8080 + Math.floor(Math.random() * 20)},
    proxy: {
      '/api': { target: 'http://localhost:' + (process.env.PORT || '3000'), changeOrigin: true },
    },
  },
})
`);

    // Dev harness
    fs.writeFileSync(path.join(targetDir, 'frontend', 'index.html'), `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${displayName} - Dev Mode</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="./dev/main.js"></script>
</body>
</html>
`);

    fs.writeFileSync(path.join(targetDir, 'frontend', 'dev', 'main.js'), `/**
 * Dev harness — standalone development without the host app.
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import plugin from '../index.js'

const app = createApp({ template: '<router-view />' })
const pinia = createPinia()
const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', name: 'Layout', component: { template: '<router-view />' }, children: [] }],
})

app.use(pinia)
app.use(router)
app.use(ElementPlus)

// Mock host context
plugin.install({
  router,
  pinia,
  addMenuItems(items) { console.log('[Dev] Menus:', items) },
  addAdminTabs() {},
  host: { apiBaseUrl: 'http://localhost:' + (process.env.PORT || '3000'), websocket: {}, user: {}, request: null },
  provide(k, v) { app.provide(k, v) },
})

app.mount('#app')
`);
  }

  // ─── .gitignore ───
  fs.writeFileSync(path.join(targetDir, '.gitignore'), `node_modules/
dist/
.DS_Store
`);
}

// ── khy plugin dev ───────────────────────────────────────────────────────────

async function handlePluginDev(args) {
  const pluginDir = args[0] ? path.resolve(args[0]) : process.cwd();
  const pkgPath = path.join(pluginDir, 'package.json');

  if (!fs.existsSync(pkgPath)) {
    printError(`No package.json found in ${pluginDir}`);
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  if (!pkg.khy) {
    printError('Not a KHY plugin (missing "khy" field in package.json)');
    return;
  }

  const namespace = pkg.khy.namespace;
  const frontendDir = path.join(pluginDir, 'frontend');
  const hasFrontend = fs.existsSync(path.join(frontendDir, 'vite.config.js'));
  const hasBackend = pkg.khy.main && fs.existsSync(path.join(pluginDir, pkg.khy.main));

  console.log('');
  console.log(chalk.bold.blue(`  ${MASCOT_MINI} Plugin Dev Mode: ${chalk.white(pkg.khy.displayName || namespace)}`));
  console.log(chalk.gray('  ─────────────────────────────────────'));

  if (hasFrontend) {
    printInfo('Starting frontend dev server...');
    // win32: npx is an npx.cmd shim — run it via cmd.exe explicitly rather than
    // shell:true. Passing an args array with shell:true triggers Node DEP0190 and
    // leaks the deprecation warning into the terminal; this form is equivalent
    // without the warning. POSIX spawns npx directly (it's on PATH).
    const isWin = process.platform === 'win32';
    const viteProcess = spawn(
      isWin ? (process.env.COMSPEC || 'cmd.exe') : 'npx',
      isWin
        ? ['/d', '/s', '/c', 'npx', 'vite', '--config', 'vite.config.js']
        : ['vite', '--config', 'vite.config.js'],
      { cwd: frontendDir, stdio: 'inherit', windowsHide: true },
    );

    viteProcess.on('error', err => {
      printError(`Frontend dev server failed: ${err.message}`);
    });

    // Handle exit
    const { safeKill } = require('../../tools/platformUtils');
    process.on('SIGINT', () => {
      safeKill(viteProcess);
      process.exit(0);
    });
  } else if (hasBackend) {
    printInfo('Backend-only plugin — use `khy` CLI to test commands.');
    printInfo(`After changes, run: khy plugin reload ${namespace}`);

    // Watch for file changes and auto-reload
    const entryFile = path.resolve(pluginDir, pkg.khy.main);
    printInfo(`Watching ${path.relative(process.cwd(), pluginDir)}/ for changes...`);

    let debounce = null;
    const watcher = fs.watch(path.join(pluginDir, 'src'), { recursive: true }, (event, filename) => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        console.log(chalk.yellow(`  ↻ File changed: ${filename} — clearing module cache`));
        // Clear require cache for the plugin
        Object.keys(require.cache)
          .filter(k => k.startsWith(pluginDir))
          .forEach(k => delete require.cache[k]);
        console.log(chalk.green('  ✓ Plugin module cache cleared. Changes will take effect on next command.'));
      }, 300);
    });

    process.on('SIGINT', () => {
      watcher.close();
      process.exit(0);
    });

    // Keep process alive
    printInfo('Press Ctrl+C to stop watching.');
    await new Promise(() => {}); // infinite wait
  } else {
    printError('No frontend/vite.config.js or backend entry found to dev.');
  }
}

// ── khy plugin doctor ────────────────────────────────────────────────────────

function parseDoctorOptions(args = []) {
  const flags = new Set();
  const positional = [];
  for (const raw of args) {
    const token = String(raw || '').trim();
    if (!token) continue;
    if (token.startsWith('-')) flags.add(token.toLowerCase());
    else positional.push(token);
  }

  const all = flags.has('--all') || positional[0] === 'all';
  const deep = flags.has('--deep');
  const strict = flags.has('--strict');
  const json = flags.has('--json');
  const target = all ? positional[1] : positional[0];

  return { all, deep, strict, json, target, flags, positional };
}

function addIssue(list, message) {
  list.push(String(message));
}

function collectJsFiles(rootDir, maxFiles = 1200) {
  const files = [];
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'coverage', '.next', '.nuxt', 'build']);
  const allowedExt = new Set(['.js', '.cjs', '.mjs']);

  function walk(dir) {
    if (files.length >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (allowedExt.has(ext)) files.push(abs);
      }
    }
  }

  if (fs.existsSync(rootDir)) walk(rootDir);
  return files;
}

function checkSyntax(filePath) {
  try {
    execFileSync(process.execPath, ['--check', filePath], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 12000,
    });
    return null;
  } catch (err) {
    const stderr = String(err?.stderr || '').trim();
    const stdout = String(err?.stdout || '').trim();
    const raw = stderr || stdout || String(err?.message || 'syntax check failed');
    return raw.split('\n').slice(0, 2).join(' ').trim();
  }
}

function extractModuleSpecifiers(sourceText) {
  const specs = new Set();
  const patterns = [
    /require\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /\bimport\s+[^'"`\n]*\s+from\s*['"`]([^'"`]+)['"`]/g,
    /\bimport\s*['"`]([^'"`]+)['"`]/g,
    /\bimport\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(sourceText)) !== null) {
      if (m[1]) specs.add(m[1]);
    }
  }
  return [...specs];
}

const BUILTIN_MODULES = new Set(
  Module.builtinModules.map(m => m.replace(/^node:/, ''))
);

function resolveModuleFromFile(specifier, fromFile, pluginDir) {
  const spec = String(specifier || '').trim();
  if (!spec) return { ok: true };

  const builtInName = spec.replace(/^node:/, '');
  if (BUILTIN_MODULES.has(builtInName)) return { ok: true };

  try {
    if (spec.startsWith('.') || spec.startsWith('/')) {
      require.resolve(path.resolve(path.dirname(fromFile), spec));
      return { ok: true };
    }
    require.resolve(spec, { paths: [path.dirname(fromFile), pluginDir] });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err?.message || `Cannot resolve "${spec}"` };
  }
}

function findWorkspacePluginDirs() {
  const found = [];
  const wsRoot = findWorkspaceRoot();
  if (!wsRoot) return found;
  const packagesDir = path.join(wsRoot, 'packages');
  if (!fs.existsSync(packagesDir)) return found;

  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('khy-')) continue;
    const pluginDir = path.join(packagesDir, entry.name);
    const pkgFile = path.join(pluginDir, 'package.json');
    if (!fs.existsSync(pkgFile)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf-8'));
      if (pkg && pkg.khy) found.push(pluginDir);
    } catch { /* ignore malformed package */ }
  }
  return found;
}

function findUserPluginDirs() {
  const dirs = [];
  for (const base of [PLUGINS_DIR, LEGACY_PLUGINS_DIR]) {
    if (!fs.existsSync(base)) continue;
    try {
      const entries = fs.readdirSync(base, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        dirs.push(path.join(base, entry.name));
      }
    } catch { /* ignore unreadable dirs */ }
  }
  return dirs;
}

function findDiscoveredPluginDirs() {
  try {
    const pluginLoader = require('../../plugin-loader');
    const nullLogger = { info() {}, warn() {}, error() {} };
    const candidates = pluginLoader.discoverPlugins(nullLogger);
    return candidates.map(c => c.pluginPath).filter(Boolean);
  } catch {
    return [];
  }
}

function dedupePaths(paths) {
  const unique = new Set();
  const out = [];
  for (const p of paths) {
    try {
      const real = fs.realpathSync(p);
      if (!unique.has(real)) {
        unique.add(real);
        out.push(real);
      }
    } catch {
      const abs = path.resolve(p);
      if (!unique.has(abs)) {
        unique.add(abs);
        out.push(abs);
      }
    }
  }
  return out;
}

function resolveDoctorTargets(options) {
  if (!options.all) {
    return [path.resolve(options.target || process.cwd())];
  }
  const all = [
    ...findDiscoveredPluginDirs(),
    ...findWorkspacePluginDirs(),
    ...findUserPluginDirs(),
  ];
  return dedupePaths(all);
}

function clearModuleCacheUnder(rootDir) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(rootDir)) delete require.cache[key];
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || 'operation timeout')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function buildDummyObjectFromSchema(schema) {
  if (!schema || typeof schema !== 'object') return {};
  const obj = {};
  const props = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    const def = props[key] || {};
    const type = def.type;
    if (type === 'string') obj[key] = 'test';
    else if (type === 'number' || type === 'integer') obj[key] = 0;
    else if (type === 'boolean') obj[key] = false;
    else if (type === 'array') obj[key] = [];
    else if (type === 'object') obj[key] = {};
    else obj[key] = null;
  }
  return obj;
}

async function runPluginDoctorForDir(pluginDir, options = {}) {
  const report = {
    pluginDir,
    pkgName: '',
    namespace: '',
    displayName: '',
    errors: [],
    warnings: [],
    infos: [],
  };

  const pkgPath = path.join(pluginDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    addIssue(report.errors, `未找到 package.json: ${pkgPath}`);
    return report;
  }

  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } catch (err) {
    addIssue(report.errors, `package.json 解析失败: ${err.message}`);
    return report;
  }

  report.pkgName = pkg.name || '';
  const manifest = { name: pkg.name, version: pkg.version, ...(pkg.khy || {}) };
  report.namespace = manifest.namespace || '';
  report.displayName = manifest.displayName || manifest.namespace || pkg.name || path.basename(pluginDir);

  if (!pkg.khy) {
    addIssue(report.errors, '缺少 package.json.khy 字段');
    return report;
  }

  const manifestCheck = validateManifest(manifest);
  if (!manifestCheck.valid) {
    for (const err of manifestCheck.errors) addIssue(report.errors, `Manifest 校验失败: ${err}`);
  } else {
    addIssue(report.infos, `Manifest 校验通过 (${manifest.name}@${manifest.version})`);
  }

  if (!String(pkg.name || '').startsWith('khy-')) {
    addIssue(report.warnings, `包名建议以 khy- 开头（当前: ${pkg.name || '(empty)'})`);
  }

  if (pkg.peerDependencies && pkg.peerDependencies['@khy/plugin-sdk']) {
    addIssue(report.infos, `SDK Peer 依赖: ${pkg.peerDependencies['@khy/plugin-sdk']}`);
  } else {
    addIssue(report.warnings, '未声明 @khy/plugin-sdk peerDependencies');
  }

  const normRel = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (pkg.main && manifest.main && normRel(pkg.main) !== normRel(manifest.main)) {
    addIssue(report.warnings, `package.json.main (${pkg.main}) 与 khy.main (${manifest.main}) 不一致`);
  }

  const entryRel = manifest.main || pkg.main;
  const entryPath = entryRel ? path.resolve(pluginDir, entryRel) : null;
  if (!entryPath) {
    addIssue(report.errors, '缺少入口文件定义（khy.main 或 package.json.main）');
    return report;
  }
  if (!fs.existsSync(entryPath)) {
    addIssue(report.errors, `入口文件不存在: ${entryRel}`);
    return report;
  }
  addIssue(report.infos, `入口文件: ${entryRel}`);

  // Static syntax + dependency checks
  const fastMode = options.fast === true;
  const sourceRoots = new Set([path.dirname(entryPath), path.join(pluginDir, 'src')]);
  const files = fastMode
    ? [entryPath]
    : dedupePaths([...sourceRoots].flatMap(d => collectJsFiles(d)));
  if (!files.includes(entryPath)) files.push(entryPath);
  addIssue(report.infos, `扫描 JS 文件: ${files.length}`);

  for (const filePath of files) {
    const rel = path.relative(pluginDir, filePath) || path.basename(filePath);
    const syntaxError = checkSyntax(filePath);
    if (syntaxError) {
      addIssue(report.errors, `语法错误 ${rel}: ${syntaxError}`);
      continue;
    }

    let code = '';
    try {
      code = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      addIssue(report.errors, `读取失败 ${rel}: ${err.message}`);
      continue;
    }

    const specs = extractModuleSpecifiers(code);
    for (const spec of specs) {
      const resolved = resolveModuleFromFile(spec, filePath, pluginDir);
      if (!resolved.ok) {
        addIssue(report.errors, `依赖解析失败 ${rel}: "${spec}" (${resolved.message})`);
      }
    }

    if (code.includes('ctx.http.fetch') && !(manifest.permissions && manifest.permissions.network === true)) {
      addIssue(report.warnings, `权限风险 ${rel}: 使用 ctx.http.fetch 但未声明 permissions.network=true`);
    }
    if (code.includes('ctx.spawn') && !(manifest.permissions && manifest.permissions.spawn === true)) {
      addIssue(report.warnings, `权限风险 ${rel}: 使用 ctx.spawn 但未声明 permissions.spawn=true`);
    }
    if (code.includes('ctx.database') && !(manifest.permissions && manifest.permissions.database === true)) {
      addIssue(report.warnings, `权限风险 ${rel}: 使用 ctx.database 但未声明 permissions.database=true`);
    }
  }

  // Activation smoke test
  let pluginInstance = null;
  try {
    clearModuleCacheUnder(pluginDir);
    const mod = require(entryPath);
    pluginInstance = mod && (mod.default || mod);
  } catch (err) {
    addIssue(report.errors, `入口加载失败: ${err.message}`);
    return report;
  }

  if (!pluginInstance || typeof pluginInstance.activate !== 'function') {
    addIssue(report.errors, '插件未导出 activate(ctx) 函数');
    return report;
  }

  const mockCtx = createMockContext({
    host: { version: '1.0.0', capabilities: ['commands', 'tools', 'storage', 'events', 'ai'] },
    database: {
      async query() { return []; },
      getModel() { return null; },
    },
  });

  try {
    await withTimeout(
      Promise.resolve(pluginInstance.activate(mockCtx)),
      5000,
      'activate() 超时 (>5s)'
    );
    addIssue(report.infos, 'activate() 冒烟测试通过');
  } catch (err) {
    addIssue(report.errors, `activate() 失败: ${err.message}`);
  }

  const declaredCommands = (manifest.contributions && manifest.contributions.commands) || [];
  const declaredTools = (manifest.contributions && manifest.contributions.tools) || [];
  const declaredDataSources = (manifest.contributions && manifest.contributions.dataSources) || [];

  const registeredCommands = (mockCtx.commands && mockCtx.commands._registered) || [];
  const registeredTools = (mockCtx.tools && mockCtx.tools._registered) || [];
  const registeredDataSources = (mockCtx.dataSources && mockCtx.dataSources._registered) || [];

  addIssue(report.infos, `命令声明/注册: ${declaredCommands.length}/${registeredCommands.length}`);
  addIssue(report.infos, `工具声明/注册: ${declaredTools.length}/${registeredTools.length}`);
  addIssue(report.infos, `数据源声明/注册: ${declaredDataSources.length}/${registeredDataSources.length}`);

  const declaredCommandNames = new Set(declaredCommands.map(c => c && c.name).filter(Boolean));
  const registeredCommandNames = new Set(registeredCommands.map(c => c && c.name).filter(Boolean));
  const declaredToolNames = new Set(declaredTools.map(t => t && t.name).filter(Boolean));
  const registeredToolNames = new Set(registeredTools.map(t => t && t.name).filter(Boolean));

  for (const name of declaredCommandNames) {
    if (!registeredCommandNames.has(name)) {
      addIssue(report.errors, `命令未注册: contributions.commands 声明了 "${name}"，但 activate() 未注册`);
    }
  }
  for (const name of declaredToolNames) {
    if (!registeredToolNames.has(name)) {
      addIssue(report.errors, `工具未注册: contributions.tools 声明了 "${name}"，但 activate() 未注册`);
    }
  }

  for (const cmd of registeredCommands) {
    if (!cmd || typeof cmd !== 'object') {
      addIssue(report.errors, '注册了非法命令对象（非 object）');
      continue;
    }
    if (!cmd.name || typeof cmd.name !== 'string') {
      addIssue(report.errors, '命令缺少 name');
    }
    if (typeof cmd.handler !== 'function') {
      addIssue(report.errors, `命令 ${cmd.name || '(unknown)'} 缺少 handler()`);
    }
  }

  for (const tool of registeredTools) {
    if (!tool || typeof tool !== 'object') {
      addIssue(report.errors, '注册了非法工具对象（非 object）');
      continue;
    }
    if (!tool.name || typeof tool.name !== 'string') {
      addIssue(report.errors, '工具缺少 name');
    }
    if (typeof tool.execute !== 'function') {
      addIssue(report.errors, `工具 ${tool.name || '(unknown)'} 缺少 execute()`);
    }
  }

  if (options.deep) {
    const cmdCtx = {
      print() {},
      printStyled() {},
      async prompt() { return ''; },
      spinner() { return { stop() {}, succeed() {}, fail() {} }; },
      cwd: pluginDir,
    };

    for (const cmd of registeredCommands) {
      if (!cmd || typeof cmd.handler !== 'function') continue;
      try {
        await withTimeout(
          Promise.resolve(cmd.handler({ raw: cmd.name, positional: ['test'], flags: { dryRun: true } }, cmdCtx)),
          1500,
          `命令 ${cmd.name} 运行超时`
        );
      } catch (err) {
        addIssue(report.warnings, `命令运行异常 ${cmd.name}: ${err.message}`);
      }
    }

    const toolCtx = {
      identity: { userId: 'doctor', username: 'doctor', role: 'admin' },
      logger: mockCtx.logger,
      signal: undefined,
    };
    for (const tool of registeredTools) {
      if (!tool || typeof tool.execute !== 'function') continue;
      try {
        const input = buildDummyObjectFromSchema(tool.parameters);
        await withTimeout(
          Promise.resolve(tool.execute(input, toolCtx)),
          1500,
          `工具 ${tool.name} 运行超时`
        );
      } catch (err) {
        addIssue(report.warnings, `工具运行异常 ${tool.name}: ${err.message}`);
      }
    }
  }

  if (pluginInstance && typeof pluginInstance.deactivate === 'function') {
    try {
      await withTimeout(Promise.resolve(pluginInstance.deactivate()), 2000, 'deactivate() 超时');
    } catch (err) {
      addIssue(report.warnings, `deactivate() 异常: ${err.message}`);
    }
  }

  return report;
}

function printDoctorReport(report) {
  const title = `${report.displayName || report.namespace || path.basename(report.pluginDir)}`;
  console.log(chalk.cyan(`  插件: ${chalk.white(title)}`));
  console.log(chalk.dim(`  路径: ${report.pluginDir}`));

  for (const line of report.infos) {
    console.log(chalk.gray(`    ℹ ${line}`));
  }
  for (const line of report.warnings) {
    console.log(chalk.yellow(`    ⚠ ${line}`));
  }
  for (const line of report.errors) {
    console.log(chalk.red(`    ✗ ${line}`));
  }

  const resultText = `errors=${report.errors.length}, warnings=${report.warnings.length}`;
  if (report.errors.length === 0) {
    if (report.warnings.length === 0) printSuccess(`检查通过 (${resultText})`);
    else printWarn(`检查完成 (${resultText})`);
  } else {
    printError(`检查失败 (${resultText})`);
  }
  console.log('');
}

function buildDoctorSummary(reports, options) {
  const pluginCount = reports.length;
  const totalErrors = reports.reduce((sum, r) => sum + r.errors.length, 0);
  const totalWarnings = reports.reduce((sum, r) => sum + r.warnings.length, 0);
  const passed = reports.filter(r => r.errors.length === 0).length;
  const failed = pluginCount - passed;
  const shouldFail = totalErrors > 0 || (options.strict && totalWarnings > 0);
  return {
    pluginCount,
    passed,
    failed,
    totalErrors,
    totalWarnings,
    shouldFail,
  };
}

async function handlePluginDoctor(args) {
  const options = parseDoctorOptions(args);

  if (!options.json) {
    console.log('');
    console.log(chalk.bold.blue(`  ${MASCOT_MINI} Plugin Doctor`));
    console.log(chalk.gray('  ─────────────────────────────────────'));
    console.log('');
  }

  const targets = resolveDoctorTargets(options);
  if (targets.length === 0) {
    if (options.json) {
      const payload = {
        mode: 'plugin-doctor',
        generatedAt: new Date().toISOString(),
        options: { all: options.all, deep: options.deep, strict: options.strict, json: true },
        targets: [],
        reports: [],
        summary: { pluginCount: 0, passed: 0, failed: 0, totalErrors: 0, totalWarnings: 0, shouldFail: false },
      };
      console.log(JSON.stringify(payload, null, 2));
      process.exitCode = 0;
      return;
    }
    printWarn('未发现可检查的插件目录');
    printInfo('可使用: plugin doctor <dir> 或 plugin doctor --all');
    console.log('');
    return;
  }

  const reports = [];

  for (const pluginDir of targets) {
    const report = await runPluginDoctorForDir(pluginDir, options);
    reports.push(report);
    if (!options.json) {
      printDoctorReport(report);
    }
  }

  const summary = buildDoctorSummary(reports, options);
  if (options.json) {
    const payload = {
      mode: 'plugin-doctor',
      generatedAt: new Date().toISOString(),
      options: { all: options.all, deep: options.deep, strict: options.strict, json: true },
      targets,
      reports: reports.map(r => ({
        pluginDir: r.pluginDir,
        pkgName: r.pkgName,
        namespace: r.namespace,
        displayName: r.displayName,
        errors: r.errors,
        warnings: r.warnings,
        infos: r.infos,
      })),
      summary,
    };
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = summary.shouldFail ? 1 : 0;
    return;
  }

  console.log(chalk.white(`  汇总: ${summary.pluginCount} 个插件, ${summary.passed} 通过, ${summary.failed} 失败, ${summary.totalErrors} error(s), ${summary.totalWarnings} warning(s)`));
  if (options.strict && summary.totalWarnings > 0) {
    printWarn('严格模式已启用：warnings 也应视为阻断项');
  }
  if (options.deep) {
    printInfo('已启用深度模式：执行了命令/工具的轻量运行检测');
  }
  if (summary.shouldFail) {
    printError('质检未通过（已设置非零退出码）');
  }
  console.log('');
  process.exitCode = summary.shouldFail ? 1 : 0;
}

// ── khy plugin list ──────────────────────────────────────────────────────────

async function handlePluginList() {
  console.log('');
  console.log(chalk.bold.blue(`  ${MASCOT_MINI} Installed Plugins`));
  console.log(chalk.gray('  ─────────────────────────────────────'));
  console.log('');

  let entries = [];

  // Prefer runtime-loaded plugins; fallback to discovery scan
  try {
    const pluginLoader = require('../../plugin-loader');
    const loaded = pluginLoader.getAllPlugins();
    if (loaded.length > 0) {
      entries = loaded.map(p => ({
        name: p.manifest?.name || p.namespace,
        namespace: p.namespace,
        displayName: p.manifest?.displayName || p.namespace,
        version: p.manifest?.version || '-',
        runtimeState: p.state,
        pluginDir: p.path,
      }));
    } else {
      const discovered = pluginLoader.discoverPlugins({ info() {}, warn() {}, error() {} });
      entries = discovered.map(c => ({
        name: c.manifestData?.name || path.basename(c.pluginPath),
        namespace: c.manifestData?.namespace || '',
        displayName: c.manifestData?.displayName || c.manifestData?.name || path.basename(c.pluginPath),
        version: c.manifestData?.version || '-',
        runtimeState: 'discovered',
        pluginDir: c.pluginPath,
      }));
    }
  } catch {
    // Ignore and use filesystem fallback
  }

  if (entries.length === 0) {
    const fallbackDirs = dedupePaths([
      ...findWorkspacePluginDirs(),
      ...findUserPluginDirs(),
    ]);
    entries = fallbackDirs.map(dir => {
      const pkgFile = path.join(dir, 'package.json');
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf-8'));
        return {
          name: pkg.name || path.basename(dir),
          namespace: pkg.khy?.namespace || '',
          displayName: pkg.khy?.displayName || pkg.name || path.basename(dir),
          version: pkg.version || '-',
          runtimeState: 'not-loaded',
          pluginDir: dir,
        };
      } catch {
        return {
          name: path.basename(dir),
          namespace: '',
          displayName: path.basename(dir),
          version: '-',
          runtimeState: 'unknown',
          pluginDir: dir,
        };
      }
    });
  }

  if (entries.length === 0) {
    printInfo('No plugins found.');
    printInfo('Plugin scan paths:');
    console.log(chalk.gray(`    1. packages/khy-* (workspace)`));
    console.log(chalk.gray(`    2. ${PLUGINS_DIR} (user plugins)`));
    console.log(chalk.gray(`    3. ${LEGACY_PLUGINS_DIR} (legacy user plugins)`));
    console.log(chalk.gray('    4. KHY_PLUGINS env variable'));
    console.log('');
    return;
  }

  const rows = [];
  for (const p of entries) {
    const report = await runPluginDoctorForDir(p.pluginDir, { deep: false, strict: false, fast: false });
    const quality = report.errors.length > 0
      ? chalk.red('bad')
      : chalk.green('health');
    const runtime = p.runtimeState === 'active'
      ? chalk.green('● active')
      : p.runtimeState === 'disabled:error'
        ? chalk.red('✕ error')
        : chalk.yellow(`○ ${p.runtimeState}`);

    rows.push([
      p.displayName || p.name || '-',
      p.namespace || '-',
      p.version || '-',
      runtime,
      quality,
      String(report.warnings.length),
    ]);
  }

  printTable(
    ['插件', 'Namespace', 'Version', 'Runtime', 'Quality', 'Warnings'],
    rows
  );
  console.log('');
}

// ── khy plugin link ──────────────────────────────────────────────────────────

async function handlePluginLink(args) {
  const pluginDir = args[0] ? path.resolve(args[0]) : process.cwd();
  const pkgPath = path.join(pluginDir, 'package.json');

  if (!fs.existsSync(pkgPath)) {
    printError('No package.json found in target directory.');
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  if (!pkg.khy || !pkg.khy.namespace) {
    printError('Not a valid KHY plugin (missing khy.namespace).');
    return;
  }

  ensureDir(PLUGINS_DIR);
  const linkPath = path.join(PLUGINS_DIR, pkg.name || `khy-${pkg.khy.namespace}`);

  if (fs.existsSync(linkPath)) {
    printWarn(`Link already exists: ${linkPath}`);
    return;
  }

  const { safeMklink } = require('../../tools/platformUtils');
  safeMklink(pluginDir, linkPath);
  printSuccess(`Linked: ${linkPath} → ${pluginDir}`);
  printInfo('Plugin will be discovered on next khy startup.');
}

// ── khy plugin unlink ────────────────────────────────────────────────────────

async function handlePluginUnlink(args) {
  const name = args[0];
  if (!name) {
    printError('Usage: khy plugin unlink <plugin-name>');
    return;
  }

  const linkPath = path.join(PLUGINS_DIR, name.startsWith('khy-') ? name : `khy-${name}`);
  if (!fs.existsSync(linkPath)) {
    printError(`No linked plugin found: ${linkPath}`);
    return;
  }

  const stat = fs.lstatSync(linkPath);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(linkPath);
    printSuccess(`Unlinked: ${linkPath}`);
  } else {
    printError(`${linkPath} is not a symlink. Remove manually if needed.`);
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

function findWorkspaceRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const pkgFile = path.join(dir, 'package.json');
    if (fs.existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf-8'));
        if (pkg.workspaces) return dir;
      } catch { /* ignore */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ── Main router ──────────────────────────────────────────────────────────────

async function handlePlugin(args) {
  const subcommand = (args[0] || '').toLowerCase();
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'init':
    case 'create':
    case 'new':
      return handlePluginInit(subArgs);

    case 'dev':
    case 'develop':
      return handlePluginDev(subArgs);

    case 'doctor':
    case 'check':
    case 'validate':
      return handlePluginDoctor(subArgs);

    case 'list':
    case 'ls':
      return handlePluginList();

    case 'link':
      return handlePluginLink(subArgs);

    case 'unlink':
      return handlePluginUnlink(subArgs);

    default:
      printPluginHelp();
  }
}

function printPluginHelp() {
  console.log('');
  console.log(chalk.bold.blue(`  ${MASCOT_MINI} KHY Plugin Development Tools`));
  console.log(chalk.gray('  ─────────────────────────────────────'));
  console.log('');
  console.log(chalk.white('  Commands:'));
  console.log('');
  console.log(`    ${chalk.cyan('plugin init')}          Scaffold a new plugin project`);
  console.log(`    ${chalk.cyan('plugin dev [dir]')}     Start dev mode (watch + HMR)`);
  console.log(`    ${chalk.cyan('plugin doctor [dir]')}  质检插件（结构 + 逻辑 + 激活冒烟）`);
  console.log(`    ${chalk.cyan('plugin doctor --all')}  扫描全部已发现插件`);
  console.log(`    ${chalk.cyan('plugin doctor --deep')} 执行命令/工具轻量运行检测`);
  console.log(`    ${chalk.cyan('plugin doctor --json')} 输出机器可读 JSON（适合集成 CI）`);
  console.log(`    ${chalk.cyan('plugin doctor --strict')} warnings 也视为失败（退出码非 0）`);
  console.log(`    ${chalk.cyan('plugin list')}          列出插件并显示质量状态(health/bad)`);
  console.log(`    ${chalk.cyan('plugin link [dir]')}    Symlink a local plugin for development`);
  console.log(`    ${chalk.cyan('plugin unlink <name>')} Remove a development symlink`);
  console.log('');
  console.log(chalk.gray('  Examples:'));
  console.log(chalk.gray('    khy plugin init                 # Interactive scaffold'));
  console.log(chalk.gray('    khy plugin dev .                # Dev current directory'));
  console.log(chalk.gray('    khy plugin doctor ./my-plugin   # 质检单个插件'));
  console.log(chalk.gray('    khy plugin doctor --all         # 质检全部插件'));
  console.log(chalk.gray('    khy plugin doctor --all --json  # 输出 JSON 到 CI'));
  console.log(chalk.gray('    khy plugin link ./my-plugin     # Link for local dev'));
  console.log('');
  console.log(chalk.gray('  Official plugins:'));
  console.log(chalk.gray('    khyquant     — 量化交易 (backtest, trading, data)'));
  console.log(chalk.gray('    khy-hello    — Reference hello-world plugin'));
  console.log('');
}

module.exports = {
  handlePlugin,
  runPluginDoctorForDir,
};

// Self-register the plugin-doctor runner on the neutral port so baseSelfCheck
// resolves it without a reverse require (DESIGN-ARCH-021, Batch 2). Legit
// cli → services direction; exports unchanged.
try {
  require('../../services/pluginDoctorPort').registerPluginDoctor(runPluginDoctorForDir);
} catch { /* port unavailable — doctor sub-check degrades to skipped */ }
