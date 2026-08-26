'use strict';

/**
 * session_registry.js — 多实例编辑会话注册表(纯叶子:零 IO、时钟注入、绝不抛)。
 *
 * WHY: 文档级合并只解决「怎么合」,还差「谁在编」。N 个实例(不是两台——协议必须支持
 * 任意数量)同时连上来时,服务端需要能回答三个问题:
 *   1. 这个 sessionId 认证过吗、还活着吗?
 *   2. 某个文件现在有哪些订阅者,变更该扇出给谁?
 *   3. 某个文件当前的编辑者是谁,租约什么时候到期?
 * 本模块就是这三个问题的唯一真源。
 *
 * 租约而非锁:_fileLock 的悲观锁是「拿到就一直持有,进程死了靠 stale 时间回收」;这里的
 * 租约是**基于活动**的 —— 每次心跳 / 每次成功提交都把 expiresAt 往后推(renewLease),
 * 只有真正**空闲**超过 TTL 才被 sweep 回收。这正是工程红线 3「基于活动的超时,不许固定
 * 时长硬 kill」:一个人连续编辑两小时不会被踢,断线 30 秒才会。断线(dropSession)则
 * 立即释放,不等 TTL —— 「断线或异常退出不会永久占用编辑状态」这条验收靠它。
 *
 * 跨进程事实不能只活在单个 Node 进程的内存里。本模块因此**不自己做持久化**,而是暴露
 * snapshot() / restore() 两个纯函数当 IoC port:调用方(file_sync_bus)把 snapshot()
 * 交给注入的 persist 端口(默认落 storageRoots 解析出的运行时目录),重启或换实例时
 * restore() 回来。注册表本身零 IO,故可脱离真实 fs / WebSocket / 时钟被确定性单测。
 *
 * 契约:每个方法返回 { ok: true, value } 或 { ok: false, error },绝不抛。
 * 时钟通过 now 注入,默认 Date.now —— 单测里传假时钟即可精确驱动租约到期。
 *
 * @module services/session_registry
 */

const CODES = {
  INVALID_SESSION_ID: 'INVALID_SESSION_ID',
  UNKNOWN_SESSION: 'UNKNOWN_SESSION',
  UNAUTHENTICATED_SESSION: 'UNAUTHENTICATED_SESSION',
  SESSION_LIMIT: 'SESSION_LIMIT',
  SUBSCRIBE_LIMIT: 'SUBSCRIBE_LIMIT',
  SUBSCRIBE_FORBIDDEN: 'SUBSCRIBE_FORBIDDEN',
  LEASE_HELD: 'LEASE_HELD',
  LEASE_NOT_HELD: 'LEASE_NOT_HELD',
  INVALID_SNAPSHOT: 'INVALID_SNAPSHOT',
};

// Snapshot envelope version. Bump only on an incompatible field change.
const SCHEMA = 'khy-file-sync-registry/1';

const DEFAULTS = {
  leaseTtlMs: 45_000,
  sessionIdleMs: 300_000,
  maxSessions: 512,
  maxPathsPerSession: 256,
  maxIdLength: 128,
};

function _fail(code, message, extra) {
  return { ok: false, error: { code, message, ...(extra || {}) } };
}

function _cleanId(value, maxLength) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed || trimmed.length > maxLength) {
    return null;
  }

  return trimmed;
}

