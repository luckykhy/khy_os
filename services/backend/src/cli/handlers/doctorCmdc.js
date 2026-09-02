/**
 * doctorCmdc.js — `khy doctor cmdc` 自检:把「khy 能不能用 cmdc」拆成 5 个
 * 独立检查点,每个点都给出可执行的修复路径。设计原则:
 *
 *   1. 只读 + 纯本地 + 离线优先。除 endpoint 探测外,不发起任何远程请求。
 *   2. 失败信息带「动作+目标+进度」,绝不只说「未检测到 cmdc」就完事。
 *   3. 复用既有单一真源:commandCodeAdapter / commandCodeInvocation /
 *      _commandAvailability,确保这里看到的与 chat 路由时看到的字节级一致。
 *   4. 可被 `khy doctor` 主入口或独立 `khy doctor cmdc` 复用(返回 check
 *      数组,不做 console 输出)。
 *
 * 检查项(顺序):
 *   [1] binary      — `where cmdc`(Win) / `which cmdc`(POSIX)
 *   [2] gate        — KHY_COMMANDCODE 是否为 1/true/on/yes
 *   [3] auth.json   — ~/.commandcode/auth.json 是否存在 + 形态合法
 *   [4] config      — ~/.commandcode/config.json 的 model / provider 字段
 *   [5] endpoint    — POST /alpha/whoami 握手可达(可选,带 3s 超时)
 *
 * @module handlers/doctorCmdc
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const https = require('https');

const chalk = require('picocolors');

const {
  printSuccess,
  printError,
  printWarn,
  printInfo,
} = require('../formatters');

// cmdc 真实 endpoint(commandCodeInvocation.js 头部 wire note 单一真源)
const CMDC_BASE_HOST = 'api.commandcode.ai';
const CMDC_WHOAMI_PATH = '/alpha/whoami';

// 各检查点超时(秒)—— 全部 ≤ 10s 符合 agent-rules 短 I/O 例外
const PROBE_TIMEOUT_MS = 3000;
const HTTP_TIMEOUT_MS = 5000;

// ── 工具:解析 home / 读 JSON / safe stat ───────────────────────────────────

function _cmdcHome(env = process.env) {
  return env.COMMAND_CODE_HOME
    ? path.resolve(env.COMMAND_CODE_HOME)
    : path.join(os.homedir(), '.commandcode');
}

function _readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

// ── 检查 1:binary 探测(走 _commandAvailability,统一缓存)────────────────────

function _checkBinary() {
  // 复用既有缓存层,避免每次 doctor 又去 spawnSync 把 Ink 转圈卡住。
  // 强制 force=true,doctor 场景下用户期望看到当前实况,不是 30s 内的缓存。
  let availability;
  try {
    availability = require('../../services/gateway/adapters/_commandAvailability');
  } catch {
    return {
      key: 'binary',
      label: 'cmdc binary',
      ok: false,
      level: 'fail',
      detail:
        '无法加载 _commandAvailability 模块,无法探测 cmdc 是否在 PATH 中',
    };
  }
  const probe = availability.check('cmdc', { force: true });
  if (probe.ok) {
    return {
      key: 'binary',
      label: 'cmdc binary',
      ok: true,
      level: 'ok',
      detail: '已在 PATH 中检测到 cmdc(`where cmdc` 命中)',
    };
  }
  return {
    key: 'binary',
    label: 'cmdc binary',
    ok: false,
    level: 'fail',
    detail: `未在 PATH 中检测到 cmdc(${probe.error || 'no match'})`,
    fix: [
      'khy.bat/khy.sh 已自动注入 D:/Portable/Tools/commandcode/npm-global,但仅在 khy 启动时生效',
      '在外部 shell 中: set PATH=%D_PORTABLE%\\Tools\\commandcode\\npm-global;%PATH%',
      '或重装: npm i -g command-code',
    ],
  };
}

// ── 检查 2:KHY_COMMANDCODE 门控 ────────────────────────────────────────────

function _checkGate() {
  let enabled = false;
  try {
    const invocation = require('../../services/gateway/adapters/commandCodeInvocation');
    enabled = invocation.isEnabled(process.env);
  } catch {
    return {
      key: 'gate',
      label: 'KHY_COMMANDCODE 门控',
      ok: false,
      level: 'fail',
      detail: '无法加载 commandCodeInvocation 模块,无法判定门控',
    };
  }
  const raw = process.env.KHY_COMMANDCODE;
  if (enabled) {
    return {
      key: 'gate',
      label: 'KHY_COMMANDCODE 门控',
      ok: true,
      level: 'ok',
      detail: `已开启 (KHY_COMMANDCODE=${raw || '1'},默认由 khy.bat 注入)`,
    };
  }
  return {
    key: 'gate',
    label: 'KHY_COMMANDCODE 门控',
    ok: false,
    level: 'fail',
    detail: `KHY_COMMANDCODE=${raw === undefined ? '(unset)' : raw || '(empty)'} 视为关闭,aiGateway 会跳过 commandcode adapter`,
    fix: [
      '在启动 khy 前: set KHY_COMMANDCODE=1 (Windows) 或 export KHY_COMMANDCODE=1 (POSIX)',
      'khy.bat / khy.sh 默认会注入 1,但若外部 shell 已 export 0/空,会覆盖默认值',
    ],
  };
}

// ── 检查 3:auth.json 形态 ──────────────────────────────────────────────────

function _checkAuth() {
  const file = path.join(_cmdcHome(), 'auth.json');
  if (!fs.existsSync(file)) {
    return {
      key: 'auth',
      label: '~/.commandcode/auth.json',
      ok: false,
      level: 'fail',
      detail: `不存在: ${file}`,
      fix: [
        'khy provider use cmdc --key <user_xxx>   一键注入',
        '或: khy provider login cmdc              引导运行 cmdcode login',
      ],
    };
  }
  const doc = _readJsonSafe(file);
  if (!doc) {
    return {
      key: 'auth',
      label: '~/.commandcode/auth.json',
      ok: false,
      level: 'fail',
      detail: `${file} JSON 解析失败,文件可能损坏`,
      fix: [
        '检查文件编码与末尾逗号',
        '备份后删除 auth.json,重新跑 khy provider login cmdc',
      ],
    };
  }
  // 形态校验:apiKey / userId / userName / authenticatedAt 至少有一个非空
  const hasKey = typeof doc.apiKey === 'string' && doc.apiKey.trim();
  const hasUser = (doc.userId && String(doc.userId).trim()) || (doc.userName && String(doc.userName).trim());
  if (!hasKey && !hasUser) {
    return {
      key: 'auth',
      label: '~/.commandcode/auth.json',
      ok: false,
      level: 'fail',
      detail: `${file} 存在但 apiKey/userId/userName 均为空`,
      fix: ['khy provider use cmdc --key <user_xxx>  重输 key'],
    };
  }
  const userLabel = doc.userName || doc.userId || '(unknown)';
  const at = doc.authenticatedAt || '(unknown)';
  return {
    key: 'auth',
    label: '~/.commandcode/auth.json',
    ok: true,
    level: 'ok',
    detail: `已登录: user=${userLabel}, authenticatedAt=${at}`,
  };
}

// ── 检查 4:config.json model / provider ────────────────────────────────────

function _checkConfig() {
  const file = path.join(_cmdcHome(), 'config.json');
  if (!fs.existsSync(file)) {
    return {
      key: 'config',
      label: '~/.commandcode/config.json',
      ok: false,
      level: 'warn',
      detail: `${file} 不存在,chat 会用 cmdc 自己的默认 model;若默认 model 是 paid tier,会走付费通道`,
      fix: [
        'echo {"model":"minimax/minimax-m3-free"} > ~/.commandcode/config.json',
        '查看可选: khy provider list (HTTP providers 节)',
      ],
    };
  }
  const doc = _readJsonSafe(file);
  if (!doc) {
    return {
      key: 'config',
      label: '~/.commandcode/config.json',
      ok: false,
      level: 'warn',
      detail: `${file} JSON 解析失败`,
    };
  }
  const model = typeof doc.model === 'string' ? doc.model.trim() : '';
  const provider = typeof doc.provider === 'string' ? doc.provider.trim() : '';
  if (!model) {
    return {
      key: 'config',
      label: '~/.commandcode/config.json',
      ok: false,
      level: 'warn',
      detail: `${file} 存在但 model 字段为空,chat 会用 cmdc 默认 model`,
      fix: ['写入: echo {"model":"minimax/minimax-m3-free"} > ~/.commandcode/config.json'],
    };
  }
  return {
    key: 'config',
    label: '~/.commandcode/config.json',
    ok: true,
    level: 'ok',
    detail: `model=${model}${provider ? `, provider=${provider}` : ''}`,
  };
}

// ── 检查 5:endpoint 握手 /alpha/whoami ─────────────────────────────────────

function _probeWhoami() {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: CMDC_BASE_HOST,
        path: CMDC_WHOAMI_PATH,
        method: 'GET',
        timeout: HTTP_TIMEOUT_MS,
        headers: { 'user-agent': 'khy-doctor-cmdc/1.0' },
      },
      (res) => {
        // 任意 2xx/4xx/5xx 都算「主机可达 + 协议层握手成功」
        // 4xx 通常是 missing-token,意味着 TLS+路由都对;5xx 是上游故障
        const reachable = res.statusCode >= 200 && res.statusCode < 600;
        res.resume();
        resolve({
          reachable,
          status: res.statusCode,
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false, status: 0, error: `timeout (>${Math.round(HTTP_TIMEOUT_MS / 1000)}s)` });
    });
    req.on('error', (err) => {
      resolve({ reachable: false, status: 0, error: err.code || err.message || String(err) });
    });
    req.end();
  });
}

async function _checkEndpoint() {
  const target = `https://${CMDC_BASE_HOST}${CMDC_WHOAMI_PATH}`;
  const r = await _probeWhoami();
  if (r.reachable) {
    return {
      key: 'endpoint',
      label: 'cmdc endpoint 握手',
      ok: true,
      level: 'ok',
      detail: `${target} → HTTP ${r.status} (TLS+路由可达,4xx/5xx 也算主机通)`,
    };
  }
  return {
    key: 'endpoint',
    label: 'cmdc endpoint 握手',
    ok: false,
    level: 'warn',
    detail: `${target} 不可达: ${r.error || 'connection failed'}`,
    fix: [
      '国内网络通常需 proxy: 检查 ~/.khy/proxy.json 或 set HTTP_PROXY=http://127.0.0.1:<port>',
      '不阻塞 chat —— chat 走 spawn 子进程,代理配置在子进程 env 中继承',
    ],
  };
}

// ── 入口 ────────────────────────────────────────────────────────────────────

/**
 * 跑全部 5 个检查,返回结构化报告(供 handleDoctor 合并 / 独立 CLI 渲染)。
 * @param {object} [opts]
 * @param {boolean} [opts.skipEndpoint] - 跳过 endpoint 网络探测(纯离线场景)
 * @returns {Promise<Array<{ key, label, ok, level, detail, fix? }>>}
 */
