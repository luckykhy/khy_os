'use strict';

const path = require('path');

const { humanBytes } = require('../services/byteFormat');

// ── 日志文件定位(与 winston transport 同源)────────────────────────────────
//
// 这里曾经自己拼路径:`(KHYQUANT_ROOT || <backend 根>)/logs/error.log`。而两个
// DailyRotateFile transport 实际写的是 `<data home>/logs/active/error-%DATE%.log`
// —— 目录和文件名双错。后果不是报错,而是**静默说谎**:两个 existsSync 恒为 false,
// 于是 `log clear` 一个字节没动却打印「日志已清理」,`log`/`log tail` 永远打印
// 「暂无日志文件 — 系统运行正常」。用户拿不到真日志,也永远清不掉旧日志。
//
// 现在只认 `logger.LOG_DIR` 这一个真源:它就是 transport 的 dirname(已含
// KHY_LOG_LAYOUT 的 active/legacy 分层),不做任何二次推导。测试可经工厂的
// `logDir` 依赖注入临时目录,不必去凑 env 优先级。
function _resolveLogDir(deps) {
  const injected = deps && deps.logDir;
  if (typeof injected === 'string' && injected) {
    return injected;
  }
  if (typeof injected === 'function') {
    try {
      return injected() || null;
    } catch {
      return null;
    }
  }
  try {
    return require('../utils/logger').LOG_DIR || null;
  } catch {
    // logger 起不来(缺依赖/权限)时不能让日志命令跟着挂,交由调用方按「解析不到」处理。
    return null;
  }
}

// transport 的 filename 是 `<prefix>-%DATE%.log`,超过 maxSize 还会追加分片后缀
// (`error-2026-08-17.log.3`)。日期是 ISO,字典序即时间序。
// 前缀里保留旧版扁平名 `error.log` / `combined.log`:老装机上它们躺在同一个目录里
// 永远不会被写入、也从来没被清理过,正是「同一批老错误看多少次都在」的来源。
const ERROR_PREFIXES = ['error'];
const COMBINED_PREFIXES = ['app', 'combined'];

// 归档(.gz)不在此列:读它要先解压,清它是不可逆删除,两件都归 `khy clean`。
function _collectLogFiles(fs, dir, prefixes) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter(
      (n) => n.includes('.log') && !n.endsWith('.gz') && prefixes.some((pre) => n.startsWith(pre))
    )
    .sort()
    .map((n) => path.join(dir, n));
}

// 从最新文件往旧文件回溯凑够 n 行。只读最新一个文件的话,刚跨日或刚轮转时那份只有
// 一两行,会让人以为历史错误都没了。
function _tailLines(fs, files, n) {
  const out = [];
  for (let i = files.length - 1; i >= 0 && out.length < n; i -= 1) {
    let content;
    try {
      content = fs.readFileSync(files[i], 'utf-8');
    } catch {
      continue; // 单个文件读不动(被独占/权限)就跳过,不能让整条 tail 失败
    }
    const lines = content.trim().split('\n').filter(Boolean);
    out.unshift(...lines.slice(-(n - out.length)));
  }
  return out;
}

// 归档目录:active 分层下是写入目录的兄弟目录,legacy 分层下是它的子目录。两处都数,
// 纯提示用途,数不到就当 0。
function _countArchived(fs, logDir) {
  let total = 0;
  for (const cand of [path.join(logDir, '..', 'archive'), path.join(logDir, 'archive')]) {
    try {
      total += fs.readdirSync(cand).filter((n) => n.endsWith('.gz')).length;
    } catch {
      /* 归档目录不存在 */
    }
  }
  return total;
}