function _positive(value, fallback) {
  const n = Number(value);

  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/**
 * 建立一个注册表实例。所有状态在闭包里,不存在模块作用域可变态,故同一进程可开多个
 * 互不干扰的注册表(单测就靠这点做到互相隔离)。
 *
 * @param {object} [opts] { now, leaseTtlMs, sessionIdleMs, maxSessions, maxPathsPerSession }
 * @returns {object} 注册表 API
 */
function createRegistry(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const leaseTtlMs = _positive(opts.leaseTtlMs, DEFAULTS.leaseTtlMs);
  const sessionIdleMs = _positive(opts.sessionIdleMs, DEFAULTS.sessionIdleMs);
  const maxSessions = _positive(opts.maxSessions, DEFAULTS.maxSessions);
  const maxPathsPerSession = _positive(opts.maxPathsPerSession, DEFAULTS.maxPathsPerSession);
  const maxIdLength = _positive(opts.maxIdLength, DEFAULTS.maxIdLength);

  /** @type {Map<string, object>} sessionId -> session record */
  const sessions = new Map();
  /** @type {Map<string, object>} path -> lease record */
  const leases = new Map();
  /**
   * @type {Map<string, number>} sessionId -> removedAt
   *
   * Removal tombstones. A union-only merge cannot express deletion: without these,
   * a peer that already adopted our session would keep writing it back to the shared
   * snapshot, and we would re-adopt our own dropped session on the next save — the
   * lease it held would then outlive the disconnect forever. Tombstones are pruned
   * once older than sessionIdleMs, so the set stays bounded.
   */
  const removals = new Map();

  function _at() {
    const t = Number(now());

    return Number.isFinite(t) ? t : 0;
  }

  function _leaseExpired(lease, at) {
    return !lease || lease.expiresAt <= at;
  }

  // Tombstone a session id so neither our own snapshot nor a peer's can resurrect it.
  function _recordRemoval(sessionId, at) {
    if (!sessionId) {
      return;
    }

    const known = removals.get(sessionId);

    if (!Number.isFinite(known) || at > known) {
      removals.set(sessionId, at);
    }
  }

  // Drop every lease held by a session, returning the paths that were freed.
  function _releaseLeasesOf(sessionId) {
    const freed = [];

    for (const [path, lease] of [...leases]) {
      if (lease.sessionId === sessionId) {
        leases.delete(path);
        freed.push(path);
      }
    }

    return freed;
  }

  /**
   * Expire tombstones once they are older than the idle window: past that point no
   * peer can still be holding a copy of the session, so the marker has no work left.
   * Also caps the map by oldest-first eviction, keeping memory bounded under churn.
   */
  function _pruneRemovals(at) {
    for (const [sessionId, removedAt] of [...removals]) {
      if (at - removedAt > sessionIdleMs) {
        removals.delete(sessionId);
      }
    }

    if (removals.size > maxSessions) {
      const oldest = [...removals].sort((a, b) => a[1] - b[1]);

      for (const [sessionId] of oldest.slice(0, removals.size - maxSessions)) {
        removals.delete(sessionId);
      }
    }
  }

  /**
   * 登记(或幂等更新)一个会话。同一 sessionId 重复登记不报错 —— 重连后客户端会重发
   * 注册,这里必须幂等,否则重连就要先猜自己是不是已登记过。
   *
   * @param {object} input { sessionId, editorId, instanceId, authenticated }
   * @returns {object} { ok: true, value: session } 或 { ok: false, error }
   */
  function registerSession(input = {}) {
    const sessionId = _cleanId(input.sessionId, maxIdLength);

    if (!sessionId) {
      return _fail(
        CODES.INVALID_SESSION_ID,
        `会话标识非法：sessionId 必须是 1-${maxIdLength} 字符的非空字符串`
      );
    }

    const existing = sessions.get(sessionId);
    const at = _at();

    if (!existing && sessions.size >= maxSessions) {
      return _fail(
        CODES.SESSION_LIMIT,
        `会话数量超限：当前已注册 ${sessions.size}/${maxSessions} 个会话，拒绝新注册`
      );
    }

    const editorId = _cleanId(input.editorId, maxIdLength) || sessionId;
    const instanceId = _cleanId(input.instanceId, maxIdLength) || 'local';
    const record = existing || { sessionId, createdAt: at, paths: new Set() };

    record.editorId = editorId;
    record.instanceId = instanceId;
    record.authenticated = input.authenticated !== false;
    record.lastSeen = at;
    sessions.set(sessionId, record);

    return {
      ok: true,
      value: {
        sessionId,
        editorId,
        instanceId,
        authenticated: record.authenticated,
        createdAt: record.createdAt,
        lastSeen: record.lastSeen,
        paths: [...record.paths],
      },
    };
  }

  /**
   * 心跳续期:刷新会话 lastSeen,并把该会话持有的所有租约 expiresAt 往后推。
   * 这是「基于活动的超时」的续期入口。
   *
   * @param {string} sessionId 会话标识
   * @returns {object} { ok: true, value: { lastSeen, renewedPaths, expiresAt } } 或 { ok: false, error }
   */
  function heartbeat(sessionId) {
    const id = _cleanId(sessionId, maxIdLength);
    const record = id ? sessions.get(id) : null;

    if (!record) {
      return _fail(
        CODES.UNKNOWN_SESSION,
        `会话未注册：sessionId "${String(sessionId)}" 不在注册表中，请重新注册后再心跳`
      );
    }

    const at = _at();

    record.lastSeen = at;

    const renewedPaths = [];

    for (const [path, lease] of leases) {
      if (lease.sessionId === id) {
        lease.expiresAt = at + leaseTtlMs;
        lease.renewals += 1;
        renewedPaths.push(path);
      }
    }

    return { ok: true, value: { lastSeen: at, renewedPaths, expiresAt: at + leaseTtlMs } };
  }

  /**
   * 订阅一批(已规范化的)路径。路径规范化与白名单由调用方在 crdt_engine 里做完 ——
   * 注册表只管边界与归属,不重复实现路径语义。
   *
   * @param {string} sessionId 会话标识
   * @param {string[]} paths 已规范化路径
   * @returns {object} { ok: true, value: { subscribed, alreadySubscribed, total } } 或 { ok: false, error }
   */
  function subscribe(sessionId, paths) {
    const id = _cleanId(sessionId, maxIdLength);
    const record = id ? sessions.get(id) : null;

    if (!record) {
      return _fail(
        CODES.UNKNOWN_SESSION,
        `会话未注册：sessionId "${String(sessionId)}" 不在注册表中，无法订阅文件`
      );
    }

    if (!record.authenticated) {
      return _fail(
        CODES.UNAUTHENTICATED_SESSION,
        `会话未认证：sessionId "${id}" 尚未通过 auth，拒绝订阅文件变更`
      );
    }

    const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : [];

    if (list.length === 0) {
      return _fail(CODES.SUBSCRIBE_FORBIDDEN, '订阅请求非法：paths 必须是非空的字符串数组');
    }

    const fresh = list.filter((p) => !record.paths.has(p));

    if (record.paths.size + fresh.length > maxPathsPerSession) {
      return _fail(
        CODES.SUBSCRIBE_LIMIT,
        `订阅数量超限：会话已订阅 ${record.paths.size} 个文件，再加 ${fresh.length} 个将超出上限 ` +
          `${maxPathsPerSession}`
      );
    }

    const subscribed = [];
    const alreadySubscribed = [];

    for (const p of list) {
      if (record.paths.has(p)) {
        alreadySubscribed.push(p);
      } else {
        record.paths.add(p);
        subscribed.push(p);
      }
    }

    record.lastSeen = _at();

    return { ok: true, value: { subscribed, alreadySubscribed, total: record.paths.size } };
  }

  /**
   * 取消订阅。未订阅的路径不算错误(幂等)。
   *
   * @param {string} sessionId 会话标识
   * @param {string[]} paths 路径列表
   * @returns {object} { ok: true, value: { removed, total } } 或 { ok: false, error }
   */
  function unsubscribe(sessionId, paths) {
    const id = _cleanId(sessionId, maxIdLength);
    const record = id ? sessions.get(id) : null;

    if (!record) {
      return _fail(
        CODES.UNKNOWN_SESSION,
        `会话未注册：sessionId "${String(sessionId)}" 不在注册表中，无法取消订阅`
      );
    }

    const list = Array.isArray(paths) ? paths : [];
    const removed = [];

    for (const p of list) {
      if (record.paths.delete(p)) {
        removed.push(p);
      }
    }

    return { ok: true, value: { removed, total: record.paths.size } };
  }

  /**
   * 查询某路径当前的订阅者(仅返回已认证且未被清理的会话)。
   *
   * @param {string} path 已规范化路径
   * @returns {object} { ok: true, value: sessionId[] }
   */
  function subscribersOf(path) {
    const out = [];

    if (typeof path !== 'string' || !path) {
      return { ok: true, value: out };
    }

    for (const [sessionId, record] of sessions) {
      if (record.authenticated && record.paths.has(path)) {
        out.push(sessionId);
      }
    }

    return { ok: true, value: out.sort() };
  }

  /**
   * 申请编辑租约。已被别人持有且未过期 → LEASE_HELD(带持有者与剩余毫秒,便于给用户
   * 一条含「动作+目标+进度」的提示);已过期 → 直接顶掉(等价于 _fileLock 的 stale 抢占)。
   * 同一会话重复申请 = 续期(幂等)。
   *
   * @param {object} input { path, sessionId }
   * @returns {object} { ok: true, value: lease } 或 { ok: false, error }
   */
  function acquireLease(input = {}) {
    const id = _cleanId(input.sessionId, maxIdLength);
    const record = id ? sessions.get(id) : null;

    if (!record) {
      return _fail(
        CODES.UNKNOWN_SESSION,
        `会话未注册：sessionId "${String(input.sessionId)}" 不在注册表中，无法申请编辑租约`
      );
    }

    if (!record.authenticated) {
      return _fail(
        CODES.UNAUTHENTICATED_SESSION,
        `会话未认证：sessionId "${id}" 尚未通过 auth，拒绝申请编辑租约`
      );
    }

    const path = typeof input.path === 'string' ? input.path.trim() : '';

    if (!path) {
      return _fail(CODES.SUBSCRIBE_FORBIDDEN, '租约请求非法：path 必须是非空字符串');
    }

    const at = _at();
    const current = leases.get(path);

    if (current && current.sessionId !== id && !_leaseExpired(current, at)) {
      return _fail(
        CODES.LEASE_HELD,
        `编辑租约被占用：文件 "${path}" 由会话 ${current.sessionId}（编辑者 ` +
          `${current.editorId}）持有，剩余 ${Math.max(0, current.expiresAt - at)} 毫秒后可抢占`,
        {
          path,
          holderSessionId: current.sessionId,
          holderEditorId: current.editorId,
          expiresAt: current.expiresAt,
        }
      );
    }

    const lease = {
      path,
      sessionId: id,
      editorId: record.editorId,
      instanceId: record.instanceId,
      acquiredAt: current && current.sessionId === id ? current.acquiredAt : at,
      expiresAt: at + leaseTtlMs,
      renewals: current && current.sessionId === id ? current.renewals + 1 : 0,
    };

    leases.set(path, lease);
    record.lastSeen = at;

    return { ok: true, value: { ...lease } };
  }

  /**
   * 续期租约。不是持有者 → LEASE_NOT_HELD(不静默改写别人的租约)。
   *
   * @param {object} input { path, sessionId }
   * @returns {object} { ok: true, value: lease } 或 { ok: false, error }
   */
  function renewLease(input = {}) {
    const id = _cleanId(input.sessionId, maxIdLength);
    const path = typeof input.path === 'string' ? input.path.trim() : '';
    const lease = path ? leases.get(path) : null;
    const at = _at();

    if (!lease || lease.sessionId !== id || _leaseExpired(lease, at)) {
      return _fail(
        CODES.LEASE_NOT_HELD,
        `编辑租约不属于本会话：文件 "${path}" 当前持有者为 ` +
          `${lease ? lease.sessionId : '无'}，无法由 ${String(input.sessionId)} 续期`,
        { path }
      );
    }

    lease.expiresAt = at + leaseTtlMs;
    lease.renewals += 1;

    const record = sessions.get(id);

    if (record) {
      record.lastSeen = at;
    }

    return { ok: true, value: { ...lease } };
  }

  /**
   * 主动释放租约。
   *
   * @param {object} input { path, sessionId }
   * @returns {object} { ok: true, value: { path, released } } 或 { ok: false, error }
   */
  function releaseLease(input = {}) {
    const id = _cleanId(input.sessionId, maxIdLength);
    const path = typeof input.path === 'string' ? input.path.trim() : '';
    const lease = path ? leases.get(path) : null;

    if (!lease) {
      return { ok: true, value: { path, released: false } };
    }

    if (lease.sessionId !== id) {
      return _fail(
        CODES.LEASE_NOT_HELD,
        `编辑租约不属于本会话：文件 "${path}" 由 ${lease.sessionId} 持有，` +
          `${String(input.sessionId)} 无权释放`,
        { path, holderSessionId: lease.sessionId }
      );
    }

    leases.delete(path);

    return { ok: true, value: { path, released: true } };
  }

  /**
   * 查询某文件当前编辑者。已过期的租约视为不存在(惰性过期,不依赖 sweep 先跑)。
   *
   * @param {string} path 已规范化路径
   * @returns {object} { ok: true, value: lease | null }
   */
  function editorOf(path) {
    const key = typeof path === 'string' ? path.trim() : '';
    const lease = key ? leases.get(key) : null;

    if (_leaseExpired(lease, _at())) {
      return { ok: true, value: null };
    }

    return { ok: true, value: { ...lease } };
  }

  /**
   * 会话是否已认证(供 crdt_engine 的 ctx.authenticated)。
   *
   * @param {string} sessionId 会话标识
   * @returns {boolean}
   */
  function isAuthenticated(sessionId) {
    const id = _cleanId(sessionId, maxIdLength);
    const record = id ? sessions.get(id) : null;

    return Boolean(record && record.authenticated);
  }

  /**
   * 断线 / 异常退出:立即释放该会话的全部租约与订阅,不等 TTL。
   * 「断线不会永久占用编辑状态」这条验收由本方法保证。
   *
   * @param {string} sessionId 会话标识
   * @returns {object} { ok: true, value: { sessionId, releasedPaths, unsubscribed, existed } }
   */
  function dropSession(sessionId) {
    const id = _cleanId(sessionId, maxIdLength);
    const record = id ? sessions.get(id) : null;
    const releasedPaths = id ? _releaseLeasesOf(id) : [];
    const unsubscribed = record ? [...record.paths] : [];
    const at = _at();

    if (id) {
      sessions.delete(id);
      // The tombstone is what makes the release stick across instances: peers holding
      // an adopted copy drop it on their next align instead of handing it back to us.
      _recordRemoval(id, at);
      _pruneRemovals(at);
    }

    return {
      ok: true,
      value: {
        sessionId: id || String(sessionId),
        releasedPaths: releasedPaths.sort(),
        unsubscribed: unsubscribed.sort(),
        existed: Boolean(record),
      },
    };
  }

  /**
   * 清扫过期租约与空闲会话。这是**空闲**超时,不是固定时长硬 kill:每次心跳 / 提交 /
   * 订阅都刷新 lastSeen 与 expiresAt,持续活动的会话永不被扫掉。
   *
   * @returns {object} { ok: true, value: { expiredLeases, idleSessions, at } }
   */
  function sweep() {
    const at = _at();
    const expiredLeases = [];
    const idleSessions = [];

    for (const [path, lease] of [...leases]) {
      if (_leaseExpired(lease, at)) {
        leases.delete(path);
        expiredLeases.push({ path, sessionId: lease.sessionId, editorId: lease.editorId });
      }
    }

    for (const [sessionId, record] of [...sessions]) {
      if (at - record.lastSeen > sessionIdleMs) {
        for (const [path, lease] of [...leases]) {
          if (lease.sessionId === sessionId) {
            leases.delete(path);
            expiredLeases.push({ path, sessionId, editorId: lease.editorId });
          }
        }

        sessions.delete(sessionId);
        _recordRemoval(sessionId, at);
        idleSessions.push(sessionId);
      }
    }

    _pruneRemovals(at);

    return { ok: true, value: { expiredLeases, idleSessions, at } };
  }

  /**
   * 当前统计(供状态展示:动作 + 目标 + 进度)。
   *
   * @returns {object} { ok: true, value: { sessions, leases, subscriptions } }
   */
  function stats() {
    let subscriptions = 0;

    for (const record of sessions.values()) {
      subscriptions += record.paths.size;
    }

    return { ok: true, value: { sessions: sessions.size, leases: leases.size, subscriptions } };
  }

  /**
   * 导出可序列化状态。这是跨进程 / 重启的 IoC port:调用方负责把它交给注入的持久化
   * 端口,本模块一个字节都不落盘。
   *
   * @returns {object} { ok: true, value: { schema, at, sessions, leases } }
   */
  function snapshot() {
    return {
      ok: true,
      value: {
        schema: SCHEMA,
        at: _at(),
        sessions: [...sessions.values()].map((r) => ({
          sessionId: r.sessionId,
          editorId: r.editorId,
          instanceId: r.instanceId,
          authenticated: r.authenticated,
          createdAt: r.createdAt,
          lastSeen: r.lastSeen,
          paths: [...r.paths],
        })),
        leases: [...leases.values()].map((l) => ({ ...l })),
        // Deletions travel with the snapshot; a union merge has no other way to learn
        // that a session is gone rather than merely absent from our own view.
        removals: [...removals].map(([sessionId, removedAt]) => ({ sessionId, removedAt })),
      },
    };
  }

  /**
   * 从快照恢复。坏快照不抛,返回结构化错误,调用方据此从零开始(fail-soft)。
   * 恢复时**丢弃已过期的租约**——重启后没人还在编辑一份 TTL 早已走完的文件。
   *
   * @param {object} state snapshot() 的产物
   * @returns {object} { ok: true, value: { sessions, leases, droppedLeases } } 或 { ok: false, error }
   */
  function restore(state) {
    if (!state || typeof state !== 'object' || state.schema !== SCHEMA) {
      return _fail(
        CODES.INVALID_SNAPSHOT,
        `注册表快照不可用：schema 应为 ${SCHEMA}，实际为 ` +
          `${state && state.schema ? String(state.schema) : '缺失'}`
      );
    }

    try {
      const at = _at();

      sessions.clear();
      leases.clear();
      removals.clear();

      // Ingest tombstones first so a stale session record in the same snapshot cannot
      // be restored ahead of the deletion that supersedes it.
      for (const raw of Array.isArray(state.removals) ? state.removals : []) {
        const sessionId = _cleanId(raw && raw.sessionId, maxIdLength);

        if (sessionId) {
          _recordRemoval(sessionId, Number.isFinite(raw.removedAt) ? raw.removedAt : at);
        }
      }

      _pruneRemovals(at);

      for (const raw of Array.isArray(state.sessions) ? state.sessions : []) {
        const sessionId = _cleanId(raw && raw.sessionId, maxIdLength);

        if (!sessionId || sessions.size >= maxSessions || removals.has(sessionId)) {
          continue;
        }

        const paths = new Set(
          (Array.isArray(raw.paths) ? raw.paths : [])
            .filter((p) => typeof p === 'string' && p)
            .slice(0, maxPathsPerSession)
        );

        sessions.set(sessionId, {
          sessionId,
          editorId: _cleanId(raw.editorId, maxIdLength) || sessionId,
          instanceId: _cleanId(raw.instanceId, maxIdLength) || 'local',
          authenticated: raw.authenticated !== false,
          createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : at,
          lastSeen: Number.isFinite(raw.lastSeen) ? raw.lastSeen : at,
          paths,
        });
      }

      let droppedLeases = 0;

      for (const raw of Array.isArray(state.leases) ? state.leases : []) {
        const path = typeof (raw && raw.path) === 'string' ? raw.path.trim() : '';
        const sessionId = _cleanId(raw && raw.sessionId, maxIdLength);

        if (
          !path ||
          !sessionId ||
          !Number.isFinite(raw.expiresAt) ||
          raw.expiresAt <= at ||
          removals.has(sessionId)
        ) {
          droppedLeases += 1;
          continue;
        }

        leases.set(path, {
          path,
          sessionId,
          editorId: _cleanId(raw.editorId, maxIdLength) || sessionId,
          instanceId: _cleanId(raw.instanceId, maxIdLength) || 'local',
          acquiredAt: Number.isFinite(raw.acquiredAt) ? raw.acquiredAt : at,
          expiresAt: raw.expiresAt,
          renewals: Number.isFinite(raw.renewals) ? raw.renewals : 0,
        });
      }

      return { ok: true, value: { sessions: sessions.size, leases: leases.size, droppedLeases } };
    } catch (err) {
      return _fail(
        CODES.INVALID_SNAPSHOT,
        `注册表快照不可用：恢复阶段异常 ${(err && err.message) || err}`
      );
    }
  }

  /**
   * 合并另一实例的快照(跨进程共享存储用)。restore() 是「清空后重建」,只适合单实例
   * 重启;多实例并发时清空会把本进程正活着的会话抹掉。本方法只做**并集**:
   *   - 会话:同 sessionId 取 lastSeen 更新的一份;本地不存在的外部会话被纳入,
   *     使 subscribersOf / editorOf 能看见其他实例的订阅者与编辑者。
   *   - 租约:已过期的外部租约直接丢弃;冲突时取 expiresAt 更晚的一份 —— 时间戳是
   *     唯一跨进程可比较的事实,不能用「谁后写文件」这种与真实持有时间无关的顺序。
   *   - `ownInstanceId`:本实例自己的会话以内存为准,不被外部快照里的旧副本回退。
   *
   * @param {object} state snapshot() 的产物
   * @param {object} [options] { ownInstanceId }
   * @returns {object} { ok: true, value: { sessionsAdded, sessionsUpdated, leasesAdopted, dropped } } 或 { ok: false, error }
   */
  function mergeSnapshot(state, options = {}) {
    if (!state || typeof state !== 'object' || state.schema !== SCHEMA) {
      return _fail(
        CODES.INVALID_SNAPSHOT,
        `注册表快照不可用：schema 应为 ${SCHEMA}，实际为 ` +
          `${state && state.schema ? String(state.schema) : '缺失'}`
      );
    }

    try {
      const at = _at();
      const ownInstanceId = _cleanId(options.ownInstanceId, maxIdLength);
      let sessionsAdded = 0;
      let sessionsUpdated = 0;
      let leasesAdopted = 0;
      let dropped = 0;
      let sessionsRemoved = 0;

      // Tombstones win over records, whichever side they came from: a peer's deletion
      // must evict the copy we adopted, and our own must not be undone by a snapshot
      // written before the disconnect.
      for (const raw of Array.isArray(state.removals) ? state.removals : []) {
        const sessionId = _cleanId(raw && raw.sessionId, maxIdLength);

        if (!sessionId) {
          continue;
        }

        const removedAt = Number.isFinite(raw.removedAt) ? raw.removedAt : at;
        const local = sessions.get(sessionId);

        _recordRemoval(sessionId, removedAt);

        // Only evict a session the removal actually supersedes; a session that
        // re-registered after the tombstone is a live reconnect, not a stale copy.
        if (local && local.lastSeen <= removedAt) {
          sessions.delete(sessionId);
          _releaseLeasesOf(sessionId);
          sessionsRemoved += 1;
        }
      }

      _pruneRemovals(at);

      for (const raw of Array.isArray(state.sessions) ? state.sessions : []) {
        const sessionId = _cleanId(raw && raw.sessionId, maxIdLength);

        if (!sessionId) {
          dropped += 1;
          continue;
        }

        const tombstonedAt = removals.get(sessionId);

        // Absent from our view but tombstoned: the session is gone, not merely unseen.
        if (Number.isFinite(tombstonedAt) && !sessions.has(sessionId)) {
          const lastSeen = Number.isFinite(raw.lastSeen) ? raw.lastSeen : at;

          if (lastSeen <= tombstonedAt) {
            dropped += 1;
            continue;
          }
        }

        const instanceId = _cleanId(raw.instanceId, maxIdLength) || 'local';

        // Our own sessions live in memory and are authoritative there: a snapshot
        // written before our latest heartbeat must not roll them back.
        if (ownInstanceId && instanceId === ownInstanceId && sessions.has(sessionId)) {
          continue;
        }

        const lastSeen = Number.isFinite(raw.lastSeen) ? raw.lastSeen : at;
        const existing = sessions.get(sessionId);

        if (existing && existing.lastSeen >= lastSeen) {
          continue;
        }

        if (!existing && sessions.size >= maxSessions) {
          dropped += 1;
          continue;
        }

        const paths = new Set(
          (Array.isArray(raw.paths) ? raw.paths : [])
            .filter((p) => typeof p === 'string' && p)
            .slice(0, maxPathsPerSession)
        );

        sessions.set(sessionId, {
          sessionId,
          editorId: _cleanId(raw.editorId, maxIdLength) || sessionId,
          instanceId,
          authenticated: raw.authenticated !== false,
          createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : at,
          lastSeen,
          paths,
        });

        if (existing) {
          sessionsUpdated += 1;
        } else {
          sessionsAdded += 1;
        }
      }

      for (const raw of Array.isArray(state.leases) ? state.leases : []) {
        const path = typeof (raw && raw.path) === 'string' ? raw.path.trim() : '';
        const sessionId = _cleanId(raw && raw.sessionId, maxIdLength);

        if (
          !path ||
          !sessionId ||
          !Number.isFinite(raw.expiresAt) ||
          raw.expiresAt <= at ||
          !sessions.has(sessionId)
        ) {
          // A lease whose session we do not (or no longer) know is unownable: adopting
          // it would leave a holder nobody can release or renew.
          dropped += 1;
          continue;
        }

        const current = leases.get(path);

        // A foreign lease may only take the slot if it genuinely outlives ours.
        if (current && current.expiresAt >= raw.expiresAt) {
          continue;
        }

        leases.set(path, {
          path,
          sessionId,
          editorId: _cleanId(raw.editorId, maxIdLength) || sessionId,
          instanceId: _cleanId(raw.instanceId, maxIdLength) || 'local',
          acquiredAt: Number.isFinite(raw.acquiredAt) ? raw.acquiredAt : at,
          expiresAt: raw.expiresAt,
          renewals: Number.isFinite(raw.renewals) ? raw.renewals : 0,
        });
        leasesAdopted += 1;
      }

      return {
        ok: true,
        value: { sessionsAdded, sessionsUpdated, sessionsRemoved, leasesAdopted, dropped },
      };
    } catch (err) {
      return _fail(
        CODES.INVALID_SNAPSHOT,
        `注册表快照不可用：合并阶段异常 ${(err && err.message) || err}`
      );
    }
  }

  return {
    CODES,
    SCHEMA,
    leaseTtlMs,
    sessionIdleMs,
    registerSession,
    heartbeat,
    subscribe,
    unsubscribe,
    subscribersOf,
    acquireLease,
    renewLease,
    releaseLease,
    editorOf,
    isAuthenticated,
    dropSession,
    sweep,
    stats,
    snapshot,
    restore,
    mergeSnapshot,
  };
}

module.exports = { CODES, DEFAULTS, SCHEMA, createRegistry };
