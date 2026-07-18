'use strict';

/**
 * codexAdopt.js — `khy codex adopt-env` (alias: `use-codex-env`).
 *
 * The codex-side counterpart of claudeAdopt.js. Persists the current codex CLI
 * credentials (CODEX_API_KEY / OPENAI_API_KEY + optional relay base URL) into
 * `~/.khy/.env` so khy reuses the same relay + key after every `pip install -U
 * khy-os` — configure once, never re-enter. This gives `khy codex` the same
 * "configure once, works after every upgrade" experience as `khy claude`.
 *
 * This is the thin IO shell; the decision of WHAT to persist lives in the pure
 * leaf codexEnvAdoptPolicy. The live key is written ONLY to the user's machine
 * (chmod 600) and never displayed unmasked or placed in the published package.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const {
  planCodexEnvAdoption,
  renderEnvFilePatch,
  resolveExportTarget,
} = require('../../services/gateway/adapters/codexEnvAdoptPolicy');
const {
  getRelayPreset,
  listRelayPresets,
} = require('../../services/gateway/adapters/openaiRelayPresets');

function _userEnvFile() {
  return path.join(os.homedir(), '.khy', '.env');
}

// Shared writer: render the patch and persist to ~/.khy/.env (chmod 600). Returns
// the resolved file path, or null on failure (message already printed).
function _writeEnvFile(entries) {
  const envFile = _userEnvFile();
  const khyDir = path.dirname(envFile);

  let existing = '';
  try {
    existing = fs.readFileSync(envFile, 'utf-8');
  } catch {
    // New file — start empty.
  }

  const next = renderEnvFilePatch(existing, entries);

  try {
    fs.mkdirSync(khyDir, { recursive: true });
    fs.writeFileSync(envFile, next, { mode: 0o600 });
    // Enforce perms even if the file pre-existed with looser mode.
    try { fs.chmodSync(envFile, 0o600); } catch { /* best effort (e.g. Windows) */ }
  } catch (err) {
    console.log(chalk.red('写入失败:'), err && err.message ? err.message : String(err));
    return null;
  }
  return envFile;
}

/**
 * `khy codex adopt-env` — persist the current codex credentials into ~/.khy/.env.
 * @param {object} options CLI flags (unused today; reserved for --file override)
 */
async function handleCodexAdoptEnv(options = {}) {
  const plan = planCodexEnvAdoption(process.env);

  if (!plan.ok) {
    console.log(chalk.yellow('未检测到 codex 的凭据环境变量(CODEX_API_KEY / OPENAI_API_KEY)。'));
    console.log('请先在当前 shell 设置与 codex 相同的一套,例如:');
    console.log(chalk.dim('  export CODEX_API_KEY="<你的 sk- key>"              # codex 原生'));
    console.log(chalk.dim('  # 或 OpenAI 兼容:export OPENAI_API_KEY="<sk-...>"'));
    console.log(chalk.dim('  export CODEX_DIRECT_BASE_URL="<你的中转端点>"       # 可选中转/网关'));
    console.log('再运行:  ' + chalk.cyan('khy codex adopt-env'));
    return;
  }

  const envFile = _writeEnvFile(plan.entries);
  if (!envFile) return;

  console.log(chalk.green('✓ 已把当前 codex 凭据固化到本地:'), chalk.dim(envFile));
  console.log(`  凭据类型: ${chalk.white(plan.credKind)}  → auth scheme: ${chalk.white(plan.authScheme)}`);
  console.log(`  端点:     ${chalk.white(plan.endpoint)}`);
  if (plan.model) console.log(`  默认模型: ${chalk.white(plan.model)}`);
  console.log(`  key:      ${chalk.white(plan.maskedToken)}  ${chalk.dim('(仅存本机 · 永不进包)')}`);
  console.log(chalk.dim('  该文件不在 site-packages,pip 升级不会覆盖它 → 写一次,以后无需再配。'));
  console.log(chalk.dim('  下次运行 khy 时会自动加载(真实 shell 环境变量优先级更高)。'));
}

/**
 * `khy codex use-relay <name>` — activate a shipped, opt-in OpenAI/Codex relay preset.
 *
 * The preset ships a NON-SECRET base URL (+ default model) inside the package, so
 * on a fresh machine the user only supplies the key. The key is read from the
 * current shell env (CODEX_API_KEY / OPENAI_API_KEY) — never from a CLI flag or the
 * package — and the preset only fills the endpoint/model the env lacks.
 *
 * With no name (or an unknown one) it lists the available presets.
 *
 * @param {string} name preset name
 * @param {object} options CLI flags (reserved)
 */
