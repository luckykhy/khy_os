'use strict';

/**
 * 读取工具的「Windows 保留设备名」读前防护 —— 纯叶子（零 IO · 纯路径 · 绝不抛）。
 *
 * ── 补的缺口:跨系统(Windows)读到保留设备名 → 永久卡死 ─────────────────────
 * 兄弟守卫已覆盖三类 POSIX 卡死向量:
 *   - `specialFileReadGuard`  按 `fs.stat` 类型拦 FIFO/套接字/字符·块设备(POSIX 语义);
 *   - `pseudoFileReadGuard`   拦 Linux `/proc`·`/sys` 伪文件(显式 `platform !== 'linux' → null`);
 *   - `inputValidators.validateNotDevicePath` → `shellClassifier.isBlockedDevicePath`
 *     只是一张 **POSIX `/dev/*` 精确名单**(/dev/zero、/dev/tty、/dev/stdin…)。
 * 三者对 **Windows 保留 DOS 设备名毫无覆盖**。而本项目的离机继任机是 Windows,读工具
 * 一旦读到 `CON` / `COM1` / `NUL` / `LPT1` 等就会**永久等待设备输入**(串口 `COM1` 等
 * 串口数据、`CON` 等控制台输入),正是「阅读工具不对不支持,长时间卡死」的跨系统复现。
 *
 * ── Windows 保留设备名的判定规则(与 Win32 语义一致)────────────────────────
 * Windows 把下列名字视为**设备**,无关所在目录、无关扩展名:
 *   `CON` `PRN` `AUX` `NUL` `COM1`–`COM9` `LPT1`–`LPT9`
 * 关键细节:
 *   - `C:\任意目录\COM1.log` 仍解析到 COM1 设备 → 取 **basename 去掉首个 '.' 之后**的词干判定;
 *   - `CONFIG` / `COM10` / `foo.con` **不是**设备(词干为 CONFIG / COM10 / FOO)→ 放行;
 *   - Windows 解析时会**忽略词干尾部的空格与点**(`CON ` / `CON.` 仍是 CON);
 *   - 设备命名空间前缀 `\\.\`(如 `\\.\PhysicalDrive0`、`\\.\COM1`)与
 *     `\\?\GLOBALROOT\Device\...` 是**显式设备路径**,一律拦;
 *     但 `\\?\C:\很长的路径` 只是扩展长度前缀的**普通路径**,不拦。
 *
 * ── 保守边界(绝不误伤)──────────────────────────────────────────────────────
 * - **平台门**:仅当 `platform === 'win32'` 才套用保留名逻辑;POSIX 上 `con`/`nul`/`com1`
 *   是**合法文件名**,故非 win32 一律返回 null(纯谓词接收显式 platform 形参 → 可在
 *   Linux 上确定性全测,不依赖宿主平台)。
 * - 纯路径判定,零 IO:在任何 `fs.statSync` / open / read **触碰设备之前**就能拦下
 *   (这正是它必须排在 readFile 的 `statSync` 之前的原因)。
 * - 空/非串/不匹配 → 返回 null,让历史读取路径继续;绝不抛。
 * - 门控 `KHY_READFILE_WIN_DEVICE_GUARD`(默认开;env ∈ {0,false,off,no} 归一后关):
 *   关 → readFile 逐字节回退历史行为(对设备名照旧走 statSync/detectFile → 卡死),
 *   本防护完全旁路。
 *
 * ── HOW-TO-EXTEND(抄写式)────────────────────────────────────────────────────
 * 新增一个要拦的 Windows 保留名:改 `_RESERVED_STEM_RE` 的字符组;新增一类设备命名空间
 * 前缀:改 `_isDeviceNamespace`。二者都只认词干/前缀,不做 IO。改完在
 * `tests/tools/winDeviceReadGuard.test.js` 补正/反例(务必配 win32 与非 win32 两种 platform)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

const WIN_DEVICE_GUARD_FLAG = 'KHY_READFILE_WIN_DEVICE_GUARD';

// 词干(去扩展名)命中即为保留设备名。COM/LPT 只认 1-9:COM10+ 需 `\\.\` 前缀访问,
// 裸名是合法文件,故此处不认。
const _RESERVED_STEM_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/;

function _isOff(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return OFF_VALUES.includes(v);
}

/**
 * 门控 KHY_READFILE_WIN_DEVICE_GUARD(默认开)。
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
function winDeviceGuardEnabled(env = process.env) {
  return !_isOff(env && env[WIN_DEVICE_GUARD_FLAG]);
}

/**
 * 显式设备命名空间前缀:`\\.\...` 或 `\\?\GLOBALROOT\...`。
 * `\\?\<drive>:\...` 是普通扩展长度路径,不算设备。
 * @param {string} backslashed  已把 '/' 归一为 '\\' 的路径
 * @returns {boolean}
 */
function _isDeviceNamespace(backslashed) {
  if (/^\\\\\.\\/.test(backslashed)) return true;               // \\.\...
  if (/^\\\\\?\\GLOBALROOT\\/i.test(backslashed)) return true;  // \\?\GLOBALROOT\Device\...
  return false;
}

/**
 * 纯路径判定 Windows 保留设备名。仅在 win32 生效。
 * @param {string} filePath
 * @param {string} [platform=process.platform]
 * @returns {('reserved-name'|'device-namespace'|null)}
 */
function classifyWindowsDevice(filePath, platform = process.platform) {
  if (platform !== 'win32') return null;
  if (!filePath || typeof filePath !== 'string') return null;

  const backslashed = filePath.replace(/\//g, '\\');
  if (_isDeviceNamespace(backslashed)) return 'device-namespace';

  // basename → 去掉首个 '.' 之后(扩展名/数据流)→ 去尾部空格与点 → 大写。
  const base = backslashed.split('\\').pop() || '';
  const stem = base.split('.')[0].replace(/[ .]+$/, '').trim().toUpperCase();
  if (_RESERVED_STEM_RE.test(stem)) return 'reserved-name';

  return null;
}

/**
 * 渲染信息性拒绝消息(绝不抛)。诚实说明「这是 Windows 保留设备名,读它会永久卡死」,
 * 并给出可行动建议,而不是把进程挂死。
 * @param {{kind?:string, path?:string}} info
 * @returns {string}
 */
function buildWinDeviceRefusal(info = {}) {
  const kind = info && info.kind;
  const p = info && info.path ? String(info.path) : '';
  const base = p.replace(/\//g, '\\').split('\\').pop() || p;
  const head = kind === 'device-namespace'
    ? `已拒绝读取设备命名空间路径「${p}」`
    : `已拒绝读取 Windows 保留设备名「${base}」`;
  return [
    `${head}。`,
    '这是 Windows 的保留设备(如 CON / COM1 / NUL / LPT1 / \\\\.\\ 设备),',
    '直接读取会让进程**永久等待设备输入而卡死**,并非一个普通文件。',
    '如果你要读的是一个普通文件,请换一个不与保留设备名冲突的路径/文件名后重试。',
  ].join('\n');
}

module.exports = {
  WIN_DEVICE_GUARD_FLAG,
  winDeviceGuardEnabled,
  classifyWindowsDevice,
  buildWinDeviceRefusal,
};
