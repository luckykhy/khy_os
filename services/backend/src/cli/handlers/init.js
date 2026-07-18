/**
 * CLI Handlers: init (setup wizard) and doctor (environment diagnostic).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const chalk = require('chalk').default || require('chalk');
const {
  printSuccess, printError, printWarn, printInfo, printTable, withSpinner,
  MASCOT_MINI, ICON_HEART, ICON_GEAR,
} = require('../formatters');

const ROOT = path.resolve(__dirname, '../../../');
const ENV_FILE = path.join(ROOT, '.env');
const DEFAULT_KHY_MD = `# KHY Project Instructions

## Language

- Use Chinese by default for all user-facing replies.
- If the user explicitly requests another language, follow the user's request.
- Do not switch languages just because a referenced file, tool, or upstream instruction uses another language.

## Code And Commands

- Keep code, identifiers, file paths, command lines, environment variables, logs, and protocol fields in the language required by the codebase or tool.
- Unless the task explicitly requires another style, keep code comments and technical identifiers in English.

## Response Style

- Be concise, direct, and practical.
- Prefer actionable answers over abstract explanations.
`;

// ── Helper: silent command execution ─────────────────────────────────────────

function runSilent(cmd, args = []) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function runProbe(cmd, args = []) {
  try {
    const output = execFileSync(cmd, args, {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { ok: true, output };
  } catch (err) {
    const toText = (v) => {
      if (v === null || v === undefined) return '';
      if (Buffer.isBuffer(v)) return v.toString('utf-8').trim();
      return String(v).trim();
    };
    const stderr = toText(err?.stderr);
    const stdout = toText(err?.stdout);
    const message = toText(err?.message) || 'unknown error';
    const combined = `${stderr} ${stdout} ${message}`.toLowerCase();

    const code = String(err?.code || '');
    if (code === 'ENOENT') return { ok: false, reason: 'missing' };
    if (code === 'EPERM' || code === 'EACCES') return { ok: false, reason: 'blocked' };
    if (code === 'ETIMEDOUT') return { ok: false, reason: 'timeout' };
    if (/permission denied|operation not permitted|sandbox|not allowed|access denied/i.test(combined)) {
      return { ok: false, reason: 'blocked', message };
    }
    if (/timed out|timeout|etimedout/i.test(combined)) {
      return { ok: false, reason: 'timeout', message };
    }
    if (/connection refused|could not connect|econnrefused|service unavailable|host is down/i.test(combined)) {
      return { ok: false, reason: 'unavailable', message: stderr || stdout || message };
    }
    return { ok: false, reason: 'error', message: stderr || stdout || message };
  }
}

function probeFailureDetail(probe, fallback = '未安装') {
  if (!probe || probe.ok) return '';
  if (probe.reason === 'blocked') return '检测受限（权限/沙箱限制）';
  if (probe.reason === 'timeout') return '检测超时';
  if (probe.reason === 'missing') return fallback;
  if (probe.reason === 'unavailable') return probe.message ? String(probe.message).slice(0, 160) : '服务不可用';
  return probe.message ? String(probe.message).slice(0, 160) : fallback;
}

function formatLocalTime(ts) {
  const n = Number(ts || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    return new Date(n).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return new Date(n).toISOString();
  }
}

function isLocalAdapterName(name = '') {
  const lower = String(name || '').toLowerCase();
  if (!lower) return false;
  return ['local', 'ollama', 'llama'].some(token => lower.includes(token));
}

function isTruthyFlag(raw = '') {
  // 布尔解析走 parseBoolean 单一真源（base tier）。
  return require('../../utils/parseBoolean')(raw, false, { extended: false });
}

function isLoopbackUrl(raw = '') {
  const input = String(raw || '').trim();
  if (!input) return false;
  try {
    const parsed = new URL(input);
    const host = String(parsed.hostname || '').trim().toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

const _isPathWithin = require('../../utils/isPathWithin');

function _buildCodexHomeEnvironmentCheck(activeAdapter = null, preferredAdapter = '') {
  const activeType = String(activeAdapter?.type || '').trim().toLowerCase();
  const preferredType = String(preferredAdapter || '').trim().toLowerCase();
  const envHome = String(process.env.HOME || '').trim();
  const resolvedHome = envHome || os.homedir() || '';
  const tmpDir = String(os.tmpdir() || '').trim();
  const isTempHome = !!resolvedHome && !!tmpDir && _isPathWithin(tmpDir, resolvedHome);
  const codexRelevant = activeType === 'codex' || preferredType === 'codex';

  if (!isTempHome) {
    return {
      category: 'AI 能力',
      label: 'Codex HOME 环境',
      ok: true,
      detail: `HOME=${resolvedHome || '-'} 不在临时目录`,
      level: 'info',
    };
  }

  const detail = `HOME=${resolvedHome} 位于临时目录；Codex CLI 可能因 helper/bin 或 TLS 会话问题出现 reconnect / handshake eof`;
  return {
    category: 'AI 能力',
    label: 'Codex HOME 环境',
    ok: !codexRelevant,
    detail: codexRelevant ? `${detail}；建议改回真实用户主目录后重试` : `${detail}；当前未激活 Codex，可暂时忽略`,
    level: codexRelevant ? 'warn' : 'info',
  };
}

function _buildGatewayPromptRiskDebugSuffix(active = null) {
  try {
    const gatewayHandler = require('./gateway');
    if (!gatewayHandler || typeof gatewayHandler.getGatewayDebugPromptSnapshot !== 'function') return '';
    const snapshot = gatewayHandler.getGatewayDebugPromptSnapshot({ tail: 1 });
    if (!snapshot || snapshot.ok === false) return '';
    if (!snapshot.exists || !snapshot.latest) {
      return `；当前尚无 KHY 注入日志，建议先执行 ${snapshot?.recommendedCommand || 'KHY_GATEWAY_DEBUG_PROMPT=1 khy gateway status'} 生成证据`;
    }

    const latest = snapshot.latest;
    const activeType = String(active?.type || active?.adapter || active?.key || '').trim().toLowerCase();
    const latestAdapter = String(latest.adapter || '').trim().toLowerCase();
    const adapterHint = activeType && latestAdapter && activeType !== latestAdapter
      ? `最近记录来自 ${latest.adapter}，当前活跃通道为 ${active?.name || activeType}`
      : `最近记录来自 ${latest.provider || latest.adapter || 'unknown'}`;
    const preview = String(latest.promptPreview || '').replace(/\s+/g, ' ').trim();
    const compactPreview = preview.length > 96 ? `${preview.slice(0, 95)}…` : preview;
    const timeText = formatLocalTime(Date.parse(String(latest.timestamp || ''))) || String(latest.timestamp || '');
    return `；${adapterHint}，注入时间 ${timeText || '-'}，system=${latest.systemLength || 0} chars，prompt=${latest.promptLength || 0} chars，preview=${compactPreview || '(empty)'}`;
  } catch {
    return '';
  }
}

function _printGatewayPromptDebugCommandsForDoctor() {
  try {
    const gatewayHandler = require('./gateway');
    if (!gatewayHandler || typeof gatewayHandler.getGatewayDebugPromptSnapshot !== 'function') return;
    const snapshot = gatewayHandler.getGatewayDebugPromptSnapshot({ tail: 1 });
    const statusCommand = snapshot?.recommendedCommand || 'KHY_GATEWAY_DEBUG_PROMPT=1 khy gateway status';
    const debugCommand = `khy gateway debug-prompt --file ${snapshot?.file || '~/.khyquant/logs/khy_gateway_prompt_debug.log'} --tail 1`;
    printInfo(`KHY 协议排查命令: ${statusCommand}`);
    printInfo(`KHY 注入摘要命令: ${debugCommand}`);
  } catch { /* best effort */ }
}

