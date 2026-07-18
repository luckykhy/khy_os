'use strict';

/**
 * Session Persistence — save/restore conversation sessions to disk.
 *
 * 双轨持久化:
 * 1. Append-only JSONL transcript (借鉴 Claude Code sessionStorage.ts)
 *    - 每条消息带 uuid + parentUuid 形成有向链表
 *    - 支持增量追加、崩溃恢复、会话分支
 * 2. JSON snapshot (原有逻辑) 作为检查点备份
 *
 * G6: 使用原子写入（tmp+fsync+rename）防止崩溃时数据丢失，
 *     并支持检查点保存/恢复。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getProjectDataDir } = require('../utils/dataHome');

const UNKNOWN_BUCKET = '_unknown';

function _sessionsDir() {
  return getProjectDataDir('sessions');
}

function _safeId(sessionId) {
  return String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * Encode an absolute cwd into a filesystem-safe project bucket name.
 * Mirrors Claude Code's projects/<encoded-path> convention, e.g.
 *   /home/kodehu03/Khy-OS -> -home-kodehu03-Khy-OS
 * Empty / missing cwd resolves to the shared "_unknown" bucket.
 *
 * @param {string} [cwd]
 * @returns {string} bucket directory name
 */
function _encodeProject(cwd) {
  const raw = String(cwd || '').trim();
  if (!raw) return UNKNOWN_BUCKET;
  const encoded = raw.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
  return encoded || UNKNOWN_BUCKET;
}

/**
 * Resolve (and create) the per-project bucket directory for a cwd.
 * @param {string} [cwd]
 * @returns {string} absolute bucket directory path
 */
function _bucketDirFromCwd(cwd) {
  const bucket = _encodeProject(cwd);
  const dir = path.join(_sessionsDir(), bucket);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  return dir;
}

/**
 * Write a small marker file recording the real cwd for a bucket, so the
 * encoded directory name can be mapped back to a human-readable path.
 * Best-effort; never throws.
 * @param {string} bucketDir
 * @param {string} [cwd]
 */
function _writeProjectMeta(bucketDir, cwd) {
  if (!cwd) return;
  try {
    const metaPath = path.join(bucketDir, '.project.json');
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { /* new */ }
    meta.cwd = cwd;
    meta.updatedAt = Date.now();
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  } catch { /* best effort */ }
}

/**
 * Locate an existing session file across project buckets.
 * Read-side resolver: scans one level of project sub-directories first, then
 * falls back to the flat (legacy) layout at the sessions root.
 *
 * @param {string} sessionId
 * @param {string} ext - file extension incl. dot, e.g. '.json', '.jsonl', '.checkpoint.json'
 * @returns {string|null} absolute path if found, else null
 */
function _locateSessionFile(sessionId, ext) {
  const safe = _safeId(sessionId);
  const root = _sessionsDir();
  const fileName = `${safe}${ext}`;

  // 1. Project buckets (one level deep)
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const candidate = path.join(root, ent.name, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }

  // 2. Flat legacy layout
  const flat = path.join(root, fileName);
  if (fs.existsSync(flat)) return flat;

  return null;
}

/**
 * Recursively collect *.json snapshot files from the sessions store,
 * across project buckets and the flat legacy root.
 * Excludes the .project.json bucket markers.
 * @returns {string[]} absolute file paths
 */
function _collectSnapshotFiles() {
  const root = _sessionsDir();
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      let sub;
      try { sub = fs.readdirSync(full); } catch { continue; }
      for (const f of sub) {
        if (f.endsWith('.json') && !f.endsWith('.checkpoint.json') && f !== '.project.json') {
          out.push(path.join(full, f));
        }
      }
    } else if (ent.name.endsWith('.json') && !ent.name.endsWith('.checkpoint.json') && ent.name !== '.project.json') {
      out.push(full);
    }
  }
  return out;
}

/**
 * Resolve the write path for a session file.
 * If projectDir is given, write into that bucket; otherwise locate an existing
 * file (any bucket / flat), falling back to the flat root for brand-new ids.
 *
 * @param {string} sessionId
 * @param {string} ext
 * @param {string} [projectDir] - target bucket directory for writes
 * @returns {string}
 */
