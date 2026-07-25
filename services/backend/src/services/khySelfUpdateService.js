'use strict';

/**
 * khySelfUpdateService.js — 让 AI agent 能「检查 khyos 是否有新版本 + 在合适位置执行更新」的叶子。
 *
 * goal「用户问『可不可以更新 khyos』时,khy 若在合适的位置有新版本,要能操作完成更新」。
 * 现状缺口(取证 2026-07):
 *   - `cli/router.js` 的 `case 'update'` 已能 `pip install --upgrade` 自升级,但那是**用户敲的
 *     CLI 命令**,AI agent 在对话里没有对应的可调工具;
 *   - `versionService.checkForUpdate()` 能查 PyPI 最新版,但只用于启动横幅,不暴露给 agent。
 * 本叶子把「检查」与「执行」两件事收成 agent 可调面,复用两处既有单一真源:
 *   - 版本检查 → versionService.checkForUpdate / PACKAGE_CANDIDATES / getCurrentVersion
 *   - pip 失败分类 / 代理直连重试 / 可执行诊断 → pipFailurePolicy(镜像 router 的自升级逻辑)
 *
 * 红线:
 *   - `checkUpdate()` 只读、绝不抛。
 *   - `applyUpdate()` 是**变更操作**(装包),调用方(工具层)标 high risk 走审批;本服务只做
 *     确定性执行 + 结构化结果,绝不静默、绝不伪造成功。
 *   - 安装命令为 curated 静态形态(`pip install --upgrade <候选包>`),包名只取自
 *     versionService.PACKAGE_CANDIDATES 白名单,**绝不取自模型输入** → 杜绝命令注入。
 *   - 门控 `KHY_SELF_UPDATE` 默认开;显式 0/false/off/no 关 → {success:false,disabled:true}。
 *   - 依赖注入 `_exec`(测试),默认走 child_process.execSync。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

// trim+小写 nullish-安全规整单一真源 utils/normLower。
const _norm = require('../utils/normLower');

/** 门控:默认开,仅显式 0/false/off/no 才关。 */
function isEnabled(env = process.env) {
  return !_FALSY.has(_norm(env && env.KHY_SELF_UPDATE));
}

/**
 * 渠道共存门控:`KHY_MULTI_CHANNEL_SYNC`,默认开。关闭时 `khy update` 只升 pip,
 * 不再顺带同步 npm 渠道(逐字节回退旧单渠道行为)。
 */
function coexistEnabled(env = process.env) {
  return !_FALSY.has(_norm(env && env.KHY_MULTI_CHANNEL_SYNC));
}

function _versionService() {
  return require('./versionService');
}

function _pipPolicy() {
  try { return require('./pipFailurePolicy'); } catch { return null; }
}

function _pipCmd() {
  return process.platform === 'win32' ? 'pip' : 'pip3';
}

// ── npm channel coexistence ─────────────────────────────────────────────────
// Design(用户诉求「不要卸载哪一个,希望相互兼容,pip 装的也支持 npm 更新」):
// pip 与 npm 是并行渠道,各自 bundle 一份独立 backend,可长期共存。冲突的真问题不是
// 「装了两个」,而是「升级一个时另一个变陈旧,PATH 遮蔽下用户以为升了级其实没生效」。
// 解法 = 让 `khy update` 渠道感知:检测本机实际存在哪些渠道,把它们**一起**升到最新,
// 而不是叫用户卸载。npm 包名固定 `@khy-os/khy-os`(与 pip 的 `khy-os` 统一)。
const NPM_PACKAGE = '@khy-os/khy-os';

/** npm 全局是否装了 @khy-os/khy-os。只读、绝不抛(取不到 → false)。 */
function _npmGlobalHasKhy(execImpl) {
  try {
    const out = String(
      execImpl(`npm ls -g ${NPM_PACKAGE} --depth=0`, { encoding: 'utf-8', timeout: 15000 }) || ''
    );
    // `npm ls` 命中时列出 `@khy-os/khy-os@<ver>`;未装则输出 `(empty)` 或非零退出。
    return new RegExp(NPM_PACKAGE.replace('/', '\\/') + '@\\d').test(out);
  } catch (err) {
    // `npm ls -g <missing>` 以非零退出并把清单打到 stdout;仍据 stdout 判定,避免误判未装。
    try {
      const out = `${(err && err.stdout) || ''}`;
      return new RegExp(NPM_PACKAGE.replace('/', '\\/') + '@\\d').test(out);
    } catch {
      return false;
    }
  }
}

