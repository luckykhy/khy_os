'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const INSTALLED_FILE = path.join(ROOT, 'installed.json');
const MANIFEST_FILE = path.join(ROOT, 'khy.extension.json');
const SUPPORTED_INJECT = new Set(['tools', 'core/tools', 'logger', 'core/logger']);
const UNSUPPORTED_INJECT = new Set([
  'session', 'core/session', 'agent', 'core/agent', 'system-prompt', 'core/system-prompt',
  'llm', 'core/llm', 'shell', 'core/shell', 'terminals', 'core/terminals',
]);

function fail(message) {
  throw new Error(`[khy dsh import] ${message}`);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function resolvePackage(specifier) {
  try {
    return require.resolve(specifier, { paths: [process.cwd(), ROOT] });
  } catch {
    const candidate = path.resolve(process.cwd(), specifier);
    if (fs.existsSync(candidate)) return candidate;
    fail(`找不到插件包: ${specifier}`);
  }
}

function packageRoot(entry) {
  let current = path.dirname(entry);
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    current = path.dirname(current);
  }
  return path.dirname(entry);
}

function scanSource(source, packageJson) {
  const text = source.join('\n');
  if (/(?:@anthropic-ai|@deepseek-ai[\/]dsh-llm|(?:^|[^a-z])openai|ollama)/i.test(text)
      || /process\.env\.[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET)/.test(text)) {
    fail('插件自行读取模型密钥或 LLM SDK；模型访问必须由 khy-os 提供');
  }
  if (/\b(?:fetch|axios|https?\.request|WebSocket)\s*[(.]/.test(text)) {
    fail('插件包含直接网络访问；导入准入只允许工具与日志服务');
  }
  const inject = []
    .concat(Array.isArray(packageJson.inject) ? packageJson.inject : [])
    .concat(Array.isArray(packageJson.dsh && packageJson.dsh.inject) ? packageJson.dsh.inject : []);
  for (const key of inject) {
    if (UNSUPPORTED_INJECT.has(key) || !SUPPORTED_INJECT.has(key)) {
      fail(`插件依赖未支持的 Cordis 服务: ${key}`);
    }
  }
}

function collectContext() {
  const tools = [];
  return {
    tools: { register(tool) { if (tool && typeof tool === 'object') tools.push(tool); return { dispose() {} }; } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    _tools: tools,
  };
}

function schemaIsObject(schema) {
  return schema && schema.type === 'object' && schema.properties && typeof schema.properties === 'object'
    && (!schema.required || Array.isArray(schema.required));
}

function buildEntry(entry, packageRootPath, id) {
  const source = fs.readFileSync(entry, 'utf8');
  const packageJson = readJson(path.join(packageRootPath, 'package.json'), {});
  scanSource([source], packageJson);
  const output = path.join(VENDOR, `${id}.mjs`);
  fs.mkdirSync(VENDOR, { recursive: true });
  esbuild.buildSync({ entryPoints: [entry], outfile: output, bundle: true, format: 'esm', platform: 'node', target: 'node20', packages: 'bundle' });
  return output;
}

async function loadTools(entry) {
  const ctx = collectContext();
  const mod = await import(pathToFileURL(entry).href);
  const apply = typeof mod.apply === 'function' ? mod.apply
    : mod.default && typeof mod.default.apply === 'function' ? mod.default.apply : null;
  if (apply) await apply(ctx);
  else if (mod.default && Array.isArray(mod.default.tools)) ctx._tools.push(...mod.default.tools);
  else if (Array.isArray(mod.tools)) ctx._tools.push(...mod.tools);
  return ctx._tools;
}

function declaration(tool) {
  const schema = tool.parameters || tool.inputSchema;
  if (!schemaIsObject(schema)) fail(`工具 ${tool.name} 没有 defineTool 生成的对象 JSON Schema`);
  return {
    name: tool.name,
    upstreamName: tool.name,
    description: tool.description || '',
    category: 'custom',
    risk: 'high',
    isReadOnly: tool.isReadOnly === true,
    isConcurrencySafe: tool.isConcurrencySafe === true,
    inputSchema: schema,
    aliases: Array.isArray(tool.aliases) ? tool.aliases : [],
    searchHint: tool.searchHint || undefined,
  };
}

async function importPlugin(specifier) {
  const resolved = resolvePackage(specifier);
  const root = packageRoot(resolved);
  const pkg = readJson(path.join(root, 'package.json'), {});
  const entry = pkg.main ? path.resolve(root, pkg.main) : resolved;
  const id = String(pkg.name || path.basename(root)).replace(/[^a-zA-Z0-9._-]/g, '_');
  const bundled = buildEntry(entry, root, id);
  const tools = await loadTools(bundled);
  if (!tools.length) fail('插件没有发现可注册工具');
  const installed = readJson(INSTALLED_FILE, { plugins: [] });
  const declarations = tools.map(declaration);
  const existingNames = new Set(installed.plugins
    .filter((item) => item && item.id !== id)
    .flatMap((item) => Array.isArray(item.tools) ? item.tools : [])
    .map((item) => item && item.name)
    .filter(Boolean));
  const duplicate = declarations.find((item) => existingNames.has(item.name));
  if (duplicate) fail(`工具名冲突: ${duplicate.name} 已由其他已安装插件声明`);
  installed.plugins = installed.plugins.filter((item) => item && item.id !== id);
  installed.plugins.push({ id, packageName: pkg.name || specifier, entry: bundled, tools: declarations });
  fs.writeFileSync(INSTALLED_FILE, `${JSON.stringify(installed, null, 2)}\n`);
  const manifest = readJson(MANIFEST_FILE, {});
  manifest.tools = installed.plugins.flatMap((item) => item.tools || []);
  fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`已导入 ${pkg.name || specifier}: ${declarations.map((item) => item.name).join(', ')}`);
}

function removePlugin(id) {
  const installed = readJson(INSTALLED_FILE, { plugins: [] });
  const removed = installed.plugins.filter((item) => item && item.id === id);
  installed.plugins = installed.plugins.filter((item) => !item || item.id !== id);
  for (const item of removed) {
    if (item.entry && path.resolve(item.entry).startsWith(`${VENDOR}${path.sep}`)) fs.rmSync(item.entry, { force: true });
  }
  fs.writeFileSync(INSTALLED_FILE, `${JSON.stringify(installed, null, 2)}\n`);
  const manifest = readJson(MANIFEST_FILE, {});
  manifest.tools = installed.plugins.flatMap((item) => item.tools || []);
  fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`已移除 ${id}`);
}

async function main(argv) {
  if (argv[0] === '--remove' && argv[1]) return removePlugin(argv[1]);
  if (!argv[0]) fail('用法: node lib/importPlugin.js <包名或路径> | --remove <插件 id>');
  return importPlugin(argv[0]);
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { importPlugin, removePlugin, scanSource };
