'use strict';

/**
 * nativeUninstaller.js — 「原生安装器应用」卸载的 **IO 壳**(仅 win32)。
 *
 * 把 nativeUninstallPolicy(纯判定)与真实系统调用桥接:
 *   - listInstalled()  读 Windows 注册表 Uninstall 键(HKLM 64/32 位视图 + HKCU),归一成记录;
 *   - findByName(name) 在归一记录里匹配可卸载目标;
 *   - uninstall(record,{confirmed})  跑 app 自带卸载器 argv(execFile,无 shell),confirmed 才执行。
 *
 * 平台:仅 Windows。其它平台 → available:false(诚实回报;Linux/mac 的原生卸载不走注册表,
 * 由 T1 包管理器覆盖)。注册表读取用 `reg query`(Windows 自带,无需 PowerShell),fail-soft。
 *
 * 门控:KHY_DEVICE_APPS_NATIVE_UNINSTALL(父 KHY_DEVICE_APPS)。关 → available:false。
 *
 * 安全:卸载命令一律来自 policy 的 argv 构造器(execFile 直传);confirmed 由调用方负责;
 * UninstallString 为空的记录被 policy 拒绝(绝不猜删)。
 */

const policy = require('./nativeUninstallPolicy');

// 三个注册表根:64 位、32 位(WOW6432Node)、当前用户。逐个读、合并、去重。
const _UNINSTALL_ROOTS = Object.freeze([
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]);

function _gateEnabled(env = process.env) {
  return policy.isEnabled(env);
}

// 默认注入:真实 reg query / execFile。测试整体替换。
function _defaultDeps() {
  const { execFile, execFileSync } = require('child_process');
  return {
    platform: process.platform,
    // 同步读注册表子树(reg query <root> /s)。返回 stdout 文本;失败返 ''(fail-soft)。
    regQuery: (root) => {
      try {
        return String(execFileSync('reg', ['query', root, '/s'], {
          timeout: 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
        }) || '');
      } catch (_) { return ''; }
    },
    // 执行卸载 argv,继承 stdio(卸载器可能有 UI/进度)。
    runInherit: (argv, timeoutMs) => new Promise((resolve) => {
      try {
        execFile(argv[0], argv.slice(1), { timeout: timeoutMs || 600000, stdio: 'inherit', windowsHide: true },
          (err) => resolve({ ok: !err, error: err ? String(err.message || err) : null }));
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    }),
  };
}

/**
 * 把 `reg query <root> /s` 的输出解析成原始记录数组(纯字符串处理;导出供测试)。
 * reg /s 输出形态:每个子键一段,子键行顶格(HKLM\...\Uninstall\<key>),
 * 其下为 `    ValueName    REG_SZ    Value` 缩进值行。空行/新顶格键分段。
 */
function _parseRegQuery(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur && (cur.DisplayName || cur.UninstallString || cur.QuietUninstallString)) out.push(cur);
    cur = null;
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    // 顶格且以 HK 开头 = 新子键边界。
    if (/^HK[A-Z_]+\\/i.test(line)) {
      flush();
      const parts = line.trim().split('\\');
      cur = { keyName: parts[parts.length - 1] };
      continue;
    }
    if (!cur) continue;
    // 值行:`    Name    REG_SZ    Value`(REG_SZ/REG_EXPAND_SZ/…)。以 2+ 空格切三段。
    const m = /^\s+(\S.*?)\s{2,}REG_[A-Z_]+\s{2,}(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    const val = m[2].trim();
    if (name === 'DisplayName') cur.DisplayName = val;
    else if (name === 'UninstallString') cur.UninstallString = val;
    else if (name === 'QuietUninstallString') cur.QuietUninstallString = val;
    else if (name === 'InstallLocation') cur.InstallLocation = val;
    else if (name === 'DisplayVersion') cur.DisplayVersion = val;
    else if (name === 'Publisher') cur.Publisher = val;
  }
  flush();
  return out;
}

/**
 * 取原生卸载器句柄。门控关 / 非 win32 → available:false(诚实回报)。
 * @param {object} [env]
 * @param {object} [deps] 注入点(测试用)
 */
function getNativeUninstaller(env = process.env, deps) {
  if (!_gateEnabled(env)) {
    return { available: false, reason: 'KHY_DEVICE_APPS_NATIVE_UNINSTALL 已关闭' };
  }
  const d = deps || _defaultDeps();
  if (d.platform !== 'win32') {
    return { available: false, reason: `原生卸载器仅支持 Windows(当前 ${d.platform});其它平台由包管理器(T1)覆盖` };
  }

  return {
    available: true,
    /**
     * 列出注册表里所有「有自带卸载器」的应用(归一记录数组)。
     * 无卸载器的条目被 policy.normalizeRecord 过滤掉(诚实:只列可卸载的)。
     * @returns {{ok:boolean, apps:Array, error?:string}}
     */
    listInstalled() {
      const seen = new Set();
      const apps = [];
      for (const root of _UNINSTALL_ROOTS) {
        let text = '';
        try { text = d.regQuery(root); } catch (_) { text = ''; }
        if (!text) continue;
        for (const raw of _parseRegQuery(text)) {
          const norm = policy.normalizeRecord(raw);
          if (!norm.ok) continue; // 无卸载器 → 跳过(不列不可卸的)
          const key = (norm.record.displayName + '|' + norm.record.keyName).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          apps.push(norm.record);
        }
      }
      return { ok: true, apps };
    },

    /**
     * 按名称/关键字找可卸载目标。→ { ok, matches:[record], error? }
     */
    findByName(query) {
      const listed = this.listInstalled();
      if (!listed.ok) return { ok: false, matches: [], error: listed.error };
      return { ok: true, matches: policy.matchRecords(listed.apps, query) };
    },

    /**
     * 跑 app 自带卸载器卸载一条记录。confirmed 必为 true(破坏性)。
     * @param {object} record policy.normalizeRecord 产出的记录
     * @returns {{ok:boolean, error?:string, argv?:string[], plan?:string}}
     */
    async uninstall(record, { confirmed = false } = {}) {
      const cmd = policy.buildNativeUninstallCommand(record);
      if (!cmd.ok) return { ok: false, error: cmd.reason || '无法构造卸载命令(无自带卸载器)' };
      const plan = cmd.argv.join(' ');
      if (!confirmed) return { ok: false, error: '卸载未确认(需 confirmed:true)', argv: cmd.argv, plan };
      const res = await d.runInherit(cmd.argv, 600000);
      return { ok: res.ok, error: res.error || undefined, argv: cmd.argv, plan };
    },
  };
}

module.exports = {
  getNativeUninstaller,
  _gateEnabled,
  _parseRegQuery,
  _UNINSTALL_ROOTS,
};
