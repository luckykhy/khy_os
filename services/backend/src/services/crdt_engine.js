'use strict';

/**
 * crdt_engine.js — 文档级操作合并引擎(纯叶子:零 IO、确定性、绝不抛)。
 *
 * WHY: khy 已有 _fileLock 悲观锁 + 冲突副本,这只能「避免互相覆盖」,不能让两个实例
 * **基于同一版本**同时提交编辑再自动合并。缺口是一层「带基线版本的最小操作 + 确定性
 * 合并」。本模块就是这一层的判定核心:所有「这个操作合法吗 / 能不能自动合并 / 合并成
 * 什么」的判断都在这里,且不碰 fs / net / 时钟,故可脱离真实 IO 被确定性单测。
 *
 * 为什么不是「纯 Yjs」:Yjs 是 CRDT,它**永远不报冲突** —— 重叠编辑被字符级 LWW 静默
 * 吞掉,调用方拿不到「这两个人改了同一块」的信号。而本任务的红线正是「不允许最后写入者
 * 静默覆盖另一方」。所以冲突语义由本模块的 OT 变换负责,Yjs 只做**收敛基座**:
 *   - 每文件一份权威 Y.Doc,提供 encodeStateVector / encodeStateAsUpdate,
 *     使断线补齐与 resync 有一个与到达顺序无关的二进制真源;
 *   - 乱序/重放的更新经 Y.applyUpdate 后收敛到同一状态,给「相同输入不同实例同一输出」
 *     兜第二道底。
 * yjs 是**懒 require + try/catch**:装不上或坏了 → degraded 标记回给调用方,由 bus 走
 * MERGE_FALLBACK 回落文件锁,绝不因为一个可选依赖让写入失败。
 *
 * 契约:每个导出函数返回 { ok: true, value } 或 { ok: false, error },绝不抛
 * 可预期的输入错误 / 依赖错误 / 合并冲突。零模块作用域可变态。
 *
 * 门控 KHY_FILE_SYNC(默认开,仅显式 0/false/off/no 关):关 → isEngineEnabled 返 false,
 * 调用方据此逐字节回退到今日的 _fileLock 行为(本模块不主动改变任何既有路径)。
 *
 * @module services/crdt_engine
 */

const OFF_WORDS = ['0', 'false', 'off', 'no'];

// Structured error codes. Public contract — clients branch on these, keep stable.
const CODES = {
  INVALID_PATH: 'INVALID_PATH',
  PATH_ESCAPE: 'PATH_ESCAPE',
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
  MISSING_OP_ID: 'MISSING_OP_ID',
  DUPLICATE_OP_ID: 'DUPLICATE_OP_ID',
  MISSING_BASE_VERSION: 'MISSING_BASE_VERSION',
  BASE_VERSION_STALE: 'BASE_VERSION_STALE',
  BASE_VERSION_AHEAD: 'BASE_VERSION_AHEAD',
  HISTORY_EVICTED: 'HISTORY_EVICTED',
  INVALID_OPERATION: 'INVALID_OPERATION',
  INVALID_RANGE: 'INVALID_RANGE',
  OVERLAPPING_BATCH: 'OVERLAPPING_BATCH',
  OP_TOO_LARGE: 'OP_TOO_LARGE',
  INVALID_ENCODING: 'INVALID_ENCODING',
  BINARY_FILE: 'BINARY_FILE',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  UNAUTHENTICATED_SESSION: 'UNAUTHENTICATED_SESSION',
  SUBSCRIBE_FORBIDDEN: 'SUBSCRIBE_FORBIDDEN',
  EDIT_FORBIDDEN: 'EDIT_FORBIDDEN',
  MERGE_CONFLICT: 'MERGE_CONFLICT',
  MERGE_FALLBACK: 'MERGE_FALLBACK',
};

