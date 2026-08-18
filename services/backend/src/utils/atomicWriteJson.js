'use strict';

/**
 * atomicWriteJson.js — 「原子写 JSON 文件·fail-soft 返 boolean」单一真源。
 *
 * **做 IO(写文件系统)**:同步 mkdir / open / write / fsync / rename;IO 汇聚隔离在
 * 此单点,调用方只拿到 true/false,不接触临时文件与 rename 细节。
 *
 * 为什么需要它:全仓有 422 处 `fs.writeFileSync`(其中 142 处内联 `JSON.stringify`)
 * 散在 119 个文件里,绝大多数是**裸写**——写到一半断电/被 kill 就留下一个截断的 JSON,
 * 下次启动读到畸形内容,状态直接归零。而已经做了原子写的少数模块又各写了一套:
 *   - `services/sessionPersistence.js` `_writeAtomic`:tmp + fsync + rename;
 *   - `services/trajectoryProvenance/traceChain.js` `_writeAtomic`:同上,另一份拷贝;
 *   - `utils/dataHome.js` `_writePointer`:tmp + rename,**无 fsync**;
 *   - `services/goalStore.js` / `vaultStore.js` / `learningProfile.js`:各自一套。
 * `sessionPersistence.js` 的注释自己就写明了「本仓三套原子写标准不一致」。本模块把
 * 「原子写 JSON」收成一个口子,后续裸写调用点分批迁移过来。
 *
 * 迁移进度(F2 第一批):两处 `_writeAtomic`(sessionPersistence / traceChain)已改为委派本
 * 模块 —— **函数名与「失败即抛」的契约刻意保留**,因为它们的调用方靠异常向上传播感知失败,
 * 而本模块返回 false 从不抛。goalStore / vaultStore / learningProfile / dataHome._writePointer
 * 仍是各自的实现,留待下一批(改 dataHome 会牵动路径解析的启动顺序,单独一批做)。
 *
 * 原子性来自 `rename`:同一目录内的 rename 在 POSIX 与 Windows(ReplaceFile 语义)上
 * 都是原子替换,读者永远看到「旧的完整内容」或「新的完整内容」,不存在中间态。fsync 只
 * 决定断电后能否保住**新**内容,不影响原子性——故 fsync 可门控关闭而不破坏契约。
 *
 * **刻意不收敛(不可互委)**:
 *   - schema / 字段校验(多一步,且各调用方口径不同);
 *   - 文件锁与并发协调:同一路径并发写仍是「最后 rename 者赢」,本模块不提供互斥;
 *   - JSONL 追加写(append 语义与 rename 语义互斥,那是 sessionPersistence `_appendDurable` 的域);
 *   - 二进制写(Buffer 有自己的编码/长度语义,等到有第二个调用点再开)。
 *
 * 同时导出 `atomicWriteText`:原子性属于**写文件**这件事,JSON 只是最常见的载荷。
 * 迁移期至少两处需要它——`apiKeyPool` / `customProviderRegistry` 的 legacy 迁移是把旧文件
 * **逐字节**搬到新路径,重新序列化会改变字节(格式/键序),那是迁移语义所不允许的。
 * `atomicWriteJson` 自身即是「序列化 + atomicWriteText」的组合。
 *
 * 门控 KHY_ATOMIC_FSYNC(默认开,仅显式 0/false/off/no 关):关闭 → 跳过 fsync,
 * 仍保留 tmp+rename 的原子替换。已登记进 services/flagRegistry.js。
 *
 * 契约:确定性 fail-soft;**绝不抛**——目录不可建、磁盘满、权限不足、循环引用/BigInt
 * 令 JSON.stringify 抛,一律返回 false 并尽力清掉临时文件;不 mutate 入参;不缓存。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// CANON 4 词关闭方言(与全仓 71 个文件一致;见 services/flagRegistry.js OFF_WORDS.CANON)。
const _OFF = ['0', 'false', 'off', 'no'];

/**
 * fsync 是否启用。默认开;仅显式 0/false/off/no 关。
 * @param {object} [env]
 * @returns {boolean}
 */
function _fsyncEnabled(env) {
  try {
    const v = (env || process.env || {}).KHY_ATOMIC_FSYNC;
    if (v === undefined || v === null || v === '') {
      return true;
    }
    return !_OFF.includes(String(v).trim().toLowerCase());
  } catch {
    return true;
  }
}

