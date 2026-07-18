#!/usr/bin/env node
/**
 * @pattern Template Method
 */

/**
 * KHY-Quant Cross-Platform Setup Wizard
 *
 * Guided installer with Chinese mirrors, auto-deploy env,
 * and dependency installation. Friendly for non-technical users.
 *
 * Usage:
 *   node setup.js          — interactive guided setup
 *   node setup.js --auto   — non-interactive with sensible defaults
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const readline = require('readline');

// ── Constants ────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname);
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const FRONTEND_DIR = path.resolve(ROOT, '..', 'frontend');

const NPM_MIRRORS = {
  taobao: 'https://registry.npmmirror.com',
  huawei: 'https://repo.huaweicloud.com/repository/npm/',
  tencent: 'https://mirrors.cloud.tencent.com/npm/',
  default: 'https://registry.npmjs.org',
};

const PIP_MIRRORS = {
  tsinghua: 'https://pypi.tuna.tsinghua.edu.cn/simple/',
  aliyun: 'https://mirrors.aliyun.com/pypi/simple/',
  douban: 'https://pypi.doubanio.com/simple/',
  default: 'https://pypi.org/simple/',
};

const REQUIRED_PYTHON_PACKAGES = ['akshare'];

// ── Color helpers (no chalk dependency — setup must run before npm install) ──

const isColorSupported = process.stdout.isTTY && !process.env.NO_COLOR;

const c = {
  reset:   (s) => isColorSupported ? `\x1b[0m${s}\x1b[0m` : s,
  bold:    (s) => isColorSupported ? `\x1b[1m${s}\x1b[0m` : s,
  dim:     (s) => isColorSupported ? `\x1b[2m${s}\x1b[0m` : s,
  red:     (s) => isColorSupported ? `\x1b[31m${s}\x1b[0m` : s,
  green:   (s) => isColorSupported ? `\x1b[32m${s}\x1b[0m` : s,
  yellow:  (s) => isColorSupported ? `\x1b[33m${s}\x1b[0m` : s,
  blue:    (s) => isColorSupported ? `\x1b[34m${s}\x1b[0m` : s,
  cyan:    (s) => isColorSupported ? `\x1b[36m${s}\x1b[0m` : s,
};

const ok   = (msg) => console.log(c.green('  ✓ ') + msg);
const fail = (msg) => console.log(c.red('  ✗ ') + msg);
const warn = (msg) => console.log(c.yellow('  ⚠ ') + msg);
const info = (msg) => console.log(c.blue('  ℹ ') + msg);
const step = (n, msg) => console.log(c.cyan(`\n  [${n}] `) + c.bold(msg));

// ── Platform detection ───────────────────────────────────────────────────────

function getPlatform() {
  const p = process.platform;
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  return 'linux';
}

function isInChina() {
  const timezoneFile = path.join(path.sep, 'etc', 'timezone');
  // Heuristic: check TZ, LANG, or LC_ALL for Chinese locale
  const tz = process.env.TZ || '';
  const lang = process.env.LANG || process.env.LC_ALL || '';
  if (tz.includes('Asia/Shanghai') || tz.includes('Asia/Chongqing')) return true;
  if (lang.startsWith('zh')) return true;
  // Also try to detect via system timezone on Linux/macOS
  if (process.platform !== 'win32') {
    try {
      const tz2 = fs.readFileSync(timezoneFile, 'utf-8').trim();
      if (tz2.includes('Asia/Shanghai') || tz2.includes('Asia/Chongqing')) return true;
    } catch { /* file may not exist */ }
  }
  return false;
}

// ── Command execution helpers ────────────────────────────────────────────────

function runSilent(cmd, args = []) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function runVisible(cmd, args = [], label) {
  try {
    console.log(c.dim(`    $ ${cmd} ${args.join(' ')}`));
    execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', timeout: 300000 });
    return true;
  } catch (err) {
    fail(`${label || cmd} 执行失败`);
    return false;
  }
}

// ── Simple interactive prompt (no deps) ──────────────────────────────────────

function createPrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (question) => new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });

  const confirm = async (question, defaultYes = true) => {
    const hint = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = await ask(`${question} ${c.dim(hint)} `);
    if (!answer) return defaultYes;
    return answer.toLowerCase().startsWith('y');
  };

  const select = async (question, options) => {
    console.log(`\n  ${question}`);
    options.forEach((opt, i) => {
      const marker = i === 0 ? c.green('→') : ' ';
      console.log(`    ${marker} ${c.bold(String(i + 1))}. ${opt.label}${opt.desc ? c.dim(' — ' + opt.desc) : ''}`);
    });
    const answer = await ask(c.dim('  输入编号 (默认 1): '));
    const idx = parseInt(answer || '1', 10) - 1;
    return (idx >= 0 && idx < options.length) ? options[idx].value : options[0].value;
  };

  const close = () => rl.close();

  return { ask, confirm, select, close };
}

// ── Environment checks ───────────────────────────────────────────────────────

function checkNode() {
  const version = process.version;
  const major = parseInt(version.slice(1), 10);
  return { version, major, ok: major >= 16 };
}

function checkPython() {
  // Try python3, python, py (Windows)
  for (const cmd of ['python3', 'python', 'py']) {
    const ver = runSilent(cmd, ['--version']);
    if (ver) {
      const match = ver.match(/Python (\d+)\.(\d+)/);
      if (match) {
        const major = parseInt(match[1], 10);
        const minor = parseInt(match[2], 10);
        return { cmd, version: ver.trim(), major, minor, ok: major === 3 && minor >= 8 };
      }
    }
  }
  return { cmd: null, version: null, ok: false };
}

function checkPip(pythonCmd) {
  const pipCmd = pythonCmd ? `${pythonCmd} -m pip` : null;
  if (!pipCmd) return { cmd: null, ok: false };
  const ver = runSilent(pythonCmd, ['-m', 'pip', '--version']);
  return { cmd: pipCmd, version: ver, ok: !!ver };
}

function checkGit() {
  const ver = runSilent('git', ['--version']);
  return { version: ver, ok: !!ver };
}

function checkPythonPackage(pythonCmd, pkg) {
  const result = runSilent(pythonCmd, ['-m', 'pip', 'show', pkg]);
  return !!result;
}

// ── .env generation ──────────────────────────────────────────────────────────

function generateJwtSecret() {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
}

function generateEnv(options = {}) {
  const {
    dbType = 'sqlite',
    port = 3000,
    jwtSecret = generateJwtSecret(),
    enableAkshare = true,
    dbHost, dbPort, dbName, dbUser, dbPassword,
  } = options;

  const lines = [
    '# KHY-Quant Environment Configuration',
    '# Generated by setup wizard',
    `# Date: ${new Date().toISOString()}`,
    '',
    '# Database',
    `DB_TYPE=${dbType}`,
  ];

  if (dbType === 'postgres') {
    lines.push(`DB_HOST=${dbHost || '127.0.0.1'}`);
    lines.push(`DB_PORT=${dbPort || '5432'}`);
    lines.push(`DB_NAME=${dbName || 'quant_trading'}`);
    lines.push(`DB_USER=${dbUser || 'postgres'}`);
    lines.push(`DB_PASSWORD=${dbPassword || require('crypto').randomBytes(16).toString('hex')}`);
  }

  lines.push('');
  lines.push('# Server');
  lines.push(`PORT=${port}`);
  lines.push('NODE_ENV=development');
  lines.push('LOG_LEVEL=info');
  lines.push('');
  lines.push('# Authentication');
  lines.push(`JWT_SECRET=${jwtSecret}`);
  lines.push('JWT_EXPIRES_IN=7d');
  lines.push('');
  lines.push('# Data Sources');
  lines.push(`ENABLE_AKSHARE=${enableAkshare}`);
  lines.push('ENABLE_TUSHARE=false');
  lines.push('DEFAULT_DATA_SOURCE=reliable');
  lines.push('');
  lines.push('# AI Providers (fill in the ones you have)');
  lines.push('# GEMINI_API_KEY=');
  lines.push('# GROQ_API_KEY=');
  lines.push('# OPENROUTER_API_KEY=');
  lines.push('# ZHIPU_API_KEY=');
  lines.push('');
  lines.push('# Redis (optional — falls back to in-memory cache)');
  lines.push('# REDIS_URL=redis://${REDIS_HOST:-127.0.0.1}:${REDIS_PORT:-6379}');

  return lines.join('\n') + '\n';
}

