'use strict';

/**
 * chunk_diff.js — 二进制/大文件的分块差异引擎(纯叶子:零 IO、确定性、绝不抛)。
 *
 * WHY: crdt_engine 是**字符位置**语义的文本合并器,对二进制文件不成立(第 N 个字符没有
 * 意义),对几 MB 的大文件也不划算(maxDocChars 之外整份重传)。所以今日 file_sync_bus
 * 命中二进制就回 BINARY_FILE 让调用方走文件锁,命中体积上限就回 OP_TOO_LARGE —— 两条
 * 路都退化成「整份重传 / 独占锁」。缺口是一层「按内容切块 + 只传缺失块」。
 *
 * 本模块补的正是这一层,且刻意**不参与文本合并**:它不判断「谁改了同一行」,只回答
 *   1. 这份字节流切成哪些块(内容定义边界,插入一字节只挪动一个块,而非全部错位);
 *   2. 对端已有哪些块、还缺哪些块(清单比对);
 *   3. 缺的块怎么拼回完整文件(copy/data 补丁 + 摘要校验)。
 * 并发写入的仲裁仍归 session_registry 的租约 / 文件锁 —— 分块只解决**传输量**,
 * 不改变「不允许最后写入者静默覆盖」这条红线。
 *
 * 为什么是内容定义分块(CDC)而不是定长分块:定长块在文件头部插入一个字节后,后面
 * 每一块的边界都平移,摘要全变,退化成整份重传。CDC 用滚动哈希在「内容特征处」断开,
 * 局部改动只影响邻近一到两块,这才是分块传输真正省流量的前提。
 *
 * 契约:每个导出函数返回 { ok: true, value } 或 { ok: false, error },绝不抛可预期的
 * 输入错误 / 越界 / 校验失败。零模块作用域可变态(GEAR 表是只读常量)。
 *
 * 门控 KHY_FILE_SYNC_CHUNK(默认开,仅显式 0/false/off/no 关):关 → isChunkDiffEnabled
 * 返 false,调用方逐字节保持今日行为(二进制回 BINARY_FILE、超限回 OP_TOO_LARGE)。
 *
 * @module services/chunk_diff
 */

const OFF_WORDS = ['0', 'false', 'off', 'no'];

// Structured error codes. Public contract — clients branch on these, keep stable.
const CODES = {
  INVALID_INPUT: 'INVALID_INPUT',
  TOO_LARGE: 'TOO_LARGE',
  TOO_MANY_CHUNKS: 'TOO_MANY_CHUNKS',
  INVALID_MANIFEST: 'INVALID_MANIFEST',
  INVALID_PATCH: 'INVALID_PATCH',
  CHUNK_MISSING: 'CHUNK_MISSING',
  DIGEST_MISMATCH: 'DIGEST_MISMATCH',
};

const SCHEMA = 'khy-file-sync-chunks/1';

// Default bounds. Every one is env-overridable so ops can tune without a release;
// resolveChunkLimits stays pure (env is passed in, never read from process here).
const DEFAULT_CHUNK_LIMITS = {
  minChunkBytes: 2 * 1024,
  targetChunkBytes: 16 * 1024,
  maxChunkBytes: 64 * 1024,
  maxChunks: 4096,
  maxTotalBytes: 256 * 1024 * 1024,
};

/**
 * 门控:默认开,仅显式 0/false/off/no 关。父闸 KHY_FILE_SYNC 关则整条同步链都关,
 * 由调用方判定,本函数只管自己这一层。
 *
 * @param {object} [env] 注入的环境变量视图
 * @returns {boolean}
 */
function isChunkDiffEnabled(env) {
  try {
    const raw = env && env.KHY_FILE_SYNC_CHUNK;

    if (raw === undefined || raw === null || raw === '') {
      return true;
    }

    return !OFF_WORDS.includes(String(raw).trim().toLowerCase());
  } catch {
    return true;
  }
}

/**
 * 解析边界值。坏值 / 非正数一律回落默认;并强制 min <= target <= max,
 * 避免运维把三个旋钮调成互相矛盾的值后切出畸形块。
 *
 * @param {object} [env] 注入的环境变量视图
 * @returns {object} 与 DEFAULT_CHUNK_LIMITS 同形
 */
