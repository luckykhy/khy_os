/**
 * filePreReadHangGuard — 文件读取类工具「触碰字节前」的统一防卡死前检。
 *
 * 把三条会导致**永久卡死**的读前向量合成单一调用。任何 file-reading 工具(读取 / 格式检查 /
 * 定位替换等)在 `detectFile` / `readFileSync` / `open` **之前**调一次即可,避免每个工具重复
 * 接线、或漏接某一条向量:
 *   1) Windows 保留设备名(CON/PRN/AUX/NUL/COM1-9/LPT1-9、`\\.\…`)—— 纯路径判定,statSync 前即可判。
 *   2) 特殊文件(FIFO / 套接字 / 字符或块设备)—— 读第一个字节会永久阻塞(等写端 / 无尽输入)。
 *   3) 阻塞伪文件(Linux `/proc`·`/sys`)—— 内核按需产出 / 无尽输入,读会永久等待。
 *
 * 每条向量各自沿用其族门(default-on):对应门关 → 该向量返 null(逐字节回退历史行为)。
 * 纯判定、零副作用(winDevice=路径;special=已算好的 stat;pseudo=路径 + stat 谓词),**绝不抛**。
 * 返回:安全 → `null`;命中 → `{ blocked:true, kind, error }`(调用方 `return { success:false, error }` 短路)。
 *
 * 设计边界:主读工具 `readFile.js` / `FileReadTool` 有各自更细的读路径(pseudo 走**有界读**取回
 * 内容、binary 走**格式路由**),故它们**不**改用本合成器,保留其读专用内联守卫。本合成器服务于
 * 「命中即拒绝、不需读回内容」的其它读类工具(inspectDocument / replaceAtLocation …)。
 *
 * HOW-TO-EXTEND:新增一条「读前会卡死」向量时,在下方加一个 `try` 块(沿用其族门 + 纯判定),
 * 命中则返回 `{ blocked:true, kind:'<vector>:<detail>', error:'<refusal>' }`;并给对应族叶补独立测。
 * 调用方(inspectDocument / replaceAtLocation …)**无需改动**——这正是集中式前检的价值。
 */

/**
 * @param {{ absPath: string, stat?: import('fs').Stats|null, env?: NodeJS.ProcessEnv }} args
 * @returns {{ blocked: true, kind: string, error: string } | null}
 */
function classifyPreReadHang(args) {
  const a = args && typeof args === 'object' ? args : {};
  const absPath = a.absPath;
  const stat = a.stat || null;
  const env = a.env || process.env;

  // 1) Windows 保留设备名(纯路径,无需 stat)。
  try {
    const { winDeviceGuardEnabled, classifyWindowsDevice, buildWinDeviceRefusal } = require('./winDeviceReadGuard');
    if (winDeviceGuardEnabled(env)) {
      const k = classifyWindowsDevice(absPath);
      if (k) return { blocked: true, kind: `win-device:${k}`, error: buildWinDeviceRefusal({ kind: k, path: absPath }) };
    }
  } catch { /* 判定失败 → 跳过本向量 */ }

  // 2) 特殊文件 FIFO/套接字/字符或块设备(用已算好的 stat 类型谓词,statSync 对设备只读元数据不阻塞)。
  try {
    const { specialReadGuardEnabled, classifySpecialFile, buildSpecialFileRefusal } = require('./specialFileReadGuard');
    if (stat && specialReadGuardEnabled(env)) {
      const k = classifySpecialFile(stat);
      if (k) return { blocked: true, kind: `special:${k}`, error: buildSpecialFileRefusal({ kind: k, path: absPath, size: stat.size }) };
    }
  } catch { /* 判定失败 → 跳过本向量 */ }

  // 3) 阻塞伪文件(/proc·/sys)。本合成器面向「只需拒绝」的工具,故检测即拒绝(不做有界读回内容);
  //    需要其背后实时数据者按提示改用带超时的定向 shell。
  try {
    const { shouldBoundedRead, PSEUDO_GUARD_FLAG } = require('./pseudoFileReadGuard');
    if (stat) {
      const k = shouldBoundedRead({ absPath, stat, env });
      if (k) {
        return {
          blocked: true,
          kind: `pseudo:${k}`,
          error: `拒绝读取：目标是会阻塞的伪文件(/proc·/sys)：${absPath}。`
            + `读取它会永久等待(内核按需产出 / 无尽输入)。`
            + `\n若你想要的是该路径背后的实时数据,请改用带超时的定向 shell(如 \`timeout 2 cat ${absPath}\`),不要用文件工具整读。`
            + `\n如确需强读(可能卡死),设 ${PSEUDO_GUARD_FLAG}=0 后重试。`,
        };
      }
    }
  } catch { /* 判定失败 → 跳过本向量 */ }

  return null;
}

module.exports = { classifyPreReadHang };