// ── Main setup flow ──────────────────────────────────────────────────────────

async function main() {
  const isAuto = process.argv.includes('--auto');
  const platform = getPlatform();
  const china = isInChina();

  console.log('');
  console.log(c.cyan('      ╭─────╮'));
  console.log(c.cyan('      │ ◉ ◉ │  ') + c.bold('KHY-Quant') + c.dim(' 量化交易系统'));
  console.log(c.cyan('    ╭─┤ ▽▽▽ ├─╮'));
  console.log(c.cyan('    │ ╰─┬─┬─╯ │') + '  ' + c.bold('安装向导'));
  console.log(c.cyan('    ╰───┤ ├───╯') + '  ' + c.dim('跨平台一键部署 · 中国镜像加速'));
  console.log(c.cyan('      ╭─┴─┴─╮'));
  console.log(c.cyan('      │ KHY │'));
  console.log(c.cyan('      ╰─────╯'));
  console.log('');
  info(`检测到平台: ${c.bold(platform)}${china ? ' (中国网络环境)' : ''}`);

  const prompt = isAuto ? null : createPrompt();

  try {
    // ── Step 1: Check Node.js ──────────────────────────────────────────────
    step(1, '检查 Node.js 环境');
    const node = checkNode();
    if (node.ok) {
      ok(`Node.js ${node.version} — 符合要求 (≥16)`);
    } else {
      fail(`Node.js ${node.version || '未安装'} — 需要 16 或以上版本`);
      info('请先安装 Node.js: https://nodejs.org/');
      if (china) info('国内下载: https://npmmirror.com/mirrors/node/');
      process.exit(1);
    }

    // ── Step 2: Check Python ───────────────────────────────────────────────
    step(2, '检查 Python 环境');
    const python = checkPython();
    if (python.ok) {
      ok(`${python.version} (${python.cmd}) — 符合要求 (≥3.8)`);
    } else {
      warn('Python 3.8+ 未找到 — 部分数据获取功能将不可用');
      if (china) {
        info('推荐安装: https://mirrors.huaweicloud.com/python/');
      } else {
        info('推荐安装: https://www.python.org/downloads/');
      }
      if (!isAuto && prompt) {
        const cont = await prompt.confirm('  是否继续安装（Python 相关功能将不可用）?');
        if (!cont) { prompt.close(); process.exit(0); }
      }
    }

    // ── Step 3: npm mirror ─────────────────────────────────────────────────
    step(3, '配置 npm 镜像源');
    let npmMirror = 'default';

    if (isAuto && china) {
      npmMirror = 'taobao';
    } else if (!isAuto && prompt) {
      npmMirror = await prompt.select('选择 npm 镜像源:', [
        { label: '淘宝镜像 (npmmirror.com)', desc: '国内推荐', value: 'taobao' },
        { label: '华为云镜像', desc: '国内备选', value: 'huawei' },
        { label: '腾讯云镜像', desc: '国内备选', value: 'tencent' },
        { label: '官方源 (npmjs.org)', desc: '海外网络', value: 'default' },
      ]);
    }

    const npmRegistry = NPM_MIRRORS[npmMirror];
    if (npmMirror !== 'default') {
      ok(`使用 ${npmMirror} 镜像: ${npmRegistry}`);
    } else {
      ok('使用 npm 官方源');
    }

    // ── Step 4: Install Node.js dependencies ───────────────────────────────
    step(4, '安装 Node.js 依赖');
    const registryArgs = npmMirror !== 'default' ? ['--registry', npmRegistry] : [];

    info('安装后端依赖...');
    if (!runVisible('npm', ['install', ...registryArgs], 'npm install (backend)')) {
      fail('后端依赖安装失败，请检查网络连接后重试');
      if (prompt) prompt.close();
      process.exit(1);
    }
    ok('后端依赖安装完成');

    // Install frontend deps if frontend dir exists
    if (fs.existsSync(path.join(FRONTEND_DIR, 'package.json'))) {
      info('安装前端依赖...');
      try {
        execFileSync('npm', ['install', ...registryArgs], { cwd: FRONTEND_DIR, stdio: 'inherit', timeout: 300000 });
        ok('前端依赖安装完成');
      } catch {
        warn('前端依赖安装失败 — 可稍后手动安装');
      }
    }

    // ── Step 5: Install Python packages ────────────────────────────────────
    step(5, '安装 Python 依赖');
    if (python.ok) {
      const pip = checkPip(python.cmd);

      if (!pip.ok) {
        warn('pip 不可用，跳过 Python 包安装');
      } else {
        let pipMirror = 'default';
        if (isAuto && china) {
          pipMirror = 'tsinghua';
        } else if (!isAuto && prompt) {
          pipMirror = await prompt.select('选择 pip 镜像源:', [
            { label: '清华镜像 (tuna)', desc: '国内推荐', value: 'tsinghua' },
            { label: '阿里云镜像', desc: '国内备选', value: 'aliyun' },
            { label: '豆瓣镜像', desc: '国内备选', value: 'douban' },
            { label: '官方源 (pypi.org)', desc: '海外网络', value: 'default' },
          ]);
        }

        const pipIndexArgs = pipMirror !== 'default'
          ? ['-i', PIP_MIRRORS[pipMirror], '--trusted-host', new URL(PIP_MIRRORS[pipMirror]).hostname]
          : [];

        for (const pkg of REQUIRED_PYTHON_PACKAGES) {
          const installed = checkPythonPackage(python.cmd, pkg);
          if (installed) {
            ok(`${pkg} 已安装`);
          } else {
            info(`正在安装 ${pkg}...`);
            const success = runVisible(python.cmd, ['-m', 'pip', 'install', pkg, ...pipIndexArgs], `pip install ${pkg}`);
            if (success) {
              ok(`${pkg} 安装成功`);
            } else {
              warn(`${pkg} 安装失败 — 数据获取功能可能不可用`);
            }
          }
        }
      }
    } else {
      warn('Python 未安装，跳过 Python 包安装');
    }

    // ── Step 6: Generate .env ──────────────────────────────────────────────
    step(6, '配置环境变量');

    if (fs.existsSync(ENV_FILE)) {
      ok('.env 文件已存在');
      if (!isAuto && prompt) {
        const overwrite = await prompt.confirm('  是否重新生成 .env 配置文件?', false);
        if (overwrite) {
          await generateEnvInteractive(prompt);
        } else {
          info('保留现有配置');
        }
      }
    } else {
      if (isAuto) {
        const envContent = generateEnv({
          dbType: 'sqlite',
          port: 3000,
          enableAkshare: python.ok,
        });
        fs.writeFileSync(ENV_FILE, envContent);
        if (process.platform !== 'win32') {
          try { fs.chmodSync(ENV_FILE, 0o600); } catch { /* ignore */ }
        }
        ok('.env 已生成（默认配置：SQLite + 端口 3000）');
      } else {
        await generateEnvInteractive(prompt);
      }
    }

    // ── Step 7: Initialize database ────────────────────────────────────────
    step(7, '初始化数据库');
    info('正在初始化数据库结构...');
    try {
      // Use the bootstrap mechanism to init DB
      require('dotenv').config({ path: ENV_FILE });
      const { applyEnvDefaults } = require('./src/config/env');
      applyEnvDefaults();

      // Suppress noisy output
      const origLog = console.log;
      const origWarn = console.warn;
      try {
        console.log = () => {};
        console.warn = () => {};

        const db = require('./src/config/database');
        const sequelize = await db.initDatabase();
        require('./src/models');
        await sequelize.sync({ force: false });
      } finally {
        console.log = origLog;
        console.warn = origWarn;
      }

      ok('数据库初始化完成');
    } catch (err) {
      warn(`数据库初始化出错: ${err.message}`);
      info('可稍后运行 khy db init 重试');
    }

    // ── Step 8: Seed demo data ─────────────────────────────────────────────
    step(8, '填充示例数据');
    let shouldSeed = isAuto;
    if (!isAuto && prompt) {
      shouldSeed = await prompt.confirm('  是否填充示例数据（策略、品种等）?');
    }

    if (shouldSeed) {
      try {
        execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed.js')], {
          cwd: ROOT,
          stdio: 'pipe',
          timeout: 60000,
          env: { ...process.env },
        });
        ok('示例数据填充完成');
      } catch (err) {
        warn('示例数据填充出错 — 可稍后运行 khy db seed');
      }
    } else {
      info('跳过示例数据');
    }

    // ── Step 9: Link CLI globally ──────────────────────────────────────────
    step(9, '注册全局命令');
    let shouldLink = isAuto;
    if (!isAuto && prompt) {
      shouldLink = await prompt.confirm('  是否注册 khy / khyquant 全局命令?');
    }

    if (shouldLink) {
      const linkSuccess = runVisible('npm', ['link'], 'npm link');
      if (linkSuccess) {
        ok('全局命令注册成功 — 输入 khy 即可启动');
      } else {
        warn('全局注册失败 — 可使用 npm run cli 代替');
        if (platform === 'linux' || platform === 'macos') {
          info('提示: 可能需要 sudo npm link');
        }
      }
    } else {
      info('跳过全局注册 — 可使用 npm run cli 启动');
    }

    // ── Done ───────────────────────────────────────────────────────────────
    console.log('');
    console.log(c.green('  ╭────────────────────────────────────────╮'));
    console.log(c.green('  │') + c.bold(c.green('  ✓ 安装完成！                            ')) + c.green('│'));
    console.log(c.green('  ╰────────────────────────────────────────╯'));
    console.log('');
    console.log(c.bold('  ◉ 快速开始:'));
    console.log(c.dim('    khy                    启动交互终端'));
    console.log(c.dim('    khy help               查看所有命令'));
    console.log(c.dim('    khy doctor             诊断环境'));
    console.log(c.dim('    khy server start       启动后端服务'));
    console.log(c.dim('    khy hq 茅台            查询行情'));
    console.log('');

    if (prompt) prompt.close();
    process.exit(0);

  } catch (err) {
    fail(`安装过程出错: ${err.message}`);
    if (prompt) prompt.close();
    process.exit(1);
  }
}