function _buildLatestDeliveryRequestDetail() {
  try {
    const traceAudit = require('../../services/traceAuditService');
    if (!traceAudit || typeof traceAudit.getLatestDeliveryRequestSummary !== 'function') {
      return {
        ok: true,
        level: 'info',
        detail: '诊断服务未启用，无法评估最近一次交付链路',
      };
    }
    const summary = traceAudit.getLatestDeliveryRequestSummary();
    if (!summary) {
      return {
        ok: true,
        level: 'info',
        detail: '尚无最近交付链路摘要',
      };
    }
    if (summary.ok === false) {
      const nonBlockingReasons = new Set(['no_session', 'no_events', 'no_request_id']);
      if (nonBlockingReasons.has(String(summary.reason || '').trim())) {
        return {
          ok: true,
          level: 'info',
          detail: summary.summary || '尚无最近交付链路摘要',
        };
      }
      return {
        ok: false,
        level: 'warn',
        detail: summary.summary || '最近交付链路检查失败',
      };
    }
    const informationalStatuses = new Set(['completed', 'summary_only', 'response_only']);
    return {
      ok: informationalStatuses.has(String(summary.status || '').trim()),
      level: informationalStatuses.has(String(summary.status || '').trim()) ? 'info' : 'warn',
      detail: `${summary.summary}；事件=${summary.eventCount}；最后事件=${summary.lastEvent?.type || 'unknown'}`,
    };
  } catch {
    return {
      ok: false,
      level: 'warn',
      detail: '读取最近交付链路摘要失败',
    };
  }
}

function _buildLatestLanguageConsistencyDetail() {
  try {
    const traceAudit = require('../../services/traceAuditService');
    if (!traceAudit || typeof traceAudit.getLatestLanguageConsistencySummary !== 'function') {
      return {
        ok: true,
        level: 'info',
        detail: '诊断服务未启用，无法评估语言一致性',
      };
    }
    const summary = traceAudit.getLatestLanguageConsistencySummary();
    if (!summary) {
      return {
        ok: true,
        level: 'info',
        detail: '尚无语言一致性摘要',
      };
    }
    if (summary.ok === false) {
      const nonBlockingReasons = new Set([
        'no_session',
        'no_events',
        'no_language_event',
        'no_language_event_for_request',
        'awaiting_model_output_for_request',
        'language_audit_missing_after_response',
      ]);
      if (nonBlockingReasons.has(String(summary.reason || '').trim())) {
        return {
          ok: true,
          level: 'info',
          detail: summary.summary || '尚无语言一致性摘要',
        };
      }
      return {
        ok: false,
        level: 'warn',
        detail: summary.summary || '语言一致性检查失败',
      };
    }
    const sample = String(summary.textSample || '').trim();
    return {
      ok: summary.status === 'aligned',
      level: summary.status === 'aligned' ? 'info' : 'warn',
      detail: `${summary.summary}${sample ? `；sample=${sample}` : ''}`,
    };
  } catch {
    return {
      ok: false,
      level: 'warn',
      detail: '读取语言一致性摘要失败',
    };
  }
}

function _hasDoctorToolCandidate(toolNames = new Set(), candidates = []) {
  if (!(toolNames instanceof Set) || toolNames.size === 0) return false;
  return candidates.some((candidate) => toolNames.has(String(candidate || '').trim().toLowerCase()));
}

function _probeDoctorTempWorkspace() {
  let tempDir = '';
  try {
    // Use the OS temp dir so doctor never touches the active repository files.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-doctor-'));
    const filePath = path.join(tempDir, 'coding-agent-smoke.txt');
    const payload = 'khy coding agent smoke\n';
    fs.writeFileSync(filePath, payload, 'utf-8');
    const readBack = fs.readFileSync(filePath, 'utf-8');
    if (readBack !== payload) {
      return { ok: false, detail: '临时工作区读写校验失败' };
    }
    return { ok: true, detail: '可写' };
  } catch (err) {
    const message = String(err?.message || 'unknown error').replace(/\s+/g, ' ').trim();
    return { ok: false, detail: message ? message.slice(0, 120) : '临时工作区不可写' };
  } finally {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch { /* best effort */ }
    }
  }
}

function _buildCodingAgentSmokeCheck(activeAdapter = null) {
  const detailParts = [];
  let ok = true;
  let level = 'info';

  const activeName = String(activeAdapter?.name || activeAdapter?.type || '').trim();
  if (activeName) {
    detailParts.push(`通道=${activeName}`);
  } else {
    ok = false;
    level = 'warn';
    detailParts.push('通道=无活跃通道');
  }

  try {
    const { getProfileTools } = require('../../tools/toolProfile');
    const codingProfileTools = getProfileTools('coding');
    const profileCount = Array.isArray(codingProfileTools) ? codingProfileTools.length : 0;
    if (profileCount > 0) {
      detailParts.push(`coding profile=${profileCount} 个工具`);
    } else {
      ok = false;
      level = 'warn';
      detailParts.push('coding profile=空');
    }
  } catch {
    ok = false;
    level = 'warn';
    detailParts.push('coding profile=加载失败');
  }

  try {
    const toolCalling = require('../../services/toolCalling');
    const tools = Array.isArray(toolCalling.listTools?.()) ? toolCalling.listTools() : [];
    const toolNames = new Set(
      tools
        .map((tool) => (typeof tool === 'string' ? tool : tool?.name))
        .filter(Boolean)
        .map((name) => String(name).trim().toLowerCase())
    );
    const toolGroups = [
      { label: 'read', candidates: ['readfile', 'read_file', 'read'] },
      { label: 'search', candidates: ['grep', 'search', 'glob', 'explore', 'toolsearch'] },
      { label: 'edit', candidates: ['editfile', 'edit_file', 'writefile', 'write_file', 'apply_patch', 'applypatch', 'patch'] },
      { label: 'execute', candidates: ['shellcommand', 'shell_command', 'bash', 'executecode', 'run_tests', 'build_project', 'lint_code'] },
    ];
    const readyGroups = toolGroups.filter((group) => _hasDoctorToolCandidate(toolNames, group.candidates));
    const missingGroups = toolGroups
      .filter((group) => !_hasDoctorToolCandidate(toolNames, group.candidates))
      .map((group) => group.label);
    detailParts.push(`工具组=${readyGroups.length}/${toolGroups.length} 就绪`);
    if (missingGroups.length > 0) {
      ok = false;
      level = 'warn';
      detailParts.push(`缺少=${missingGroups.join('/')}`);
    }
  } catch {
    ok = false;
    level = 'warn';
    detailParts.push('工具组=加载失败');
  }

  const tempProbe = _probeDoctorTempWorkspace();
  detailParts.push(`临时工作区=${tempProbe.ok ? '可写' : `受限 (${tempProbe.detail})`}`);
  if (!tempProbe.ok) {
    ok = false;
    level = 'warn';
  }

  return {
    category: 'AI 能力',
    label: '编程智能体烟雾测试',
    ok,
    detail: detailParts.join('；'),
    level,
  };
}

