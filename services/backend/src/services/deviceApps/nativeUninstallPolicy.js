'use strict';

/**
 * nativeUninstallPolicy.js — 「原生安装器应用」卸载的**纯叶子决策层**(单一真源)。
 *
 * 背景(承 deviceAppsPolicy 的 T1 包管理器层):winget/choco/scoop/brew/apt/… 只能卸「它们
 * 装的」app。Windows 上大量 exe 由 MSI / Inno Setup / NSIS 之类**原生安装器**落盘,不被任何
 * 包管理器跟踪——但它们**自己在注册表里登记了一个卸载器**(HKLM/HKCU\…\Uninstall\<key>)。
 * 「卸干净」的唯一可靠办法是**跑 app 自带的卸载器**(它知道全部文件),而不是在安装目录附近
 * 猜哪些文件要删。本层把「一条注册表 Uninstall 记录 → 该跑什么卸载 argv」这个确定性判定收敛到一处。
 *
 * 叶子契约(与 deviceAppsPolicy.js / uninstall/installLedger.js 同口径):
 *   - 零 IO:不读注册表、不 spawn、不 stat。注册表读取/执行是 nativeUninstaller(IO 壳)的职责。
 *   - 确定性:同输入同输出,node:test 全量覆盖。
 *   - 绝不抛:任何异常路径返回结构化「拒绝」({ ok:false, reason })而非 throw(卸载是破坏性操作)。
 *
 * 安全红线(承 deviceAppsPolicy):
 *   - 卸载命令一律是 **argv 数组**(execFile 直传,绝不拼 shell 字符串)。
 *   - **UninstallString 为空 → 拒绝**,绝不退化成 rmdir/rm 猜删安装目录(猜删=不干净=红线)。
 *   - MSI ProductCode 必过 GUID 白名单;卸载器 exe 路径必是绝对路径且以 .exe 结尾,否则拒绝。
 *   - 静默参数(/qn、/VERYSILENT、/S)按安装器类型注入,让卸载无人值守。
 */

// 门控:KHY_DEVICE_APPS_NATIVE_UNINSTALL(父 KHY_DEVICE_APPS)。关 → isEnabled 返 false,
// 消费侧(nativeUninstaller/路由)逐字节回退到「不碰原生卸载器」。
const _FALSY = new Set(['0', 'false', 'off', 'no']);

function isEnabled(env = process.env) {
  try {
    return require('../flagRegistry').isFlagEnabled('KHY_DEVICE_APPS_NATIVE_UNINSTALL', env);
  } catch (_) {
    const raw = env && env.KHY_DEVICE_APPS_NATIVE_UNINSTALL;
    if (raw === undefined || raw === null) return true;
    return !_FALSY.has(String(raw).trim().toLowerCase());
  }
}

// 安装器家族。分类只影响「注入哪套静默参数」;generic 表示 UninstallString 可用但形态不认识,
// 仍诚实执行原样命令(不猜静默参数)。msi 单独走 msiexec 重构(最稳、最静默)。
const INSTALLER_KIND = Object.freeze({
  MSI: 'msi',
  INNO: 'inno',
  NSIS: 'nsis',
  GENERIC: 'generic',
});

// Windows MSI ProductCode:{8-4-4-4-12} 十六进制 GUID(大括号必带)。
const _MSI_GUID_RE = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/;

// 从 UninstallString 里抓「首个 exe 路径」。兼容带引号("C:\...\unins000.exe" /x)与
// 不带引号(C:\Program Files\App\uninstall.exe)。仅用于分类/取路径;绝不据此拼 shell。
function _extractExePath(uninstallString) {
  const s = String(uninstallString || '').trim();
  if (!s) return null;
  // 带引号:取第一段引号内容。
  const q = /^"([^"]+\.exe)"/i.exec(s);
  if (q) return q[1];
  // 不带引号:取到 .exe 为止(路径可含空格,故贪婪到首个 .exe 边界)。
  const m = /^(.+?\.exe)(?:\s|$)/i.exec(s);
  return m ? m[1].trim() : null;
}

/**
 * 把一条原始注册表 Uninstall 记录归一为结构化形态(纯计算)。
 * 入参 raw 形如 { DisplayName, UninstallString, QuietUninstallString?, InstallLocation?,
 *   ModifyPath?, DisplayVersion?, Publisher?, keyName?, msiProductCode? }。
 * 缺字段容忍。返回 { ok, record?/reason }。
 */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '记录为空或非对象' };
  const displayName = String(raw.DisplayName || raw.displayName || '').trim();
  const quiet = String(raw.QuietUninstallString || raw.quietUninstallString || '').trim();
  const normal = String(raw.UninstallString || raw.uninstallString || '').trim();
  // MSI ProductCode:优先取显式字段;否则从 keyName(HKLM 下 MSI 的子键名即 ProductCode)推断。
  const keyName = String(raw.keyName || raw.KeyName || '').trim();
  const explicitGuid = String(raw.msiProductCode || '').trim();
  const guid = _MSI_GUID_RE.test(explicitGuid) ? explicitGuid
    : (_MSI_GUID_RE.test(keyName) ? keyName : '');

  // 两个卸载串都空、且无 MSI GUID → 无卸载器可用,拒绝(绝不猜删)。
  if (!quiet && !normal && !guid) {
    return { ok: false, reason: 'UninstallString/QuietUninstallString 均为空且无 MSI ProductCode:无自带卸载器,拒绝盲删' };
  }

  let kind = INSTALLER_KIND.GENERIC;
  const probe = (quiet || normal).toLowerCase();
  if (guid || /msiexec/i.test(probe)) kind = INSTALLER_KIND.MSI;
  else if (/unins\d*\.exe/i.test(probe)) kind = INSTALLER_KIND.INNO;   // Inno Setup: unins000.exe
  else if (/uninst.*\.exe|\\uninstall\.exe/i.test(probe)) kind = INSTALLER_KIND.NSIS; // NSIS: uninstall.exe/uninst.exe

  return {
    ok: true,
    record: Object.freeze({
      displayName: displayName || '(未命名)',
      quietUninstallString: quiet,
      uninstallString: normal,
      msiProductCode: guid,
      installLocation: String(raw.InstallLocation || raw.installLocation || '').trim(),
      version: String(raw.DisplayVersion || raw.displayVersion || '').trim(),
      publisher: String(raw.Publisher || raw.publisher || '').trim(),
      keyName,
      kind,
    }),
  };
}