// Default bounds. Every one is env-overridable so ops can tune without a release;
// resolveLimits stays pure (env is passed in, never read from process here).
const DEFAULT_LIMITS = {
  maxPathLength: 400,
  maxIdLength: 128,
  maxOpsPerBatch: 200,
  maxInsertChars: 64 * 1024,
  maxBatchChars: 256 * 1024,
  maxDocChars: 4 * 1024 * 1024,
  historyLimit: 200,
};

/**
 * 门控:默认开,仅显式 0/false/off/no 关。
 *
 * @param {object} [env] 注入的环境变量视图
 * @returns {boolean}
 */
function isEngineEnabled(env) {
  try {
    const raw = env && env.KHY_FILE_SYNC;

    if (raw === undefined || raw === null || raw === '') {
      return true;
    }

    return !OFF_WORDS.includes(String(raw).trim().toLowerCase());
  } catch {
    return true;
  }
}

/**
 * 解析边界值。坏值 / 越界值一律回落默认,绝不抛。
 *
 * @param {object} [env] 注入的环境变量视图
 * @returns {object} 与 DEFAULT_LIMITS 同形
 */
function resolveLimits(env) {
  const out = { ...DEFAULT_LIMITS };
  const map = {
    maxOpsPerBatch: 'KHY_FILE_SYNC_MAX_OPS',
    maxInsertChars: 'KHY_FILE_SYNC_MAX_INSERT',
    maxBatchChars: 'KHY_FILE_SYNC_MAX_BATCH',
    maxDocChars: 'KHY_FILE_SYNC_MAX_DOC',
    historyLimit: 'KHY_FILE_SYNC_HISTORY',
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

  return out;
}

function _fail(code, message, extra) {
  return { ok: false, error: { code, message, ...(extra || {}) } };
}

function _isInt(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

/**
 * 稳定 32-bit FNV-1a 哈希。用于给 Y.Doc 派生**确定性** clientID —— Yjs 默认随机
 * clientID 会让同一份输入在两个实例上产出不同二进制,破坏「确定性」这条验收。
 *
 * @param {string} input 任意字符串
 * @returns {number} 正整数
 */
function stableHash(input) {
  let h = 0x811c9dc5;
  const s = String(input === null || input === undefined ? '' : input);

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }

  return h === 0 ? 1 : h;
}

/**
 * 文本是否「像二进制」:含空字节、或控制字符占比过高。文本 CRDT 合并器绝不能用于
 * 二进制文件(逐字符位置语义不成立),命中即由调用方走文件锁降级。
 *
 * @param {string} text 待判定内容
 * @returns {boolean}
 */
function looksBinary(text) {
  try {
    const s = String(text === null || text === undefined ? '' : text);

    if (s.indexOf('\u0000') >= 0) {
      return true;
    }

    const probe = s.slice(0, 8192);

    if (probe.length === 0) {
      return false;
    }

    let ctrl = 0;

    for (let i = 0; i < probe.length; i++) {
      const c = probe.charCodeAt(i);

      // Allow TAB / LF / CR — everything else below 0x20 plus DEL is a control char.
      if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0x7f) {
        ctrl++;
      }
    }

    return ctrl / probe.length > 0.02;
  } catch {
    // 无法判断时保守当二进制 → 走降级,绝不拿文本合并器去糟蹋它
    return true;
  }
}

/**
 * 文本编码是否合法:拒绝替换字符 U+FFFD 与孤立代理对(JSON 往返后常见的坏编码信号)。
 *
 * @param {string} text 待判定内容
 * @returns {boolean}
 */