function _resolvePath(sessionId, ext, projectDir) {
  const safe = _safeId(sessionId);
  if (projectDir) return path.join(projectDir, `${safe}${ext}`);
  const existing = _locateSessionFile(sessionId, ext);
  if (existing) return existing;
  return path.join(_sessionsDir(), `${safe}${ext}`);
}

function _filePath(sessionId, projectDir) {
  return _resolvePath(sessionId, '.json', projectDir);
}

function _jsonlPath(sessionId, projectDir) {
  return _resolvePath(sessionId, '.jsonl', projectDir);
}

/**
 * Public, read-only resolver for a session's JSONL transcript path (the SSOT for
 * where a session's sidecars co-locate). Exposed for sidecar producers such as
 * the trajectory replay ledger (DESIGN-ARCH-048), so they derive co-located file
 * paths without re-implementing path logic.
 */
function jsonlPathFor(sessionId, projectDir) {
  return _jsonlPath(sessionId, projectDir);
}

function _checkpointPath(sessionId, projectDir) {
  return _resolvePath(sessionId, '.checkpoint.json', projectDir);
}

function _uuid() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * G6: 原子写入 — tmp 文件 + fsync + rename
 * 从 DeepSeek-TUI session_manager.rs 学习
 */
function _writeAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.tmp-${crypto.randomBytes(6).toString('hex')}`);
  const fd = fs.openSync(tmpPath, 'w', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

// ── 持久化耐久性门控 ──
// 预防原则:把「每一次单次提示词」都当成「完成后进程即不可用」。会话每轮收尾
// (_persistLiveSession → persistSession → appendMessage) 写的 JSONL transcript 是
// resume/rewind 的**主恢复产物**;但此前 appendMessage 用裸 fs.appendFileSync 落盘,
// 数据只进 OS page cache —— 与本文件 snapshot 轨(_writeAtomic)、sidecar 哈希链
// (traceChain)、文件头自称的「G6: tmp+fsync+rename 防崩溃丢失」标准都不一致,机器级
// 崩溃/掉电会丢掉最后一轮已「写入」的字节。此处补齐:append 后对该文件描述符 fsync,
// 让「完成即落盘」真正落到稳定存储,而非仅缓存。
//
// 门控 KHY_DURABLE_TRANSCRIPT 默认开;`0/false/off/no` 关 → 逐字节回退到原
// fs.appendFileSync(同样的 data、同样的目标文件,无 fsync)。fail-soft:fsync 失败
// (只读 fd/特殊文件系统/平台不支持)绝不让消息写入失败 —— 数据已 append 成功,fsync
// 只是把缓存刷盘的额外保证,降级到「至少写进了缓存」严格不弱于回退路径。
const _DURABLE_FALSY = new Set(['0', 'false', 'off', 'no']);
function _durableTranscriptEnabled(env = process.env) {
  const raw = env && env.KHY_DURABLE_TRANSCRIPT;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_DURABLE_FALSY.has(v);
}

// ── 会话持久化收尾提速门控(镜像上面 _durableTranscriptEnabled 的本地 CANON 读法)──
// 见 flagRegistry.KHY_SESSION_PERSIST_FAST:开(默认)→ 每轮免去对整份 JSONL 的双读(改
// per-file 计数记忆)+ 对进程内已建立的会话把快照写挪出本轮 tick;`0/false/off/no` 关 →
// 逐字节回退今日「双读 + 同步快照」。
const _PERSIST_FAST_FALSY = new Set(['0', 'false', 'off', 'no']);
function _sessionPersistFastEnabled(env = process.env) {
  const raw = env && env.KHY_SESSION_PERSIST_FAST;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_PERSIST_FAST_FALSY.has(v);
}

// per-file 已追加计数 + 末条 uuid 记忆(仅本进程)。persistSession 是 JSONL 唯一追加者
// (appendMessage 无外部调用者)→ 进程内「已追加条数」恒等于 JSONL 行数,可替代每轮对整份
// 文件的两次 readFileSync(随会话增长 O(n)/turn 的纯浪费)。cache miss 时单次读盘播种。
// 不变量:count === 文件行数(只追加,从不截断);故与原「读文件数行」逐路径等价——包括
// 压缩/orphan-pop 使 messages.length < count 时两者都「不追加」直到再次越过历史高水位。
const _appendIndexCache = new Map(); // jsonlFile(abs) -> { count, lastUuid }

/**
 * 耐久 append:把一行写入文件并 fsync 到稳定存储。
 * 门控关 → 逐字节等价于 fs.appendFileSync(filePath, data)(无 fsync)。
 * @param {string} filePath 目标文件绝对路径
 * @param {string} data 已含结尾换行的整行内容
 */
function _appendDurable(filePath, data) {
  if (!_durableTranscriptEnabled()) {
    fs.appendFileSync(filePath, data);
    return;
  }
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(fd, data);
    // fsync 失败不应丢掉已写入的数据:append 已落到缓存(≥ 回退路径的保证),
    // 仅刷盘保证降级。fail-soft 吞掉异常,绝不让热路径消息写入抛错。
    try { fs.fsyncSync(fd); } catch { /* fsync 不可用 → 降级为已 append(不弱于回退) */ }
  } finally {
    fs.closeSync(fd);
  }
}

// ── JSONL Transcript (借鉴 Claude Code append-only + parentUuid chain) ──

/**
 * 追加单条消息到 JSONL transcript.
 * 每条消息自动分配 uuid，parentUuid 指向前一条链式参与消息。
 *
 * @param {string} sessionId
 * @param {object} msg - { role, content, ... }
 * @param {string} [parentUuid] - 前一条消息的 uuid
 * @param {string} [projectDir] - 目标项目桶目录（写侧）
 * @returns {{ uuid: string, parentUuid: string|null }}
 */
function appendMessage(sessionId, msg, parentUuid = null, projectDir = null) {
  if (!sessionId) return null;

  const uuid = msg.uuid || _uuid();
  const entry = {
    uuid,
    parentUuid: parentUuid || null,
    role: msg.role || 'unknown',
    content: msg.content || '',
    timestamp: msg.timestamp || Date.now(),
    isMeta: msg.isMeta || false,
    isCompactSummary: msg.isCompactSummary || false,
  };

  // 让逐回合回溯(rewind)的 checkpointId 随 JSONL 往返存活(单一真源 rewindResume)。
  // 门控 KHY_REWIND_PERSIST 关 → 不搬任何字段 = 写出的行字节不变(向后兼容)。
  try { require('./rewindResume').carryRewindFields(msg, entry); } catch { /* fail-soft */ }

  // DESIGN-ARCH-047: 附加溯源信封 `_khyTrace`（增量、向后兼容；旧 reader 忽略未知字段）。
  // 显式传入则原样保留；否则据 role + 可选 provenance 提示盖戳。缺省 fail-safe 到
  // khy-local / verified，绝不把本地内容误标为外部。
  try {
    const khyTrace = require('./trajectoryProvenance/khyTrace');
    if (msg._khyTrace && typeof msg._khyTrace === 'object') {
      entry._khyTrace = msg._khyTrace;
    } else {
      const hint = msg._khyProvenance && typeof msg._khyProvenance === 'object'
        ? msg._khyProvenance
        : {};
      entry._khyTrace = khyTrace.makeTrace({
        producer: hint.producer,
        producerId: hint.producerId,
        trust: hint.trust,
        kind: hint.kind || (entry.role === 'assistant' ? khyTrace.KIND.TEXT : undefined),
        at: entry.timestamp,
        contradictions: hint.contradictions,
      });
    }
  } catch { /* trace 是增量证据，失败绝不阻断消息写入 */ }

  const jsonlFile = _jsonlPath(sessionId, projectDir);
  const dir = path.dirname(jsonlFile);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }

  // append-only: 追加一行 JSON。
  // 耐久写:每轮收尾写的 transcript 是 resume/rewind 主恢复产物,append 后 fsync 刷盘
  // (与 snapshot _writeAtomic / 文件头 G6 标准一致),让「完成即落盘」落到稳定存储。
  // 门控 KHY_DURABLE_TRANSCRIPT 关 → 字节回退到 fs.appendFileSync(无 fsync)。
  _appendDurable(jsonlFile, JSON.stringify(entry) + '\n');

  // DESIGN-ARCH-047 P2: 防篡改 sidecar 哈希链（与 JSONL 并列、append-only）。
  // 把本条 turn 绑定进 prevHash→hash 链，事后改 transcript 会被 verify 当场抓出。
  // best-effort：链失败绝不让消息写入失败（防呆②：fail-soft，断/缺链告警不 brick）。
  try {
    const traceChain = require('./trajectoryProvenance/traceChain');
    const tr = entry._khyTrace || {};
    traceChain.append(traceChain.chainPathFor(jsonlFile), {
      uuid: entry.uuid,
      producer: tr.producer,
      trust: tr.trust,
      content: entry.content,
      at: entry.timestamp,
    });
  } catch { /* 链是事后审计 evidence，写入失败不阻断热路径 */ }

  return { uuid, parentUuid: entry.parentUuid };
}

/**
 * 从 JSONL transcript 重建对话链。
 * 从 leafUuid 反向遍历 parentUuid 链，返回完整消息序列。
 *
 * @param {string} sessionId
 * @param {string} [leafUuid] - 末端 uuid, null 则自动取最后一条
 * @returns {Array<object>} 按时间顺序排列的消息链
 */
function buildConversationChain(sessionId, leafUuid = null) {
  const jsonlFile = _jsonlPath(sessionId);
  if (!fs.existsSync(jsonlFile)) return [];

  const raw = fs.readFileSync(jsonlFile, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length === 0) return [];

  // 构建 uuid -> entry 映射
  const byUuid = new Map();
  let lastUuid = null;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.uuid) {
        byUuid.set(entry.uuid, entry);
        lastUuid = entry.uuid;
      }
    } catch { /* skip corrupt line */ }
  }

  // 从 leaf 反向遍历
  const leaf = leafUuid || lastUuid;
  if (!leaf) return [];

  const chain = [];
  let current = leaf;
  const visited = new Set();
  while (current && byUuid.has(current) && !visited.has(current)) {
    visited.add(current);
    chain.unshift(byUuid.get(current));
    current = byUuid.get(current).parentUuid;
  }

  return chain;
}

/**
 * DESIGN-ARCH-047 P5: 只读校验某会话的防篡改 sidecar 哈希链。
 * 交叉核对链记录与盘上 JSONL 正文（contentHash），同时抓「改链」「改正文」「删行」。
 * 路径解析复用本模块 `_jsonlPath`（单一真源），不向调用方泄露私有内部。
 * fail-soft：任何异常 → `{available:false}`，绝不抛（防呆②：缺/断链告警不 brick）。
 *
 * @param {string} sessionId
 * @returns {{ok:boolean, available:boolean, length:number, brokenAt:number|null, reason:string|null}}
 */
function verifyTraceChain(sessionId) {
  try {
    const jsonlFile = _jsonlPath(sessionId);
    if (!fs.existsSync(jsonlFile)) {
      return { ok: false, available: false, length: 0, brokenAt: null, reason: 'transcript 不存在' };
    }
    const traceChain = require('./trajectoryProvenance/traceChain');
    const chainFile = traceChain.chainPathFor(jsonlFile);
    const entries = buildConversationChain(sessionId);
    return traceChain.verifyAgainstEntries(chainFile, entries);
  } catch (e) {
    return { ok: false, available: false, length: 0, brokenAt: null, reason: e && e.message ? e.message : String(e) };
  }
}

/**
 * 获取 JSONL transcript 的所有 leaf UUID (没有子节点的消息)
 * @param {string} sessionId
 * @returns {string[]}
 */
function getLeafUuids(sessionId) {
  const jsonlFile = _jsonlPath(sessionId);
  if (!fs.existsSync(jsonlFile)) return [];

  const raw = fs.readFileSync(jsonlFile, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);

  const allUuids = new Set();
  const parentUuids = new Set();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.uuid) allUuids.add(entry.uuid);
      if (entry.parentUuid) parentUuids.add(entry.parentUuid);
    } catch { /* skip */ }
  }

  return [...allUuids].filter(u => !parentUuids.has(u));
}

/**
 * Persist a session to disk (双轨: JSONL + JSON snapshot).
 * @param {string} sessionId - Unique session identifier
 * @param {object} state - Session state to persist
 * @param {Array} state.messages - Conversation messages
 * @param {string} [state.title] - Session title
 * @param {string} [state.model] - Model used
 * @param {object} [state.metadata] - Additional metadata
 * @returns {string} sessionId
 */
function persistSession(sessionId, state) {
  if (!sessionId) {
    sessionId = 'sess-' + crypto.randomBytes(4).toString('hex');
  }

  const messages = state.messages || [];
  const cwd = (state.metadata && state.metadata.cwd) || process.cwd();
  const bucketDir = _bucketDirFromCwd(cwd);
  _writeProjectMeta(bucketDir, cwd);

  // ── JSONL 追加（增量写入新消息） ──
  const jsonlFile = _jsonlPath(sessionId, bucketDir);
  const _fast = _sessionPersistFastEnabled();

  let existingCount = 0;
  let seededLastUuid = null; // fast 路径下从缓存/单次读得到的末条 uuid
  let _cacheHit = false;

  if (_fast) {
    const cached = _appendIndexCache.get(jsonlFile);
    if (cached) {
      existingCount = cached.count;
      seededLastUuid = cached.lastUuid;
      _cacheHit = true;
    } else {
      // 单次全量读:一趟同时得到 行数 + 末条 uuid(替代原来的两次 readFileSync）。
      try {
        const raw = fs.readFileSync(jsonlFile, 'utf-8');
        const lines = raw.split('\n');
        let count = 0;
        let lastLine = '';
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]) { count++; lastLine = lines[i]; }
        }
        existingCount = count;
        if (count > 0) {
          try { seededLastUuid = (JSON.parse(lastLine) || {}).uuid || null; } catch { seededLastUuid = null; }
        }
      } catch { /* 新文件 */ existingCount = 0; seededLastUuid = null; }
    }
  } else {
    // 逐字节回退:原路径第一次全量读(仅数行)。
    try {
      const raw = fs.readFileSync(jsonlFile, 'utf-8');
      existingCount = raw.split('\n').filter(Boolean).length;
    } catch { /* 新文件 */ }
  }

  if (messages.length > existingCount) {
    // 只追加新消息
    let parentUuid = _fast ? seededLastUuid : null;
    // 取已有的最后一个 uuid 作为 parent
    if (!_fast && existingCount > 0) {
      try {
        const raw = fs.readFileSync(jsonlFile, 'utf-8');
        const lines = raw.split('\n').filter(Boolean);
        const last = JSON.parse(lines[lines.length - 1]);
        parentUuid = last.uuid || null;
      } catch { /* ok */ }
    }

    for (let i = existingCount; i < messages.length; i++) {
      const result = appendMessage(sessionId, messages[i], parentUuid, bucketDir);
      if (result) parentUuid = result.uuid;
    }
    // 更新记忆:count 恒等于现文件行数(= messages.length),lastUuid 为链尾。
    if (_fast) _appendIndexCache.set(jsonlFile, { count: messages.length, lastUuid: parentUuid });
  } else if (_fast) {
    // 未追加(含压缩/orphan-pop 使 messages.length ≤ existingCount)也把播种值写回缓存,
    // 免下轮再次全量读盘;count 保持等于文件行数,不变量成立。
    _appendIndexCache.set(jsonlFile, { count: existingCount, lastUuid: seededLastUuid });
  }

  // ── JSON 快照 (保持兼容) ──
  const data = {
    sessionId,
    title: state.title || '',
    model: state.model || '',
    messages,
    messageCount: messages.length,
    metadata: state.metadata || {},
    createdAt: state.createdAt || Date.now(),
    updatedAt: Date.now(),
  };

  const _snapshotPath = _filePath(sessionId, bucketDir);
  const _writeSnapshot = () => {
    _writeAtomic(_snapshotPath, JSON.stringify(data, null, 2));

    // Write-through to search index (best-effort, non-blocking)
    try {
      const searchIndex = require('./sessionSearchIndex');
      searchIndex.init();
      searchIndex.indexSession(sessionId, data);
    } catch { /* search index is optional */ }
  };

  // 快照是兼容/元数据产物:权威恢复源是已同步 fsync 落盘的 JSONL,且 restoreSession 的消息
  // 取自 JSONL、仅从快照补 title/model/metadata。故对**进程内已建立**的会话(cache hit=非
  // 首轮/非 fork/非 resume 首触)把「整份 pretty re-stringify + 阻塞 fsync + rename」挪出本轮
  // 收尾 tick,让用户回车后可立刻输入下一条(setImmediate 在下一次用户输入前必已排空,内容
  // 与同步写字节相同)。首轮/fork/新会话(cache miss)仍同步写,保证紧随其后的同步读回(如
  // /fork → resumePersistedSession 取 title/model/metadata)拿得到。门控关 → 一律同步(逐字节
  // 回退今日行为,含 _writeAtomic 抛错向上传播)。
  if (_fast && _cacheHit) {
    setImmediate(() => { try { _writeSnapshot(); } catch { /* best-effort: JSONL 才是权威源 */ } });
  } else {
    _writeSnapshot();
  }

  return sessionId;
}

/**
 * G6: 保存检查点 — 中间状态快照，不覆盖主文件
 */
function saveCheckpoint(sessionId, state) {
  if (!sessionId) return;
  const cwd = (state.metadata && state.metadata.cwd) || process.cwd();
  const bucketDir = _bucketDirFromCwd(cwd);
  const data = {
    sessionId,
    checkpoint: true,
    messages: state.messages || [],
    metadata: state.metadata || {},
    savedAt: Date.now(),
  };
  try {
    _writeAtomic(_checkpointPath(sessionId, bucketDir), JSON.stringify(data));
  } catch { /* 检查点失败不中断主流程 */ }
}

/**
 * G6: 加载检查点 — 如果主文件损坏，尝试从检查点恢复
 */
function loadCheckpoint(sessionId) {
  try {
    const raw = fs.readFileSync(_checkpointPath(sessionId), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Restore a session from disk.
 * 优先从 JSONL transcript 重建，退回 JSON snapshot，最后尝试检查点。
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {string} [opts.leafUuid] - 指定分支末端
 * @returns {object|null}
 */
function restoreSession(sessionId, opts = {}) {
  // 尝试 JSONL 优先
  const chain = buildConversationChain(sessionId, opts.leafUuid || null);
  if (chain.length > 0) {
    // 补充元数据从 JSON snapshot
    let meta = {};
    try {
      const raw = fs.readFileSync(_filePath(sessionId), 'utf-8');
      meta = JSON.parse(raw);
    } catch { /* ok */ }
    return {
      sessionId,
      title: meta.title || '',
      model: meta.model || '',
      messages: chain.map((e) => {
        const m = { role: e.role, content: e.content, uuid: e.uuid, parentUuid: e.parentUuid, timestamp: e.timestamp };
        // 把回溯字段(checkpointId)从 JSONL 条目搬回消息(门控关 → 恒等,m 不变)。
        try { require('./rewindResume').carryRewindFields(e, m); } catch { /* fail-soft */ }
        return m;
      }),
      messageCount: chain.length,
      metadata: meta.metadata || {},
      createdAt: meta.createdAt || (chain[0] && chain[0].timestamp) || Date.now(),
      updatedAt: meta.updatedAt || (chain[chain.length - 1] && chain[chain.length - 1].timestamp) || Date.now(),
      _source: 'jsonl',
    };
  }

  // 退回 JSON snapshot
  try {
    const raw = fs.readFileSync(_filePath(sessionId), 'utf-8');
    return { ...JSON.parse(raw), _source: 'json' };
  } catch {
    // 会话快照 JSON 损坏/截断:承 sessionFileRepair 叶(此前零消费者),先尝试结构修复再
    // 还原,而不是直接把整段会话丢给检查点/null。直接服务「完整的简单的还原」——损坏快照
    // 从「整段丢失」变「salvage 后还原」。门控 KHY_SESSION_FILE_REPAIR 关 → 跳过修复,逐字节
    // 回退到旧的 checkpoint/null。fail-soft:修复任何异常都落回既有兜底,绝不打断还原。
    const _repairEnabled = !['0', 'false', 'off', 'no'].includes(
      String(process.env.KHY_SESSION_FILE_REPAIR || 'true').trim().toLowerCase()
    );
    if (_repairEnabled) {
      try {
        const { repairSessionFile, tryParsePartialJson } = require('./sessionFileRepair');
        const _snapPath = _filePath(sessionId);
        const res = repairSessionFile(_snapPath, { dryRun: false, backup: true });
        if (res && res.repaired) {
          // 修复重写了快照(原子写 + .bak):re-read 干净结果还原。
          const raw = fs.readFileSync(_snapPath, 'utf-8');
          const parsed = JSON.parse(raw);
          const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
          return { ...parsed, messageCount: msgs.length, _source: 'json-repaired' };
        }
        // 修复未重写(截断前缀 partial-parse 出的对象本身「有效无警告」→ 叶子按约定不落盘),
        // 但磁盘仍是坏的:最后一搏用同叶 tryParsePartialJson 从原始字节 salvage 出可用会话。
        const salvaged = tryParsePartialJson(fs.readFileSync(_snapPath, 'utf-8'));
        if (salvaged && typeof salvaged === 'object') {
          const msgs = Array.isArray(salvaged.messages) ? salvaged.messages : [];
          if (msgs.length > 0) {
            return { ...salvaged, messageCount: msgs.length, _source: 'json-repaired' };
          }
        }
      } catch { /* fail-soft:修复失败 → 落回既有兜底 */ }
    }
    // 最后尝试检查点
    const checkpoint = loadCheckpoint(sessionId);
    if (checkpoint) return { ...checkpoint, _source: 'checkpoint' };
    return null;
  }
}

/**
 * List all persisted sessions with metadata.
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @returns {Array<{ sessionId: string, title: string, model: string, messageCount: number, updatedAt: number, projectDir: string, cwd: string }>}
 */
function listPersistedSessions(opts = {}) {
  const root = _sessionsDir();
  const limit = opts.limit || 50;

  const files = _collectSnapshotFiles();
  if (files.length === 0) return [];

  const sessions = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const data = JSON.parse(raw);
      const projectDir = path.dirname(file);
      let firstUserMessage = '';
      if (Array.isArray(data.messages)) {
        const fu = data.messages.find((m) => m && m.role === 'user');
        if (fu) {
          let c = fu.content;
          if (Array.isArray(c)) {
            c = c.map((p) => (p && typeof p === 'object' ? (p.text || '') : String(p || ''))).join(' ');
          } else if (c && typeof c === 'object') {
            c = c.text || '';
          }
          firstUserMessage = String(c || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        }
      }
      sessions.push({
        sessionId: data.sessionId,
        title: data.title || '(untitled)',
        model: data.model || '',
        messageCount: data.messageCount || 0,
        createdAt: data.createdAt || 0,
        updatedAt: data.updatedAt || 0,
        projectDir: projectDir === root ? '' : projectDir,
        cwd: (data.metadata && data.metadata.cwd) || '',
        firstUserMessage,
      });
    } catch { /* skip corrupt */ }
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions.slice(0, limit);
}

/**
 * Delete a persisted session.
 * @param {string} sessionId
 * @returns {boolean}
 */
function deleteSession(sessionId) {
  let removed = false;
  for (const ext of ['.json', '.jsonl', '.checkpoint.json']) {
    const target = _locateSessionFile(sessionId, ext);
    if (target) {
      try { fs.unlinkSync(target); removed = true; } catch { /* ignore */ }
    }
  }
  // Remove from search index
  try {
    const searchIndex = require('./sessionSearchIndex');
    searchIndex.removeSessionIndex(sessionId);
  } catch { /* optional */ }
  return removed;
}

/**
 * Rename (set the title of) a persisted session.
 *
 * Titles live in the JSON snapshot (single source of truth for metadata); the
 * JSONL transcript is append-only and carries no title, so a rename only needs
 * to rewrite the snapshot atomically and refresh the search index. The on-disk
 * `cwd`/bucket is preserved by writing back into the snapshot's own directory.
 *
 * @param {string} sessionId
 * @param {string} newTitle - trimmed and capped at 200 chars (mirrors the web store)
 * @returns {boolean} true if a snapshot was found and updated
 */
function renameSession(sessionId, newTitle) {
  const file = _locateSessionFile(sessionId, '.json');
  if (!file) return false;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return false;
  }

  data.title = String(newTitle == null ? '' : newTitle).trim().slice(0, 200);
  data.updatedAt = Date.now();

  try {
    _writeAtomic(file, JSON.stringify(data, null, 2));
  } catch {
    return false;
  }

  // Refresh the search index title (best-effort, non-blocking).
  try {
    const searchIndex = require('./sessionSearchIndex');
    searchIndex.init();
    searchIndex.indexSession(data.sessionId || sessionId, data);
  } catch { /* search index is optional */ }

  return true;
}

/**
 * Cheaply load a session's snapshot metadata WITHOUT rebuilding the message chain.
 *
 * `listPersistedSessions` projects away `metadata` (only surfaces `cwd`), and
 * `restoreSession` rebuilds the full JSONL message chain (heavy). The session
 * topology only needs each node's `metadata` (forkedFrom + insight/memory slots)
 * plus title/updatedAt/messageCount — all of which live in the JSON snapshot.
 * This reads just that snapshot.
 *
 * @param {string} sessionId
 * @returns {{ sessionId, title, model, messageCount, updatedAt, createdAt, metadata }|null}
 */
function loadSessionMeta(sessionId) {
  const file = _locateSessionFile(sessionId, '.json');
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return {
      sessionId: data.sessionId || sessionId,
      title: data.title || '',
      model: data.model || '',
      messageCount: data.messageCount || 0,
      updatedAt: data.updatedAt || 0,
      createdAt: data.createdAt || 0,
      metadata: (data.metadata && typeof data.metadata === 'object') ? data.metadata : {},
    };
  } catch {
    return null;
  }
}

/**
 * Patch a persisted session's `metadata` in place (mirror of renameSession).
 *
 * Metadata lives in the JSON snapshot (single source of truth); the JSONL
 * transcript is append-only and carries no metadata. So an in-place metadata
 * update only needs to rewrite the snapshot atomically and refresh the search
 * index — far cheaper than a full restore→persist round-trip. Used by the
 * session-topology slots (insight / memory / per-node systemPrompt).
 *
 * @param {string} sessionId
 * @param {object} patch - shallow-merged into the snapshot's `metadata`
 * @returns {boolean} true if a snapshot was found and updated
 */
function updateSessionMetadata(sessionId, patch) {
  if (!patch || typeof patch !== 'object') return false;
  const file = _locateSessionFile(sessionId, '.json');
  if (!file) return false;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return false;
  }

  data.metadata = Object.assign({}, data.metadata || {}, patch);
  data.updatedAt = Date.now();

  try {
    _writeAtomic(file, JSON.stringify(data, null, 2));
  } catch {
    return false;
  }

  // Refresh the search index (best-effort, non-blocking).
  try {
    const searchIndex = require('./sessionSearchIndex');
    searchIndex.init();
    searchIndex.indexSession(data.sessionId || sessionId, data);
  } catch { /* search index is optional */ }

  return true;
}

/**
 * Remove sessions older than the threshold.
 * @param {number} [olderThanMs=604800000] - Default: 7 days
 * @returns {number} Number of sessions cleaned up
 */
function cleanupStaleSessions(olderThanMs = 7 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - olderThanMs;
  let cleaned = 0;

  const files = _collectSnapshotFiles();
  for (const file of files) {
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const data = JSON.parse(raw);
      if ((data.updatedAt || 0) < cutoff) {
        const base = file.replace(/\.json$/, '');
        for (const ext of ['.json', '.jsonl', '.checkpoint.json']) {
          try { fs.unlinkSync(base + ext); } catch { /* may not exist */ }
        }
        cleaned++;
      }
    } catch { /* skip */ }
  }

  return cleaned;
}

module.exports = {
  persistSession,
  restoreSession,
  listPersistedSessions,
  deleteSession,
  renameSession,
  loadSessionMeta,
  updateSessionMetadata,
  cleanupStaleSessions,
  saveCheckpoint,
  loadCheckpoint,
  // JSONL API (新增)
  appendMessage,
  buildConversationChain,
  getLeafUuids,
  verifyTraceChain,
  jsonlPathFor,
};

// Register as the bulk session source for sessionSearchIndex.reindexAll, so the
// search index never has to require persistence back (breaks the R3 cycle; the
// port is a zero-dep leaf). DESIGN-ARCH-020.
try {
  require('./sessionSourcePort').registerSessionSource(module.exports);
} catch { /* port optional — reindex simply degrades to a no-op without a source */ }