/**
 * 由归一记录构造卸载 argv(纯计算,绝不 throw)。
 * 策略(可靠度从高到低):
 *   1. MSI:有 ProductCode → `msiexec /x {GUID} /qn /norestart`(最稳、天然静默、系统级回收)。
 *   2. Inno/NSIS/generic:优先 QuietUninstallString(app 作者已给的静默卸载);其次给
 *      UninstallString 的 exe 补该家族的静默 flag(Inno /VERYSILENT /NORESTART、NSIS /S)。
 *   3. 都无法安全解析出 exe → 拒绝(reason),绝不回退到删目录。
 * 返回 { ok, argv?/reason, silent, source }。
 */
function buildNativeUninstallCommand(record) {
  if (!record || typeof record !== 'object') return { ok: false, reason: '记录无效' };
  const kind = record.kind || INSTALLER_KIND.GENERIC;

  // 1) MSI:最优先,最静默。
  if (record.msiProductCode && _MSI_GUID_RE.test(record.msiProductCode)) {
    return {
      ok: true,
      argv: ['msiexec', '/x', record.msiProductCode, '/qn', '/norestart'],
      silent: true,
      source: 'msi-productcode',
    };
  }

  // 2) 作者提供的静默卸载串:直接采用(切成 argv;不改内容,作者已负责静默)。
  if (record.quietUninstallString) {
    const argv = _splitCommandLine(record.quietUninstallString);
    if (argv && argv.length) return { ok: true, argv, silent: true, source: 'quiet-uninstall-string' };
  }

  // 3) 普通卸载串:抽 exe,补该家族静默 flag。
  const exe = _extractExePath(record.uninstallString);
  if (exe && /\.exe$/i.test(exe)) {
    // 采用作者原串里 exe 之后已有的参数,再补静默 flag(去重,不重复叠加)。
    const rest = _splitCommandLine(record.uninstallString).slice(1);
    const flags = _silentFlagsFor(kind);
    const merged = rest.slice();
    for (const f of flags) {
      if (!merged.some(a => a.toLowerCase() === f.toLowerCase())) merged.push(f);
    }
    return { ok: true, argv: [exe, ...merged], silent: flags.length > 0, source: 'uninstall-string' };
  }

  // 4) 无法安全取得卸载器 → 拒绝(绝不猜删安装目录)。
  return { ok: false, reason: '无法从 UninstallString 安全解析出卸载器 exe;拒绝盲删安装目录' };
}

// 各安装器家族的静默参数(让卸载无人值守;generic 不猜,返回空表照原样执行)。
function _silentFlagsFor(kind) {
  if (kind === INSTALLER_KIND.INNO) return ['/VERYSILENT', '/NORESTART'];
  if (kind === INSTALLER_KIND.NSIS) return ['/S'];
  return [];
}

/**
 * 把一条 Windows 命令行切成 argv(尊重双引号)。纯字符串处理,绝不执行。
 * 仅用于把注册表里的 UninstallString 转成 execFile 可用的 argv(无 shell 解释)。
 */
function _splitCommandLine(cmd) {
  const s = String(cmd || '');
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (!inQuote && /\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 在一组已归一记录里,按 app 名称/关键字匹配可卸载目标(纯计算)。
 * 大小写不敏感;精确 displayName 命中优先,其次子串命中。返回匹配数组(可能空)。
 */
function matchRecords(records, query) {
  if (!Array.isArray(records)) return [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const exact = [];
  const partial = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const name = String(r.displayName || '').toLowerCase();
    if (!name) continue;
    if (name === q) exact.push(r);
    else if (name.includes(q) || q.includes(name)) partial.push(r);
  }
  return exact.length ? exact : partial;
}

function describeNativeUninstallPolicy(env = process.env) {
  return {
    flag: 'KHY_DEVICE_APPS_NATIVE_UNINSTALL',
    enabled: isEnabled(env),
    kinds: Object.values(INSTALLER_KIND),
    strategy: 'MSI→msiexec /x /qn；Inno/NSIS→quiet 串或补静默 flag；无卸载器→拒绝盲删',
  };
}

module.exports = {
  isEnabled,
  INSTALLER_KIND,
  normalizeRecord,
  buildNativeUninstallCommand,
  matchRecords,
  describeNativeUninstallPolicy,
  // 内部工具导出仅供 node:test 锁死解析行为。
  _extractExePath,
  _splitCommandLine,
  _MSI_GUID_RE,
};