function createRouterHandlers(deps) {
  const { fmt, chk, symResolver } = deps || {};
  async function resolveArg0(args) {
    if (!args[0]) {
      return args[0];
    }
    const result = await symResolver().resolveSymbol(args[0]);
    if (result.matched && result.symbol !== args[0]) {
      fmt().printInfo(`${args[0]} → ${result.symbol} (${result.name})`);
      if (result.alternatives) {
        fmt().printInfo(`其他匹配: ${result.alternatives.join(', ')}`);
      }
    }
    return result.symbol;
  }

  async function handleLogCommand(subCommand, args, options) {
    const { printError, printSuccess, printInfo, printWarn } = fmt();
    const chalk = chk();
    const fs = require('fs');
    // printWarn 是后加的出口,注入式 fmt 桩可能没有它 —— 缺了就退到 printInfo,
    // 不能因为一个提示函数缺席就让整条日志命令抛。
    const warn = typeof printWarn === 'function' ? printWarn : printInfo;

    const logDir = _resolveLogDir(deps);
    const prefixes = subCommand === 'tail' ? COMBINED_PREFIXES : ERROR_PREFIXES;
    const kindLabel = subCommand === 'tail' ? '' : '错误';

    if (subCommand === 'clear') {
      if (!logDir) {
        printError('清理失败: 无法解析日志目录(logger.LOG_DIR 不可用)');
        return;
      }
      const targets = _collectLogFiles(fs, logDir, ERROR_PREFIXES.concat(COMBINED_PREFIXES));
      if (targets.length === 0) {
        printInfo(`清理日志: ${logDir} 下没有可清空的日志文件`);
        return;
      }
      let cleared = 0;
      let freed = 0;
      const failures = [];
      for (const file of targets) {
        let size = 0;
        try {
          size = fs.statSync(file).size;
        } catch {
          /* 量不出来就不计入释放量,不影响清空本身 */
        }
        try {
          // 截断而不是删除:两个 DailyRotateFile transport 的句柄还开着,
          // 删掉文件后 winston 会继续往已解链的 inode 写,日志就凭空消失了。
          fs.writeFileSync(file, '');
          cleared += 1;
          freed += size;
        } catch (e) {
          failures.push(`${path.basename(file)}(${(e && e.message) || e})`);
        }
      }
      if (cleared === 0) {
        printError(`清理日志失败: ${targets.length} 个文件全部无法写入 — ${failures.join('、')}`);
        return;
      }
      printSuccess(
        `清理日志: 已清空 ${cleared}/${targets.length} 个文件,释放 ${humanBytes(freed)}`
      );
      if (failures.length > 0) {
        warn(`${failures.length} 个文件清空失败: ${failures.join('、')}`);
      }
      // 归档是压缩历史,删除不可逆,不属于本命令职责 —— 但必须说出来。否则用户清完
      // 发现占用没降,又会以为是一次假成功。
      const archived = _countArchived(fs, logDir);
      if (archived > 0) {
        printInfo(`另有 ${archived} 个归档日志(.gz)未处理,需要回收请用 clean`);
      }
      // 同进程内的输出软 bug 累积一并归零。TUI 里 `log clear` 与监控跑在同一进程,
      // 不清的话 health 会继续拿着已被清空的日志报同一条 yellow。
      try {
        require('../services/outputIntegrityMonitor').reset();
      } catch {
        /* 监控缺失不影响日志清理本身 */
      }
      return;
    }

    // `--n <count>` caps how many trailing lines to show (default 20). The `||'20'`
    // idiom only guards undefined/empty — a non-numeric ('abc'), valueless (bare
    // `--n` → true), zero, or negative value slips through to parseInt as NaN/≤0,
    // and `slice(-NaN)`/`slice(-0)` degrade to `slice(0)` = the WHOLE file. Validate
    // the parsed number and fall back to 20 for anything that isn't a positive int.
    const _n = Number.parseInt(options.n, 10);
    const lines = Number.isFinite(_n) && _n > 0 ? _n : 20;

    if (!logDir) {
      printInfo('无法解析日志目录(logger.LOG_DIR 不可用)');
      return;
    }

    const files = _collectLogFiles(fs, logDir, prefixes);
    if (files.length === 0) {
      // 旧文案是「暂无日志文件 — 系统运行正常」。找不到文件只说明找不到文件,
      // 断言「系统运行正常」是无根据的 —— 恰恰是路径找错时最误导人的一句。
      printInfo(`${logDir} 下暂无${kindLabel}日志文件`);
      return;
    }

    const recentLines = _tailLines(fs, files, lines);

    if (recentLines.length === 0) {
      printSuccess(`${kindLabel || '运行'}日志为空 — 没有记录`);
      return;
    }

    console.log('');
    console.log(chalk.bold(`  📋 最近 ${recentLines.length} 条${kindLabel}日志:`));
    console.log(chalk.dim('  ─'.repeat(25)));

    const knownFixes = {
      ECONNREFUSED: { desc: '连接被拒绝', fix: '检查目标服务是否运行', cmd: 'server start' },
      EADDRINUSE: { desc: '端口被占用', fix: '更换端口或关闭占用进程', cmd: null },
      ENOMEM: { desc: '内存不足', fix: '清理缓存或增加内存', cmd: 'cache clear' },
      SQLITE_CORRUPT: { desc: '数据库损坏', fix: '重新初始化数据库', cmd: 'db init --force' },
      MODULE_NOT_FOUND: { desc: '模块缺失', fix: '重新安装依赖', cmd: null },
      ETIMEOUT: { desc: '请求超时', fix: '检查网络或稍后重试', cmd: null },
      SequelizeConnectionError: { desc: '数据库连接失败', fix: '检查数据库服务', cmd: 'doctor' },
      'rate limit': { desc: 'API 限流', fix: '降低请求频率', cmd: null },
    };

    const suggestedFixes = new Set();

    recentLines.forEach((line) => {
      const isError = line.includes('error') || line.includes('Error') || line.includes('FATAL');
      const color = isError ? chalk.red : chalk.dim;
      const truncated = line.length > 120 ? `${line.slice(0, 120)}...` : line;
      console.log(`  ${color(truncated)}`);

      for (const [pattern, info] of Object.entries(knownFixes)) {
        if (line.includes(pattern)) {
          suggestedFixes.add(info);
        }
      }
    });

    if (suggestedFixes.size > 0) {
      console.log('');
      console.log(chalk.yellow.bold('  💡 建议修复措施:'));
      let fixIdx = 1;
      for (const fix of suggestedFixes) {
        console.log(
          `  ${fixIdx}. ${chalk.yellow(fix.desc)} → ${fix.fix}${fix.cmd ? chalk.cyan(` (运行: ${fix.cmd})`) : ''}`
        );
        fixIdx += 1;
      }

      console.log('');
      printInfo('输入 ai on 后可以问 AI 分析完整错误原因');
    }

    console.log('');
  }

  async function handleAccountInfo() {
    const { printTable, printError } = fmt();
    const chalk = chk();
    const { bootstrap, muteDbLogs, restoreDbLogs } = require('./bootstrap');
    await bootstrap({ silent: true });
    muteDbLogs();
    const { Trade, User } = require('../models');
    restoreDbLogs();

    const cliAuth = require('../services/cliAuthService');
    const currentUser = cliAuth.getCurrentUser();
    if (!currentUser) {
      printError('请先登录 (login)');
      return;
    }
    const dbUser = await User.findOne({ where: { username: currentUser.username }, raw: true });
    if (!dbUser) {
      printError('用户不存在');
      return;
    }

    const trades = await Trade.findAll({
      where: { user_id: dbUser.id, status: 'filled' },
      raw: true,
    });

    let totalProfit = 0;
    let positionCost = 0;
    trades.forEach((t) => {
      if (t.isClosed && t.profit) {
        totalProfit += Number.parseFloat(t.profit);
      } else if (!t.isClosed && t.side === 'buy') {
        positionCost += Number.parseFloat(t.amount || 0);
      }
    });

    const initial = 1000000;
    const available = initial + totalProfit - positionCost;

    printTable(
      ['项目', '金额'],
      [
        ['初始资金', `¥${initial.toLocaleString()}`],
        [
          '累计盈亏',
          (totalProfit >= 0 ? chalk.red('+') : chalk.green('')) + `¥${totalProfit.toFixed(2)}`,
        ],
        ['持仓占用', `¥${positionCost.toFixed(2)}`],
        ['可用资金', chalk.bold(`¥${available.toFixed(2)}`)],
        ['总成交笔数', String(trades.length)],
      ]
    );
  }

  async function handlePositionInfo() {
    const { printInfo, printSuccess, printTable, printError } = fmt();
    const { bootstrap, muteDbLogs, restoreDbLogs } = require('./bootstrap');
    await bootstrap({ silent: true });
    muteDbLogs();
    const { Trade, User } = require('../models');
    restoreDbLogs();

    const cliAuth = require('../services/cliAuthService');
    const currentUser = cliAuth.getCurrentUser();
    if (!currentUser) {
      printError('请先登录 (login)');
      return;
    }
    const dbUser = await User.findOne({ where: { username: currentUser.username }, raw: true });
    if (!dbUser) {
      printError('用户不存在');
      return;
    }

    const openTrades = await Trade.findAll({
      where: { user_id: dbUser.id, status: 'filled', isClosed: false, side: 'buy' },
      raw: true,
    });

    if (!openTrades || openTrades.length === 0) {
      printInfo('当前无持仓');
      return;
    }

    printSuccess(`当前 ${openTrades.length} 笔持仓`);
    printTable(
      ['品种', '方向', '数量', '成本价', '金额', '时间'],
      openTrades.map((t) => [
        t.symbol || '-',
        t.side || '-',
        String(t.quantity || 0),
        `¥${Number(t.price || 0).toFixed(2)}`,
        `¥${Number(t.amount || 0).toFixed(2)}`,
        t.createdAt ? new Date(t.createdAt).toLocaleDateString('zh-CN') : '-',
      ])
    );
  }

  return {
    handleAccountInfo,
    handleLogCommand,
    handlePositionInfo,
    resolveArg0,
  };
}

module.exports = {
  createRouterHandlers,
};