/** npm 全局已安装版本(取不到 → '')。 */
function _npmGlobalVersion(execImpl) {
  const collect = (out) => {
    const m = String(out || '').match(
      new RegExp(NPM_PACKAGE.replace('/', '\\/') + '@([\\d.]+)')
    );
    return m ? m[1] : '';
  };
  try {
    return collect(execImpl(`npm ls -g ${NPM_PACKAGE} --depth=0`, { encoding: 'utf-8', timeout: 15000 }));
  } catch (err) {
    return collect(err && err.stdout);
  }
}

/**
 * 把 npm 渠道升到最新(变更操作)。仅在 npm 渠道确实存在时调用。绝不抛。
 * 命令为静态 curated 形态,包名取自常量白名单,绝不取自模型输入 → 无注入面。
 */
function _updateNpmChannel(execImpl, env) {
  const before = _npmGlobalVersion(execImpl);
  try {
    const out = String(
      execImpl(`npm install -g ${NPM_PACKAGE}@latest`, { encoding: 'utf-8', timeout: 180000, env }) || ''
    );
    const after = _npmGlobalVersion(execImpl);
    return {
      channel: 'npm',
      success: true,
      changed: !!after && after !== before,
      from: before || null,
      to: after || null,
      output: out.slice(0, 200),
    };
  } catch (err) {
    return {
      channel: 'npm',
      success: false,
      from: before || null,
      error: `npm 更新失败:${((err && err.message) || '').slice(0, 200)}`,
      hint: `手动更新:npm install -g ${NPM_PACKAGE}@latest`,
    };
  }
}


/** 查某个 PyPI 包的最新版(官方 JSON API,白名单主机,绝不抛)。同步不可,故 async。 */
async function _pypiLatest(pkgName, fetchImpl, timeoutMs = 8000) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return null;
  let signal;
  try { signal = AbortSignal.timeout(timeoutMs); } catch { /* older runtime */ }
  try {
    const res = await doFetch(`https://pypi.org/pypi/${encodeURIComponent(pkgName)}/json`, {
      signal, headers: { Accept: 'application/json', 'User-Agent': 'khy-os-selfupdate/1.0' },
    });
    if (!res || !res.ok) return null;
    const j = await res.json();
    return (j && j.info && j.info.version) || null;
  } catch {
    return null;
  }
}

/**
 * 检查是否有可用更新(只读、绝不抛)。
 *
 * 关键正确性红线(goal「在合适的位置有新版本」):必须**同包比对**——查的是**当前实际安装的那个
 * 包**在 PyPI 的最新版,再与本地版本比。绝不把另一个包(如无关的 khy-quant 量化项目)的版本
 * 当成 khy-os 的「更新」跨包误报。versionService.checkForUpdate 会取候选表里首个有版本的包并
 * 跨包比对(启动横幅可容忍的近似),此处不复用它的跨包结论,而是自查同包最新版。
 *
 * @param {object|undefined} [opts]  { env?, _exec?, _fetch? } —— 注入供测试;传裸 env 亦兼容旧签名。
 * @returns {Promise<object>} { success, updateAvailable, current, latest, package, notice }
 */
async function checkUpdate(opts) {
  // 兼容:既可 checkUpdate(env) 也可 checkUpdate({env,_exec,_fetch})。
  const isOptsObj = opts && typeof opts === 'object' && ('env' in opts || '_exec' in opts || '_fetch' in opts);
  const env = isOptsObj ? (opts.env || process.env) : (opts || process.env);
  const execImpl = isOptsObj && typeof opts._exec === 'function' ? opts._exec : require('child_process').execSync;
  const fetchImpl = isOptsObj && typeof opts._fetch === 'function' ? opts._fetch : null;

  if (!isEnabled(env)) {
    return { success: false, disabled: true, error: 'khyos self-update disabled (KHY_SELF_UPDATE=0)' };
  }
  try {
    const vs = _versionService();
    const candidates = (vs.PACKAGE_CANDIDATES && vs.PACKAGE_CANDIDATES.length) ? vs.PACKAGE_CANDIDATES : ['khy-os', 'khy-quant'];
    // 同包比对:优先用「实际安装的包 + 其 pip 安装版本」;取不到安装版本时回落到 repo 内版本号。
    const installedPkg = _detectInstalledPackage(execImpl, candidates);
    const installedVersion = _readInstalledVersion(execImpl, installedPkg);
    const current = installedVersion || env.KHYQUANT_PKG_VERSION || vs.getCurrentVersion();

    const latest = await _pypiLatest(installedPkg, fetchImpl);
    if (!latest) {
      // 网络/PyPI 不可用:诚实降级,不谎报「已最新」也不跨包臆测。
      return {
        success: true,
        updateAvailable: false,
        current,
        latest: null,
        package: installedPkg,
        indeterminate: true,
        notice: `无法确认最新版本(网络或 PyPI 不可用)。当前 ${installedPkg} v${current}。可稍后重试或手动 pip install --upgrade ${installedPkg}。`,
      };
    }
    const updateAvailable = vs.compareVersions(latest, current) > 0;
    return {
      success: true,
      updateAvailable,
      current,
      latest,
      package: installedPkg,
      notice: updateAvailable
        ? `有可用更新:${installedPkg} v${current} → v${latest}。`
        : `已是最新版本 ${installedPkg} v${current}。`,
    };
  } catch (err) {
    return { success: false, error: `check update failed: ${(err && err.message) || String(err)}` };
  }
}

