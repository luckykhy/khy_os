'use strict';

/**
 * CLI Handler: `khy credentials` — 凭据审计与管理。
 *
 * 子命令：
 *   khy credentials list [limit] [type] 列出抓取的凭据
 *   khy credentials status              凭据统计
 *   khy credentials scan                扫描配置文件中的凭据
 *   khy credentials clear               清空凭据记录
 *   khy credentials export              导出凭据清单（脱敏）
 */

const chalk = require('chalk').default || require('chalk');
const { printError, printWarn, printInfo, printTable } = require('../formatters');
const fs = require('fs');
const path = require('path');
const os = require('os');

function formatTimestamp(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function credentialStatus() {
  const { credentialHarvester } = require('../../services/gateway/credential-harvester');
  const stats = credentialHarvester.store.getStats();
  console.log(`\n  ${chalk.cyan.bold('凭据审计统计')}\n`);
  console.log(`  总凭据数: ${chalk.bold(stats.total)}`);
  if (Object.keys(stats.types).length > 0) {
    console.log(`\n  ${chalk.cyan('按类型分布:')}`);
    const rows = Object.entries(stats.types).map(([type, count]) => [type, String(count)]);
    printTable(['类型', '数量'], rows);
  }
  if (Object.keys(stats.sources).length > 0) {
    console.log(`\n  ${chalk.cyan('按来源分布:')}`);
    const rows = Object.entries(stats.sources).map(([source, count]) => [source, String(count)]);
    printTable(['来源', '数量'], rows);
  }
}

function credentialList(args) {
  const { credentialHarvester } = require('../../services/gateway/credential-harvester');
  const limit = parseInt(args[0], 10) || 20;
  const typeFilter = args[1] || '';

  let credentials = credentialHarvester.store.query({ limit: limit * 2 });
  if (typeFilter) {
    credentials = credentials.filter((c) => c.type === typeFilter);
  }
  credentials = credentials.slice(0, limit);

  if (credentials.length === 0) {
    printInfo('暂无凭据记录。');
    printInfo('提示：凭据在 AI API 调用时自动抓取（需开启流量捕获）。');
    return;
  }

  console.log(`\n  ${chalk.cyan.bold(`最近 ${credentials.length} 条凭据`)}\n`);
  const rows = credentials.map((c) => [
    formatTimestamp(c.timestamp),
    c.type,
    c.source,
    c.name,
    c.prefix,
  ]);
  printTable(['时间', '类型', '来源', '名称', '预览'], rows);
}

function credentialClear() {
  const { credentialHarvester } = require('../../services/gateway/credential-harvester');
  const count = credentialHarvester.store.getStats().total;
  credentialHarvester.store.clear();
  printInfo(`已清空 ${count} 条凭据记录。`);
}

function credentialExport() {
  const { credentialHarvester } = require('../../services/gateway/credential-harvester');
  const outputPath = path.join(os.tmpdir(), `khy-credentials-${Date.now()}.json`);
  const data = credentialHarvester.store.export();

  try {
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf8');
    printInfo(`已导出 ${data.length} 条凭据到: ${outputPath}`);
  } catch (err) {
    printError(`导出失败: ${err.message}`);
  }
}

/**
 * 扫描 KhyOS 配置文件中的凭据。
 * 扫描路径：
 *   - ~/.khyquant/config.json (API keys, tokens)
 *   - ~/.khyquant/token_usage.json
 *   - .khy/ 目录下的 JSON 配置
 *   - .khyos/ 目录下的配置
 */
function credentialScan() {
  console.log(`\n  ${chalk.cyan.bold('扫描 KhyOS 配置文件中的凭据')}\n`);

  const scanPaths = [
    path.join(os.homedir(), '.khyquant', 'config.json'),
    path.join(os.homedir(), '.khyquant', 'token_usage.json'),
    path.join(os.homedir(), '.khyquant', 'conversations'),
    path.join(process.cwd(), '.khy'),
    path.join(process.cwd(), '.khyos'),
  ];

  const { credentialHarvester } = require('../../services/gateway/credential-harvester');
  let totalFound = 0;

  for (const scanPath of scanPaths) {
    if (!fs.existsSync(scanPath)) {
      continue;
    }

    const stat = fs.statSync(scanPath);
    if (stat.isDirectory()) {
      totalFound += scanDirectory(scanPath, credentialHarvester);
    } else {
      totalFound += scanFile(scanPath, credentialHarvester);
    }
  }

  if (totalFound > 0) {
    printInfo(`扫描完成，发现 ${totalFound} 个凭据。`);
    printInfo('使用 `khy credentials list` 查看详细信息。');
  } else {
    printInfo('扫描完成，未发现凭据。');
  }
}

function scanDirectory(dirPath, credentialHarvester) {
  let found = 0;
  let entries;
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        found += scanDirectory(fullPath, credentialHarvester);
      } else if (stat.isFile() && shouldScanFile(entry)) {
        found += scanFile(fullPath, credentialHarvester);
      }
    } catch {
      /* skip */
    }
  }
  return found;
}

function shouldScanFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ['.json', '.env', '.conf', '.cfg', '.yaml', '.yml', '.toml'].includes(ext);
}

function scanFile(filePath, credentialHarvester) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return 0;
  }

  let data;
  try {
    data = JSON.parse(content);
  } catch {
    // 非 JSON 文件，尝试 KEY=VALUE 格式
    return scanEnvFile(filePath, content, credentialHarvester);
  }

  // 递归扫描 JSON 对象
  return scanObject(data, filePath, credentialHarvester);
}

function scanObject(obj, source, credentialHarvester, prefix = '') {
  let found = 0;
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (isCredentialKey(key) && typeof value === 'string' && value.length > 0) {
      credentialHarvester.store.add({
        id: require('crypto').randomUUID(),
        timestamp: Date.now(),
        type: classifyCredentialType(key),
        source: `file:${source}`,
        name: fullKey,
        valueHash: require('crypto').createHash('sha256').update(value).digest('hex'),
        prefix: value.length > 4 ? value.slice(0, 4) + '****' : '****',
        metadata: { sourceFile: source },
      });
      found++;
    } else if (value && typeof value === 'object') {
      found += scanObject(value, source, credentialHarvester, fullKey);
    }
  }
  return found;
}

function scanEnvFile(filePath, content, credentialHarvester) {
  let found = 0;
  const lines = content.split('\n');
  for (const line of lines) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (match) {
      const [, key, value] = match;
      if (isCredentialKey(key) && value.length > 0) {
        credentialHarvester.store.add({
          id: require('crypto').randomUUID(),
          timestamp: Date.now(),
          type: classifyCredentialType(key),
          source: `file:${filePath}`,
          name: key,
          valueHash: require('crypto').createHash('sha256').update(value).digest('hex'),
          prefix: value.length > 4 ? value.slice(0, 4) + '****' : '****',
          metadata: { sourceFile: filePath },
        });
        found++;
      }
    }
  }
  return found;
}

function isCredentialKey(key) {
  const patterns = [
    /api[_-]?key/i,
    /token/i,
    /secret/i,
    /password/i,
    /passwd/i,
    /auth/i,
    /credential/i,
    /access[_-]?key/i,
    /private[_-]?key/i,
    /client[_-]?id/i,
    /client[_-]?secret/i,
    /bearer/i,
    /jwt/i,
    /session/i,
  ];
  return patterns.some((p) => p.test(key));
}

function classifyCredentialType(key) {
  const lower = key.toLowerCase();
  if (lower.includes('api_key') || lower.includes('apikey') || lower.includes('access_key')) {
    return 'api_key';
  }
  if (lower.includes('token') || lower.includes('bearer') || lower.includes('jwt')) {
    return 'bearer_token';
  }
  if (lower.includes('secret') || lower.includes('client_secret') || lower.includes('private_key')) {
    return 'secret';
  }
  if (lower.includes('password') || lower.includes('passwd')) {
    return 'password';
  }
  if (lower.includes('session')) {
    return 'session';
  }
  return 'unknown';
}

async function handleCredentials(subCommand, args = [], _options = {}) {
  const sub = String(subCommand || 'list').toLowerCase();

  switch (sub) {
    case 'list':
    case 'ls':
      return credentialList(args);
    case 'status':
    case 'st':
      return credentialStatus();
    case 'scan':
      return credentialScan();
    case 'clear':
    case 'cls':
      return credentialClear();
    case 'export':
    case 'ex':
      return credentialExport();
    default:
      printWarn(`未知子命令: ${sub}`);
      printInfo('可用: list | status | scan | clear | export');
  }
}

module.exports = { handleCredentials };
