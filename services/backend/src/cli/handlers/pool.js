/**
 * CLI handlers for login account pool management.
 * Commands:
 *   pool list [provider]
 *   pool import <windsurf|kiro|trae|cursor|warp|antigravity|nirvana> [path]
 *   pool use <provider> <id|label|email>
 *   pool add <provider> [token]
 *   pool delete <id|label|email>
 *   pool enable <id|label|email>
 *   pool disable <id|label|email>
 *   pool status
 *   pool scheduling [mode]
 *   pool api [clientLabel]
 *   pool auto-import now [provider] [sourcePath]
 */
const chalk = require('chalk').default || require('chalk');
const { printSuccess, printError, printInfo, printTable } = require('../formatters');

function getPool() {
  return require('../../services/accountPool');
}

const IMPORTABLE_PROVIDERS = ['windsurf', 'kiro', 'trae', 'cursor', 'warp', 'antigravity', 'nirvana'];
const VALID_SCHEDULING_MODES = ['PerformanceFirst', 'Balance', 'CacheFirst'];
const IMPORT_PROVIDER_ALIAS = Object.freeze({
  nir: 'nirvana',
  nrv: 'nirvana',
  ag: 'antigravity',
});
const PROVIDER_CANONICAL_MAP = Object.freeze({
  antigravity: 'trae',
  nirvana: 'trae',
});

function canonicalProvider(provider) {
  const raw = String(provider || '').trim().toLowerCase();
  return PROVIDER_CANONICAL_MAP[raw] || raw;
}

function normalizeImportProvider(provider) {
  const raw = String(provider || '').trim().toLowerCase();
  return IMPORT_PROVIDER_ALIAS[raw] || raw;
}

const IMPORTABLE_PROVIDER_CANONICAL = [...new Set(IMPORTABLE_PROVIDERS.map(canonicalProvider))];

function statusColor(status) {
  const st = String(status || '').toLowerCase();
  if (st === 'active') return chalk.green;
  if (st === 'disabled') return chalk.dim;
  if (st === 'banned' || st === 'invalid') return chalk.red;
  if (st === 'leased' || st === 'cooldown') return chalk.yellow;
  return chalk.white;
}

async function findAccountByNeedle(pool, needle) {
  const accounts = await pool.getAllAccounts();
  const key = String(needle || '').trim().toLowerCase();
  if (!key) return null;
  return accounts.find(a =>
    String(a.id) === key ||
    String(a.label || '').trim().toLowerCase() === key ||
    String(a.email || '').trim().toLowerCase() === key
  ) || null;
}

async function handlePoolList(provider) {
  const pool = getPool();
  await pool.init();
  const norm = String(provider || '').trim().toLowerCase();
  const accounts = await pool.getAllAccounts(norm || '');

  if (accounts.length === 0) {
    printInfo(norm
      ? `账号池中暂无 ${norm} 账号，使用 pool import ${norm} 或 pool add ${norm} 添加`
      : `账号池为空，使用 pool import <${IMPORTABLE_PROVIDERS.join('|')}> 导入`);
    return;
  }

  console.log('');
  console.log(`  ${chalk.cyan.bold('账号池列表')}`);
  console.log('');
  printTable(
    ['ID', '提供商', '标签', '状态', 'Token', '来源'],
    accounts.map(a => [
      String(a.id),
      a.provider,
      a.label || a.email || chalk.dim('-'),
      statusColor(a.status)(a.status),
      chalk.dim(a.tokenPreview || '***'),
      a.sourcePath ? chalk.dim(a.sourcePath) : chalk.dim('-'),
    ])
  );
  console.log('');
}