function resolveChunkLimits(env) {
  const out = { ...DEFAULT_CHUNK_LIMITS };
  const map = {
    minChunkBytes: 'KHY_FILE_SYNC_CHUNK_MIN',
    targetChunkBytes: 'KHY_FILE_SYNC_CHUNK_TARGET',
    maxChunkBytes: 'KHY_FILE_SYNC_CHUNK_MAX',
    maxChunks: 'KHY_FILE_SYNC_CHUNK_COUNT',
    maxTotalBytes: 'KHY_FILE_SYNC_CHUNK_TOTAL',
  };

  try {
    for (const key of Object.keys(map)) {
      const n = Number(env && env[map[key]]);

      if (Number.isSafeInteger(n) && n > 0) {
        out[key] = n;
      }
    }
  } catch {
    /* keep defaults */
  }

  // Clamp into a sane order so a bad combination degrades instead of misbehaving.
  out.minChunkBytes = Math.max(1, out.minChunkBytes);
  out.targetChunkBytes = Math.max(out.minChunkBytes, out.targetChunkBytes);
  out.maxChunkBytes = Math.max(out.targetChunkBytes, out.maxChunkBytes);

  return out;
}

function _fail(code, message, extra) {
  return { ok: false, error: { code, message, ...(extra || {}) } };
}

// Gear 表:CDC 滚动哈希的字节替换表。用固定种子的 LCG 生成而非硬编码 256 个字面量,
// 保证任何实例、任何进程算出同一张表(纯确定性),同时保持可读。表只读,冻结防篡改。
const GEAR = Object.freeze(
  (() => {
    const table = new Array(256);
    let seed = 0x1f2e3d4c;

    for (let i = 0; i < 256; i++) {
      // xorshift32 而非 LCG:LCG 在模 2^32 下低位周期极短(bit0 周期为 2),
      // 而滚动哈希会把这些位混进判定,直接导致切点分布畸形、块长退化到上限。
      seed ^= (seed << 13) >>> 0;
      seed >>>= 17;
      seed ^= (seed << 5) >>> 0;
      seed = (Math.imul(seed ^ i, 0x9e3779b1) ^ (seed >>> 15)) >>> 0;
      table[i] = seed >>> 0;
    }

    return table;
  })()
);

/**
 * 把入参收敛成 Buffer。刻意只接受 Buffer / Uint8Array / string(utf8)三种,
 * 拿不准的类型直接结构化报错 —— 二进制路径上「猜编码」比报错危险得多。
 *
 * @param {Buffer|Uint8Array|string} input 待归一的内容
 * @returns {object} { ok: true, value: Buffer } 或 { ok: false, error }
 */
function toBuffer(input) {
  try {
    if (Buffer.isBuffer(input)) {
      return { ok: true, value: input };
    }

    if (input instanceof Uint8Array) {
      return { ok: true, value: Buffer.from(input) };
    }

    if (typeof input === 'string') {
      return { ok: true, value: Buffer.from(input, 'utf8') };
    }

    if (input === null || input === undefined) {
      return { ok: true, value: Buffer.alloc(0) };
    }

    return _fail(CODES.INVALID_INPUT, '内容必须是 Buffer、Uint8Array 或字符串');
  } catch (err) {
    return _fail(CODES.INVALID_INPUT, `内容无法归一为字节流：${(err && err.message) || err}`);
  }
}

/**
 * 内容摘要。用 FNV-1a 的 64 位变体(两条 32 位链)而非 crypto:本模块要在
 * 浏览器侧同样可跑,且这里只做「块是否相同」的去重判定,不做安全性判定。
 * 拼装结果另有整体校验(verifyAssembled),摘要碰撞不会静默产出错文件。
 *
 * @param {Buffer} buf 字节流
 * @param {number} [start] 起点(含)
 * @param {number} [end] 终点(不含)
 * @returns {string} 16 位十六进制摘要
 */