function readClaudeSettingsSnapshot() {
  const os = require('os');
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

  if (!fs.existsSync(settingsPath)) {
    return {
      settingsPath,
      exists: false,
      parseError: null,
      settings: null,
      env: {},
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const settings = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    const env = (settings.env && typeof settings.env === 'object') ? settings.env : {};
    return {
      settingsPath,
      exists: true,
      parseError: null,
      settings,
      env: { ...env },
    };
  } catch (err) {
    return {
      settingsPath,
      exists: true,
      parseError: err,
      settings: null,
      env: {},
    };
  }
}

function writeClaudeSettingsSnapshot(settingsPath, settings) {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${settingsPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, settingsPath);
}

function inspectClaudeSettingsConflict() {
  const snapshot = readClaudeSettingsSnapshot();

  if (!snapshot.exists) {
    return {
      ok: true,
      level: 'info',
      detail: '未发现 ~/.claude/settings.json（未检测到冲突项）',
    };
  }

  if (snapshot.parseError) {
    return {
      ok: false,
      level: 'warn',
      detail: `~/.claude/settings.json 解析失败：${String(snapshot.parseError?.message || 'invalid json').slice(0, 120)}`,
    };
  }

  const env = snapshot.env;
  const authToken = String(env.ANTHROPIC_AUTH_TOKEN || '').trim();
  const apiKey = String(env.ANTHROPIC_API_KEY || '').trim();
  const baseUrl = String(env.ANTHROPIC_BASE_URL || '').trim();
  const hasAnyAuth = !!authToken || !!apiKey;
  const hasDualAuth = !!authToken && !!apiKey;
  const hasKhyApiKey = apiKey.startsWith('khy-');
  const hasExternalBaseUrl = !!baseUrl && !isLoopbackUrl(baseUrl);
  const writeSettingsEnabled = (
    isTruthyFlag(process.env.KHY_ALLOW_WRITE_CLAUDE_SETTINGS)
    || isTruthyFlag(process.env.KHY_MANAGE_CLAUDE_SETTINGS)
  );

  if (hasDualAuth && hasKhyApiKey && hasExternalBaseUrl) {
    return {
      ok: false,
      level: 'warn',
      detail: '检测到外部 AUTH_TOKEN + khy-* API_KEY + 外部 BASE_URL，存在高风险冲突（建议删除 settings.json 中 ANTHROPIC_API_KEY）',
    };
  }

  if (hasDualAuth && hasKhyApiKey) {
    return {
      ok: false,
      level: 'warn',
      detail: '检测到同时存在 AUTH_TOKEN 与 khy-* API_KEY（建议仅保留一种认证方式）',
    };
  }

  if (hasDualAuth) {
    return {
      ok: false,
      level: 'warn',
      detail: '检测到同时配置 AUTH_TOKEN 与 API_KEY（Claude Code 可能拒绝请求，建议只保留一种）',
    };
  }

  if (!hasAnyAuth) {
    return {
      ok: true,
      level: 'info',
      detail: '未检测到 Claude 认证项（若使用直连 Claude，请配置 AUTH_TOKEN 或 API_KEY）',
    };
  }

  if (writeSettingsEnabled && hasExternalBaseUrl) {
    return {
      ok: false,
      level: 'warn',
      detail: '检测到已开启 Claude settings 写入开关且使用外部 BASE_URL（建议关闭 KHY_ALLOW_WRITE_CLAUDE_SETTINGS）',
    };
  }

  return {
    ok: true,
    level: 'info',
    detail: '未发现 KHY 与 Claude 的配置冲突',
  };
}

function fixClaudeSettingsConflict() {
  const snapshot = readClaudeSettingsSnapshot();
  if (!snapshot.exists) {
    return { ok: true, changed: false, detail: '未发现 ~/.claude/settings.json，无需修复' };
  }
  if (snapshot.parseError || !snapshot.settings) {
    return {
      ok: false,
      changed: false,
      detail: `无法修复：settings.json 解析失败（${String(snapshot.parseError?.message || 'invalid json').slice(0, 120)}）`,
    };
  }

  const env = { ...(snapshot.env || {}) };
  const authToken = String(env.ANTHROPIC_AUTH_TOKEN || '').trim();
  const apiKey = String(env.ANTHROPIC_API_KEY || '').trim();
  const baseUrl = String(env.ANTHROPIC_BASE_URL || '').trim();
  const hasAuthToken = !!authToken;
  const hasApiKey = !!apiKey;
  const hasKhyApiKey = apiKey.startsWith('khy-');
  const hasExternalBaseUrl = !!baseUrl && !isLoopbackUrl(baseUrl);
  const actions = [];

  if (hasKhyApiKey && (hasAuthToken || hasExternalBaseUrl)) {
    delete env.ANTHROPIC_API_KEY;
    actions.push('移除冲突的 ANTHROPIC_API_KEY (khy-*)');
  }

  if (hasAuthToken && isLoopbackUrl(baseUrl)) {
    delete env.ANTHROPIC_BASE_URL;
    actions.push('移除本地代理 ANTHROPIC_BASE_URL，保留外部 AUTH_TOKEN');
  }

  if (actions.length === 0) {
    if (hasAuthToken && hasApiKey) {
      return {
        ok: false,
        changed: false,
        detail: '检测到双认证但 API_KEY 非 khy-*，请手动决定保留 AUTH_TOKEN 或 API_KEY',
      };
    }
    return { ok: true, changed: false, detail: '未发现可自动修复的冲突项' };
  }

  try {
    const nextSettings = {
      ...snapshot.settings,
      env,
    };
    writeClaudeSettingsSnapshot(snapshot.settingsPath, nextSettings);
    return {
      ok: true,
      changed: true,
      detail: actions.join('；'),
    };
  } catch (err) {
    return {
      ok: false,
      changed: false,
      detail: `写入失败：${String(err?.message || err).slice(0, 160)}`,
    };
  }
}

function ensureBuiltinSenseNovaProvider(options = {}) {
  // Single source: delegate to the shared registrar so the built-in SenseNova
  // channel is seeded identically here, at server/gateway startup, and in tests.
  require('../../services/customProviderRegistrar')
    .ensureBuiltinSenseNova({ force: !!options.force });
}

// ── khy init ─────────────────────────────────────────────────────────────────

/**
 * Interactive initialization wizard using inquirer.
 * Lighter than setup.js — assumes Node deps are already installed.
 */
async function handleInit(options = {}) {
  const { promptCompat } = require('../uiPrompt');
  const projectInstructionFile = path.join(process.cwd(), 'khy.md');

  console.log('');
  console.log(`  ${ICON_GEAR} ${chalk.cyan.bold('khy OS 初始化向导')}`);
  console.log(chalk.dim('     快速配置环境，让系统正常运行'));
  console.log('');

  // Check what needs initialization
  const checks = runDoctorChecks();
  const issues = checks.filter(c => !c.ok);

  if (issues.length === 0 && !options.force) {
    printSuccess('环境检测正常，无需初始化');
    printInfo('如需强制重新初始化，请使用 init --force');
    return;
  }

  // Show current issues
  if (issues.length > 0) {
    console.log(chalk.yellow('  发现以下问题:'));
    issues.forEach(issue => {
      console.log(chalk.red('    ✗ ') + issue.label + ': ' + issue.detail);
    });
    console.log('');
  }

  // .env configuration
  if (!fs.existsSync(ENV_FILE) || options.force) {
    const { dbType } = await promptCompat([{
      type: 'list',
      name: 'dbType',
      message: '选择数据库类型:',
      choices: [
        { name: 'SQLite (零配置，推荐开发)', value: 'sqlite' },
        { name: 'PostgreSQL (生产推荐)', value: 'postgres' },
      ],
    }]);

    const { port } = await promptCompat([{
      type: 'input',
      name: 'port',
      message: '服务端口:',
      default: '3000',
      validate: (v) => /^\d+$/.test(v) ? true : '请输入数字',
    }]);

    let pgConfig = {};
    if (dbType === 'postgres') {
      pgConfig = (await promptCompat([
        { type: 'input', name: 'dbHost', message: 'PostgreSQL 地址:', default: '127.0.0.1' },
        { type: 'input', name: 'dbPort', message: 'PostgreSQL 端口:', default: '5432' },
        { type: 'input', name: 'dbName', message: '数据库名称:', default: 'quant_trading' },
        { type: 'input', name: 'dbUser', message: '数据库用户:', default: 'postgres' },
        { type: 'password', name: 'dbPassword', message: '数据库密码 (留空自动生成):' },
      ]));
    }

    // Generate secure JWT secret
    const crypto = require('crypto');
    const jwtSecret = crypto.randomBytes(32).toString('hex');
    if (!pgConfig.dbPassword) pgConfig.dbPassword = crypto.randomBytes(16).toString('hex');

    const lines = [
      '# khy OS Environment Configuration',
      `# Generated: ${new Date().toISOString()}`,
      '',
      `DB_TYPE=${dbType}`,
    ];

    if (dbType === 'postgres') {
      lines.push(`DB_HOST=${pgConfig.dbHost}`);
      lines.push(`DB_PORT=${pgConfig.dbPort}`);
      lines.push(`DB_NAME=${pgConfig.dbName}`);
      lines.push(`DB_USER=${pgConfig.dbUser}`);
      lines.push(`DB_PASSWORD=${pgConfig.dbPassword}`);
    }

    lines.push('', `PORT=${port}`, 'NODE_ENV=development', 'LOG_LEVEL=info');
    lines.push('', `JWT_SECRET=${jwtSecret}`, 'JWT_EXPIRES_IN=7d');
    lines.push('', 'ENABLE_AKSHARE=true', 'ENABLE_TUSHARE=false', 'DEFAULT_DATA_SOURCE=reliable');
    lines.push('', '# AI Providers', '# GEMINI_API_KEY=', '# GROQ_API_KEY=');
    lines.push('',
      '# ── Provider 路由配置 ──',
      '# 内置示例: SenseNova (OpenAI-compatible)',
      'GATEWAY_API_POOL_SERVICE_MAP={"sensenova":"openai"}',
      'GATEWAY_API_POOL_DEFAULT_MODEL_MAP={"sensenova":"sensenova-6.7-flash-lite"}',
      'PROXY_MODEL_ROUTE_MAP={"sensenova-6.7-flash-lite":{"target":"api:sensenova:sensenova-6.7-flash-lite","strict":true},"sensenova-u1-fast":{"target":"api:sensenova:sensenova-u1-fast","strict":true},"deepseek-v4-flash":{"target":"api:sensenova:deepseek-v4-flash","strict":true}}',
      'PROXY_PRIMARY_ADAPTER=api',
      'GATEWAY_API_POOL_PROVIDER=sensenova',
      // 默认/首选用 flash-lite：可正常文本对话、走 /v1/chat/completions。它**不收图像输入**
      // (实测带图当作没收到)，带图请求会自动退回本地 OCR(见 visionCapability/decideVisionRouting)。
      // 切勿用 u1-fast 当默认——那是信息图生成模型(独立端点、不收图/不做通用对话)，会 404。
      'GATEWAY_PREFERRED_MODEL=sensenova-6.7-flash-lite',
    );

    fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n');
    // Restrict .env permissions to owner only (Unix)
    if (process.platform !== 'win32') {
      try { fs.chmodSync(ENV_FILE, 0o600); } catch { /* ignore */ }
    }
    printSuccess('.env 配置文件已生成');

  } else {
    printInfo('.env 已存在，跳过');
  }

  ensureBuiltinSenseNovaProvider({ force: !!options.force });
  printSuccess('内置 AI Provider (SenseNova) 已配置');

  // Seed the qoder reverse-proxy channels only when the user opted in
  // (QODER_PROXY_ENDPOINT/API_KEY or KHY_QODER_PROXY); otherwise a silent no-op.
  try {
    const qoderSeed = require('../../services/customProviderRegistrar').ensureBuiltinQoder();
    if (qoderSeed && qoderSeed.seeded) {
      printSuccess('已配置 Qoder 反代 Provider (OpenAI + Anthropic)');
    }
  } catch { /* best effort — never block init wizard */ }


  // Database initialization
  const { shouldInitDb } = await promptCompat([{
    type: 'confirm',
    name: 'shouldInitDb',
    message: '初始化数据库结构?',
    default: true,
  }]);

  if (shouldInitDb) {
    await withSpinner('初始化数据库...', async () => {
      const { bootstrap } = require('../bootstrap');
      await bootstrap({ syncSchema: true, silent: true });
    }, { muteOutput: true });
  }

  // Seed data
  const { shouldSeed } = await promptCompat([{
    type: 'confirm',
    name: 'shouldSeed',
    message: '填充示例数据（策略、品种）?',
    default: true,
  }]);

  if (shouldSeed) {
    await withSpinner('填充示例数据...', async () => {
      const { execFileSync } = require('child_process');
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed.js')], {
        cwd: ROOT,
        stdio: 'pipe',
        timeout: 60000,
      });
    }, { muteOutput: true });
  }

  const shouldCreateKhyMdDefault = !fs.existsSync(projectInstructionFile) || !!options.force;
  if (shouldCreateKhyMdDefault) {
    const { createKhyMd } = await promptCompat([{
      type: 'confirm',
      name: 'createKhyMd',
      message: `创建默认项目指令文件 ${path.basename(projectInstructionFile)}?（默认中文优先，除非用户明确要求其他语言）`,
      default: true,
    }]);

    if (createKhyMd) {
      try {
        fs.writeFileSync(projectInstructionFile, DEFAULT_KHY_MD, 'utf-8');
        printSuccess(`已创建项目指令文件: ${projectInstructionFile}（默认中文优先）`);
      } catch (err) {
        printWarn(`创建 ${path.basename(projectInstructionFile)} 失败: ${String(err?.message || err).slice(0, 160)}`);
      }
    }
  } else {
    printInfo(`项目指令文件已存在，跳过: ${projectInstructionFile}`);
  }

  // AI key configuration
  const { configAi } = await promptCompat([{
    type: 'confirm',
    name: 'configAi',
    message: '现在配置 AI 密钥?',
    default: false,
  }]);

  if (configAi) {
    const { handleGatewayConfig } = require('./gateway');
    await handleGatewayConfig();
  }

  console.log('');
  printSuccess('初始化完成！输入 help 查看可用命令');
  console.log('');
}