function hasValidEncoding(text) {
  try {
    const s = String(text === null || text === undefined ? '' : text);

    if (s.indexOf('�') >= 0) {
      return false;
    }

    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);

      if (c >= 0xd800 && c <= 0xdbff) {
        const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;

        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          return false;
        }

        i++;
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * 规范化客户端提交的文件路径。**绝不把未经校验的客户端路径交给磁盘** —— 这里是那道闸。
 *
 * 只接受仓库相对的 POSIX 路径:拒绝绝对路径、盘符、UNC、`..` 越界、空字节 / 控制字符、
 * 超长路径。可选 allowPrefixes 白名单(注入,本模块不写死任何路径)。
 *
 * @param {string} input 客户端给的路径
 * @param {object} [opts] { limits, allowPrefixes }
 * @returns {object} { ok: true, value } 或 { ok: false, error }
 */
/** Control-byte scan by code point — avoids a control-character literal in a regex. */
function _hasControlChar(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

function normalizeRelPath(input, opts = {}) {
  const limits = opts.limits || DEFAULT_LIMITS;

  if (typeof input !== 'string' || input.trim() === '') {
    return _fail(CODES.INVALID_PATH, '文件路径非法：路径必须是非空字符串');
  }

  if (input.length > limits.maxPathLength) {
    return _fail(
      CODES.INVALID_PATH,
      `文件路径非法：长度 ${input.length} 字符，超出上限 ${limits.maxPathLength}`
    );
  }

  if (_hasControlChar(input)) {
    return _fail(CODES.INVALID_PATH, '文件路径非法：路径含控制字符或空字节');
  }

  const unified = input.replace(/\\/g, '/');

  if (unified.startsWith('//') || unified.startsWith('/') || /^[a-zA-Z]:\//.test(unified)) {
    return _fail(CODES.PATH_ESCAPE, `文件路径越界：不接受绝对路径或 UNC 路径 "${input}"`);
  }

  const segments = [];

  for (const raw of unified.split('/')) {
    if (raw === '' || raw === '.') {
      continue;
    }

    if (raw === '..') {
      return _fail(CODES.PATH_ESCAPE, `文件路径越界：不接受向上穿越段 ".." — "${input}"`);
    }

    segments.push(raw);
  }

  if (segments.length === 0) {
    return _fail(CODES.INVALID_PATH, '文件路径非法：规范化后为空');
  }

  const value = segments.join('/');
  const prefixes = Array.isArray(opts.allowPrefixes) ? opts.allowPrefixes.filter(Boolean) : [];

  if (prefixes.length > 0) {
    const allowed = prefixes.some((p) => {
      const norm = String(p)
        .replace(/\\/g, '/')
        .replace(/\/+$/, '');

      return value === norm || value.startsWith(`${norm}/`);
    });

    if (!allowed) {
      return _fail(
        CODES.PATH_NOT_ALLOWED,
        `未授权的订阅/编辑目标：路径 "${value}" 不在 ${prefixes.length} 条白名单前缀内`,
        { path: value }
      );
    }
  }

  return { ok: true, value };
}

/**
 * 归一化单个操作。接受三种客户端写法,统一成 { kind, position, text | length }:
 *   { insert: 'abc', position: 5 }
 *   { delete: 3, position: 5 } | { delete: true, range: { start, end } }
 *   { range: { start, end }, insert: 'x' } → 拆成 delete + insert(替换)
 *
 * @param {object} raw 客户端原始操作
 * @param {object} limits 边界值
 * @returns {object} { ok: true, value: op[] } 或 { ok: false, error }
 */
function normalizeOperation(raw, limits) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return _fail(CODES.INVALID_OPERATION, '操作非法：每个操作必须是对象');
  }

  const range = raw.range && typeof raw.range === 'object' ? raw.range : null;
  let position = raw.position;
  let deleteLength = null;

  if (range) {
    if (!_isInt(range.start) || !_isInt(range.end) || range.end < range.start) {
      return _fail(
        CODES.INVALID_RANGE,
        `操作区间非法：range 必须满足 0 ≤ start ≤ end（收到 start=${range.start}, end=${range.end}）`
      );
    }

    position = range.start;
    deleteLength = range.end - range.start;
  }

  if (raw.delete !== undefined && raw.delete !== null && raw.delete !== false) {
    if (_isInt(raw.delete)) {
      deleteLength = raw.delete;
    } else if (raw.delete !== true) {
      return _fail(
        CODES.INVALID_OPERATION,
        '操作非法：delete 必须是非负整数长度、true（配合 range）或省略'
      );
    }
  }

  if (raw.kind === 'delete' && deleteLength === null && _isInt(raw.length)) {
    deleteLength = raw.length;
  }

  const insertText = raw.insert === undefined || raw.insert === null ? null : raw.insert;

  if (insertText !== null && typeof insertText !== 'string') {
    return _fail(CODES.INVALID_OPERATION, '操作非法：insert 必须是字符串');
  }

  if (!_isInt(position)) {
    return _fail(
      CODES.INVALID_RANGE,
      `操作区间非法：position 必须是非负整数（收到 ${JSON.stringify(raw.position)}）`
    );
  }

  if (insertText === null && !deleteLength) {
    return _fail(CODES.INVALID_OPERATION, '操作非法：既没有 insert 内容也没有 delete 长度');
  }

  if (insertText !== null) {
    if (insertText.length > limits.maxInsertChars) {
      return _fail(
        CODES.OP_TOO_LARGE,
        `操作过大：单次插入 ${insertText.length} 字符，超出上限 ${limits.maxInsertChars}`
      );
    }

    if (!hasValidEncoding(insertText)) {
      return _fail(CODES.INVALID_ENCODING, '操作编码非法：插入内容含替换字符或孤立代理对');
    }

    if (looksBinary(insertText)) {
      return _fail(CODES.BINARY_FILE, '拒绝合并二进制内容：插入内容含空字节或过多控制字符');
    }
  }

  const out = [];

  // Delete first: both halves of a replace address the same base snapshot, so the
  // delete range is expressed before the insert lands.
  if (deleteLength) {
    out.push({ kind: 'delete', position, length: deleteLength });
  }

  if (insertText !== null && insertText !== '') {
    out.push({ kind: 'insert', position, text: insertText });
  }

  if (out.length === 0) {
    return _fail(CODES.INVALID_OPERATION, '操作非法：归一化后为空操作');
  }

  return { ok: true, value: out };
}