async function generateEnvInteractive(prompt) {
  const dbType = await prompt.select('选择数据库类型:', [
    { label: 'SQLite', desc: '零配置，适合开发和单机部署', value: 'sqlite' },
    { label: 'PostgreSQL', desc: '生产推荐，需要独立安装', value: 'postgres' },
  ]);

  const portStr = await prompt.ask(c.dim('  服务端口 (默认 3000): '));
  const port = parseInt(portStr || '3000', 10);

  let dbOptions = {};
  if (dbType === 'postgres') {
    const dbHost = await prompt.ask(c.dim('  PostgreSQL 地址 (默认 127.0.0.1): '));
    const dbPort = await prompt.ask(c.dim('  PostgreSQL 端口 (默认 5432): '));
    const dbName = await prompt.ask(c.dim('  数据库名称 (默认 quant_trading): '));
    const dbUser = await prompt.ask(c.dim('  数据库用户 (默认 postgres): '));
    const dbPassword = await prompt.ask(c.dim('  数据库密码 (留空自动生成): '));
    dbOptions = {
      dbHost: dbHost || '127.0.0.1',
      dbPort: dbPort || '5432',
      dbName: dbName || 'quant_trading',
      dbUser: dbUser || 'postgres',
      dbPassword: dbPassword || require('crypto').randomBytes(16).toString('hex'),
    };
  }

  const envContent = generateEnv({
    dbType,
    port,
    enableAkshare: true,
    ...dbOptions,
  });

  fs.writeFileSync(ENV_FILE, envContent);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(ENV_FILE, 0o600); } catch { /* ignore */ }
  }
  ok('.env 配置文件已生成');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