// ── khy doctor ───────────────────────────────────────────────────────────────

/**
 * Run all environment diagnostic checks and display results.
 */
async function handleDoctor(options = {}, args = []) {
  const asJson = !!options.json;
  if (!asJson) {
    console.log('');
    console.log(`  ${ICON_HEART} ${chalk.cyan.bold('khy OS 环境诊断')}`);
    console.log(chalk.dim('     检查系统环境是否满足运行要求'));
    console.log('');
  }

  const fixRequested = (
    isTruthyFlag(options['fix-claude-conflict'])
    || isTruthyFlag(options['fix-claude'])
    || (Array.isArray(args) && args.some(arg => (
      String(arg || '').trim().toLowerCase() === 'fix-claude-conflict'
      || String(arg || '').trim().toLowerCase() === 'fix-claude'
    )))
  );
  let fixResult = null;
  if (fixRequested) {
    fixResult = fixClaudeSettingsConflict();
    if (!asJson) {
      if (fixResult.ok && fixResult.changed) {
        printSuccess(`Claude 冲突修复完成：${fixResult.detail}`);
      } else if (fixResult.ok) {
        printInfo(`Claude 冲突修复：${fixResult.detail}`);
      } else {
        printWarn(`Claude 冲突修复失败：${fixResult.detail}`);
      }
      console.log('');
    }
  }

  const checks = runDoctorChecks();

  // Group by category
  const categories = {};
  checks.forEach(check => {
    if (!categories[check.category]) categories[check.category] = [];
    categories[check.category].push(check);
  });

  let totalOk = 0;
  let totalFail = 0;
  let totalWarn = 0;

  checks.forEach(item => {
    if (item.ok) totalOk++;
    else if (item.level === 'warn') totalWarn++;
    else totalFail++;
  });

  if (asJson) {
    const status = totalFail > 0 ? 'fail' : (totalWarn > 0 ? 'warn' : 'ok');
    const groupedCategories = Object.entries(categories).map(([category, items]) => ({
      category,
      checks: items,
    }));
    console.log(JSON.stringify({
      generatedAt: Date.now(),
      status,
      counts: {
        ok: totalOk,
        warn: totalWarn,
        fail: totalFail,
        total: checks.length,
      },
      fix: fixRequested ? {
        requested: true,
        ok: !!fixResult?.ok,
        changed: !!fixResult?.changed,
        detail: String(fixResult?.detail || ''),
      } : null,
      checks,
      categories: groupedCategories,
      maintenance: [
        'khy docs maintainer',
        'npm run maintainer:map',
        'npm run test:maintainer:gateway',
      ],
    }, null, 2));
    return;
  }

  for (const [category, items] of Object.entries(categories)) {
    console.log(chalk.cyan(`  ${category}`));
    items.forEach(item => {
      const icon = item.ok ? chalk.green('✓') : (item.level === 'warn' ? chalk.yellow('⚠') : chalk.red('✗'));
      const detail = item.detail ? chalk.dim(` — ${item.detail}`) : '';
      console.log(`    ${icon} ${item.label}${detail}`);
    });
    console.log('');
  }

  // Summary
  const summary = [];
  if (totalOk > 0) summary.push(chalk.green(`${totalOk} 通过`));
  if (totalWarn > 0) summary.push(chalk.yellow(`${totalWarn} 警告`));
  if (totalFail > 0) summary.push(chalk.red(`${totalFail} 失败`));
  console.log(`  ${chalk.bold('总计:')} ${summary.join(' · ')}`);

  if (totalFail > 0) {
    console.log('');
    printInfo('运行 khy init 修复问题');
  } else if (totalWarn > 0) {
    console.log('');
    printInfo('所有核心功能正常，部分可选功能不可用');
  } else {
    console.log('');
    printSuccess('所有检查通过，系统就绪');
  }

  const localModelBlocked = checks.find(c => c.label === '本地模型可用性' && !c.ok);
  const localListenBlocked = checks.find(c => c.label === '本地监听能力' && !c.ok);
  if (localModelBlocked || localListenBlocked) {
    printInfo('检测到当前环境限制本地模型通道，可一键执行: `khy gateway prefer-remote`');
    printInfo('也可手动使用 `khy gateway model` 切换到 API/桥接通道');
  }
  const codexHealCheck = checks.find(c => c.label === 'Codex 自愈状态');
  if (codexHealCheck && codexHealCheck.level === 'warn') {
    printWarn('检测到 Codex 通道近期异常；建议先重启 Codex CLI 会话，再执行 `khy gateway status` 复查');
  }
  const codexHomeCheck = checks.find(c => c.label === 'Codex HOME 环境' && !c.ok && c.level === 'warn');
  if (codexHomeCheck) {
    printWarn('检测到 Codex CLI 使用临时 HOME；建议切回真实用户主目录后，再执行 `khy gateway status` 或 `khy gateway sample codex`');
  }
  const claudeSettingsCheck = checks.find(c => c.label === 'Claude 配置隔离');
  if (claudeSettingsCheck && !claudeSettingsCheck.ok) {
    printWarn('检测到 Claude 配置冲突风险；建议清理 ~/.claude/settings.json 中冲突认证项');
    printInfo('可执行 `khy doctor --fix-claude-conflict` 自动修复常见冲突项');
  }
  const khyProtocolRiskCheck = checks.find(c => c.label === 'KHY 协议优先级风险' && !c.ok);
  if (khyProtocolRiskCheck) {
    _printGatewayPromptDebugCommandsForDoctor();
  }
  const codingAgentSmokeCheck = checks.find(c => c.label === '编程智能体烟雾测试' && !c.ok);
  if (codingAgentSmokeCheck) {
    printInfo('编程代理排查建议: 先执行 `khy gateway status` 确认活跃通道；如工具组缺失或临时目录受限，优先检查 `npm install`、coding tool profile 与当前工作区写权限');
  }
  const deliveryChainCheck = checks.find(c => c.label === '最近交付链路' && !c.ok && c.level === 'warn');
  if (deliveryChainCheck) {
    printInfo('交付链路排查建议: 结合 `khy gateway status --json` 查看 latestDeliveryRequest，并按 requestId 回查网关请求、工具调用与最终响应是否缺段');
    const requestIdMatch = String(deliveryChainCheck.detail || '').match(/requestId=([a-zA-Z0-9._:-]+)/);
    if (requestIdMatch?.[1]) {
      printInfo(`快速复盘命令: khy gateway trace ${requestIdMatch[1]}`);
    }
  }
  const languageConsistencyCheck = checks.find(c => c.label === '首段语言一致性' && !c.ok && c.level === 'warn');
  if (languageConsistencyCheck) {
    printInfo('语言偏航排查建议: 结合 `khy gateway status --json` 查看 latestLanguageConsistency，并按 requestId 回查首段正文、最终答复与 KHY 语言注入证据');
    const requestIdMatch = String(languageConsistencyCheck.detail || '').match(/requestId=([a-zA-Z0-9._:-]+)/);
    if (requestIdMatch?.[1]) {
      printInfo(`快速复盘命令: khy gateway trace ${requestIdMatch[1]}`);
    }
  }
  console.log(chalk.cyan('  维护入口'));
  console.log(chalk.dim('    khy docs maintainer              查看维护地图、入口文档、分层验证'));
  console.log(chalk.dim('    npm run maintainer:map           输出维护领域地图'));
  console.log(chalk.dim('    npm run test:maintainer:gateway  执行网关最小回归'));
  console.log('');
}