function digestBytes(buf, start, end) {
  const len = buf.length;
  const from = Math.min(Number.isSafeInteger(start) && start > 0 ? start : 0, len);
  // 反序区间(end < from)视为**空区间**,不回落到「一直算到末尾」—— 后者会为一个
  // 明显写错的区间返回看似正常的摘要,把调用方的 bug 藏成一次静默的内容不符。
  const rawEnd = Number.isSafeInteger(end) ? end : len;
  const to = Math.max(from, Math.min(rawEnd, len));

  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;

  for (let i = from; i < to; i++) {
    const b = buf[i];

    h1 = ((h1 ^ b) * 0x01000193) >>> 0;
    h2 = ((h2 + b) ^ ((h2 << 5) + (h2 >>> 2))) >>> 0;
  }

  // 长度掺进摘要:否则全零块之间只靠字节值无法区分长度差异。
  h2 = ((h2 ^ (to - from)) * 0x01000193) >>> 0;

  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * 内容定义分块(CDC)。滚动哈希在「内容特征处」断开:mask 由 targetChunkBytes 推出,
 * 命中即切;并用 minChunkBytes / maxChunkBytes 兜住块长分布,避免退化成 1 字节块
 * 或整份一块。同一份内容在任何实例上切出的边界完全一致(纯函数、无随机、无时钟)。
 *
 * @param {Buffer|Uint8Array|string} content 待分块内容
 * @param {object} [opts] { limits }
 * @returns {object} { ok: true, value: { schema, size, digest, chunks } } 或 { ok: false, error }
 */
function splitChunks(content, opts = {}) {
  const limits = opts.limits ? { ...DEFAULT_CHUNK_LIMITS, ...opts.limits } : DEFAULT_CHUNK_LIMITS;
  const buffered = toBuffer(content);

  if (!buffered.ok) {
    return buffered;
  }

  const buf = buffered.value;

  if (buf.length > limits.maxTotalBytes) {
    return _fail(
      CODES.TOO_LARGE,
      `文件过大：${buf.length} 字节，超出分块上限 ${limits.maxTotalBytes} 字节`,
      { size: buf.length, limit: limits.maxTotalBytes }
    );
  }

  // 掩码放在**高位**:命中概率约 1/target,但判定位取寄存器高位而非低位。
  // 低位在移位累加式滚动哈希里进位有限、分布很差,拿低位判边界会几乎不切块。
  let bits = 0;

  while (1 << (bits + 1) <= limits.targetChunkBytes) {
    bits += 1;
  }

  bits = Math.max(1, Math.min(24, bits));

  const mask = (((1 << bits) - 1) << (32 - bits)) >>> 0;

  const chunks = [];
  let start = 0;
  let roll = 0;
  let offset = 0;

  while (offset < buf.length) {
    // Gear 滚动哈希:左移**丢弃**高位(不是循环移位),于是约 32 字节之前的内容自动
    // 滑出窗口。这正是「插入一个字节后边界能重新对齐」的关键 —— 若用循环移位,旧字节
    // 永不离开寄存器,块摘要会全部改变,分块传输退化成整份重传。
    roll = ((roll << 1) + GEAR[buf[offset]]) >>> 0;
    offset += 1;

    const length = offset - start;
    const atBoundary = length >= limits.minChunkBytes && (roll & mask) === 0;

    if (atBoundary || length >= limits.maxChunkBytes || offset === buf.length) {
      if (chunks.length >= limits.maxChunks) {
        return _fail(
          CODES.TOO_MANY_CHUNKS,
          `分块数超出上限 ${limits.maxChunks}：请调大 KHY_FILE_SYNC_CHUNK_TARGET 后重试`,
          { limit: limits.maxChunks }
        );
      }

      chunks.push({ offset: start, size: length, digest: digestBytes(buf, start, offset) });
      start = offset;
      roll = 0;
    }
  }

  return {
    ok: true,
    value: {
      schema: SCHEMA,
      size: buf.length,
      digest: digestBytes(buf, 0, buf.length),
      chunks,
    },
  };
}

/**
 * 校验清单形状。跨进程/跨端来的清单一律当不可信输入:schema 不符、chunks 非数组、
 * 块字段缺失都回结构化错误,绝不让坏清单流进拼装逻辑。
 *
 * @param {object} manifest 待校验清单
 * @returns {object} { ok: true, value: manifest } 或 { ok: false, error }
 */
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return _fail(CODES.INVALID_MANIFEST, `分块清单无效：期望 ${SCHEMA} 结构的对象`);
  }

  if (manifest.schema !== SCHEMA) {
    return _fail(
      CODES.INVALID_MANIFEST,
      `分块清单 schema 不匹配：期望 ${SCHEMA}，收到 ${manifest.schema || '(缺失)'}`
    );
  }

  if (!Array.isArray(manifest.chunks)) {
    return _fail(CODES.INVALID_MANIFEST, '分块清单缺少 chunks 数组');
  }

  for (const chunk of manifest.chunks) {
    const bad =
      !chunk ||
      typeof chunk !== 'object' ||
      typeof chunk.digest !== 'string' ||
      !chunk.digest ||
      !Number.isSafeInteger(chunk.size) ||
      chunk.size < 0;

    if (bad) {
      return _fail(CODES.INVALID_MANIFEST, '分块清单含缺少 digest/size 的块条目');
    }
  }

  return { ok: true, value: manifest };
}

