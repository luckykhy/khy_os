'use strict';

/**
 * bundleLaunchContract.test.js — 离机渠道「启动入口契约」纯叶子的 node:test 覆盖。
 * 跑法：node --test scripts/tests/bundleLaunchContract.test.js（勿用 jest 前缀）。
 *
 * 两层覆盖：
 *   A. 纯叶子单测——用合成清单文本喂 assessChannelParity，验证逐渠道缺失判定、
 *      畸形输入绝不抛、确定性/幂等。
 *   B. 真实清单一致性——解析磁盘上三份权威清单原文（pip REQUIRED_WHEEL_PATHS /
 *      REQUIRED_SDIST_PATHS、npm REQUIRED_PATHS），断言三渠道都钉死了自己 exec 的
 *      启动脚本。这条一旦漂移（某渠道漏钉启动地板）立即变红并点名。
 *   C. 离机渠道启动交接——文件在不在只是第一层，装完之后子命令能不能真的跑起来
 *      是第二层。两条实测出来的断链都在这里钉住：npm 壳不告知入口别名、pip 侧
 *      把「wheel 里本就没有 backend 目录」误判成「安装包损坏」。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  assessChannelParity,
  LAUNCH_CRITICAL_BUNDLE_PATHS,
  PIP_WHEEL_PREFIX,
  PIP_SDIST_PREFIX,
  NPM_PREFIX,
  _missingFrom,
  _pinnedAsQuotedEntry,
} = require('../lib/bundleLaunchContract');

// ── 合成清单构造器 ───────────────────────────────────────────────────────────
function makeList(prefix, paths) {
  return paths.map((p) => `    "${prefix}${p}",`).join('\n');
}
const ALL = LAUNCH_CRITICAL_BUNDLE_PATHS;

// ── A. 纯叶子单测 ────────────────────────────────────────────────────────────

test('三渠道都齐全 → ok=true，三份 missing 均空', () => {
  const r = assessChannelParity({
    pipWheelText: makeList(PIP_WHEEL_PREFIX, ALL),
    pipSdistText: makeList(PIP_SDIST_PREFIX, ALL),
    npmText: makeList(NPM_PREFIX, ALL),
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.missingInPipWheel, []);
  assert.deepStrictEqual(r.missingInPipSdist, []);
  assert.deepStrictEqual(r.missingInNpm, []);
  assert.match(r.summary, /契约齐全/);
});

test('pip wheel 漏钉启动脚本 → ok=false，点名它', () => {
  const partial = ALL.slice(1); // 去掉 bin/khy.js
  const r = assessChannelParity({
    pipWheelText: makeList(PIP_WHEEL_PREFIX, partial),
    pipSdistText: makeList(PIP_SDIST_PREFIX, ALL),
    npmText: makeList(NPM_PREFIX, ALL),
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.missingInPipWheel.includes('runtime/khy/bundle.mjs'));
  assert.deepStrictEqual(r.missingInPipSdist, []);
  assert.deepStrictEqual(r.missingInNpm, []);
  assert.match(r.summary, /契约破裂/);
});

test('npm 漏钉 → 只 missingInNpm 非空', () => {
  const partial = ALL.slice(0, ALL.length - 1); // 去掉最后一个
  const r = assessChannelParity({
    pipWheelText: makeList(PIP_WHEEL_PREFIX, ALL),
    pipSdistText: makeList(PIP_SDIST_PREFIX, ALL),
    npmText: makeList(NPM_PREFIX, partial),
  });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.missingInPipWheel, []);
  assert.deepStrictEqual(r.missingInPipSdist, []);
  assert.ok(r.missingInNpm.includes(ALL[ALL.length - 1]));
});

test('前缀敏感：wheel 清单漏写 khy_os/bundled/ 前缀则判缺失', () => {
  // wheel 判定用非空前缀 khy_os/bundled/。若清单只写裸路径（漏前缀），
  // 子串 `khy_os/bundled/<path>` 找不到 → 判缺失。这堵住「路径进了包但没进 wheel 命名空间」。
  const r = assessChannelParity({
    pipWheelText: makeList('', ALL), // 裸路径，无 wheel 前缀
    pipSdistText: makeList(PIP_SDIST_PREFIX, ALL),
    npmText: makeList(NPM_PREFIX, ALL),
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.missingInPipWheel.length, ALL.length);
  assert.deepStrictEqual(r.missingInPipSdist, []); // sdist 裸路径本就正确
});

test('畸形输入绝不抛，恒返回结构完整对象且保守判缺失', () => {
  for (const bad of [null, undefined, 42, 'x', [], NaN, { pipWheelText: 123 }]) {
    const r = assessChannelParity(bad);
    assert.ok(r && typeof r === 'object');
    assert.strictEqual(typeof r.ok, 'boolean');
    assert.ok(Array.isArray(r.missingInPipWheel));
    assert.ok(Array.isArray(r.missingInPipSdist));
    assert.ok(Array.isArray(r.missingInNpm));
    assert.strictEqual(typeof r.summary, 'string');
  }
});

test('空清单 → 三渠道全缺（保守）', () => {
  const r = assessChannelParity({ pipWheelText: '', pipSdistText: '', npmText: '' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.missingInPipWheel.length, ALL.length);
  assert.strictEqual(r.missingInPipSdist.length, ALL.length);
  assert.strictEqual(r.missingInNpm.length, ALL.length);
});

test('确定性 + 幂等：同输入多次调用结果一致', () => {
  const input = {
    pipWheelText: makeList(PIP_WHEEL_PREFIX, ALL.slice(1)),
    pipSdistText: makeList(PIP_SDIST_PREFIX, ALL),
    npmText: makeList(NPM_PREFIX, ALL),
  };
  assert.deepStrictEqual(assessChannelParity(input), assessChannelParity(input));
});

test('_missingFrom：完整带引号条目命中才算钉死', () => {
  const text = makeList(PIP_WHEEL_PREFIX, ALL);
  assert.deepStrictEqual(_missingFrom(text, PIP_WHEEL_PREFIX), []);
  assert.deepStrictEqual(_missingFrom('', PIP_WHEEL_PREFIX), ALL.slice());
});

// ── 深挖修正：substring false-GREEN 边界锚定 ─────────────────────────────────
// 裸子串匹配可被欺骗：一个启动地板路径只作为「更长路径的子串」或「注释文本」出现，
// 却被误判为已钉死 → 守卫对一个真没钉死该文件的清单放行（false-GREEN，最危险的失败）。
// 判定必须锚定收尾引号：只有作为完整带引号条目出现才算数。
test('substring false-GREEN：server.js 仅作 .template 子串 / 注释 → 判为缺失（不放行）', () => {
  const victim = 'runtime/khy/bundle.mjs';
  const sdistPaths = ALL.filter((p) => p !== victim);
  let sdistText = sdistPaths.map((p) => `    "${p}",`).join('\n');
  // victim 真没被钉死，只作为更长路径的子串 + 注释里出现：
  sdistText += `\n    # launched: ${victim} via cli.py\n`;
  sdistText += `    "tools/gen/${victim}.template",\n`;
  const r = assessChannelParity({
    pipWheelText: makeList(PIP_WHEEL_PREFIX, ALL),
    pipSdistText: sdistText,
    npmText: makeList(NPM_PREFIX, ALL),
  });
  assert.strictEqual(r.ok, false, '子串/注释伪命中必须被判缺失');
  assert.deepStrictEqual(r.missingInPipSdist, [victim]);
});

test('_pinnedAsQuotedEntry：紧后是引号才算，双引号与单引号皆认，.map 不误命中', () => {
  const p = 'services/backend/server.js';
  assert.strictEqual(_pinnedAsQuotedEntry(`"${p}",`, p), true);
  assert.strictEqual(_pinnedAsQuotedEntry(`'${p}',`, p), true);
  assert.strictEqual(_pinnedAsQuotedEntry(`"${p}.map",`, p), false);
  assert.strictEqual(_pinnedAsQuotedEntry(`# ${p} is launched\n`, p), false);
  // 一个短路径同时作为长条目子串 + 自己独立带引号条目 → 命中：
  assert.strictEqual(_pinnedAsQuotedEntry(`"x/${p}.template",\n"${p}",`, p), true);
});

test('LAUNCH_CRITICAL_BUNDLE_PATHS 非空、无重复、皆为相对路径', () => {
  assert.ok(LAUNCH_CRITICAL_BUNDLE_PATHS.length >= 1);
  assert.strictEqual(new Set(ALL).size, ALL.length);
  for (const p of ALL) {
    assert.ok(!p.startsWith('/'), `${p} 不应是绝对路径`);
    assert.ok(!p.includes('..'), `${p} 不应含 ..`);
  }
});

// ── B. 真实清单一致性（防漂移，堵渠道非对称） ─────────────────────────────────
// 解析磁盘上三份权威清单原文，断言三渠道都钉死了自己 exec 的启动脚本。
// 复用 installIntegrity.test.js 同款正则定位块。
test('真实清单：pip(wheel/sdist) 与 npm 三渠道都钉死了启动地板', () => {
  const pipFile = path.resolve(__dirname, '..', 'release', 'pip_packaging_rules.py');
  const pipSrc = fs.readFileSync(pipFile, 'utf8');
  const wheelBlock = /REQUIRED_WHEEL_PATHS\s*=\s*_ordered_unique\(\[([\s\S]*?)\]\)/.exec(pipSrc);
  const sdistBlock = /REQUIRED_SDIST_PATHS\s*=\s*_ordered_unique\(\[([\s\S]*?)\]\)/.exec(pipSrc);
  assert.ok(wheelBlock, '未能定位 REQUIRED_WHEEL_PATHS 块');
  assert.ok(sdistBlock, '未能定位 REQUIRED_SDIST_PATHS 块');

  const npmFile = path.resolve(__dirname, '..', '..', 'packaging', 'npm', 'scripts', 'audit-purity.js');
  const npmSrc = fs.readFileSync(npmFile, 'utf8');
  const npmBlock = /REQUIRED_PATHS\s*=\s*\[([\s\S]*?)\]/.exec(npmSrc);
  assert.ok(npmBlock, '未能定位 npm REQUIRED_PATHS 块');

  const r = assessChannelParity({
    pipWheelText: wheelBlock[1],
    pipSdistText: sdistBlock[1],
    npmText: npmBlock[1],
  });
  assert.ok(
    r.ok,
    `启动入口契约破裂——某条离机渠道没在自己的发布完整性清单里钉死它 exec 的启动脚本：\n` +
      `${r.summary}\n` +
      `修法：把缺失路径加进 scripts/release/pip_packaging_rules.py 的 REQUIRED_WHEEL_PATHS/` +
      `REQUIRED_SDIST_PATHS，或 packaging/npm/scripts/audit-purity.js 的 REQUIRED_PATHS。`
  );
});

// 钉死启动脚本只解决「文件在不在」，还有一层「进程怎么被告知它是谁」。
// bundle.mjs 是被 spawn 的目标，argv[1] 的 basename 恒为 bundle.mjs，
// services/backend/bin/khy.js 的 getInvokedBinary() 两个正则都不命中，
// 回落到 khyquant 模式，于是全部系统子命令被「khyquant 仅用于启动量化应用」挡下。
// 实测症状：npm install -g 之后只有 --version 能用，khy gateway status 只回两行提示。
// pip 侧靠 cli.py 设 KHYQUANT_INVOKED_AS 绕开了，npm 侧必须自己也说一声。
test('npm 启动壳把「用户敲的是哪个入口」如实传给 bundle', () => {
  const shim = path.resolve(__dirname, '..', '..', 'packaging', 'npm', 'bin', 'khy.js');
  const src = fs.readFileSync(shim, 'utf8');
  assert.match(
    src,
    /KHYQUANT_INVOKED_AS/,
    'packaging/npm/bin/khy.js 没有传 KHYQUANT_INVOKED_AS：' +
      'bundle 会把自己当成 khyquant，npm 渠道的系统子命令全部失效。'
  );
  assert.doesNotMatch(
    src,
    /env:\s*process\.env/,
    '直接把 process.env 原样传下去等于没设 KHYQUANT_INVOKED_AS：应传拷贝后的 env。'
  );
  assert.match(
    src,
    /KHYQUANT_INVOKED_AS\s*=\s*'khy'/,
    '本包只发 khy / khy-os 两个系统入口，默认值应当是 khy。'
  );
});

// ── C. 离机渠道启动交接（真实驱动 Python 启动器）──────────────────────────────
// wheel 装完之后没有 backend 目录树，运行时就是一个自带依赖的 bundle.mjs。
// _run_doctor_cli 的每一步修复（npm install / 写 .env / 改端口）都对着目录树，
// 所以它在第 2 步就报「Backend directory not found」并劝用户 force-reinstall ——
// 其实什么都没坏。判定归口到 _is_standalone_bundle_install()，这里驱动真 Python
// 断言它的三种情形，顺带保证 doctor 分流与启动分流用的是同一个判据。
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const { searchExecutable } = require('../../services/backend/src/tools/platformUtils');

const PY_CANDIDATES = process.platform === 'win32'
  ? ['python', 'py', 'python3']
  : ['python3', 'python'];

function pythonCommand() {
  for (const candidate of PY_CANDIDATES) {
    if (searchExecutable(candidate)) return candidate;
  }
  return null;
}

const STANDALONE_PROBE = [
  'import json, pathlib, sys',
  'sys.path.insert(0, sys.argv[1])',
  'import khy_platform.cli as cli',
  'root = pathlib.Path(sys.argv[2])',
  '# 源码检出优先：即便旁边躺着一份 bundle 产物也不算 standalone',
  'cli._source_checkout_backend = lambda: root / "services" / "backend"',
  'cli._find_bundled_root = lambda: root / "bundled"',
  'checkout_wins = cli._is_standalone_bundle_install()',
  '# 无源码树 + bundle.mjs 在位 = wheel 安装',
  'cli._source_checkout_backend = lambda: None',
  'wheel = cli._is_standalone_bundle_install()',
  '# 无源码树 + 无 bundle 根 = 既非源码也非 wheel，保守判 False',
  'cli._find_bundled_root = lambda: None',
  'neither = cli._is_standalone_bundle_install()',
  'print(json.dumps([checkout_wins, wheel, neither]))',
].join('\n');

test('_is_standalone_bundle_install：源码检出压过 bundle，wheel 判 True，两者皆无判 False', () => {
  const python = pythonCommand();
  if (!python) return; // 无 Python 的环境跳过：这条断言不该阻断 Node 侧全绿

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-standalone-'));
  try {
    const bundleDir = path.join(root, 'bundled', 'runtime', 'khy');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'bundle.mjs'), '// stub\n');

    const platformDir = path.resolve(__dirname, '..', '..', 'platform');
    const r = spawnSync(python, ['-c', STANDALONE_PROBE, platformDir, root], { encoding: 'utf8' });
    assert.equal(r.status, 0, `probe failed: ${r.stderr || r.stdout}`);
    assert.deepStrictEqual(
      JSON.parse(r.stdout.trim()),
      [false, true, false],
      'wheel 安装必须判为 standalone，否则 khy doctor 会把「本就没有 backend 目录」误报成安装损坏'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor 分流与启动分流共用同一个 standalone 判据（不许各算一遍）', () => {
  const cliFile = path.resolve(__dirname, '..', '..', 'platform', 'khy_platform', 'cli.py');
  const src = fs.readFileSync(cliFile, 'utf8');
  assert.match(
    src,
    /if not _is_standalone_bundle_install\(\):\n\s+sys\.exit\(_run_doctor_cli/,
    'khy doctor 必须在 standalone 模式下放行到 Node 侧 doctor，而不是报「安装包损坏」。'
  );
  assert.match(
    src,
    /is_standalone_bundle = _is_standalone_bundle_install\(\)/,
    '启动分流应复用同一判据；就地重算会和 doctor 分流悄悄分叉。'
  );
});
// preflight / where 也栽在同一个坑里：健康的 wheel 安装被它们说成
// 「bundled backend directory not found / 安装包可能损坏，请 force-reinstall」，
// preflight 还因此返回退出码 1。这条驱动真 Python 跑两个子命令，断言它们在
// standalone 模式下如实报告「依赖已链进 bundle」，且绝不劝人重装。
const DIAGNOSTIC_PROBE = [
  'import contextlib, io, json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'import khy_platform.cli as cli',
  'cli._is_standalone_bundle_install = lambda: True',
  'out = {}',
  'for name in ("_run_preflight_cli", "_run_where_cli"):',
  '    buf = io.StringIO()',
  '    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):',
  '        getattr(cli, name)([])',
  '    out[name] = buf.getvalue()',
  'print(json.dumps(out))',
].join('\n');

test('standalone 模式下 preflight / where 不再把健康安装说成损坏', () => {
  const python = pythonCommand();
  if (!python) return;

  const platformDir = path.resolve(__dirname, '..', '..', 'platform');
  const r = spawnSync(python, ['-c', DIAGNOSTIC_PROBE, platformDir], { encoding: 'utf8' });
  assert.equal(r.status, 0, `probe failed: ${r.stderr || r.stdout}`);
  const out = JSON.parse(r.stdout.trim());

  assert.match(
    out._run_preflight_cli,
    /Backend dependencies: linked into the standalone bundle/,
    'khy preflight 应当承认 wheel 安装的依赖已在 bundle 里，而不是判 FAIL 并返回 1。'
  );
  assert.match(
    out._run_where_cli,
    /mode\s+: standalone-bundle/,
    'khy where 应当报出 standalone-bundle 模式，而不是 unknown。'
  );
  for (const [name, text] of Object.entries(out)) {
    assert.doesNotMatch(
      text,
      /force-reinstall|may be corrupted/,
      `${name} 在健康的 standalone 安装上劝用户重装 —— 这是误报。`
    );
  }
});