/**
 * Run all diagnostic checks, return array of { category, label, ok, detail, level }.
 */
function runDoctorChecks() {
  const results = [];
  let activeAdapter = null;
  let activeAdapterName = '';

  // ── Runtime ──────────────────────────────────────────────────────────────
  const nodeVer = process.version;
  const nodeMajor = parseInt(nodeVer.slice(1), 10);
  results.push({
    category: '运行环境',
    label: 'Node.js',
    ok: nodeMajor >= 16,
    detail: `${nodeVer} ${nodeMajor >= 16 ? '(≥16)' : '(需要 ≥16)'}`,
    level: 'error',
  });

  // Python
  let pythonCmd = null;
  let pythonBlocked = false;
  for (const cmd of ['python3', 'python', 'py']) {
    const probe = runProbe(cmd, ['--version']);
    if (!probe.ok) {
      if (probe.reason === 'blocked') pythonBlocked = true;
      continue;
    }
    const ver = probe.output;
    if (ver.includes('Python 3')) {
      pythonCmd = cmd;
      const match = ver.match(/Python (\d+\.\d+\.\d+)/);
      results.push({
        category: '运行环境',
        label: 'Python',
        ok: true,
        detail: `${match ? match[1] : ver} (${cmd})`,
        level: 'warn',
      });
      break;
    }
  }
  if (!pythonCmd) {
    results.push({
      category: '运行环境',
      label: 'Python',
      ok: false,
      detail: pythonBlocked ? '检测受限（权限/沙箱限制）' : '未安装 — 数据获取功能不可用',
      level: 'warn',
    });
  }

  // Git
  const gitProbe = runProbe('git', ['--version']);
  results.push({
    category: '运行环境',
    label: 'Git',
    ok: gitProbe.ok,
    detail: gitProbe.ok ? gitProbe.output : probeFailureDetail(gitProbe, '未安装'),
    level: 'warn',
  });

  // ── Python packages ──────────────────────────────────────────────────────
  if (pythonCmd) {
    const pipCmd = `${pythonCmd} -m pip`;
    for (const pkg of ['akshare']) {
      const installed = !!runSilent(pythonCmd, ['-m', 'pip', 'show', pkg]);
      results.push({
        category: 'Python 依赖',
        label: pkg,
        ok: installed,
        detail: installed ? '已安装' : '未安装',
        level: 'warn',
      });
    }
  }

  // ── Configuration ────────────────────────────────────────────────────────
  results.push({
    category: '项目配置',
    label: '.env 文件',
    ok: fs.existsSync(ENV_FILE),
    detail: fs.existsSync(ENV_FILE) ? '已配置' : '未找到 — 运行 khy init 生成',
    level: 'error',
  });

  // Check node_modules
  const hasNodeModules = fs.existsSync(path.join(ROOT, 'node_modules'));
  results.push({
    category: '项目配置',
    label: 'Node 依赖',
    ok: hasNodeModules,
    detail: hasNodeModules ? '已安装' : '未安装 — 运行 npm install',
    level: 'error',
  });

  // ── Database ─────────────────────────────────────────────────────────────
  // Check if .env has DB_TYPE and if SQLite file exists
  if (fs.existsSync(ENV_FILE)) {
    const envContent = fs.readFileSync(ENV_FILE, 'utf-8');
    const dbType = envContent.match(/DB_TYPE=(\w+)/)?.[1] || 'auto';

    results.push({
      category: '数据库',
      label: '数据库类型',
      ok: true,
      detail: dbType,
      level: 'info',
    });

    if (dbType === 'sqlite' || dbType === 'auto') {
      // Check for SQLite file in common locations
      const sqliteLocations = [
        path.join(ROOT, 'data', 'khy-quant.db'),
        path.join(ROOT, 'khy-quant.db'),
        path.join(ROOT, 'data', 'database.sqlite'),
      ];
      const dbExists = sqliteLocations.some(p => fs.existsSync(p));
      results.push({
        category: '数据库',
        label: 'SQLite 数据文件',
        ok: dbExists,
        detail: dbExists ? '已创建' : '未创建 — 运行 khy db init',
        level: 'warn',
      });
    }
  }

  // ── Network services ─────────────────────────────────────────────────────
  // Redis check
  const redisProbe = runProbe('redis-cli', ['ping']);
  const redisOk = redisProbe.ok && /pong/i.test(String(redisProbe.output || ''));
  const redisOptional = redisProbe.reason === 'missing' || redisProbe.reason === 'blocked';
  let redisDetail = '未运行 — 将使用内存缓存';
  if (redisOk) {
    redisDetail = '运行中';
  } else if (redisProbe.reason === 'missing') {
    redisDetail = '未安装 redis-cli — 跳过服务探测，将使用内存缓存';
  } else if (redisProbe.reason === 'blocked') {
    redisDetail = '检测受限（权限/沙箱限制）— 跳过服务探测，将使用内存缓存';
  } else if (redisProbe.reason === 'timeout') {
    redisDetail = '探测超时 — 将使用内存缓存';
  } else if (redisProbe.reason === 'unavailable') {
    redisDetail = 'Redis 未响应 — 将使用内存缓存';
  }
  results.push({
    category: '可选服务',
    label: 'Redis',
    ok: redisOk || redisOptional,
    detail: redisDetail,
    level: redisOk || redisOptional ? 'info' : 'warn',
  });

  // AI provider check
  if (fs.existsSync(ENV_FILE)) {
    const envContent = fs.readFileSync(ENV_FILE, 'utf-8');
    const aiKeys = [
      'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY',
      'ZHIPU_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    ];
    const hasAiKey = aiKeys.some(key => {
      const match = envContent.match(new RegExp(`^${key}=(.+)$`, 'm'));
      return match && match[1] && !match[1].startsWith('#');
    });
    results.push({
      category: '可选服务',
      label: 'AI 密钥',
      ok: hasAiKey,
      detail: hasAiKey ? '已配置' : '未配置 — 运行 khy ai config',
      level: 'warn',
    });
  }

  const claudeSettingsCheck = inspectClaudeSettingsConflict();
  results.push({
    category: 'AI 能力',
    label: 'Claude 配置隔离',
    ok: claudeSettingsCheck.ok,
    detail: claudeSettingsCheck.detail,
    level: claudeSettingsCheck.level,
  });

  // ── AI Gateway & Tool Calling ─────────────────────────────────────────
  try {
    const aiGateway = require('../../services/gateway/aiGateway');
    const active = aiGateway.getActiveAdapter();
    activeAdapter = active || null;
    activeAdapterName = String(active?.name || '');
    const defaultRouteRecommendation = typeof aiGateway.getDefaultRouteRecommendation === 'function'
      ? aiGateway.getDefaultRouteRecommendation()
      : null;
    results.push({
      category: 'AI 能力',
      label: 'AI 网关',
      ok: !!active,
      detail: active ? `${active.name}${active.activeModel ? ' · ' + active.activeModel : ''}` : '无可用适配器',
      level: 'warn',
    });
    results.push({
      category: 'AI 能力',
      label: '默认推荐通道',
      ok: !!defaultRouteRecommendation,
      detail: defaultRouteRecommendation?.summary || '当前无可用默认路由建议',
      level: defaultRouteRecommendation ? 'info' : 'warn',
    });

    let riskDetail = '当前激活通道由 KHY 网关统一注入最高优先级协议';
    let riskOk = true;
    let riskLevel = 'info';
    try {
      if (typeof aiGateway.getKhyProtocolPriorityRisk === 'function') {
        const risk = aiGateway.getKhyProtocolPriorityRisk(active);
        riskOk = !risk?.risky;
        riskLevel = risk?.level || (riskOk ? 'info' : 'warn');
        riskDetail = risk?.detail || riskDetail;
        if (risk?.risky) {
          riskDetail += _buildGatewayPromptRiskDebugSuffix(active);
        }
      }
    } catch { /* best effort */ }
    results.push({
      category: 'AI 能力',
      label: 'KHY 协议优先级风险',
      ok: riskOk,
      detail: riskDetail,
      level: riskLevel,
    });
  } catch {
    results.push({
      category: 'AI 能力',
      label: 'AI 网关',
      ok: false,
      detail: '加载失败',
      level: 'warn',
    });
    results.push({
      category: 'AI 能力',
      label: '默认推荐通道',
      ok: false,
      detail: '无法加载 AI 网关，无法评估默认路由',
      level: 'warn',
    });
    results.push({
      category: 'AI 能力',
      label: 'KHY 协议优先级风险',
      ok: false,
      detail: '无法加载 AI 网关，无法评估上游覆盖风险',
      level: 'warn',
    });
  }
  const preferredAdapter = String(process.env.GATEWAY_PREFERRED_ADAPTER || '');
  const localModelExpected = isLocalAdapterName(preferredAdapter) || isLocalAdapterName(activeAdapterName);
  results.push(_buildCodexHomeEnvironmentCheck(activeAdapter, preferredAdapter));

  try {
    const aiGateway = require('../../services/gateway/aiGateway');
    const activeAdapterKey = String(activeAdapter?.key || activeAdapter?.type || preferredAdapter || '').trim();
    const runtimeAdapter = activeAdapterKey && typeof aiGateway.getAdapter === 'function'
      ? aiGateway.getAdapter(activeAdapterKey)
      : null;
    const runtimeLabel = activeAdapterKey === 'codex'
      ? 'Codex 自愈状态'
      : (activeAdapter?.name ? `${activeAdapter.name} 运行时诊断` : 'AI 通道运行时诊断');
    if (!runtimeAdapter || typeof runtimeAdapter.getRuntimeDiagnostics !== 'function') {
      results.push({
        category: 'AI 能力',
        label: runtimeLabel,
        ok: true,
        detail: activeAdapterKey
          ? `当前通道 ${activeAdapter?.name || activeAdapterKey} 尚未提供持久化运行时诊断`
          : '当前无活跃通道，暂无运行时诊断',
        level: 'info',
      });
    } else {
      const runtimeDiag = runtimeAdapter.getRuntimeDiagnostics({ includePersisted: true });
      const recentStallDiag = runtimeAdapter.getRuntimeDiagnostics({ includePersisted: true, preferCategory: 'stall' });
      const collectDiagDetails = (diag, { diagnosisLimit = 200, errorLimit = 120 } = {}) => {
        const out = [];
        const timeText = formatLocalTime(diag?.at);
        const diagText = String(diag?.diagnosis || '').replace(/\s+/g, ' ').trim();
        const errorText = String(diag?.lastError || '').replace(/\s+/g, ' ').trim();
        if (timeText) out.push(`时间: ${timeText}`);
        if (diagText) out.push(`自检: ${diagText.slice(0, diagnosisLimit)}`);
        if (errorText) out.push(`错误: ${errorText.slice(0, errorLimit)}`);
        return out;
      };
      const buildHeadline = (diag) => {
        const healed = !!diag?.healed;
        const trigger = String(diag?.trigger || '').trim().toLowerCase();
        const category = String(diag?.category || '').trim().toLowerCase();
        if (healed) {
          return activeAdapterKey === 'codex'
            ? '已执行自愈（sandbox=none，仅当前进程）'
            : '已执行恢复动作';
        }
        if (trigger === 'first_response_timeout') return '检测到首响阻塞，未触发自愈';
        if (category === 'stall' || /timeout|handshake|no_stream|canceled/.test(trigger)) return '检测到通道阻塞，未触发自愈';
        return '检测到通道异常，未触发自愈';
      };
      const hasRecentRecord = runtimeDiag && Number(runtimeDiag.at) > 0;
      if (!hasRecentRecord) {
        results.push({
          category: 'AI 能力',
          label: runtimeLabel,
          ok: true,
          detail: '无近期运行时诊断记录',
          level: 'info',
        });
      } else {
        const detailParts = [buildHeadline(runtimeDiag)];
        detailParts.push(...collectDiagDetails(runtimeDiag));
        const hasRecentStall = recentStallDiag && Number(recentStallDiag.at) > 0;
        const recentStallIsSeparate = hasRecentStall && (
          String(recentStallDiag.trigger || '').trim().toLowerCase() !== String(runtimeDiag.trigger || '').trim().toLowerCase()
          || Number(recentStallDiag.at || 0) !== Number(runtimeDiag.at || 0)
        );
        if (recentStallIsSeparate) {
          detailParts.push(`最近首响阻塞: ${collectDiagDetails(recentStallDiag, {
            diagnosisLimit: 180,
            errorLimit: 110,
          }).join('；') || '已记录'}`);
        }
        results.push({
          category: 'AI 能力',
          label: runtimeLabel,
          ok: !!runtimeDiag.healed,
          detail: detailParts.join('；'),
          level: runtimeDiag.healed ? 'info' : 'warn',
        });
      }
    }
  } catch {
    results.push({
      category: 'AI 能力',
      label: 'AI 通道运行时诊断',
      ok: true,
      detail: '诊断不可用',
      level: 'info',
    });
  }

  // Local loopback listen capability (required by local runner/python/http backends)
  const loopbackProbe = runProbe(process.execPath, [
    '-e',
    'const n=require("net");const s=n.createServer();s.once("error",e=>{console.log("ERR:"+((e&&e.message)||e));process.exit(2)});s.listen(0,"127.0.0.1",()=>{s.close(()=>{console.log("OK");process.exit(0)})});setTimeout(()=>{console.log("ERR:loopback listen probe timed out (1.2s)");process.exit(3)},1200)',
  ]);
  const loopbackBlocked = !loopbackProbe.ok;
  const loopbackDetail = loopbackProbe.ok
    ? '可监听 127.0.0.1（本地模型后端可启动）'
    : (localModelExpected
      ? `受限：${probeFailureDetail(loopbackProbe, loopbackProbe.message ? loopbackProbe.message.slice(0, 120) : 'listen 失败')}`
      : `受限：${probeFailureDetail(loopbackProbe, 'listen 失败')}（当前未启用本地模型，可忽略）`);
  results.push({
    category: 'AI 能力',
    label: '本地监听能力',
    ok: loopbackProbe.ok || !localModelExpected,
    detail: loopbackDetail,
    level: localModelExpected ? 'warn' : 'info',
  });

  // bundled ollama-runner capability
  const bundledRunnerCandidates = [
    path.resolve(__dirname, '../../../bin/ollama-runner/bin/ollama'),
    path.resolve(__dirname, '../../../bin/ollama-runner/bin/ollama.exe'),
  ];
  const bundledRunner = bundledRunnerCandidates.find(p => fs.existsSync(p)) || '';
  const bundledRunnerProbe = bundledRunner ? runProbe(bundledRunner, ['runner', '--help']) : { ok: false, reason: 'missing' };
  const systemRunnerProbe = runProbe(process.platform === 'win32' ? 'ollama.exe' : 'ollama', ['runner', '--help']);
  const runnerProbe = bundledRunnerProbe.ok ? bundledRunnerProbe : systemRunnerProbe;
  const runnerSource = bundledRunnerProbe.ok ? 'bundled' : (systemRunnerProbe.ok ? 'system' : 'none');
  const runnerBaseDetail = runnerProbe.ok
    ? (runnerSource === 'bundled' ? '可执行（内置二进制）' : '可执行（系统 ollama）')
    : (bundledRunner ? probeFailureDetail(runnerProbe, '不可执行') : '未找到二进制（首次使用自动拉取，或 `khy runtime install` 预拉取）');
  results.push({
    category: 'AI 能力',
    label: 'ollama-runner',
    ok: runnerProbe.ok || !localModelExpected,
    detail: runnerProbe.ok
      ? runnerBaseDetail
      : (localModelExpected ? runnerBaseDetail : `${runnerBaseDetail}（当前未启用本地模型，可忽略）`),
    level: localModelExpected ? 'warn' : 'info',
  });

  // bundled llama-cpp binary capability
  const bundledLlamaRoot = path.resolve(__dirname, '../../../bin/llama-cpp');
  const bundledLlamaCandidates = [
    path.join(bundledLlamaRoot, 'llama-completion'),
    path.join(bundledLlamaRoot, 'llama-cli'),
  ];
  if (fs.existsSync(bundledLlamaRoot)) {
    try {
      const dirs = fs.readdirSync(bundledLlamaRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      for (const dir of dirs) {
        bundledLlamaCandidates.push(path.join(bundledLlamaRoot, dir, 'llama-completion'));
        bundledLlamaCandidates.push(path.join(bundledLlamaRoot, dir, 'llama-cli'));
      }
    } catch { /* ignore */ }
  }
  const bundledLlamaBin = bundledLlamaCandidates.find(p => fs.existsSync(p));
  const bundledLlamaProbe = bundledLlamaBin
    ? runProbe(bundledLlamaBin, ['--help'])
    : { ok: false, reason: 'missing' };
  const llamaBaseDetail = bundledLlamaProbe.ok
    ? '已内置（可离线推理）'
    : (bundledLlamaBin ? probeFailureDetail(bundledLlamaProbe, '不可执行') : '未找到二进制（首次使用自动拉取，或 `khy runtime install` 预拉取）');
  results.push({
    category: 'AI 能力',
    label: 'llama-cpp binary',
    ok: bundledLlamaProbe.ok || !localModelExpected,
    detail: bundledLlamaProbe.ok
      ? llamaBaseDetail
      : (localModelExpected ? llamaBaseDetail : `${llamaBaseDetail}（当前未启用本地模型，可忽略）`),
    level: localModelExpected ? 'warn' : 'info',
  });

  // node-llama-cpp direct backend availability
  const llamaCppProbe = runProbe(process.execPath, [
    '-e',
    `require.resolve("node-llama-cpp",{paths:[${JSON.stringify(path.join(ROOT, 'backend'))}]});console.log("OK")`,
  ]);
  const hasBundledLocalBackend = runnerProbe.ok || bundledLlamaProbe.ok;
  const nodeLlamaDetail = llamaCppProbe.ok
    ? '已安装（可用进程内本地推理）'
    : (hasBundledLocalBackend
      ? '未安装（已内置 runner/llama-cpp，可正常本地推理）'
      : (localModelExpected
        ? '未安装 — 本地模型仅能依赖 runner/python/http 后端'
        : '未安装（当前未启用本地模型，可忽略）'));
  results.push({
    category: 'AI 能力',
    label: 'node-llama-cpp',
    ok: llamaCppProbe.ok || hasBundledLocalBackend || !localModelExpected,
    detail: nodeLlamaDetail,
    level: localModelExpected && loopbackBlocked && !hasBundledLocalBackend ? 'warn' : 'info',
  });

  if (localModelExpected && loopbackBlocked && !llamaCppProbe.ok && !hasBundledLocalBackend) {
    results.push({
      category: 'AI 能力',
      label: '本地模型可用性',
      ok: false,
      detail: '当前环境无法启动本地模型后端（监听受限且无 node-llama-cpp）',
      level: 'warn',
    });
  }

  // Ollama 推理服务在线探测 + 模型匹配自动纠正。
  // 上游 goal: 内置 node-llama-cpp 对较新 GGUF（如 Qwen 3.5）超参不兼容时，Ollama 是
  // 推荐的本地推理回退路径。doctor 在此真实探测 OLLAMA_HOST/api/tags（与 loopback 检查
  // 同样的子进程沙箱方式，保持一致），并据 diagnoseOllamaModel 的纯判定给出「在线/已装模型
  // /同系需改 OLLAMA_MODEL/未装需 pull」的可执行结论——把诊断落到能直接照做的一步。
  try {
    const localLLM = require('../../services/localLLMService');
    const tagsProbe = runProbe(process.execPath, [
      '-e',
      'const http=require("http");const u=new URL((process.env.OLLAMA_HOST||"http://localhost:11434").replace(/\\/+$/,"")+"/api/tags");const req=http.get(u,{timeout:1500},res=>{let b="";res.on("data",d=>b+=d);res.on("end",()=>{try{const j=JSON.parse(b);const names=(j.models||[]).map(m=>m&&m.name).filter(Boolean);console.log("TAGS:"+JSON.stringify(names));process.exit(0)}catch(e){console.log("ERR:parse "+(e&&e.message));process.exit(2)}})});req.on("error",e=>{console.log("ERR:"+((e&&e.message)||e));process.exit(3)});req.on("timeout",()=>{req.destroy();console.log("ERR:timeout");process.exit(4)});',
    ]);
    let tags = [];
    if (tagsProbe.ok) {
      const m = String(tagsProbe.output || '').match(/TAGS:(\[.*\])/);
      if (m) { try { tags = JSON.parse(m[1]); } catch { tags = []; } }
    }
    const verdict = localLLM.diagnoseOllamaModel({
      online: !!tagsProbe.ok,
      tags,
      configuredModel: localLLM.OLLAMA_MODEL,
    });
    // 未启用本地模型时，离线只是「未配置」而非故障，降为 info 且判定 ok（可忽略）。
    const softWhenNotExpected = !verdict.ok && !localModelExpected && !tagsProbe.ok;
    results.push({
      category: 'AI 能力',
      label: 'Ollama 推理服务',
      ok: verdict.ok || softWhenNotExpected,
      detail: softWhenNotExpected ? `${verdict.detail}（当前未启用本地模型，可忽略）` : verdict.detail,
      level: verdict.ok || softWhenNotExpected ? 'info' : (localModelExpected ? 'warn' : 'info'),
    });
  } catch {
    // diagnose 不可用不应阻断 doctor 其它检查。
  }

  // Tool calling support
  try {
    const toolCalling = require('../../services/toolCalling');
    const tools = toolCalling.listTools();
    results.push({
      category: 'AI 能力',
      label: '工具调用',
      ok: tools.length > 0,
      detail: `${tools.length} 个工具注册`,
      level: 'info',
    });

    const dangerMode = toolCalling.isDangerousMode();
    results.push({
      category: 'AI 能力',
      label: '安全模式',
      ok: !dangerMode,
      detail: dangerMode ? '⚠ 危险模式已开启 (跳过权限确认)' : '正常 (工具调用需确认)',
      level: dangerMode ? 'warn' : 'info',
    });
  } catch { /* ignore */ }

  results.push(_buildCodingAgentSmokeCheck(activeAdapter));
  const latestDeliveryRequestCheck = _buildLatestDeliveryRequestDetail();
  results.push({
    category: 'AI 能力',
    label: '最近交付链路',
    ok: latestDeliveryRequestCheck.ok,
    detail: latestDeliveryRequestCheck.detail,
    level: latestDeliveryRequestCheck.level,
  });
  const latestLanguageConsistencyCheck = _buildLatestLanguageConsistencyDetail();
  results.push({
    category: 'AI 能力',
    label: '首段语言一致性',
    ok: latestLanguageConsistencyCheck.ok,
    detail: latestLanguageConsistencyCheck.detail,
    level: latestLanguageConsistencyCheck.level,
  });

  // MCP servers — canonical loader (mcpServers map, project + user + legacy).
  try {
    const mcp = require('../../services/mcp');
    const mcpConfig = mcp.loadConfig(process.cwd());
    const entries = Object.entries(mcpConfig.mcpServers || {});
    const serverCount = entries.length;
    const enabledCount = entries.filter(([, c]) => !c._disabled).length;
    results.push({
      category: 'AI 能力',
      label: 'MCP 服务器',
      ok: true,
      detail: serverCount > 0 ? `${enabledCount}/${serverCount} 已启用` : '未配置 — 在 ~/.khy/mcp.json 中添加',
      level: 'info',
    });
  } catch { /* ignore */ }

  // ── Ecosystem ─────────────────────────────────────────────────────────
  try {
    const skillRegistry = require('../../services/skillRegistry');
    const installed = skillRegistry.getInstalledSkills();
    results.push({
      category: '生态系统',
      label: 'Skills',
      ok: true,
      detail: `5 内置 + ${installed.length} 已安装`,
      level: 'info',
    });
  } catch { /* ignore */ }

  try {
    const cloudSync = require('../../services/cloudSync');
    const loggedIn = cloudSync.isLoggedIn();
    results.push({
      category: '生态系统',
      label: '云端连接',
      ok: loggedIn,
      detail: loggedIn ? `已登录 (${cloudSync.getUsername()})` : '未登录 — 可选: khy cloud login',
      level: loggedIn ? 'info' : 'warn',
    });
  } catch { /* ignore */ }

  // User profile
  try {
    const userProfile = require('../../services/userProfile');
    const profile = userProfile.getProfile();
    results.push({
      category: '生态系统',
      label: '用户画像',
      ok: true,
      detail: `等级: ${profile.skillLevel || 'beginner'} · 命令: ${profile.commandCount || 0}次`,
      level: 'info',
    });
  } catch { /* ignore */ }

  // ── 离机还原自检 (fresh-machine off-machine-restore) ───────────────────────
  // Shipped, human-facing "真实原因 + 解决方法" for a fresh pip/npm install:
  // launch entry, server entry, dependency hydration, khy-command reachability,
  // and the OPTIONAL proxy-core (mihomo) download hint (代理二进制去哪下载 — the
  // headless/off-machine user's only such surface, no web UI). Gated
  // KHY_DOCTOR_FRESH_INSTALL (default-on); fail-soft — never breaks doctor.
  try {
    const { freshInstallChecks } = require('../../services/freshInstallDoctor');
    for (const c of freshInstallChecks({
      bundleRoot: ROOT,
      existsSync: fs.existsSync,
      readdir: fs.readdirSync,
      env: process.env,
      platform: process.platform,
      arch: process.arch,
    })) {
      results.push(c);
    }
  } catch { /* ignore — add-on must never crash doctor */ }

  return results;
}

module.exports = {
  handleInit,
  handleDoctor,
  runDoctorChecks,
  inspectClaudeSettingsConflict,
  fixClaudeSettingsConflict,
};