async function runCmdcDoctorChecks({ skipEndpoint = false } = {}) {
  const checks = [
    _checkBinary(),
    _checkGate(),
    _checkAuth(),
    _checkConfig(),
  ];
  if (!skipEndpoint) {
    checks.push(await _checkEndpoint());
  } else {
    checks.push({
      key: 'endpoint',
      label: 'cmdc endpoint 握手',
      ok: true,
      level: 'ok',
      detail: '已跳过(用户指定 --offline)',
    });
  }
  return checks;
}

/**
 * 命令行渲染:`khy doctor cmdc` 独立模式,无参时医生自检。
 * @param {object} [options]
 * @param {string[]} [args]
 */
async function handleDoctorCmdc(options = {}, args = []) {
  const offline = Array.isArray(args) && args.some(
    (a) => String(a || '').trim().toLowerCase() === '--offline'
  );
  const checks = await runCmdcDoctorChecks({ skipEndpoint: offline });

  console.log('');
  console.log(chalk.bold(chalk.cyan('  khy doctor cmdc — Command Code 自检')));
  console.log(chalk.dim('     5 个独立检查点:binary / 门控 / 凭证 / 配置 / endpoint'));
  if (offline) {
    console.log(chalk.dim('     (endpoint 检查已跳过: --offline)'));
  }
  console.log('');

  let pass = 0;
  let warn = 0;
  let fail = 0;
  for (const c of checks) {
    const icon = c.ok
      ? (c.level === 'warn' ? chalk.yellow('!') : chalk.green('+'))
      : chalk.red('x');
    const tag = c.ok
      ? (c.level === 'warn' ? chalk.yellow('warn') : chalk.green('ok  '))
      : chalk.red('FAIL');
    console.log(`  [${tag}] ${icon} ${chalk.bold(c.label)}`);
    console.log(`         ${chalk.dim(c.detail)}`);
    if (c.fix && c.fix.length) {
      for (const line of c.fix) {
        console.log(`         ${chalk.dim('  修复:')} ${chalk.cyan(line)}`);
      }
    }
    if (c.ok && c.level !== 'warn') pass += 1;
    else if (c.ok && c.level === 'warn') warn += 1;
    else fail += 1;
  }

  console.log('');
  const summary = [];
  if (pass > 0) summary.push(chalk.green(`${pass} 通过`));
  if (warn > 0) summary.push(chalk.yellow(`${warn} 警告`));
  if (fail > 0) summary.push(chalk.red(`${fail} 失败`));
  console.log(`  ${chalk.bold('总计:')} ${summary.join(' / ')}`);

  if (fail === 0 && warn === 0) {
    printSuccess('cmdc 自检全部通过,chat 走 commandcode 已就绪');
    return 0;
  }
  if (fail > 0) {
    printError('存在阻断 chat 走 cmdc 的失败项,按上述 修复 行操作后重跑 `khy doctor cmdc`');
    return 1;
  }
  printWarn('全部检查通过但存在警告;chat 可用,建议按警告项调整');
  return 0;
}

module.exports = {
  runCmdcDoctorChecks,
  handleDoctorCmdc,
  // 暴露给 doctorConnectivity 那种「合并进总报告」场景
  _checkBinary,
  _checkGate,
  _checkAuth,
  _checkConfig,
  _checkEndpoint,
};