async function handlePoolImport(provider, sourcePathArg) {
  const pool = getPool();
  await pool.init();

  let target = normalizeImportProvider(provider);
  if (!target) {
    const { promptCompat } = require('../uiPrompt');
    const { picked } = await promptCompat([{
      type: 'list',
      name: 'picked',
      message: '选择要导入的登录账号来源:',
      choices: [
        ...IMPORTABLE_PROVIDERS,
        { name: '↩️  返回', value: null },
      ],
    }]);
    if (!picked) return;
    target = normalizeImportProvider(picked);
  }

  const sourcePath = String(sourcePathArg || '').trim();
  if (!IMPORTABLE_PROVIDERS.includes(target) && !sourcePath) {
    printError(`不支持的提供商: ${target}。若为自定义来源，请提供导入路径：pool import ${target} <path>`);
    printInfo(`内置可选: ${IMPORTABLE_PROVIDERS.join(', ')}`);
    return;
  }
  try {
    const result = await pool.importProviderTokens(target, {
      activateIfNone: true,
      ...(sourcePath ? { sourcePath } : {}),
    });
    printSuccess(`已导入 ${target} 账号: 发现 ${result.found}，新增 ${result.inserted}，更新 ${result.updated}`);
    const byProvider = result && result.byProvider && typeof result.byProvider === 'object'
      ? result.byProvider
      : {};
    const providerRows = Object.entries(byProvider).filter(([, v]) => Number(v?.found || 0) > 0);
    if (providerRows.length > 1 || target === 'nirvana' || target === 'antigravity') {
      console.log('');
      printTable(
        ['提供商', '发现', '新增', '更新', '激活'],
        providerRows.map(([providerName, stats]) => [
          providerName,
          String(stats?.found || 0),
          String(stats?.inserted || 0),
          String(stats?.updated || 0),
          stats?.activated ? chalk.green(String(stats.activated)) : chalk.dim('-'),
        ])
      );
      console.log('');
    }
    if (sourcePath) {
      printInfo(`导入源路径: ${sourcePath}`);
    }
    if (result.activated) {
      printInfo(`已自动激活账号 ID: ${result.activated}`);
    } else {
      printInfo('当前激活账号保持不变');
    }
  } catch (err) {
    printError(`导入失败: ${err.message}`);
  }
}

async function refreshGatewayAfterAccountSwitch(provider) {
  const adapterKey = canonicalProvider(provider);
  if (!adapterKey) return { adapterKey: '', skipped: true, reason: 'invalid-provider' };

  try {
    const gateway = require('../../services/gateway/aiGateway');
    if (!gateway._initialized) await gateway.init();

    const reconnect = await gateway.forceReconnect(adapterKey);
    try { await gateway.refreshAdapters(); } catch { /* best effort */ }

    let modelCount = null;
    try {
      const models = await gateway.listModels(adapterKey);
      if (Array.isArray(models)) modelCount = models.length;
    } catch { /* best effort */ }

    return { adapterKey, reconnect, modelCount };
  } catch (error) {
    return { adapterKey, error };
  }
}

async function handlePoolUse(provider, idOrLabel) {
  const pool = getPool();
  await pool.init();

  const p = String(provider || '').trim().toLowerCase();
  const key = String(idOrLabel || '').trim();
  if (!p || !key) {
    printError('用法: pool use <provider> <id|label|email>');
    return;
  }

  try {
    const used = await pool.useAccount(p, key);
    if (!used) {
      printError('切换失败：未找到目标账号');
      return;
    }
    printSuccess(`已切换 ${p} 当前账号: ${used.label || used.email || `ID ${used.id}`}`);
    printInfo(`Token: ${used.tokenPreview}`);
    try {
      const sync = await pool.syncActiveAccountToLocal(p);
      if (sync.updated > 0) {
        printInfo(`已同步到本地客户端存储: ${sync.updated}/${sync.attempted}`);
      } else if (sync.reason) {
        printInfo(`本地同步未执行: ${sync.reason}`);
      }
    } catch (syncErr) {
      printInfo(`本地同步失败: ${syncErr.message}`);
    }

    const gatewayRefresh = await refreshGatewayAfterAccountSwitch(p);
    if (gatewayRefresh?.error) {
      printInfo(`AI 网关刷新跳过: ${gatewayRefresh.error.message}`);
    } else if (gatewayRefresh?.reconnect?.available) {
      const modelText = Number.isFinite(gatewayRefresh.modelCount)
        ? `（模型 ${gatewayRefresh.modelCount}）`
        : '';
      printInfo(`AI 网关已刷新 ${gatewayRefresh.adapterKey}${modelText}`);
    } else if (gatewayRefresh?.adapterKey) {
      const reason = gatewayRefresh?.reconnect?.error || '未检测到可用通道';
      printInfo(`AI 网关已刷新 ${gatewayRefresh.adapterKey}，但当前不可用: ${reason}`);
    }

    printInfo('可运行 pool api <客户端名> 生成外部可用 API token');
  } catch (err) {
    printError(`切换失败: ${err.message}`);
  }
}