async function handleCodexUseRelay(name, options = {}) {
  const preset = getRelayPreset(name);

  if (!preset) {
    if (name) console.log(chalk.yellow(`未知的中转预设: ${name}`));
    const presets = listRelayPresets();
    if (presets.length === 0) {
      console.log(chalk.dim('当前没有内置的 codex/OpenAI 中转预设。'));
      console.log('你可以直接用你自己的端点:');
      console.log(chalk.dim('  export CODEX_DIRECT_BASE_URL="<你的中转端点>"'));
      console.log(chalk.dim('  export CODEX_API_KEY="<你的 sk- key>"'));
      console.log('再运行:  ' + chalk.cyan('khy codex adopt-env'));
      return;
    }
    console.log('可用的中转预设(URL 已随包内置,只需你自带 key):');
    for (const p of presets) {
      console.log(`  ${chalk.cyan(p.name)}  ${chalk.dim('→')} ${chalk.white(p.baseUrl)}` +
        (p.model ? chalk.dim(`  (默认模型 ${p.model})`) : '') +
        (p.label ? chalk.dim(`  — ${p.label}`) : ''));
    }
    console.log('用法:  ' + chalk.cyan('khy codex use-relay <name>') +
      chalk.dim('   (先在 shell 里 export CODEX_API_KEY)'));
    return;
  }

  // Preset supplies the non-secret endpoint/model; the key must come from env.
  const plan = planCodexEnvAdoption(process.env, { baseUrl: preset.baseUrl, model: preset.model });

  if (!plan.ok) {
    console.log(chalk.yellow(`已选中转预设 ${chalk.white(preset.label)}(${preset.baseUrl}),但当前 shell 没有 key。`));
    console.log('请先设置 key(预设只提供端点,key 绝不随包发布,必须你自带):');
    console.log(chalk.dim('  export CODEX_API_KEY="<你的 sk- key>"'));
    console.log(chalk.dim('  # 或 OpenAI 兼容:export OPENAI_API_KEY="<sk-...>"'));
    console.log('再运行:  ' + chalk.cyan(`khy codex use-relay ${name}`));
    return;
  }

  const envFile = _writeEnvFile(plan.entries);
  if (!envFile) return;

  console.log(chalk.green('✓ 已启用中转预设并固化到本地:'), chalk.dim(envFile));
  console.log(`  预设:     ${chalk.white(preset.label)}  ${chalk.dim('(端点随包内置 · 非机密)')}`);
  console.log(`  凭据类型: ${chalk.white(plan.credKind)}  → auth scheme: ${chalk.white(plan.authScheme)}`);
  console.log(`  端点:     ${chalk.white(plan.endpoint)}`);
  if (plan.model) console.log(`  默认模型: ${chalk.white(plan.model)}`);
  console.log(`  key:      ${chalk.white(plan.maskedToken)}  ${chalk.dim('(仅存本机 · 永不进包)')}`);
  console.log(chalk.dim('  下次运行 khy 时会自动加载(真实 shell 环境变量优先级更高)。'));
}

/**
 * `khy codex export-env [path]` — write a portable credential file (default: Desktop)
 * so the user can carry it to a new machine and restore in one copy.
 *
 * The credential is the user's own, written to a LOCAL file on the user's own machine
 * (chmod 600) — this is fine (same as adopt-env's ~/.khy/.env), and is NOT the package.
 * Source of truth: current shell env first; if absent, fall back to the already-adopted
 * ~/.khy/.env. The key is written to the file but only ever shown MASKED on screen.
 *
 * @param {string} targetArg optional destination path (positional)
 * @param {object} options CLI flags (reserved)
 */
async function handleCodexExportEnv(targetArg, options = {}) {
  // Prefer live env; fall back to the previously adopted ~/.khy/.env.
  let entries = null;
  let masked = '';
  let endpoint = '';
  let credKind = '';

  const plan = planCodexEnvAdoption(process.env);
  if (plan.ok) {
    entries = plan.entries;
    masked = plan.maskedToken;
    endpoint = plan.endpoint;
    credKind = plan.credKind;
  } else {
    // No credential in the shell — try to export what adopt-env already saved.
    try {
      const saved = fs.readFileSync(_userEnvFile(), 'utf-8');
      const savedEnv = {};
      for (const line of saved.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (m) savedEnv[m[1]] = m[2];
      }
      const p2 = planCodexEnvAdoption(savedEnv);
      if (p2.ok) {
        entries = p2.entries;
        masked = p2.maskedToken;
        endpoint = p2.endpoint;
        credKind = p2.credKind;
      }
    } catch { /* nothing saved yet */ }
  }

  if (!entries) {
    console.log(chalk.yellow('没有可导出的凭据。'));
    console.log('请先在当前 shell 设置 codex 那套 env(再运行本命令),或先执行:');
    console.log('  ' + chalk.cyan('khy codex adopt-env') + chalk.dim('   # 把当前凭据固化到 ~/.khy/.env'));
    return;
  }

  const target = resolveExportTarget(os.homedir(), targetArg);
  const header = [
    '# khy codex 订阅迁移文件 — 含 LIVE key,请当机密对待。',
    '# 用法(新电脑):把本文件放到  ~/.khy/.env  (Windows: %USERPROFILE%\\.khy\\.env),khy 启动即自动加载。',
    '# 只走私密渠道传输(scp/U盘/密码管理器);用完删除;切勿提交 git / 发聊天 / 截图。',
    '',
  ].join('\n');
  const body = renderEnvFilePatch('', entries);
  const content = header + body;

  try {
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, content, { mode: 0o600 });
    try { fs.chmodSync(target, 0o600); } catch { /* best effort (e.g. Windows) */ }
  } catch (err) {
    console.log(chalk.red('写入失败:'), err && err.message ? err.message : String(err));
    console.log(chalk.dim('  可指定其它路径:khy codex export-env "/some/writable/path/khy-codex-env.env"'));
    return;
  }

  console.log(chalk.green('✓ 已导出凭据迁移文件:'), chalk.white(target));
  console.log(`  凭据类型: ${chalk.white(credKind)}`);
  console.log(`  端点:     ${chalk.white(endpoint)}`);
  console.log(`  key:      ${chalk.white(masked)}  ${chalk.dim('(文件里是明文 · 屏幕只显打码)')}`);
  console.log(chalk.yellow('  ⚠ 这是含 live key 的机密文件。只走私密渠道拷到新电脑,用完请删除。'));
  console.log(chalk.dim('  新电脑还原:把它放到  ~/.khy/.env  即可(Windows: %USERPROFILE%\\.khy\\.env)。'));
}

module.exports = { handleCodexAdoptEnv, handleCodexUseRelay, handleCodexExportEnv, _userEnvFile };
