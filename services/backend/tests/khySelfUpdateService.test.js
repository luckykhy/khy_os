'use strict';

/**
 * khySelfUpdateService.test.js — 回归 khyos 自更新叶子(检查 + 执行)。
 *
 * 覆盖:门控关停用、checkUpdate 委托 versionService、applyUpdate 成功/已最新/找不到包换候选/
 * 代理失败诊断、绝不抛。applyUpdate 全用注入的 _exec,零真实 pip。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/khySelfUpdateService');

// 构造一个 _exec:`pip show <pkg>` 返回给定版本;`install --upgrade` 走给定 handler。
function mkExec({ showVersion = '0.1.100', installHandler } = {}) {
  return (cmd, opts) => {
    if (/pip3?\s+show\s+/.test(cmd)) {
      if (showVersion == null) { const e = new Error('not installed'); throw e; }
      return `Name: khy-os\nVersion: ${showVersion}\n`;
    }
    if (/install\s+--upgrade/.test(cmd)) {
      return installHandler ? installHandler(cmd, opts) : 'Successfully installed khy-os-0.1.101';
    }
    return '';
  };
}

describe('khySelfUpdateService', () => {
  test('gate off → disabled for both check and apply', async () => {
    const env = { KHY_SELF_UPDATE: '0' };
    const c = await svc.checkUpdate({ env });
    assert.equal(c.success, false);
    assert.equal(c.disabled, true);
    const a = svc.applyUpdate({ env, _exec: mkExec() });
    assert.equal(a.success, false);
    assert.equal(a.disabled, true);
  });

  test('checkUpdate compares the SAME installed package (no cross-package false positive)', async () => {
    // Installed khy-os 0.1.88; PyPI khy-os latest 0.1.90 → real update, same package.
    const _exec = (cmd) => {
      if (/pip3?\s+show\s+khy-os/.test(cmd)) return 'Name: khy-os\nVersion: 0.1.88\n';
      return ''; // khy-quant not installed
    };
    const _fetch = async (url) => {
      assert.match(url, /pypi\.org\/pypi\/khy-os\/json/); // must query khy-os, NOT khy-quant
      return { ok: true, status: 200, async json() { return { info: { version: '0.1.90' } }; } };
    };
    const r = await svc.checkUpdate({ env: {}, _exec, _fetch });
    assert.equal(r.success, true);
    assert.equal(r.package, 'khy-os');
    assert.equal(r.current, '0.1.88');
    assert.equal(r.latest, '0.1.90');
    assert.equal(r.updateAvailable, true);
  });

  test('checkUpdate does NOT report an unrelated package as an update', async () => {
    // Only khy-os installed at 0.1.150; its PyPI latest is also 0.1.150 → up to date.
    // Even though a different candidate (khy-quant) sits at 1.8.0 on PyPI, it must be ignored.
    const _exec = (cmd) => {
      if (/pip3?\s+show\s+khy-os/.test(cmd)) return 'Version: 0.1.150\n';
      return '';
    };
    const _fetch = async (url) => {
      // Should only ever be asked about khy-os.
      assert.doesNotMatch(url, /khy-quant/);
      return { ok: true, status: 200, async json() { return { info: { version: '0.1.150' } }; } };
    };
    const r = await svc.checkUpdate({ env: {}, _exec, _fetch });
    assert.equal(r.updateAvailable, false);
    assert.equal(r.package, 'khy-os');
    assert.match(r.notice, /已是最新/);
  });

  test('checkUpdate PyPI unavailable → indeterminate, not a false "up to date"', async () => {
    const _exec = (cmd) => (/pip3?\s+show\s+khy-os/.test(cmd) ? 'Version: 0.1.150\n' : '');
    const _fetch = async () => { throw new Error('network down'); };
    const r = await svc.checkUpdate({ env: {}, _exec, _fetch });
    assert.equal(r.success, true);
    assert.equal(r.updateAvailable, false);
    assert.equal(r.indeterminate, true);
    assert.equal(r.latest, null);
  });

  test('applyUpdate success with version change', () => {
    // show 首先返回旧版本(current),升级后 show 返回新版本。
    let installed = '0.1.100';
    const _exec = (cmd) => {
      if (/pip3?\s+show/.test(cmd)) return `Version: ${installed}\n`;
      if (/install\s+--upgrade/.test(cmd)) { installed = '0.1.101'; return 'Successfully installed khy-os-0.1.101'; }
      return '';
    };
    const r = svc.applyUpdate({ env: { KHYQUANT_PKG_VERSION: '0.1.100' }, _exec });
    assert.equal(r.success, true);
    assert.equal(r.changed, true);
    assert.equal(r.from, '0.1.100');
    assert.equal(r.to, '0.1.101');
    assert.equal(r.package, 'khy-os');
    assert.match(r.notice, /重启/);
  });

  // ── 文件占用(WinError 32)一次性自动重试(修:「pip 装到一半失败,往往要装两次才成功」)──
  test('applyUpdate: file-locked(WinError 32)首次失败 → 自动 --force-reinstall 重试一次 → 成功', () => {
    const WIN32 = 'ERROR: Could not install packages due to an OSError: [WinError 32] 另一个程序正在使用此文件,进程无法访问。: khyos-markdown';
    let installed = '0.1.100';
    const installCmds = [];
    let sleeps = 0;
    const _exec = (cmd) => {
      if (/pip3?\s+show/.test(cmd)) return `Version: ${installed}\n`;
      if (/install\s+--upgrade/.test(cmd) || /--upgrade/.test(cmd)) {
        installCmds.push(cmd);
        // 第一次(无 --force-reinstall)撞文件锁;第二次(带 --force-reinstall)成功。
        if (!/--force-reinstall/.test(cmd)) { const e = new Error('fail'); e.stdout = WIN32; throw e; }
        installed = '0.1.101';
        return 'Successfully installed khy-os-0.1.101';
      }
      return '';
    };
    const r = svc.applyUpdate({
      env: { KHYQUANT_PKG_VERSION: '0.1.100', KHY_MULTI_CHANNEL_SYNC: '0' },
      _exec,
      _sleep: () => { sleeps += 1; },
    });
    assert.equal(r.success, true, '一次性自动重试后应成功(不再要求用户手动第二次)');
    assert.equal(r.changed, true);
    assert.equal(r.to, '0.1.101');
    // 恰好两次 install:普通一次 + force-reinstall 重试一次。
    assert.equal(installCmds.length, 2, '应恰好重试一次(普通 + force-reinstall)');
    assert.ok(!/--force-reinstall/.test(installCmds[0]), '首次为普通升级');
    assert.match(installCmds[1], /--force-reinstall --no-cache-dir/, '重试带 --force-reinstall --no-cache-dir');
    assert.ok(sleeps >= 1, '重试前应等待句柄释放');
  });

  test('applyUpdate: 门 KHY_UPDATE_LOCK_RETRY=0 → 不自动重试(逐字节回退旧「放弃并诊断」)', () => {
    const WIN32 = '[WinError 32] 另一个程序正在使用此文件';
    const installCmds = [];
    const _exec = (cmd) => {
      if (/pip3?\s+show/.test(cmd)) return 'Version: 0.1.100\n';
      if (/--upgrade/.test(cmd)) { installCmds.push(cmd); const e = new Error('fail'); e.stdout = WIN32; throw e; }
      return '';
    };
    const r = svc.applyUpdate({
      env: { KHYQUANT_PKG_VERSION: '0.1.100', KHY_UPDATE_LOCK_RETRY: '0', KHY_MULTI_CHANNEL_SYNC: '0' },
      _exec,
      _sleep: () => {},
    });
    assert.equal(r.success, false);
    // 每个候选各一次、零 force-reinstall 重试。
    assert.ok(installCmds.every((c) => !/--force-reinstall/.test(c)), '门关时绝不 force-reinstall 重试');
    assert.equal(r.kind, 'file-locked');
  });

  test('applyUpdate already latest → changed false', () => {
    const _exec = (cmd) => {
      if (/pip3?\s+show/.test(cmd)) return 'Version: 0.1.100\n';
      if (/install\s+--upgrade/.test(cmd)) return 'Requirement already satisfied: khy-os';
      return '';
    };
    const r = svc.applyUpdate({ env: { KHYQUANT_PKG_VERSION: '0.1.100' }, _exec });
    assert.equal(r.success, true);
    assert.equal(r.changed, false);
    assert.equal(r.alreadyLatest, true);
  });

  test('applyUpdate falls through to next candidate on not-found', () => {
    // 第一候选 not-found,第二候选成功。
    const calls = [];
    let installed = '0.1.100';
    const _exec = (cmd) => {
      if (/pip3?\s+show\s+khy-os(\s|$)/.test(cmd)) return `Version: ${installed}\n`;
      if (/pip3?\s+show/.test(cmd)) return ''; // other candidate not installed
      if (/install\s+--upgrade\s+khy-os(\s|2)/.test(cmd)) {
        calls.push('khy-os');
        const e = new Error('No matching distribution found for khy-os'); e.stderr = 'No matching distribution found'; throw e;
      }
      if (/install\s+--upgrade\s+khy-quant/.test(cmd)) { calls.push('khy-quant'); installed = '0.1.101'; return 'Successfully installed khy-quant-0.1.101'; }
      return '';
    };
    const r = svc.applyUpdate({ env: { KHYQUANT_PKG_VERSION: '0.1.100', KHY_PIP_FAILURE_POLICY: '0' }, _exec });
    assert.equal(r.success, true);
    assert.equal(r.package, 'khy-quant');
    assert.deepEqual(calls, ['khy-os', 'khy-quant']);
  });

  test('applyUpdate proxy failure → deterministic diagnosis, never throws', () => {
    const _exec = (cmd) => {
      if (/pip3?\s+show/.test(cmd)) return 'Version: 0.1.100\n';
      if (/install\s+--upgrade/.test(cmd)) {
        const e = new Error('ProxyError'); e.stderr = 'ProxyError: Cannot connect to proxy. [WinError 10061]'; throw e;
      }
      return '';
    };
    const r = svc.applyUpdate({ env: { KHYQUANT_PKG_VERSION: '0.1.100' }, _exec });
    assert.equal(r.success, false);
    // 门控默认开 → 走 pipFailurePolicy 诊断
    assert.ok(r.diagnosis || r.error, 'should carry a diagnosis or error');
    if (r.kind) assert.equal(typeof r.kind, 'string');
  });

  test('_detectInstalledPackage returns first candidate with a version', () => {
    const exec = (cmd) => {
      if (/khy-os/.test(cmd)) return ''; // not installed
      if (/khy-quant/.test(cmd)) return 'Version: 0.1.100\n';
      return '';
    };
    const pkg = svc._detectInstalledPackage(exec, ['khy-os', 'khy-quant']);
    assert.equal(pkg, 'khy-quant');
  });

  // ── 渠道共存(pip + npm)──────────────────────────────────────────────────
  test('_npmGlobalHasKhy true when npm ls lists the scoped package', () => {
    const exec = (cmd) => {
      if (/npm ls -g @khy-os\/khy-os/.test(cmd)) return '/x\n└── @khy-os/khy-os@0.1.180\n';
      return '';
    };
    assert.equal(svc._npmGlobalHasKhy(exec), true);
    assert.equal(svc._npmGlobalVersion(exec), '0.1.180');
  });

  test('_npmGlobalHasKhy false on (empty) / non-zero exit', () => {
    const execEmpty = () => '/x\n└── (empty)\n';
    assert.equal(svc._npmGlobalHasKhy(execEmpty), false);
    // npm ls -g <missing> 常以非零退出;据 err.stdout 判定,不误判为已装。
    const execThrows = () => { const e = new Error('exit 1'); e.stdout = '(empty)\n'; throw e; };
    assert.equal(svc._npmGlobalHasKhy(execThrows), false);
  });

  test('applyUpdate also syncs npm channel when present (coexistence)', () => {
    const calls = [];
    let pipVer = '0.1.100';
    let npmVer = '0.1.100';
    const _exec = (cmd) => {
      calls.push(cmd);
      if (/pip3?\s+show/.test(cmd)) return `Version: ${pipVer}\n`;
      if (/install\s+--upgrade/.test(cmd)) { pipVer = '0.1.101'; return 'Successfully installed khy-os-0.1.101'; }
      if (/npm ls -g @khy-os\/khy-os/.test(cmd)) return `└── @khy-os/khy-os@${npmVer}\n`;
      if (/npm install -g @khy-os\/khy-os@latest/.test(cmd)) { npmVer = '0.1.101'; return 'added 1 package'; }
      return '';
    };
    const r = svc.applyUpdate({ env: { KHYQUANT_PKG_VERSION: '0.1.100' }, _exec });
    assert.equal(r.success, true);
    assert.ok(Array.isArray(r.channels));
    const npmCh = r.channels.find((c) => c.channel === 'npm');
    assert.ok(npmCh, 'npm channel should be in the result');
    assert.equal(npmCh.success, true);
    assert.equal(npmCh.to, '0.1.101');
    assert.match(r.notice, /npm 渠道已同步/);
    assert.ok(calls.some((c) => /npm install -g @khy-os\/khy-os@latest/.test(c)));
  });

  test('applyUpdate skips npm sync when npm channel absent', () => {
    const calls = [];
    let pipVer = '0.1.100';
    const _exec = (cmd) => {
      calls.push(cmd);
      if (/pip3?\s+show/.test(cmd)) return `Version: ${pipVer}\n`;
      if (/install\s+--upgrade/.test(cmd)) { pipVer = '0.1.101'; return 'Successfully installed khy-os-0.1.101'; }
      if (/npm ls -g/.test(cmd)) return '└── (empty)\n'; // npm channel not present
      return '';
    };
    const r = svc.applyUpdate({ env: { KHYQUANT_PKG_VERSION: '0.1.100' }, _exec });
    assert.equal(r.success, true);
    assert.equal(r.channels.length, 1); // pip only
    assert.ok(!calls.some((c) => /npm install -g/.test(c)), 'must not run npm install when absent');
  });

  test('coexist gate off → npm sync skipped even if npm channel present', () => {
    const calls = [];
    let pipVer = '0.1.100';
    const _exec = (cmd) => {
      calls.push(cmd);
      if (/pip3?\s+show/.test(cmd)) return `Version: ${pipVer}\n`;
      if (/install\s+--upgrade/.test(cmd)) { pipVer = '0.1.101'; return 'Successfully installed khy-os-0.1.101'; }
      if (/npm ls -g/.test(cmd)) return '└── @khy-os/khy-os@0.1.100\n';
      return '';
    };
    const r = svc.applyUpdate({ env: { KHYQUANT_PKG_VERSION: '0.1.100', KHY_MULTI_CHANNEL_SYNC: '0' }, _exec });
    assert.equal(r.success, true);
    assert.equal(r.channels.length, 1); // pip only, npm sync gated off
    assert.ok(!calls.some((c) => /npm install -g/.test(c)));
  });

  test('npm sync failure never fails the pip update (fail-soft)', () => {
    let pipVer = '0.1.100';
    const _exec = (cmd) => {
      if (/pip3?\s+show/.test(cmd)) return `Version: ${pipVer}\n`;
      if (/install\s+--upgrade/.test(cmd)) { pipVer = '0.1.101'; return 'Successfully installed khy-os-0.1.101'; }
      if (/npm ls -g/.test(cmd)) return '└── @khy-os/khy-os@0.1.100\n';
      if (/npm install -g/.test(cmd)) { throw new Error('EACCES: permission denied'); }
      return '';
    };
    const r = svc.applyUpdate({ env: { KHYQUANT_PKG_VERSION: '0.1.100' }, _exec });
    assert.equal(r.success, true); // pip result unaffected
    const npmCh = r.channels.find((c) => c.channel === 'npm');
    assert.equal(npmCh.success, false);
    assert.match(r.notice, /npm 更新失败|npm 渠道/);
  });
});