function _batchSpan(op) {
  return op.kind === 'delete'
    ? { start: op.position, end: op.position + op.length }
    : { start: op.position, end: op.position };
}

/**
 * 校验一批操作:数量、总量、批内互不重叠(批内所有 position 都相对同一基线快照,
 * 重叠即语义歧义,必须由客户端拆成两个版本提交)。
 *
 * @param {object[]} ops 已归一化操作
 * @param {object} limits 边界值
 * @returns {object} { ok: true, value: ops } 或 { ok: false, error }
 */
function validateBatch(ops, limits) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return _fail(CODES.INVALID_OPERATION, '操作非法：operations 必须是非空数组');
  }

  if (ops.length > limits.maxOpsPerBatch) {
    return _fail(
      CODES.OP_TOO_LARGE,
      `操作过大：单批 ${ops.length} 个操作，超出上限 ${limits.maxOpsPerBatch}`
    );
  }

  let chars = 0;

  for (const op of ops) {
    chars += op.kind === 'insert' ? op.text.length : op.length;
  }

  if (chars > limits.maxBatchChars) {
    return _fail(
      CODES.OP_TOO_LARGE,
      `操作过大：单批影响 ${chars} 字符，超出上限 ${limits.maxBatchChars}`
    );
  }

  const spans = ops
    .map((op, index) => ({ index, kind: op.kind, ..._batchSpan(op) }))
    .filter((s) => s.kind === 'delete')
    .sort((a, b) => a.start - b.start || a.index - b.index);

  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) {
      return _fail(
        CODES.OVERLAPPING_BATCH,
        `批内操作重叠：删除区间 [${spans[i - 1].start},${spans[i - 1].end}) 与 ` +
          `[${spans[i].start},${spans[i].end}) 相交`
      );
    }
  }

  return { ok: true, value: ops };
}

/**
 * 校验并归一化一条完整的文件操作信封。这是「未认证会话 / 未授权编辑 / 非法路径 /
 * 缺失 opId / 缺失 baseVersion / 非法 range / 超大操作 / 非法编码 / 二进制内容」
 * 这一整排边界的单一入口。
 *
 * @param {object} envelope 客户端提交的原始信封
 * @param {object} [ctx] { limits, allowPrefixes, authenticated, canEdit }
 * @returns {object} { ok: true, value } 或 { ok: false, error }
 */