/**
 * 比对两份清单,算出「对端要拼出 target 还缺哪些块」。
 *
 * 关键收益在 reusedBytes / transferBytes 这两个数:调用方据此决定走分块还是整份重传
 * (改动过大时分块反而更贵),而不是盲目相信分块一定更省。
 *
 * @param {object} targetManifest 目标(权威侧)清单
 * @param {object} [haveManifest] 对端已持有的清单;缺省视为一无所有
 * @returns {object} { ok: true, value: { missing, reusedBytes, transferBytes, ... } }
 */
function diffManifests(targetManifest, haveManifest) {
  const target = validateManifest(targetManifest);

  if (!target.ok) {
    return target;
  }

  let have = new Set();

  if (haveManifest !== null && haveManifest !== undefined) {
    const checked = validateManifest(haveManifest);

    if (!checked.ok) {
      return checked;
    }

    have = new Set(checked.value.chunks.map((c) => c.digest));
  }

  const missing = [];
  const seen = new Set();
  let reusedBytes = 0;
  let transferBytes = 0;

  for (const chunk of target.value.chunks) {
    if (have.has(chunk.digest)) {
      reusedBytes += chunk.size;
      continue;
    }

    // 同一摘要在一份文件里可能重复出现(全零块等),只需传一次。
    if (seen.has(chunk.digest)) {
      reusedBytes += chunk.size;
      continue;
    }

    seen.add(chunk.digest);
    missing.push({ offset: chunk.offset, size: chunk.size, digest: chunk.digest });
    transferBytes += chunk.size;
  }

  const size = Number.isSafeInteger(target.value.size) ? target.value.size : 0;

  return {
    ok: true,
    value: {
      schema: SCHEMA,
      missing,
      reusedBytes,
      transferBytes,
      totalBytes: size,
      // 供调用方做「分块是否划算」的判断:整份重传就是 totalBytes。
      savedRatio: size > 0 ? Number((reusedBytes / size).toFixed(4)) : 0,
    },
  };
}

/**
 * 构造补丁:按 target 清单顺序输出指令流,对端已有的块记 copy(只带摘要),
 * 缺的块记 data(带字节)。刻意保留 copy 指令而不只发缺块 —— 拼装时才能纯靠补丁
 * 定序,不必要求对端另存一份「块该放哪」的元数据。
 *
 * @param {Buffer|Uint8Array|string} content 权威侧完整内容
 * @param {object} targetManifest content 对应的清单
 * @param {object} [haveManifest] 对端已持有清单
 * @returns {object} { ok: true, value: { schema, size, digest, instructions } }
 */
function buildPatch(content, targetManifest, haveManifest) {
  const buffered = toBuffer(content);

  if (!buffered.ok) {
    return buffered;
  }

  const diffed = diffManifests(targetManifest, haveManifest);

  if (!diffed.ok) {
    return diffed;
  }

  const buf = buffered.value;
  const needed = new Set(diffed.value.missing.map((c) => c.digest));
  const emitted = new Set();
  const instructions = [];

  for (const chunk of targetManifest.chunks) {
    const end = chunk.offset + chunk.size;

    if (needed.has(chunk.digest) && !emitted.has(chunk.digest)) {
      if (end > buf.length) {
        return _fail(
          CODES.INVALID_MANIFEST,
          `分块清单越界：块 ${chunk.digest} 落在 ${end}，内容仅 ${buf.length} 字节`
        );
      }

      emitted.add(chunk.digest);
      instructions.push({
        op: 'data',
        digest: chunk.digest,
        size: chunk.size,
        bytes: Buffer.from(buf.subarray(chunk.offset, end)),
      });
      continue;
    }

    instructions.push({ op: 'copy', digest: chunk.digest, size: chunk.size });
  }

  return {
    ok: true,
    value: {
      schema: SCHEMA,
      size: diffed.value.totalBytes,
      digest: targetManifest.digest,
      instructions,
      transferBytes: diffed.value.transferBytes,
      reusedBytes: diffed.value.reusedBytes,
    },
  };
}