async function handlePoolAdd(provider, tokenArg) {
  const pool = getPool();
  await pool.init();

  const p = String(provider || '').trim().toLowerCase();
  if (!p) {
    printError('用法: pool add <provider> [token]');
    return;
  }

  let token = String(tokenArg || '').trim();
  let label = '';
  const { promptCompat } = require('../uiPrompt');

  if (!token) {
    const answers = await promptCompat([
      {
        type: 'password',
        name: 'token',
        message: `${p} access token:`,
        mask: '*',
        validate: v => v.length > 0 ? true : '请输入 token',
      },
      {
        type: 'input',
        name: 'label',
        message: '标签（可选）:',
        default: '',
      },
    ]);
    token = String(answers.token || '').trim();
    label = String(answers.label || '').trim();
  } else {
    const answers = await promptCompat([{
      type: 'input',
      name: 'label',
      message: '标签（可选）:',
      default: '',
    }]);
    label = String(answers.label || '').trim();
  }

  if (!token) {
    printError('token 不能为空');
    return;
  }

  try {
    const account = await pool.addAccount({
      provider: p,
      apiKey: token,
      label: label || null,
      tier: 'LOGIN',
      source: 'manual',
      priority: 10,
    });
    printSuccess(`已添加账号: ${p} ${account?.tokenPreview || ''}`.trim());

    const { activateNow } = await promptCompat([{
      type: 'confirm',
      name: 'activateNow',
      message: '是否立即设为当前账号?',
      default: true,
    }]);
    if (activateNow && account?.id) {
      await pool.useAccount(p, String(account.id));
      printSuccess('已设为当前账号');
    }
  } catch (err) {
    printError(`添加失败: ${err.message}`);
  }
}

async function handlePoolDelete(idOrLabel) {
  const pool = getPool();
  await pool.init();

  const key = String(idOrLabel || '').trim();
  if (!key) {
    printError('用法: pool delete <id|label|email>');
    return;
  }

  const target = await findAccountByNeedle(pool, key);
  if (!target) {
    printError(`未找到账号: ${key}`);
    return;
  }

  const { promptCompat } = require('../uiPrompt');
  const { confirm } = await promptCompat([{
    type: 'confirm',
    name: 'confirm',
    message: `确认删除 ${target.provider} 账号 "${target.label || target.email || target.id}"?`,
    default: false,
  }]);
  if (!confirm) return;

  try {
    await pool.removeAccount(target.id);
    printSuccess('账号已删除');
  } catch (err) {
    printError(`删除失败: ${err.message}`);
  }
}

async function handlePoolEnable(idOrLabel) {
  const pool = getPool();
  await pool.init();

  const key = String(idOrLabel || '').trim();
  if (!key) {
    printError('用法: pool enable <id|label|email>');
    return;
  }

  const target = await findAccountByNeedle(pool, key);
  if (!target) {
    printError(`未找到账号: ${key}`);
    return;
  }

  try {
    await pool.enableAccount(target.id);
    printSuccess(`已启用账号: ${target.label || target.email || target.id}`);
  } catch (err) {
    printError(`启用失败: ${err.message}`);
  }
}