function validateOpEnvelope(envelope, ctx = {}) {
  const limits = ctx.limits || DEFAULT_LIMITS;

  if (!envelope || typeof envelope !== 'object') {
    return _fail(CODES.INVALID_OPERATION, '操作非法：信封必须是对象');
  }

  if (ctx.authenticated === false) {
    return _fail(CODES.UNAUTHENTICATED_SESSION, '会话未认证：请先完成 auth 再提交文件操作');
  }

  if (ctx.canEdit === false) {
    return _fail(
      CODES.EDIT_FORBIDDEN,
      `未授权编辑：当前会话对 "${String(envelope.path || '')}" 没有写权限`
    );
  }

  const pathResult = normalizeRelPath(envelope.path, {
    limits,
    allowPrefixes: ctx.allowPrefixes,
  });

  if (!pathResult.ok) {
    return pathResult;
  }

  const opId = typeof envelope.opId === 'string' ? envelope.opId.trim() : '';

  if (!opId) {
    return _fail(CODES.MISSING_OP_ID, '缺少 opId：每个操作必须带唯一的 opId 以支持幂等去重');
  }

  if (opId.length > limits.maxIdLength) {
    return _fail(
      CODES.MISSING_OP_ID,
      `opId 非法：长度 ${opId.length} 字符，超出上限 ${limits.maxIdLength}`
    );
  }

  if (!_isInt(envelope.baseVersion)) {
    return _fail(
      CODES.MISSING_BASE_VERSION,
      `缺少 baseVersion：提交必须声明基线版本（收到 ${JSON.stringify(envelope.baseVersion)}）`
    );
  }

  const sessionId = typeof envelope.sessionId === 'string' ? envelope.sessionId.trim() : '';
  const editor = typeof envelope.editor === 'string' ? envelope.editor.trim() : '';

  if (!sessionId && !editor) {
    return _fail(CODES.INVALID_OPERATION, '操作非法：必须至少提供 sessionId 或 editor 之一');
  }

  if (sessionId.length > limits.maxIdLength || editor.length > limits.maxIdLength) {
    return _fail(
      CODES.INVALID_OPERATION,
      `操作非法：sessionId / editor 长度超出上限 ${limits.maxIdLength}`
    );
  }

  const rawOps = Array.isArray(envelope.operations)
    ? envelope.operations
    : [
        {
          position: envelope.position,
          range: envelope.range,
          insert: envelope.insert,
          delete: envelope.delete,
          kind: envelope.kind,
          length: envelope.length,
        },
      ];

  if (rawOps.length > limits.maxOpsPerBatch) {
    return _fail(
      CODES.OP_TOO_LARGE,
      `操作过大：单批 ${rawOps.length} 个操作，超出上限 ${limits.maxOpsPerBatch}`
    );
  }

  const flat = [];

  for (const raw of rawOps) {
    const norm = normalizeOperation(raw, limits);

    if (!norm.ok) {
      return norm;
    }

    flat.push(...norm.value);
  }

  const batch = validateBatch(flat, limits);

  if (!batch.ok) {
    return batch;
  }

  return {
    ok: true,
    value: {
      path: pathResult.value,
      opId,
      editor: editor || sessionId,
      sessionId: sessionId || editor,
      baseVersion: envelope.baseVersion,
      operations: batch.value,
    },
  };
}

/**
 * 把一个操作对另一个**已提交**操作做变换(两者位置都相对同一份文档状态)。
 *
 * 确定性来源:同位置 insert 用 opId 字典序定序 —— 任何实例算同一对 (a, c) 都得同一
 * 结果,故「相同输入在不同实例得到相同输出」。真正重叠的编辑不做猜测,直接报冲突。
 *
 * @param {object} a 待变换的入向操作
 * @param {object} c 已提交操作
 * @param {string} aOpId 入向操作所属批次 opId
 * @param {string} cOpId 已提交操作所属批次 opId
 * @returns {object} { ok: true, value: op | null } 或 { ok: false, error }
 */
