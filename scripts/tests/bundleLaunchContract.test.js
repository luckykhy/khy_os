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