async function handlePoolDisable(idOrLabel) {
  const pool = getPool();
  await pool.init();

  const key = String(idOrLabel || '').trim();
  if (!key) {
    printError('用法: pool disable <id|label|email>');
    return;
  }

  const target = await findAccountByNeedle(pool, key);
  if (!target) {
    printError(`未找到账号: ${key}`);
    return;
  }

  try {
    await pool.disableAccount(target.id);
    printSuccess(`已禁用账号: ${target.label || target.email || target.id}`);
  } catch (err) {
    printError(`禁用失败: ${err.message}`);
  }
}

async function handlePoolStatus() {
  const pool = getPool();
  await pool.init();
  const status = await pool.getStatus();

  console.log('');
  console.log(`  ${chalk.cyan.bold('账号池概览')}`);
  console.log('');
  console.log(`  总账号: ${chalk.white.bold(String(status.totalAccounts || 0))}`);
  console.log(`  调度模式: ${chalk.cyan(status.schedulingMode || 'Balance')}`);
  console.log(`  熔断器: ${status.circuitBreaker?.enabled ? chalk.green('启用') : chalk.dim('禁用')}`);
  console.log('');

  const rows = Object.entries(status.byProvider || {});
  if (rows.length === 0) {
    printInfo('暂无账号');
    console.log('');
    return;
  }

  printTable(
    ['提供商', '总数', '当前', '可用', '禁用', '异常'],
    rows.map(([provider, s]) => [
      provider,
      String(s.total || 0),
      chalk.green(String(s.active || 0)),
      String((s.available || 0) + (s.cooldown || 0)),
      s.disabled > 0 ? chalk.dim(String(s.disabled)) : '0',
      (s.banned || 0) > 0 ? chalk.red(String(s.banned || 0)) : '0',
    ])
  );

  console.log('');
  for (const provider of IMPORTABLE_PROVIDER_CANONICAL) {
    const active = await pool.getActiveAccount(provider);
    if (!active) continue;
    console.log(`  ${chalk.dim(provider)} 当前: ${chalk.white(active.label || active.email || `ID ${active.id}`)} ${chalk.dim(active.tokenPreview || '')}`);
  }
  console.log('');
}

async function handlePoolScheduling(mode) {
  const pool = getPool();
  await pool.init();

  const m = String(mode || '').trim();
  if (!m) {
    const cfg = await pool.getSchedulingConfig();
    console.log('');
    console.log(`  当前调度模式: ${chalk.cyan.bold(cfg.schedulingMode)}`);
    console.log(`  最大等待秒数: ${cfg.maxWaitSeconds}s`);
    console.log('');
    console.log(chalk.dim(`  可用模式: ${VALID_SCHEDULING_MODES.join(', ')}`));
    console.log(chalk.dim('  用法: pool scheduling <mode>'));
    console.log('');
    return;
  }

  if (!VALID_SCHEDULING_MODES.includes(m)) {
    printError(`无效模式: ${m}。可选: ${VALID_SCHEDULING_MODES.join(', ')}`);
    return;
  }

  await pool.setSchedulingConfig({ schedulingMode: m });
  printSuccess(`调度模式已切换为: ${m}`);
}