function transformAgainst(a, c, aOpId, cOpId) {
  if (c.kind === 'insert') {
    const len = c.text.length;

    if (a.kind === 'insert') {
      if (a.position < c.position) {
        return { ok: true, value: a };
      }

      if (a.position > c.position) {
        return { ok: true, value: { ...a, position: a.position + len } };
      }

      // Same insertion point: total order by opId — no conflict, no data loss.
      return String(aOpId) > String(cOpId)
        ? { ok: true, value: { ...a, position: a.position + len } }
        : { ok: true, value: a };
    }

    const aEnd = a.position + a.length;

    if (c.position <= a.position) {
      return { ok: true, value: { ...a, position: a.position + len } };
    }

    if (c.position >= aEnd) {
      return { ok: true, value: a };
    }

    return _fail(
      CODES.MERGE_CONFLICT,
      `文件存在重叠编辑冲突：已提交插入落在待删除区间 [${a.position},${aEnd}) 内部` +
        `（插入位置 ${c.position}）`,
      { conflictingOpIds: [cOpId] }
    );
  }

  const cEnd = c.position + c.length;

  if (a.kind === 'insert') {
    if (a.position <= c.position) {
      return { ok: true, value: a };
    }

    if (a.position >= cEnd) {
      return { ok: true, value: { ...a, position: a.position - c.length } };
    }

    return _fail(
      CODES.MERGE_CONFLICT,
      `文件存在重叠编辑冲突：插入位置 ${a.position} 落在已提交删除区间 ` +
        `[${c.position},${cEnd}) 内部`,
      { conflictingOpIds: [cOpId] }
    );
  }

  const aEnd = a.position + a.length;

  if (aEnd <= c.position) {
    return { ok: true, value: a };
  }

  if (a.position >= cEnd) {
    return { ok: true, value: { ...a, position: a.position - c.length } };
  }

  return _fail(
    CODES.MERGE_CONFLICT,
    `文件存在重叠编辑冲突：待删除区间 [${a.position},${aEnd}) 与已提交删除区间 ` +
      `[${c.position},${cEnd}) 相交`,
    { conflictingOpIds: [cOpId] }
  );
}

/**
 * 把一个基于 baseVersion 的操作批次,顺序变换到最新版本(rebase)。
 *
 * committed 是 baseVersion 之后按版本升序的已提交批次;顺序在每个实例上都相同,
 * 故 rebase 结果确定。任一步命中重叠 → 结构化 MERGE_CONFLICT,保留双方 opId 信息,
 * 调用方可继续审阅或走冲突副本。
 *
 * @param {object} incoming { opId, operations }
 * @param {object[]} committed [{ version, opId, operations }]
 * @returns {object} { ok: true, value: { operations, rebasedOver } } 或 { ok: false, error }
 */
function rebaseOperations(incoming, committed) {
  try {
    const list = Array.isArray(committed) ? committed.slice() : [];

    list.sort((x, y) => x.version - y.version);

    let ops = Array.isArray(incoming && incoming.operations) ? incoming.operations.slice() : [];

    if (ops.length === 0) {
      return _fail(CODES.INVALID_OPERATION, '操作非法：待变换的操作列表为空');
    }

    const conflicting = new Set();

    for (const batch of list) {
      for (const c of batch.operations || []) {
        const next = [];

        for (const a of ops) {
          const r = transformAgainst(a, c, incoming.opId, batch.opId);

          if (!r.ok) {
            for (const id of r.error.conflictingOpIds || []) {
              conflicting.add(id);
            }

            return { ok: false, error: { ...r.error, conflictingOpIds: [...conflicting] } };
          }

          if (r.value) {
            next.push(r.value);
          }
        }

        ops = next;

        if (ops.length === 0) {
          return _fail(
            CODES.MERGE_CONFLICT,
            '文件存在重叠编辑冲突：本次操作已被此前提交的删除完全吞掉，无可应用内容',
            { conflictingOpIds: [batch.opId] }
          );
        }
      }
    }

    return { ok: true, value: { operations: ops, rebasedOver: list.length } };
  } catch (err) {
    return _fail(
      CODES.MERGE_FALLBACK,
      `实时合并不可用，已进入文件锁降级路径：变换阶段异常 ${(err && err.message) || err}`,
      { fallback: 'file_lock' }
    );
  }
}