function _readInstalledVersion(execImpl, pkgName) {
  try {
    const info = execImpl(`${_pipCmd()} show ${pkgName}`, { encoding: 'utf-8', timeout: 5000 });
    const match = String(info).match(/Version:\s*([\d.]+)/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function _detectInstalledPackage(execImpl, candidates) {
  for (const pkgName of candidates) {
    if (_readInstalledVersion(execImpl, pkgName)) return pkgName;
  }
  return candidates[0];
}

/**
 * 执行更新(变更操作)。镜像 router `case 'update'` 的 pip 升级 + 代理直连重试 + 诊断,
 * 但以结构化结果返回(供 agent 消费),而非直接打印。绝不抛。
 *
 * @param {object} [opts]
 * @param {function} [opts._exec]  注入 execSync(测试)。
 * @param {object}   [opts.env=process.env]
 * @returns {object} { success, changed, from, to, package, alreadyLatest?, diagnosis?, output? }
 */
function applyUpdate(opts = {}) {
  const env = opts.env || process.env;
  if (!isEnabled(env)) {
    return { success: false, disabled: true, error: 'khyos self-update disabled (KHY_SELF_UPDATE=0)' };
  }

  const execImpl = typeof opts._exec === 'function'
    ? opts._exec
    : require('child_process').execSync;

  // 同步睡眠(供文件占用重试前等待 OS 释放句柄);可注入供测试(避免真等 1.5s)。
  const sleepImpl = typeof opts._sleep === 'function'
    ? opts._sleep
    : (ms) => {
        try {
          const n = Number(ms) || 0;
          if (n > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
        } catch { /* fail-soft:睡眠失败不阻断升级。 */ }
      };

  const vs = _versionService();
  const candidates = (vs.PACKAGE_CANDIDATES && vs.PACKAGE_CANDIDATES.length) ? vs.PACKAGE_CANDIDATES : ['khy-os', 'khy-quant'];
  const pip = _pipCmd();

  const pipPolicy = _pipPolicy();
  const policyOn = !!(pipPolicy && pipPolicy.isEnabled(env));

  let proxyRetried = false;
  let lockRetried = false; // 文件占用(WinError 32)一次性自动重试是否已用掉(全局仅一次)。
  let lastDetail = '';
  let updateChannelPkg = candidates[0];

  try {
    const currentVersion = env.KHYQUANT_PKG_VERSION || vs.getCurrentVersion();
    const installedPkg = _detectInstalledPackage(execImpl, candidates);
    updateChannelPkg = installedPkg || candidates[0];

    let output = '';
    let upgradedPkg = null;
    let lastError = null;

    for (const pkgName of candidates) {
      // 内层:先正常装;门控开且判为代理/网络失败时,绕过代理直连重试一次(全局只重试一次);
      // 判为文件占用(WinError 32)时,清残骸 + 等待后以 --force-reinstall 重试一次。
      let bypassProxy = false;
      let forceReinstall = false;
      for (;;) {
        try {
          const execOpts = { encoding: 'utf-8', timeout: 120000 };
          let cmd = `${pip} install`;
          if (bypassProxy && policyOn) {
            cmd += ' --proxy ""';
            execOpts.env = pipPolicy.stripProxyEnv(env);
          }
          if (forceReinstall) cmd += ' --force-reinstall --no-cache-dir';
          cmd += ` --upgrade ${pkgName} 2>&1`;
          output = String(execImpl(cmd, execOpts) || '');
          upgradedPkg = pkgName;
          break;
        } catch (err) {
          const detail = `${err.stdout || ''}\n${err.stderr || ''}\n${err.message || ''}`;
          lastError = err;
          lastDetail = detail;
          if (policyOn) {
            const cls = pipPolicy.classifyPipFailure(detail);
            if (cls.retryWithoutProxy && !bypassProxy && !proxyRetried) {
              proxyRetried = true;
              bypassProxy = true;
              continue;
            }
            // 文件占用(WinError 32):等待句柄释放后以 --force-reinstall 干净覆盖重试一次
            //(修:「pip 装到一半失败,往往要装两次才成功」——把手动的「第二次」收进本次调用内)。
            const lockPlan = typeof pipPolicy.buildLockRetryPlan === 'function'
              ? pipPolicy.buildLockRetryPlan({ kind: cls.kind, alreadyRetried: lockRetried, env })
              : { shouldRetry: false };
            if (lockPlan.shouldRetry) {
              lockRetried = true;
              sleepImpl(lockPlan.waitMs);
              forceReinstall = lockPlan.forceReinstall;
              continue;
            }
            break; // not-found / 重试后仍失败 / 其它 → 换下一个候选
          }
          // 门控关:逐字节回退旧行为(找不到分布→换候选;其它→抛)。
          if (/No matching distribution found|Could not find a version|404|not found/i.test(detail)) break;
          throw err;
        }
      }
      if (upgradedPkg) break;
    }

    if (!upgradedPkg) throw lastError || new Error('No installable package found for upgrade');

    if (/Successfully installed|already up-to-date|already satisfied/i.test(output)) {
      const newVersion = _readInstalledVersion(execImpl, upgradedPkg) || currentVersion;
      const changed = newVersion !== currentVersion;
      // 渠道共存:pip 升级完成后,若 npm 渠道也在,顺带把它升到最新,保持两渠道同步
      // (避免 PATH 遮蔽下另一渠道变陈旧)。fail-soft:npm 步骤失败绝不影响 pip 结果。
      const channels = [{ channel: 'pip', success: true, changed, from: currentVersion, to: newVersion }];
      let npmResult = null;
      if (coexistEnabled(env) && _npmGlobalHasKhy(execImpl)) {
        npmResult = _updateNpmChannel(execImpl, env);
        channels.push(npmResult);
      }
      const anyChanged = channels.some((c) => c.changed);
      let notice = changed
        ? `更新完成:v${currentVersion} → v${newVersion}。请重启 CLI 以应用更新。`
        : `已是最新版本 v${currentVersion}。`;
      if (npmResult) {
        notice += npmResult.success
          ? `\nnpm 渠道已同步(${NPM_PACKAGE}${npmResult.to ? ' v' + npmResult.to : ''})。`
          : `\n${npmResult.error || 'npm 渠道同步失败'}(${npmResult.hint || ''})`;
      }
      return {
        success: true,
        changed,
        alreadyLatest: !anyChanged,
        package: upgradedPkg,
        from: currentVersion,
        to: newVersion,
        proxyRetried,
        channels,
        notice,
      };
    }

    // pip 退出 0 但输出不含成功标记:诚实报告原始输出片段,不谎报成功。
    return {
      success: false,
      package: upgradedPkg,
      from: currentVersion,
      error: '更新命令已执行但未检测到成功标记',
      output: output.slice(0, 400),
    };
  } catch (err) {
    const detail = lastDetail || `${err.stdout || ''}\n${err.stderr || ''}\n${err.message || ''}`;
    if (policyOn) {
      const cls = pipPolicy.classifyPipFailure(detail);
      const diagnosis = pipPolicy.buildPipFailureDiagnosis({
        kind: cls.kind,
        pkg: updateChannelPkg,
        autoRetried: proxyRetried,
      });
      return { success: false, package: updateChannelPkg, kind: cls.kind, proxyRetried, diagnosis };
    }
    return {
      success: false,
      package: updateChannelPkg,
      error: '更新失败:' + (err.message || '').slice(0, 200),
      hint: '手动更新:pip install --upgrade khy-os (兼容: khy-quant)',
    };
  }
}

module.exports = {
  isEnabled,
  coexistEnabled,
  checkUpdate,
  applyUpdate,
  // 供测试(非稳定 API)。
  _detectInstalledPackage,
  _readInstalledVersion,
  _npmGlobalHasKhy,
  _npmGlobalVersion,
  _updateNpmChannel,
  NPM_PACKAGE,
};