/**
 * 原子写一段文本。临时文件 → fsync(可门控)→ rename 替换。
 *
 * 这是本模块的底层原语;`atomicWriteJson` 只是在它前面加了一步序列化。
 *
 * @param {string} filePath 目标文件绝对/相对路径。
 * @param {string} text 要写入的完整内容(必须是字符串;非字符串直接返回 false,
 *   避免把 `undefined` / `[object Object]` 写进状态文件)。
 * @param {object} [opts]
 * @param {number} [opts.mode=0o600] 目标文件权限(Windows 上被忽略,属正常)。迁移存量裸写
 *   调用点时传 **0o666**:那是 `fs.writeFileSync` 的默认值,实际权限由 umask 决定(通常 0644)。
 *   收紧到 0600 是**另一件事** —— 若有人把 KHY_DATA_HOME 指向多用户共享目录,收紧会让另一个
 *   用户读不到文件,且写入方一切正常、毫无报错。所以「换写入原语」和「改权限」必须分批做。
 * @param {boolean} [opts.ensureDir=true] 是否递归创建父目录。
 * @param {boolean} [opts.fsync] 覆盖门控:显式 true/false 时不看 env。
 * @param {object} [opts.env] 注入 env(测试用)。
 * @returns {boolean} 成功 true;任何失败 false(绝不抛)。
 */
function atomicWriteText(filePath, text, opts = {}) {
  let tmpPath = null;
  try {
    const target = String(filePath || '');
    if (!target || typeof text !== 'string') {
      return false;
    }

    const mode = opts.mode === undefined ? 0o600 : opts.mode;
    const ensureDir = opts.ensureDir !== false;
    const wantFsync =
      typeof opts.fsync === 'boolean' ? opts.fsync : _fsyncEnabled(opts.env);

    const dir = path.dirname(target);
    if (ensureDir) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 临时文件必须与目标**同目录**:跨设备 rename 会退化成 copy,失去原子性。
    tmpPath = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);

    const fd = fs.openSync(tmpPath, 'wx', mode);
    try {
      fs.writeFileSync(fd, text, 'utf-8');
      if (wantFsync) {
        fs.fsyncSync(fd);
      }
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmpPath, target);
    tmpPath = null; // rename 成功后临时文件已不存在,勿再删
    return true;
  } catch {
    return false;
  } finally {
    if (tmpPath) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* 清不掉临时文件不改变「写失败」的结论 */
      }
    }
  }
}

/**
 * 原子写一个 JSON 文件。序列化 → `atomicWriteText`。
 *
 * @param {string} filePath 目标文件绝对/相对路径。
 * @param {*} value 任意可 JSON 序列化的值。
 * @param {object} [opts]
 * @param {number|string|null} [opts.pretty=2] 传给 JSON.stringify 的 space;null/0 = 紧凑。
 * @param {boolean} [opts.trailingNewline=false] 末尾补一个换行。存量调用点里有一部分写的是
 *   `${JSON.stringify(x, null, 2)}\n`,迁移时必须保留那个换行,否则文件字节变了(git diff、
 *   文本工具、逐字节比对都会察觉)。
 * @param {number} [opts.mode=0o600] 目标文件权限(Windows 上被忽略,属正常)。迁移存量裸写
 *   调用点时传 **0o666**:那是 `fs.writeFileSync` 的默认值,实际权限由 umask 决定(通常 0644)。
 *   收紧到 0600 是**另一件事** —— 若有人把 KHY_DATA_HOME 指向多用户共享目录,收紧会让另一个
 *   用户读不到文件,且写入方一切正常、毫无报错。所以「换写入原语」和「改权限」必须分批做。
 * @param {boolean} [opts.ensureDir=true] 是否递归创建父目录。
 * @param {boolean} [opts.fsync] 覆盖门控:显式 true/false 时不看 env。
 * @param {object} [opts.env] 注入 env(测试用)。
 * @returns {boolean} 成功 true;任何失败 false(绝不抛)。
 */
function atomicWriteJson(filePath, value, opts = {}) {
  let data;
  try {
    const pretty = opts.pretty === undefined ? 2 : opts.pretty;
    // 序列化先行:入参不可序列化时,目标文件必须**保持原样**,不能已被截断。
    data = JSON.stringify(value, null, pretty === null ? undefined : pretty);
  } catch {
    return false; // 循环引用 / BigInt
  }
  if (data === undefined) {
    return false; // undefined / function / Symbol → 没有 JSON 表示
  }
  return atomicWriteText(filePath, opts.trailingNewline ? `${data}\n` : data, opts);
}

module.exports = atomicWriteJson;
module.exports.atomicWriteJson = atomicWriteJson;
module.exports.atomicWriteText = atomicWriteText;