/**
 * 批内应用顺序:position 降序、同位置按原下标降序。批内所有 position 都相对同一份
 * 基线,倒序应用可保证先应用的改动不移动后应用的位置;同位置时倒序恰好保留原始次序。
 *
 * @param {object[]} ops 操作数组
 * @returns {object[]} 应用顺序副本
 */
function orderForApply(ops) {
  return ops
    .map((op, index) => ({ op, index }))
    .sort((a, b) => b.op.position - a.op.position || b.index - a.index)
    .map((entry) => entry.op);
}

/**
 * 在纯字符串上应用一批操作(yjs 不可用时的降级路径,也是 yjs 路径的对照真源)。
 *
 * @param {string} text 当前文本
 * @param {object[]} operations 已变换操作
 * @param {object} [limits] 边界值
 * @returns {object} { ok: true, value: string } 或 { ok: false, error }
 */
function applyOperations(text, operations, limits = DEFAULT_LIMITS) {
  try {
    let out = String(text === null || text === undefined ? '' : text);

    for (const op of orderForApply(operations)) {
      if (op.kind === 'delete') {
        const end = op.position + op.length;

        if (end > out.length) {
          return _fail(
            CODES.OUT_OF_RANGE,
            `操作区间越界：删除 [${op.position},${end}) 超出文档长度 ${out.length}`
          );
        }

        out = out.slice(0, op.position) + out.slice(end);
      } else {
        if (op.position > out.length) {
          return _fail(
            CODES.OUT_OF_RANGE,
            `操作区间越界：插入位置 ${op.position} 超出文档长度 ${out.length}`
          );
        }

        out = out.slice(0, op.position) + op.text + out.slice(op.position);
      }
    }

    if (out.length > limits.maxDocChars) {
      return _fail(
        CODES.OP_TOO_LARGE,
        `操作过大：应用后文档 ${out.length} 字符，超出上限 ${limits.maxDocChars}`
      );
    }

    return { ok: true, value: out };
  } catch (err) {
    return _fail(
      CODES.MERGE_FALLBACK,
      `实时合并不可用，已进入文件锁降级路径：应用阶段异常 ${(err && err.message) || err}`,
      { fallback: 'file_lock' }
    );
  }
}

/** 懒加载 yjs。装不上 / 坏了 → null,由调用方走降级,绝不抛。 */
function _loadYjs() {
  try {
    // Lazy + guarded on purpose: yjs is the convergence substrate, not a hard
    // requirement — a broken optional dep must never fail a write.
    return require('yjs');
  } catch {
    return null;
  }
}

/**
 * yjs 是否可用(供 doctor / 状态展示)。
 *
 * @returns {boolean}
 */
function isYjsAvailable() {
  return _loadYjs() !== null;
}

/**
 * 建立一份文件的权威 Y.Doc。clientID 由 clientKey 确定性派生,使同一输入在任何实例上
 * 产出逐字节相同的二进制更新。
 *
 * @param {object} [opts] { text, clientKey }
 * @returns {object} { ok: true, value: { doc, text, available, degraded? } }
 */
function createDocument(opts = {}) {
  const text = String(opts.text === null || opts.text === undefined ? '' : opts.text);
  const Y = _loadYjs();

  if (!Y) {
    return { ok: true, value: { doc: null, text, available: false, degraded: 'yjs_unavailable' } };
  }

  try {
    const doc = new Y.Doc();

    doc.clientID = stableHash(opts.clientKey || 'khy-file-sync');

    if (text) {
      doc.getText('content').insert(0, text);
    }

    return { ok: true, value: { doc, text, available: true } };
  } catch (err) {
    return {
      ok: true,
      value: {
        doc: null,
        text,
        available: false,
        degraded: `yjs_init_failed:${(err && err.message) || 'unknown'}`,
      },
    };
  }
}