/**
 * 应用补丁。copy 指令从本地块库(digest → bytes)取,data 指令直接落字节;
 * 任一块缺失或整体摘要不符都回结构化错误 —— **绝不返回半拼好的内容**,
 * 否则一次丢包就会把用户文件写成一半新一半旧。
 *
 * @param {object} patch buildPatch 的产物
 * @param {Map|object} localChunks 本地块库,digest → Buffer/Uint8Array/string
 * @returns {object} { ok: true, value: { content, size, digest } } 或 { ok: false, error }
 */
function applyPatch(patch, localChunks) {
  if (!patch || typeof patch !== 'object' || patch.schema !== SCHEMA) {
    return _fail(CODES.INVALID_PATCH, `分块补丁无效：期望 ${SCHEMA} 结构的对象`);
  }

  if (!Array.isArray(patch.instructions)) {
    return _fail(CODES.INVALID_PATCH, '分块补丁缺少 instructions 数组');
  }

  const lookup = (digest) => {
    if (localChunks instanceof Map) {
      return localChunks.get(digest);
    }

    return localChunks && typeof localChunks === 'object' ? localChunks[digest] : undefined;
  };

  const parts = [];

  for (const step of patch.instructions) {
    if (!step || typeof step !== 'object') {
      return _fail(CODES.INVALID_PATCH, '分块补丁含非对象指令');
    }

    if (step.op === 'data') {
      const bytes = toBuffer(step.bytes);

      if (!bytes.ok) {
        return _fail(CODES.INVALID_PATCH, `分块补丁的 data 指令字节无效：块 ${step.digest}`);
      }

      parts.push(bytes.value);
      continue;
    }

    if (step.op !== 'copy') {
      return _fail(CODES.INVALID_PATCH, `分块补丁含未知指令 op：${String(step.op)}`);
    }

    const held = lookup(step.digest);

    if (held === undefined || held === null) {
      return _fail(CODES.CHUNK_MISSING, `本地缺少块 ${step.digest}，需请求重传该块`, {
        digest: step.digest,
      });
    }

    const bytes = toBuffer(held);

    if (!bytes.ok) {
      return bytes;
    }

    parts.push(bytes.value);
  }

  const content = Buffer.concat(parts);

  if (Number.isSafeInteger(patch.size) && content.length !== patch.size) {
    return _fail(
      CODES.DIGEST_MISMATCH,
      `拼装长度不符：得到 ${content.length} 字节，补丁声明 ${patch.size} 字节`,
      { expectedSize: patch.size, actualSize: content.length }
    );
  }

  if (typeof patch.digest === 'string' && patch.digest) {
    const actual = digestBytes(content, 0, content.length);

    if (actual !== patch.digest) {
      return _fail(CODES.DIGEST_MISMATCH, `拼装摘要不符：得到 ${actual}，期望 ${patch.digest}`, {
        expectedDigest: patch.digest,
        actualDigest: actual,
      });
    }
  }

  return { ok: true, value: { content, size: content.length, digest: patch.digest || null } };
}

/**
 * 面向用户的状态文本:必须是「动作 + 目标 + 进度」,不允许「同步中… / 请稍候」这类
 * 无信息量文案(工程红线 2)。
 *
 * @param {string} relPath 文件路径
 * @param {object} diff diffManifests 的 value
 * @returns {string}
 */
function describeChunkPlan(relPath, diff) {
  const path = typeof relPath === 'string' && relPath ? relPath : '(未命名文件)';

  if (!diff || typeof diff !== 'object') {
    return `分块比对 ${path}：尚未生成传输计划`;
  }

  const missing = Array.isArray(diff.missing) ? diff.missing.length : 0;
  const percent = Math.round((Number(diff.savedRatio) || 0) * 100);

  if (missing === 0) {
    return `分块比对 ${path}：${diff.totalBytes || 0} 字节全部命中本地块，无需传输`;
  }

  return (
    `分块传输 ${path}：需传 ${missing} 块 / ${diff.transferBytes || 0} 字节，` +
    `复用 ${diff.reusedBytes || 0} 字节（省 ${percent}%）`
  );
}

module.exports = {
  CODES,
  SCHEMA,
  DEFAULT_CHUNK_LIMITS,
  isChunkDiffEnabled,
  resolveChunkLimits,
  toBuffer,
  digestBytes,
  splitChunks,
  validateManifest,
  diffManifests,
  buildPatch,
  applyPatch,
  describeChunkPlan,
};