async function pickDefaultClientLabel(pool) {
  for (const provider of IMPORTABLE_PROVIDER_CANONICAL) {
    const active = await pool.getActiveAccount(provider);
    if (!active) continue;
    const base = active.label || active.email || provider;
    return `${provider}-${String(base).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  }
  return `khy-client-${Date.now()}`;
}

async function handlePoolApi(clientLabel) {
  const pool = getPool();
  await pool.init();

  const label = String(clientLabel || '').trim() || await pickDefaultClientLabel(pool);
  const proxyHandler = require('./proxy');
  await proxyHandler.handleProxyQuickstart([label], {});
}

function normalizePoolProvider(value = '') {
  const raw = normalizeImportProvider(value);
  if (!raw) return '';
  return canonicalProvider(raw);
}

function printPoolAutoImportUsage() {
  console.log('');
  console.log(chalk.cyan.bold('  pool auto-import 命令'));
  console.log('');
  console.log(chalk.dim('  pool auto-import now'));
  console.log(chalk.dim('  pool auto-import now <provider>'));
  console.log(chalk.dim('  pool auto-import now <provider> <sourcePath>'));
  console.log(chalk.dim('  pool auto-import now <sourcePath>'));
  console.log('');
  console.log(chalk.dim('  说明:'));
  console.log(chalk.dim('    1) now 会强制触发一次导入（绕过冷却时间）'));
  console.log(chalk.dim('    2) 默认导入源优先读取 KHY_POOL_AUTO_IMPORT_SOURCE，其次 ~/Downloads/nirvana-source.zip'));
  console.log(chalk.dim(`    3) provider 可选: ${IMPORTABLE_PROVIDER_CANONICAL.join(', ')}`));
  console.log('');
}

async function handlePoolAutoImport(action, arg1, arg2) {
  const pool = getPool();
  await pool.init();

  const sub = String(action || '').trim().toLowerCase();
  if (!sub || sub === 'help' || sub === 'status') {
    printPoolAutoImportUsage();
    return;
  }
  if (!['now', 'run', 'force'].includes(sub)) {
    printError(`未知 auto-import 子命令: ${sub}`);
    printPoolAutoImportUsage();
    return;
  }

  const rawArg1 = String(arg1 || '').trim();
  const rawArg2 = String(arg2 || '').trim();
  const parsedProvider = normalizePoolProvider(rawArg1);

  const provider = parsedProvider || '';
  const sourcePath = provider
    ? rawArg2
    : rawArg1;

  if (provider && !IMPORTABLE_PROVIDER_CANONICAL.includes(provider)) {
    printError(`不支持的 provider: ${provider}`);
    printInfo(`可选 provider: ${IMPORTABLE_PROVIDER_CANONICAL.join(', ')}`);
    return;
  }

  const targets = provider ? [provider] : IMPORTABLE_PROVIDER_CANONICAL.slice();
  const rows = [];
  let totalFound = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let importedCount = 0;

  for (const p of targets) {
    let result = null;
    try {
      result = await pool.autoImportObservedCredentials(p, {
        force: true,
        ...(sourcePath ? { sourcePath } : {}),
      });
    } catch (err) {
      result = {
        provider: p,
        imported: false,
        skipped: true,
        reason: 'import_failed',
        error: err?.message || String(err),
      };
    }

    const found = Number(result?.found || 0);
    const inserted = Number(result?.inserted || 0);
    const updated = Number(result?.updated || 0);
    totalFound += found;
    totalInserted += inserted;
    totalUpdated += updated;
    if (result?.imported) importedCount += 1;

    rows.push([
      p,
      result?.imported ? chalk.green('导入') : chalk.dim('跳过'),
      String(found),
      String(inserted),
      String(updated),
      result?.reason || '-',
      result?.sourcePath ? chalk.dim(result.sourcePath) : chalk.dim('-'),
      result?.error ? chalk.red(result.error) : chalk.dim('-'),
    ]);
  }

  console.log('');
  printTable(
    ['Provider', '结果', '发现', '新增', '更新', '原因', '来源', '错误'],
    rows
  );
  console.log('');
  if (sourcePath) printInfo(`导入源路径: ${sourcePath}`);
  printSuccess(`auto-import 完成: provider ${targets.length}，执行 ${importedCount}，发现 ${totalFound}，新增 ${totalInserted}，更新 ${totalUpdated}`);
}

module.exports = {
  handlePoolList,
  handlePoolAdd,
  handlePoolDelete,
  handlePoolEnable,
  handlePoolDisable,
  handlePoolStatus,
  handlePoolScheduling,
  handlePoolImport,
  handlePoolUse,
  handlePoolApi,
  handlePoolAutoImport,
};