/**
 * 把一批已变换的操作应用到 Y.Doc,返回本次的增量二进制更新(base64)与新文本。
 * yjs 缺席 / 文档损坏 → degraded 标记 + 纯字符串结果,调用方据此决定是否降级。
 *
 * @param {object|null} doc Y.Doc 或 null
 * @param {object[]} operations 已变换操作
 * @param {object} [opts] { fallbackText, limits }
 * @returns {object} { ok: true, value: { text, update, degraded? } } 或 { ok: false, error }
 */
function applyToDocument(doc, operations, opts = {}) {
  const limits = opts.limits || DEFAULT_LIMITS;
  const Y = _loadYjs();

  if (!Y || !doc) {
    const plain = applyOperations(opts.fallbackText, operations, limits);

    if (!plain.ok) {
      return plain;
    }

    return { ok: true, value: { text: plain.value, update: null, degraded: 'yjs_unavailable' } };
  }

  try {
    const before = Y.encodeStateVector(doc);
    const ytext = doc.getText('content');
    const current = ytext.toString();

    // Pre-flight on the plain string so an out-of-range op is rejected BEFORE it
    // mutates the authoritative doc — a half-applied batch is exactly the
    // "半写入" the contract forbids.
    const preflight = applyOperations(current, operations, limits);

    if (!preflight.ok) {
      return preflight;
    }

    doc.transact(() => {
      for (const op of orderForApply(operations)) {
        if (op.kind === 'delete') {
          ytext.delete(op.position, op.length);
        } else {
          ytext.insert(op.position, op.text);
        }
      }
    });

    const text = ytext.toString();

    if (text !== preflight.value) {
      return _fail(
        CODES.MERGE_FALLBACK,
        '实时合并不可用，已进入文件锁降级路径：Yjs 物化结果与纯文本对照不一致，文档状态可疑',
        { fallback: 'file_lock' }
      );
    }

    return {
      ok: true,
      value: {
        text,
        update: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString('base64'),
      },
    };
  } catch (err) {
    return _fail(
      CODES.MERGE_FALLBACK,
      `实时合并不可用，已进入文件锁降级路径：Yjs 应用阶段异常 ${(err && err.message) || err}`,
      { fallback: 'file_lock' }
    );
  }
}

/**
 * 导出整份文档状态(resync 依据)。yjs 在场时给 Yjs 二进制快照 + 状态向量,
 * 缺席时只给纯文本 —— 两种情况客户端都能恢复。
 *
 * @param {object|null} doc Y.Doc 或 null
 * @param {string} fallbackText yjs 缺席时的文本
 * @returns {object} { ok: true, value: { text, snapshot, stateVector } }
 */
function encodeSnapshot(doc, fallbackText) {
  const plain = String(fallbackText === null || fallbackText === undefined ? '' : fallbackText);
  const Y = _loadYjs();

  if (!Y || !doc) {
    return { ok: true, value: { text: plain, snapshot: null, stateVector: null } };
  }

  try {
    return {
      ok: true,
      value: {
        text: doc.getText('content').toString(),
        snapshot: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
        stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'),
      },
    };
  } catch {
    return { ok: true, value: { text: plain, snapshot: null, stateVector: null } };
  }
}

module.exports = {
  CODES,
  DEFAULT_LIMITS,
  isEngineEnabled,
  resolveLimits,
  stableHash,
  looksBinary,
  hasValidEncoding,
  normalizeRelPath,
  normalizeOperation,
  validateBatch,
  validateOpEnvelope,
  transformAgainst,
  rebaseOperations,
  orderForApply,
  applyOperations,
  isYjsAvailable,
  createDocument,
  applyToDocument,
  encodeSnapshot,
};
