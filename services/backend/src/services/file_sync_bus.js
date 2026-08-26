'use strict';

/**
 * file_sync_bus.js — 文件变更事件总线 + 版本化文档仓(薄 IO 层)。
 *
 * WHY: crdt_engine 只会判定与合并,session_registry 只记谁在编。真正把两者串起来、
 * 维护「每个文件当前是第几版、历史有哪些批次、谁该收到通知」的是这一层。它是本特性里
 * **唯一**碰真实副作用的地方,而且所有副作用都走注入端口(send / readFile / writeFile /
 * persist / fileLock / now),因此纯判定与合并逻辑可以脱离真实 fs、WebSocket 和时钟单测。
 *
 * 每个文件维护:当前文本 + 权威 Y.Doc、当前版本号、操作历史环、已处理 opId 表、
 * 订阅者已送达版本、当前编辑租约(委托 registry)、历史容量与淘汰策略。
 *
 * 与既有 _fileLock 的关系是**互补而非替代**:
 *   - 内存合并成功 → 落盘那一下仍然走 _fileLock,和仓库里其他写者保持同一套互斥;
 *   - 合并不可用(yjs 缺席 / 历史断裂 / 文档损坏 / 二进制 / 无法合并 / 版本无法确认 /
 *     权限失败 / 显式独占锁)→ 返回 MERGE_FALLBACK{fallback:'file_lock'},调用方回落到
 *     今天的悲观锁 + conflictCopyPath 冲突副本路径。任何一条降级路径都不丢数据。
 *
 * 事件族是**纯加法**的:入向 subscribe_files / unsubscribe_files / file_op / file_lease /
 * file_lock / file_catch_up / file_chunk_manifest / file_chunk_request / file_chunk_patch,
 * 出向 file_subscribed / file_changed / file_op_result / file_resync_required /
 * file_lease_state / file_lock_state / file_chunk_plan / file_chunk_patch /
 * file_chunk_result。老客户端一个字节都不用改,终端流、桌面帧、任务轮询等既有消息
 * 类型完全不受影响。
 *
 * 二进制与超长文件走**分块 diff**(chunk_diff)而非文本合并:文本合并对它们既不安全
 * (utf8 读写会静默损坏字节)也不划算(整份重传)。分块路径不参与 CRDT 版本推进,
 * 它是「拿字节」通道,互斥仍由租约/文件锁负责。
 *
 * @module services/file_sync_bus
 */

const fs = require('fs');
const path = require('path');

const engineModule = require('./crdt_engine');
const registryModule = require('./session_registry');
const chunkModule = require('./chunk_diff');

const SCHEMA = 'khy-file-sync/1';

function _fail(code, message, extra) {
  return { ok: false, error: { code, message, ...(extra || {}) } };
}

function _fallback(message) {
  return _fail(
    engineModule.CODES.MERGE_FALLBACK,
    `实时合并不可用，已进入文件锁降级路径：${message}`,
    { fallback: 'file_lock' }
  );
}

/**
 * 建立默认端口。这是本特性里唯一真正 require fs 的地方,且全部 fail-soft ——
 * 单测一律注入假端口,不碰真实磁盘。
 *
 * @param {object} [opts] { projectDir, logger }
 * @returns {object} { readFile, writeFile, persist }
 */
function createDefaultPorts(opts = {}) {
  const projectDir = opts.projectDir || process.cwd();

  function _abs(relPath) {
    const abs = path.resolve(projectDir, relPath);
    const root = path.resolve(projectDir);

    // Second gate. crdt_engine already refused `..` and absolute paths, but the
    // disk boundary re-checks containment — never trust a path twice-removed
    // from validation.
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return null;
    }

    return abs;
  }

  return {
    readFile(relPath) {
      const abs = _abs(relPath);

      if (!abs) {
        return _fail(engineModule.CODES.PATH_ESCAPE, `文件路径越界：解析后逃出项目根 "${relPath}"`);
      }

      try {
        return { ok: true, value: fs.readFileSync(abs, 'utf8') };
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          return { ok: true, value: '' };
        }

        return _fail('READ_FAILED', `读取文件失败：${relPath} — ${(err && err.message) || err}`);
      }
    },

    writeFile(relPath, text) {
      const abs = _abs(relPath);

      if (!abs) {
        return _fail(engineModule.CODES.PATH_ESCAPE, `文件路径越界：解析后逃出项目根 "${relPath}"`);
      }

      // NOTE: _fileLock.acquire() is async (returns a Promise) and this port is
      // sync, so it is deliberately NOT used here — calling it without await
      // would hand back a Promise and lock nothing at all. The merge path has a
      // single authoritative writer per instance, and the tmp+rename below is
      // atomic, so readers never observe a half-written file. Cross-process
      // mutual exclusion in the MERGE path is a documented limitation (see the
      // follow-up task list); _fileLock stays the exclusive owner of the
      // DEGRADATION path via fallbackToFileLock() below, which is async and
      // does await it.
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });

        const tmp = `${abs}.khyfsync.tmp`;

        fs.writeFileSync(tmp, text, 'utf8');
        fs.renameSync(tmp, abs);

        return { ok: true, value: { bytes: Buffer.byteLength(text, 'utf8') } };
      } catch (err) {
        return _fail('WRITE_FAILED', `写入文件失败：${relPath} — ${(err && err.message) || err}`);
      }
    },

    /**
     * 二进制读取端口。文本路径用 readFile(utf8),分块路径必须拿原始字节 ——
     * 以 utf8 读二进制会把非法序列替换成 U+FFFD,写回去就是**静默损坏文件**。
     */
    readBinary(relPath) {
      const abs = _abs(relPath);

      if (!abs) {
        return _fail(engineModule.CODES.PATH_ESCAPE, `文件路径越界：解析后逃出项目根 "${relPath}"`);
      }

      try {
        return { ok: true, value: fs.readFileSync(abs) };
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          return { ok: true, value: Buffer.alloc(0) };
        }

        return _fail('READ_FAILED', `读取文件失败：${relPath} — ${(err && err.message) || err}`);
      }
    },

    /** 二进制写入端口。与 writeFile 同样走 tmp + rename,读者永远看不到半份文件。 */
    writeBinary(relPath, bytes) {
      const abs = _abs(relPath);

      if (!abs) {
        return _fail(engineModule.CODES.PATH_ESCAPE, `文件路径越界：解析后逃出项目根 "${relPath}"`);
      }

      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });

        const tmp = `${abs}.khyfsync.tmp`;

        fs.writeFileSync(tmp, bytes);
        fs.renameSync(tmp, abs);

        return { ok: true, value: { bytes: bytes.length } };
      } catch (err) {
        return _fail('WRITE_FAILED', `写入文件失败：${relPath} — ${(err && err.message) || err}`);
      }
    },

    persist: (() => {
      let target = null;

      function _target() {
        if (target !== null) {
          return target;
        }

        try {
          // Project-scoped data home (~ <project>/.khy), NOT the working directory:
          // the registry snapshot is internal cross-instance state, so it must not
          // litter the checkout the way resolveGeneratedFileDir's preferCwd branch
          // would. Project scope is deliberate — two khy instances editing the same
          // project share one registry; different projects stay isolated.
          const dataHome = require('../utils/dataHome');

          target = path.join(dataHome.getProjectDataDir('file-sync'), 'session-registry.json');
        } catch {
          target = '';
        }

        return target;
      }

      return {
        load() {
          const file = _target();

          if (!file) {
            return { ok: true, value: null };
          }

          try {
            return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
          } catch {
            return { ok: true, value: null };
          }
        },

        // Cross-process write: read-merge-write, then atomic rename. A plain
        // writeFileSync would make the last instance to save clobber every other
        // instance's sessions and leases — the exact "cross-process fact living in
        // one Node process's memory" failure this port exists to avoid.
        //
        // `merge` is injected by the caller (the registry's own union logic) so
        // this port stays a dumb file mover with no knowledge of the data model.
        save(state, options = {}) {
          const file = _target();

          if (!file) {
            return { ok: true, value: { skipped: true } };
          }

          const merge = typeof options.merge === 'function' ? options.merge : null;
          const attempts = 3;
          let lastErr = null;

          for (let i = 0; i < attempts; i += 1) {
            try {
              fs.mkdirSync(path.dirname(file), { recursive: true });

              let outgoing = state;

              if (merge) {
                let onDisk = null;

                try {
                  onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
                } catch {
                  onDisk = null; // absent or corrupt → our state is the whole truth
                }

                outgoing = merge(onDisk) || state;
              }

              // Same-directory temp + rename: readers see either the old or the new
              // file, never a half-written one.
              const tmp = `${file}.${process.pid}.${i}.tmp`;

              fs.writeFileSync(tmp, JSON.stringify(outgoing), 'utf8');
              fs.renameSync(tmp, file);

              return { ok: true, value: { file, merged: Boolean(merge), attempt: i + 1 } };
            } catch (err) {
              lastErr = err;
            }
          }

          return _fail(
            'PERSIST_FAILED',
            `注册表快照落盘失败：${file} 重试 ${attempts} 次仍失败 — ` +
              `${(lastErr && lastErr.message) || lastErr}`
          );
        },
      };
    })(),
  };
}

/**
 * 建立总线实例。所有状态在闭包里 —— 同一进程可开多个互不干扰的总线,单测靠这点隔离。
 *
 * @param {object} [opts] 见下方端口说明
 * @returns {object} 总线 API
 */
function createBus(opts = {}) {
  const engine = opts.engine || engineModule;
  const env = opts.env || process.env;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const logger = opts.logger || null;
  const projectDir = opts.projectDir || process.cwd();
  const limits = engine.resolveLimits(env);
  const allowPrefixes = Array.isArray(opts.allowPrefixes) ? opts.allowPrefixes : [];
  // Identifies this Node process inside the shared registry file. Injectable so
  // tests can simulate two instances against one snapshot without forking.
  const instanceId =
    (typeof opts.instanceId === 'string' && opts.instanceId.trim()) ||
    (typeof env.KHY_FILE_SYNC_INSTANCE_ID === 'string' && env.KHY_FILE_SYNC_INSTANCE_ID.trim()) ||
    `pid-${process.pid}`;
  const historyLimit = Number.isSafeInteger(opts.historyLimit) && opts.historyLimit > 0
    ? opts.historyLimit
    : limits.historyLimit;

  const registry =
    opts.registry ||
    registryModule.createRegistry({
      now,
      leaseTtlMs: Number(env.KHY_FILE_SYNC_LEASE_MS) || undefined,
      sessionIdleMs: Number(env.KHY_FILE_SYNC_IDLE_MS) || undefined,
    });

  const ports = {
    send: typeof opts.send === 'function' ? opts.send : () => false,
    readFile: null,
    writeFile: null,
    readBinary: null,
    writeBinary: null,
    persist: null,
  };

  const lazyDefaults = () => createDefaultPorts({ projectDir: opts.projectDir, logger });
  let defaults = null;

  function _port(name) {
    if (ports[name]) {
      return ports[name];
    }

    if (typeof opts[name] === 'function' || (name === 'persist' && opts.persist)) {
      ports[name] = opts[name];

      return ports[name];
    }

    if (!defaults) {
      defaults = lazyDefaults();
    }

    ports[name] = defaults[name];

    return ports[name];
  }

  /** @type {Map<string, object>} relPath -> file state */
  const files = new Map();

  function _at() {
    const t = Number(now());

    return Number.isFinite(t) ? t : 0;
  }

  function _log(level, message) {
    if (logger && typeof logger[level] === 'function') {
      try {
        logger[level](message);
      } catch {
        /* logging must never break a merge */
      }
    }
  }

  function _enabled() {
    return engine.isEngineEnabled(env);
  }

  function _normalize(rawPath) {
    return engine.normalizeRelPath(rawPath, { limits, allowPrefixes });
  }

  /**
   * 取(或首次建立)一个文件的状态。首次建立时通过 readFile 端口拿初始内容,
   * 二进制内容直接拒绝进入文本合并路径。
   *
   * @param {string} relPath 已规范化路径
   * @returns {object} { ok: true, value: file } 或 { ok: false, error }
   */
  function ensureFile(relPath) {
    const existing = files.get(relPath);

    if (existing) {
      return { ok: true, value: existing };
    }

    const read = _port('readFile')(relPath);

    if (!read.ok) {
      return _fallback(`读取 ${relPath} 初始内容失败 — ${read.error.message}`);
    }

    const text = String(read.value === null || read.value === undefined ? '' : read.value);

    if (engine.looksBinary(text)) {
      // 二进制仍然**不进**文本合并 —— 以 utf8 读写会把非法序列换成 U+FFFD,写回即损坏。
      // 但拒绝不再是终点:分块通道开启时告知客户端改走 file_chunk_manifest 拿字节,
      // 门控关闭时才退回文件锁。错误码保持 BINARY_FILE,老客户端行为不变。
      const viaChunk = chunkModule.isChunkDiffEnabled(env);

      return _fail(
        engine.CODES.BINARY_FILE,
        viaChunk
          ? `拒绝对二进制文件做文本合并：${relPath} 含空字节或过多控制字符，请改走分块传输（file_chunk_manifest）`
          : `拒绝对二进制文件做文本合并：${relPath} 含空字节或过多控制字符，请走文件锁路径`,
        {
          path: relPath,
          fallback: 'file_lock',
          ...(viaChunk ? { route: 'chunk_diff', nextType: 'file_chunk_manifest' } : {}),
        }
      );
    }

    const created = engine.createDocument({ text, clientKey: `${SCHEMA}:${relPath}` });
    const file = {
      path: relPath,
      version: 0,
      text,
      doc: created.value.doc,
      docAvailable: created.value.available === true,
      degraded: created.value.degraded || null,
      history: [],
      processed: new Map(),
      sent: new Map(),
      exclusive: null,
      createdAt: _at(),
      updatedAt: _at(),
    };

    files.set(relPath, file);

    return { ok: true, value: file };
  }

  /** 历史环:超出容量则从头淘汰,并记录「已淘汰到哪一版」。 */
  function _pushHistory(file, entry) {
    file.history.push(entry);

    while (file.history.length > historyLimit) {
      const dropped = file.history.shift();

      // Keep the processed table bounded together with history — a version that
      // can no longer be replayed does not need dedup protection either.
      if (dropped && dropped.opId) {
        file.processed.delete(dropped.opId);
      }
    }
  }

  /** 历史里还能重放的最低版本号(即 minAvailableVersion)。 */
  function _oldestAvailable(file) {
    return file.history.length > 0 ? file.history[0].version : file.version + 1;
  }

  /**
   * 计算某个 lastSeenVersion 之后的可用增量。
   *
   * @param {object} file 文件状态
   * @param {number} lastSeenVersion 客户端已见版本
   * @returns {object} { ok: true, value: { upToDate, operations } } 或 { ok: false, error }
   */
  function _incrementsSince(file, lastSeenVersion) {
    const seen = Number.isSafeInteger(lastSeenVersion) && lastSeenVersion >= 0 ? lastSeenVersion : 0;

    if (seen === file.version) {
      return { ok: true, value: { upToDate: true, increments: [] } };
    }

    if (seen > file.version) {
      return _fail(
        engine.CODES.BASE_VERSION_AHEAD,
        `客户端版本领先服务端：${file.path} 客户端声明已见 v${seen}，服务端当前仅 v${file.version}，需要整份重同步`,
        { path: file.path, currentVersion: file.version, lastSeenVersion: seen }
      );
    }

    if (file.history.length === 0 || seen + 1 < _oldestAvailable(file)) {
      return _fail(
        engine.CODES.HISTORY_EVICTED,
        `历史已淘汰：${file.path} 只保留到 v${_oldestAvailable(file)}，无法补齐 v${seen} 之后的增量，需要整份重同步`,
        { path: file.path, currentVersion: file.version, lastSeenVersion: seen }
      );
    }

    return {
      ok: true,
      value: {
        upToDate: false,
        increments: file.history.filter((h) => h.version > seen).map((h) => ({ ...h })),
      },
    };
  }

  function _changedEvent(file, entry) {
    return {
      type: 'file_changed',
      schema: SCHEMA,
      path: file.path,
      version: entry.version,
      baseVersion: entry.baseVersion,
      opId: entry.opId,
      editor: entry.editor,
      sessionId: entry.sessionId,
      operations: entry.operations,
      update: entry.update,
      timestamp: entry.at,
    };
  }

  function _resyncEvent(file, reason) {
    const snap = engine.encodeSnapshot(file.doc, file.text);

    return {
      type: 'file_resync_required',
      schema: SCHEMA,
      path: file.path,
      version: file.version,
      reason,
      text: snap.value.text,
      snapshot: snap.value.snapshot,
      stateVector: snap.value.stateVector,
      timestamp: _at(),
    };
  }

  /**
   * 向一批会话扇出一条事件。**一个订阅者发送失败不得阻断其他订阅者** ——
   * 每个 send 单独 try/catch,失败只记数。
   *
   * @param {string[]} sessionIds 目标会话
   * @param {object} message 事件体
   * @returns {object} { delivered, failed }
   */
  function _fanout(sessionIds, message) {
    let delivered = 0;
    let failed = 0;

    for (const sessionId of sessionIds) {
      try {
        const ok = _port('send')(sessionId, message);

        if (ok === false) {
          failed += 1;
        } else {
          delivered += 1;
        }
      } catch (err) {
        failed += 1;
        _log('warn', `文件变更推送失败：会话 ${sessionId} — ${(err && err.message) || err}`);
      }
    }

    return { delivered, failed };
  }

  function _persistRegistry() {
    try {
      const snap = registry.snapshot();
      const port = _port('persist');

      if (port && typeof port.save === 'function' && snap.ok) {
        // Union on-disk state into ours before writing, so a concurrent instance's
        // sessions and leases survive our save instead of being overwritten.
        const saved = port.save(snap.value, {
          merge: (onDisk) => {
            if (!onDisk) {
              return snap.value;
            }

            const merged = registry.mergeSnapshot(onDisk, { ownInstanceId: instanceId });

            if (!merged.ok) {
              _log('warn', merged.error.message);

              return snap.value;
            }

            const after = registry.snapshot();

            return after.ok ? after.value : snap.value;
          },
        });

        if (saved && saved.ok === false) {
          _log('warn', saved.error.message);
        }
      }
    } catch (err) {
      _log('warn', `注册表快照持久化异常：${(err && err.message) || err}`);
    }
  }

  /**
   * 从持久化端口恢复注册表(跨实例 / 重启)。失败不抛,从零开始。
   *
   * @returns {object} { ok: true, value: { restored, detail } }
   */
  function restoreRegistry() {
    try {
      const port = _port('persist');

      if (!port || typeof port.load !== 'function') {
        return { ok: true, value: { restored: false, detail: '未配置持久化端口' } };
      }

      const loaded = port.load();

      if (!loaded.ok || !loaded.value) {
        return { ok: true, value: { restored: false, detail: '无可用快照' } };
      }

      const result = registry.restore(loaded.value);

      return {
        ok: true,
        value: {
          restored: result.ok === true,
          detail: result.ok
            ? `恢复 ${result.value.sessions} 个会话、${result.value.leases} 个租约（丢弃 ${result.value.droppedLeases} 个过期租约）`
            : result.error.message,
        },
      };
    } catch (err) {
      return { ok: true, value: { restored: false, detail: `恢复异常 ${(err && err.message) || err}` } };
    }
  }

  /**
   * 会话注册(通常在 WS auth 成功后调用)。
   *
   * @param {object} input { sessionId, editorId, instanceId, authenticated }
   * @returns {object} registry.registerSession 的结果
   */
  function registerSession(input) {
    // Stamp our own instanceId unless the caller pinned one: mergeSnapshot relies
    // on it to tell "my session, memory wins" from "peer's session, adopt it".
    const result = registry.registerSession({
      ...(input || {}),
      instanceId: (input && input.instanceId) || instanceId,
    });

    if (result.ok) {
      _persistRegistry();
    }

    return result;
  }

  /**
   * 主动拉取共享快照并合并进本实例(不清空本地会话)。restoreRegistry() 是启动时的
   * 「从零恢复」,本方法是运行期的「与其他实例对齐」——扇出前调用即可看见 peer 的订阅者。
   *
   * @returns {object} { ok: true, value: { synced, detail, ...merged } }
   */
  function syncRegistry() {
    try {
      const port = _port('persist');

      if (!port || typeof port.load !== 'function') {
        return { ok: true, value: { synced: false, detail: '未配置持久化端口' } };
      }

      const loaded = port.load();

      if (!loaded.ok || !loaded.value) {
        return { ok: true, value: { synced: false, detail: '共享快照尚不存在' } };
      }

      const merged = registry.mergeSnapshot(loaded.value, { ownInstanceId: instanceId });

      if (!merged.ok) {
        _log('warn', merged.error.message);

        return { ok: true, value: { synced: false, detail: merged.error.message } };
      }

      return {
        ok: true,
        value: {
          synced: true,
          detail:
            `已对齐共享注册表：新增会话 ${merged.value.sessionsAdded} 个、` +
            `更新 ${merged.value.sessionsUpdated} 个、接纳租约 ${merged.value.leasesAdopted} 个`,
          ...merged.value,
        },
      };
    } catch (err) {
      return { ok: true, value: { synced: false, detail: `对齐共享注册表异常：${(err && err.message) || err}` } };
    }
  }

  /**
   * 订阅一批文件,并按 lastSeenVersions 一次性把缺失增量 / 重同步要求带回去。
   * 这是断线重连的**主**入口:客户端重连后一条 subscribe_files 就完成补齐。
   *
   * @param {object} input { sessionId, paths, lastSeenVersions }
   * @returns {object} { ok: true, value: { results } } 或 { ok: false, error }
   */
  function subscribeFiles(input = {}) {
    if (!_enabled()) {
      return _fallback('KHY_FILE_SYNC 已关闭，文件级实时同步未启用');
    }

    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';

    if (!registry.isAuthenticated(sessionId)) {
      return _fail(
        engine.CODES.UNAUTHENTICATED_SESSION,
        `会话未认证：sessionId "${sessionId}" 未注册或未通过 auth，拒绝订阅文件变更`
      );
    }

    const rawPaths = Array.isArray(input.paths) ? input.paths : [];

    if (rawPaths.length === 0) {
      return _fail(engine.CODES.SUBSCRIBE_FORBIDDEN, '订阅请求非法：paths 必须是非空数组');
    }

    const lastSeen = input.lastSeenVersions && typeof input.lastSeenVersions === 'object'
      ? input.lastSeenVersions
      : {};
    const results = [];
    const accepted = [];

    for (const rawPath of rawPaths) {
      const norm = _normalize(rawPath);

      if (!norm.ok) {
        results.push({ path: String(rawPath), ok: false, error: norm.error });
        continue;
      }

      const file = ensureFile(norm.value);

      if (!file.ok) {
        results.push({ path: norm.value, ok: false, error: file.error });
        continue;
      }

      accepted.push(norm.value);

      const state = file.value;
      const declared = lastSeen[rawPath] !== undefined ? lastSeen[rawPath] : lastSeen[norm.value];
      const editor = registry.editorOf(norm.value);
      const entry = {
        path: norm.value,
        ok: true,
        version: state.version,
        editor: editor.value ? editor.value.editorId : null,
        editorSessionId: editor.value ? editor.value.sessionId : null,
        degraded: state.degraded,
      };

      if (declared !== undefined && declared !== null) {
        const inc = _incrementsSince(state, declared);

        if (!inc.ok) {
          entry.resync = _resyncEvent(state, inc.error.message);
          entry.resyncReason = inc.error.code;
        } else {
          entry.upToDate = inc.value.upToDate;
          entry.increments = inc.value.increments.map((h) => _changedEvent(state, h));
        }
      }

      results.push(entry);
    }

    if (accepted.length > 0) {
      const sub = registry.subscribe(sessionId, accepted);

      if (!sub.ok) {
        return sub;
      }

      for (const p of accepted) {
        const state = files.get(p);

        if (state) {
          state.sent.set(sessionId, state.version);
        }
      }

      _persistRegistry();
    }

    return {
      ok: true,
      value: {
        results,
        status: `订阅 ${accepted.length}/${rawPaths.length} 个文件的变更事件（会话 ${sessionId}）`,
      },
    };
  }

  /**
   * 取消订阅。
   *
   * @param {object} input { sessionId, paths }
   * @returns {object} registry.unsubscribe 的结果
   */
  function unsubscribeFiles(input = {}) {
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
    const paths = [];

    for (const rawPath of Array.isArray(input.paths) ? input.paths : []) {
      const norm = _normalize(rawPath);

      if (norm.ok) {
        paths.push(norm.value);
      }
    }

    const result = registry.unsubscribe(sessionId, paths);

    if (result.ok) {
      for (const p of paths) {
        const state = files.get(p);

        if (state) {
          state.sent.delete(sessionId);
        }
      }

      _persistRegistry();
    }

    return result;
  }

  /**
   * 显式补齐(客户端也可不订阅就单独拉增量)。重复调用返回同一批增量且**不改变服务端
   * 状态**,故重复补齐不会导致重复应用 —— 客户端按 version 单调过滤即可。
   *
   * @param {object} input { sessionId, path, lastSeenVersion }
   * @returns {object} { ok: true, value: { upToDate, increments } | { resync } } 或 { ok: false, error }
   */
  function catchUp(input = {}) {
    if (!_enabled()) {
      return _fallback('KHY_FILE_SYNC 已关闭，无法提供增量补齐');
    }

    const norm = _normalize(input.path);

    if (!norm.ok) {
      return norm;
    }

    const file = ensureFile(norm.value);

    if (!file.ok) {
      return file;
    }

    const state = file.value;
    const inc = _incrementsSince(state, input.lastSeenVersion);
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';

    if (!inc.ok) {
      if (
        inc.error.code === engine.CODES.HISTORY_EVICTED ||
        inc.error.code === engine.CODES.BASE_VERSION_AHEAD
      ) {
        if (sessionId) {
          state.sent.set(sessionId, state.version);
        }

        return {
          ok: true,
          value: {
            resync: _resyncEvent(state, inc.error.message),
            reason: inc.error.code,
            status: `重同步 ${state.path}（当前 v${state.version}，客户端 v${input.lastSeenVersion}）`,
          },
        };
      }

      return inc;
    }

    if (sessionId) {
      state.sent.set(sessionId, state.version);
    }

    return {
      ok: true,
      value: {
        upToDate: inc.value.upToDate,
        currentVersion: state.version,
        increments: inc.value.increments.map((h) => _changedEvent(state, h)),
        status: `补齐 ${state.path} 增量 ${inc.value.increments.length} 个批次（v${input.lastSeenVersion} → v${state.version}）`,
      },
    };
  }

  /**
   * 提交一批基于 baseVersion 的操作:校验 → 幂等去重 → 版本闸 → rebase → 物化 →
   * 落盘 → 扇出 file_changed。任何一步不可用都返回结构化错误,绝不静默覆盖。
   *
   * @param {object} envelope { path, opId, editor, sessionId, baseVersion, operations }
   * @returns {object} { ok: true, value: {...} } 或 { ok: false, error }
   */
  function submitOp(envelope = {}) {
    if (!_enabled()) {
      return _fallback('KHY_FILE_SYNC 已关闭，文件级实时同步未启用');
    }

    const sessionId =
      typeof envelope.sessionId === 'string' && envelope.sessionId.trim()
        ? envelope.sessionId.trim()
        : '';
    const authenticated = registry.isAuthenticated(sessionId);
    const validated = engine.validateOpEnvelope(envelope, {
      limits,
      allowPrefixes,
      authenticated,
      canEdit: authenticated,
    });

    if (!validated.ok) {
      return validated;
    }

    const op = validated.value;
    const file = ensureFile(op.path);

    if (!file.ok) {
      return file;
    }

    const state = file.value;

    // 1) Idempotent dedup. A retried opId returns the version it originally
    //    produced and applies nothing — never a second time.
    if (state.processed.has(op.opId)) {
      const version = state.processed.get(op.opId);

      return {
        ok: true,
        value: {
          path: op.path,
          opId: op.opId,
          version,
          baseVersion: op.baseVersion,
          duplicate: true,
          currentVersion: state.version,
          status: `跳过重复操作 ${op.opId}（${op.path} 已在 v${version} 应用过，当前 v${state.version}）`,
        },
      };
    }

    // 2) Explicit exclusive mode → this is the pessimistic degradation path.
    if (state.exclusive && state.exclusive !== op.sessionId) {
      const holder = registry.editorOf(op.path);

      if (holder.value && holder.value.sessionId === state.exclusive) {
        return _fallback(
          `${op.path} 已被会话 ${state.exclusive}（编辑者 ${holder.value.editorId}）置为独占编辑模式`
        );
      }

      state.exclusive = null;
    }

    // 3) Version gate. Ahead / evicted are reported explicitly — no last-writer-wins.
    if (op.baseVersion > state.version) {
      return _fail(
        engine.CODES.BASE_VERSION_AHEAD,
        `基线版本领先服务端：${op.path} 提交声明基线 v${op.baseVersion}，服务端当前仅 v${state.version}，请先重同步`,
        { path: op.path, opId: op.opId, baseVersion: op.baseVersion, currentVersion: state.version }
      );
    }

    if (op.baseVersion < state.version && op.baseVersion + 1 < _oldestAvailable(state)) {
      return _fail(
        engine.CODES.HISTORY_EVICTED,
        `基线版本已过期且历史已淘汰：${op.path} 提交基线 v${op.baseVersion}，历史仅保留到 v${_oldestAvailable(state)}（当前 v${state.version}），请重同步后重提`,
        { path: op.path, opId: op.opId, baseVersion: op.baseVersion, currentVersion: state.version }
      );
    }

    // 4) Rebase over everything committed after the declared base version.
    const committed = state.history.filter((h) => h.version > op.baseVersion);
    const rebased = engine.rebaseOperations(
      { opId: op.opId, operations: op.operations },
      committed
    );

    if (!rebased.ok) {
      const error = {
        ...rebased.error,
        path: op.path,
        baseVersion: op.baseVersion,
        currentVersion: state.version,
        opId: op.opId,
      };

      if (error.code === engine.CODES.MERGE_CONFLICT) {
        // Both sides' op info survives — the caller may review it or route the
        // incoming batch to a conflict copy via _fileLock.conflictCopyPath.
        error.incomingOperations = op.operations;
        error.conflictCopyHint = `${op.path}_conflict_khy_${op.editor}`;
      }

      return { ok: false, error };
    }

    // 5) Materialise on the authoritative Y.Doc (pre-flighted against the plain
    //    string inside the engine, so a bad batch cannot half-apply).
    const applied = engine.applyToDocument(state.doc, rebased.value.operations, {
      fallbackText: state.text,
      limits,
    });

    if (!applied.ok) {
      return { ok: false, error: { ...applied.error, path: op.path, opId: op.opId } };
    }

    const at = _at();
    const version = state.version + 1;
    const entry = {
      version,
      baseVersion: op.baseVersion,
      opId: op.opId,
      editor: op.editor,
      sessionId: op.sessionId,
      operations: rebased.value.operations,
      update: applied.value.update,
      at,
    };

    state.version = version;
    state.text = applied.value.text;
    state.updatedAt = at;

    if (applied.value.degraded) {
      state.degraded = applied.value.degraded;
    }

    _pushHistory(state, entry);
    state.processed.set(op.opId, version);

    // 6) Persist to disk. A write failure does NOT lose the merge — the doc and
    //    history still hold it and subscribers still get the increment — but it
    //    is reported as a warning so the caller can escalate to file_lock.
    const warnings = [];
    const written = _port('writeFile')(op.path, state.text);

    if (written && written.ok === false) {
      warnings.push(written.error.message);
      _log('warn', written.error.message);
    }

    // 7) Renew the editing lease on real activity (activity-based, never a fixed kill).
    if (sessionId) {
      const lease = registry.acquireLease({ path: op.path, sessionId });

      if (!lease.ok && lease.error.code !== registryModule.CODES.LEASE_HELD) {
        warnings.push(lease.error.message);
      }
    }

    // 8) Fan out. Per-subscriber try/catch — one dead socket cannot block others.
    const subscribers = registry.subscribersOf(op.path).value;
    const event = _changedEvent(state, entry);
    const delivery = _fanout(subscribers, event);

    for (const target of subscribers) {
      state.sent.set(target, version);
    }

    if (delivery.failed > 0) {
      warnings.push(
        `文件变更推送部分失败：${op.path} v${version} 送达 ${delivery.delivered}/${subscribers.length} 个订阅者`
      );
    }

    return {
      ok: true,
      value: {
        path: op.path,
        opId: op.opId,
        version,
        baseVersion: op.baseVersion,
        rebasedOver: rebased.value.rebasedOver,
        operations: rebased.value.operations,
        update: entry.update,
        event,
        subscribers,
        delivered: delivery.delivered,
        failed: delivery.failed,
        warnings,
        degraded: state.degraded,
        status: `合并 ${op.path} 操作 ${op.opId}（基线 v${op.baseVersion} → 新版本 v${version}，重放 ${rebased.value.rebasedOver} 个批次，送达 ${delivery.delivered}/${subscribers.length} 个订阅者）`,
      },
    };
  }

  /**
   * 编辑租约操作:acquire / renew / release。
   *
   * @param {object} input { sessionId, path, action }
   * @returns {object} { ok: true, value: { action, lease } } 或 { ok: false, error }
   */
  function lease(input = {}) {
    const norm = _normalize(input.path);

    if (!norm.ok) {
      return norm;
    }

    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
    const action = input.action === 'renew' || input.action === 'release' ? input.action : 'acquire';
    let result;

    if (action === 'renew') {
      result = registry.renewLease({ path: norm.value, sessionId });
    } else if (action === 'release') {
      result = registry.releaseLease({ path: norm.value, sessionId });
    } else {
      result = registry.acquireLease({ path: norm.value, sessionId });
    }

    if (!result.ok) {
      return result;
    }

    _persistRegistry();

    return {
      ok: true,
      value: {
        action,
        path: norm.value,
        lease: result.value,
        status: `编辑租约 ${action} 成功：${norm.value}（会话 ${sessionId}）`,
      },
    };
  }

  /**
   * 显式独占锁开关。开启后其他会话的 file_op 一律返回 MERGE_FALLBACK,由调用方走
   * _fileLock + 冲突副本 —— 这是「实时合并不适用」时的人工逃生口。
   *
   * @param {object} input { sessionId, path, action }
   * @returns {object} { ok: true, value: { path, exclusive } } 或 { ok: false, error }
   */
  function lock(input = {}) {
    const norm = _normalize(input.path);

    if (!norm.ok) {
      return norm;
    }

    const file = ensureFile(norm.value);

    if (!file.ok) {
      return file;
    }

    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
    const disable = input.action === 'disable' || input.action === 'release';

    if (disable) {
      if (file.value.exclusive && file.value.exclusive !== sessionId) {
        return _fail(
          registryModule.CODES.LEASE_NOT_HELD,
          `独占编辑模式不属于本会话：${norm.value} 由 ${file.value.exclusive} 开启，${sessionId} 无权关闭`,
          { path: norm.value }
        );
      }

      file.value.exclusive = null;
      registry.releaseLease({ path: norm.value, sessionId });

      return {
        ok: true,
        value: {
          path: norm.value,
          exclusive: null,
          status: `关闭 ${norm.value} 的独占编辑模式（会话 ${sessionId}），恢复实时合并`,
        },
      };
    }

    const acquired = registry.acquireLease({ path: norm.value, sessionId });

    if (!acquired.ok) {
      return acquired;
    }

    file.value.exclusive = sessionId;
    _persistRegistry();

    return {
      ok: true,
      value: {
        path: norm.value,
        exclusive: sessionId,
        lease: acquired.value,
        status: `开启 ${norm.value} 的独占编辑模式（会话 ${sessionId}，租约 ${acquired.value.expiresAt - _at()} 毫秒后到期）`,
      },
    };
  }

  /**
   * 断线清理:立即释放租约、独占模式与订阅。这是 cleanupSession 的接线点。
   *
   * @param {string} sessionId 会话标识
   * @returns {object} { ok: true, value: { releasedPaths, unsubscribed } }
   */
  function handleDisconnect(sessionId) {
    const dropped = registry.dropSession(sessionId);
    const id = dropped.value.sessionId;

    for (const state of files.values()) {
      if (state.exclusive === id) {
        state.exclusive = null;
      }

      state.sent.delete(id);
    }

    _persistRegistry();

    return {
      ok: true,
      value: {
        ...dropped.value,
        status: `释放会话 ${id} 的 ${dropped.value.releasedPaths.length} 个编辑租约与 ${dropped.value.unsubscribed.length} 个订阅`,
      },
    };
  }

  /**
   * 空闲清扫:过期租约 + 空闲会话。持续活动的会话永不被扫掉(红线 3)。
   *
   * @returns {object} { ok: true, value: { expiredLeases, idleSessions } }
   */
  function sweep() {
    const swept = registry.sweep();

    for (const expired of swept.value.expiredLeases) {
      const state = files.get(expired.path);

      if (state && state.exclusive === expired.sessionId) {
        state.exclusive = null;
      }
    }

    for (const sessionId of swept.value.idleSessions) {
      for (const state of files.values()) {
        state.sent.delete(sessionId);
      }
    }

    if (swept.value.expiredLeases.length > 0 || swept.value.idleSessions.length > 0) {
      _persistRegistry();
    }

    return {
      ok: true,
      value: {
        ...swept.value,
        status: `清扫过期编辑租约 ${swept.value.expiredLeases.length} 个、空闲会话 ${swept.value.idleSessions.length} 个`,
      },
    };
  }

  // ── 分块传输(二进制 / 超长文件)────────────────────────────────────────────
  // 这条通道与 CRDT 文本合并**并列**,不互相替代:文本合并推进版本号,分块只搬字节。
  // 全部 IO 走 readBinary / writeBinary 端口,单测注入假端口,不碰真实磁盘。

  function _chunkGate() {
    if (!chunkModule.isChunkDiffEnabled(env)) {
      return _fail(
        chunkModule.CODES.INVALID_INPUT,
        '分块传输已被 KHY_FILE_SYNC_CHUNK 关闭：二进制与超长文件请走文件锁路径',
        { fallback: 'file_lock' }
      );
    }

    return { ok: true, value: chunkModule.resolveChunkLimits(env) };
  }

  /** 读原始字节并切块。返回清单不含字节,可安全下发给客户端。 */
  function _localChunks(relPath, chunkLimits) {
    const read = _port('readBinary')(relPath);

    if (!read.ok) {
      return read;
    }

    return chunkModule.splitChunks(read.value, { limits: chunkLimits });
  }

  /**
   * 某文件的分块清单(客户端据此报告自己已持有哪些块)。
   *
   * @param {string} rawPath 客户端路径
   * @returns {object} { ok: true, value: { path, manifest, status } } 或 { ok: false, error }
   */
  function chunkManifestFor(rawPath) {
    const norm = _normalize(rawPath);

    if (!norm.ok) {
      return norm;
    }

    const gate = _chunkGate();

    if (!gate.ok) {
      return { ...gate, error: { ...gate.error, path: norm.value } };
    }

    const split = _localChunks(norm.value, gate.value);

    if (!split.ok) {
      return { ...split, error: { ...split.error, path: norm.value, fallback: 'file_lock' } };
    }

    const manifest = split.value;

    return {
      ok: true,
      value: {
        path: norm.value,
        manifest,
        status: `分块清单 ${norm.value}：${manifest.chunks.length} 块 / ${manifest.size} 字节已就绪`,
      },
    };
  }

  /**
   * 针对客户端已持有的清单生成补丁。data 指令的字节以 base64 上线 ——
   * 走 JSON 通道时原始 Buffer 会被 utf8 化,那等于静默损坏字节。
   *
   * @param {object} input { path, haveManifest }
   * @returns {object} { ok: true, value: { path, patch, plan, status } } 或 { ok: false, error }
   */
  function chunkPatchFor(input = {}) {
    const norm = _normalize(input.path);

    if (!norm.ok) {
      return norm;
    }

    const gate = _chunkGate();

    if (!gate.ok) {
      return { ...gate, error: { ...gate.error, path: norm.value } };
    }

    const read = _port('readBinary')(norm.value);

    if (!read.ok) {
      return { ...read, error: { ...read.error, path: norm.value, fallback: 'file_lock' } };
    }

    const split = chunkModule.splitChunks(read.value, { limits: gate.value });

    if (!split.ok) {
      return { ...split, error: { ...split.error, path: norm.value, fallback: 'file_lock' } };
    }

    const have = input.haveManifest || null;
    const diff = chunkModule.diffManifests(split.value, have);

    if (!diff.ok) {
      return { ...diff, error: { ...diff.error, path: norm.value } };
    }

    const patch = chunkModule.buildPatch(read.value, split.value, have);

    if (!patch.ok) {
      return { ...patch, error: { ...patch.error, path: norm.value } };
    }

    return {
      ok: true,
      value: {
        path: norm.value,
        patch: _encodePatch(patch.value),
        plan: diff.value,
        status: chunkModule.describeChunkPlan(norm.value, diff.value),
      },
    };
  }

  /** 把 data 指令的字节编成 base64,并标注编码方式。copy 指令不带字节。 */
  function _encodePatch(patch) {
    return {
      ...patch,
      instructions: patch.instructions.map((step) => {
        if (step.op !== 'data') {
          return step;
        }

        const buf = Buffer.isBuffer(step.bytes) ? step.bytes : Buffer.from(step.bytes || []);

        return { ...step, encoding: 'base64', bytes: buf.toString('base64') };
      }),
    };
  }

  /** base64 → Buffer。声明 base64 却解不出对应长度的,当坏补丁拒掉而不是写脏字节。 */
  function _decodePatch(patch) {
    if (!patch || typeof patch !== 'object' || !Array.isArray(patch.instructions)) {
      return _fail(chunkModule.CODES.INVALID_PATCH, `分块补丁无效：期望 ${chunkModule.SCHEMA} 结构的对象`);
    }

    const instructions = [];

    for (const step of patch.instructions) {
      if (!step || typeof step !== 'object' || step.op !== 'data' || step.encoding !== 'base64') {
        instructions.push(step);
        continue;
      }

      const buf = Buffer.from(String(step.bytes || ''), 'base64');

      if (Number.isSafeInteger(step.size) && buf.length !== step.size) {
        return _fail(
          chunkModule.CODES.INVALID_PATCH,
          `分块补丁 base64 解码长度不符：块 ${step.digest} 解出 ${buf.length} 字节，声明 ${step.size} 字节`,
          { digest: step.digest }
        );
      }

      instructions.push({ ...step, encoding: null, bytes: buf });
    }

    return { ok: true, value: { ...patch, instructions } };
  }

  /**
   * 落地客户端提交的分块补丁。写盘前必须过三道闸:分块门控、编辑租约归属、
   * 拼装校验(长度 + 摘要)。拼装失败一律**不写**,宁可让客户端重传整份,
   * 也不能留下半新半旧的文件。
   *
   * @param {object} input { sessionId, path, patch }
   * @returns {object} { ok: true, value: { path, size, digest, status } } 或 { ok: false, error }
   */
  function applyChunkPatch(input = {}) {
    const norm = _normalize(input.path);

    if (!norm.ok) {
      return norm;
    }

    const gate = _chunkGate();

    if (!gate.ok) {
      return { ...gate, error: { ...gate.error, path: norm.value } };
    }

    // 互斥仍归租约:分块通道绕过 CRDT,但绕不过「谁在编辑这个文件」。
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
    const holder = registry.editorOf(norm.value);

    if (holder.value && sessionId && holder.value.sessionId !== sessionId) {
      return _fail(
        registryModule.CODES.LEASE_HELD,
        `编辑租约被他人持有：${norm.value} 由会话 ${holder.value.sessionId}（编辑者 ${holder.value.editorId}）持有，分块写入被拒`,
        { path: norm.value, holderSessionId: holder.value.sessionId }
      );
    }

    const decoded = _decodePatch(input.patch);

    if (!decoded.ok) {
      return { ...decoded, error: { ...decoded.error, path: norm.value } };
    }

    // 本地块库来自当前磁盘内容:copy 指令引用的块必须在此能查到。
    const local = _localChunks(norm.value, gate.value);

    if (!local.ok) {
      return { ...local, error: { ...local.error, path: norm.value, fallback: 'file_lock' } };
    }

    const readBack = _port('readBinary')(norm.value);

    if (!readBack.ok) {
      return { ...readBack, error: { ...readBack.error, path: norm.value, fallback: 'file_lock' } };
    }

    const store = new Map();

    for (const c of local.value.chunks) {
      store.set(c.digest, readBack.value.subarray(c.offset, c.offset + c.size));
    }

    const assembled = chunkModule.applyPatch(decoded.value, store);

    if (!assembled.ok) {
      return { ...assembled, error: { ...assembled.error, path: norm.value } };
    }

    const written = _port('writeBinary')(norm.value, assembled.value.content);

    if (written && written.ok === false) {
      return { ...written, error: { ...written.error, path: norm.value, fallback: 'file_lock' } };
    }

    // 分块写入不推进 CRDT 版本,但文本侧缓存必须失效,否则下次文本合并会拿旧内容做基线。
    files.delete(norm.value);

    if (sessionId) {
      registry.acquireLease({ path: norm.value, sessionId });
      _persistRegistry();
    }

    return {
      ok: true,
      value: {
        path: norm.value,
        size: assembled.value.size,
        digest: assembled.value.digest,
        status: `分块写入 ${norm.value}：已拼装并落盘 ${assembled.value.size} 字节（${decoded.value.instructions.length} 条指令）`,
      },
    };
  }

  /**
   * 当前状态(供 doctor / 状态展示,含动作 + 目标 + 进度)。
   *
   * @returns {object} { ok: true, value: {...} }
   */
  function stats() {
    const reg = registry.stats().value;

    return {
      ok: true,
      value: {
        schema: SCHEMA,
        enabled: _enabled(),
        yjs: engine.isYjsAvailable(),
        files: files.size,
        historyLimit,
        ...reg,
        status: `文件级实时同步：跟踪 ${files.size} 个文件、${reg.sessions} 个会话、${reg.leases} 个编辑租约（历史容量 ${historyLimit}）`,
      },
    };
  }

  /**
   * 某文件的完整快照(resync 载荷)。
   *
   * @param {string} rawPath 客户端路径
   * @returns {object} { ok: true, value: event } 或 { ok: false, error }
   */
  function snapshotFor(rawPath) {
    const norm = _normalize(rawPath);

    if (!norm.ok) {
      return norm;
    }

    const file = ensureFile(norm.value);

    if (!file.ok) {
      return file;
    }

    return { ok: true, value: _resyncEvent(file.value, '客户端主动请求整份重同步') };
  }

  /**
   * 降级入口:实时合并不可用时,回落到既有 _fileLock 悲观锁 + conflictCopyPath 冲突副本。
   * 这是本特性里唯一 await 文件锁的地方(acquire 是异步的),也是 MERGE_FALLBACK 之后
   * 调用方该走的下一步。任何一层不可用都只降级、不抛、不丢数据。
   *
   * @param {object} input { path, editor, timeoutMs }
   * @returns {Promise<object>} { ok: true, value: { path, absPath, conflictCopyPath, lockAcquired, release, status } }
   */
  async function fallbackToFileLock(input = {}) {
    const norm = _normalize(input.path);

    if (!norm.ok) {
      return norm;
    }

    let fileLock = null;

    try {
      fileLock = require('../tools/_fileLock');
    } catch (err) {
      return _fail(
        engine.CODES.MERGE_FALLBACK,
        `实时合并不可用，且文件锁模块同样不可用：${(err && err.message) || err}`,
        { path: norm.value, fallback: 'file_lock' }
      );
    }

    const abs = path.resolve(projectDir, norm.value);
    const tag = typeof input.editor === 'string' && input.editor.trim()
      ? input.editor.trim().replace(/[^\w.-]+/g, '_').slice(0, 40)
      : 'file_sync';
    let conflictCopy = null;

    try {
      conflictCopy = fileLock.conflictCopyPath(abs, tag);
    } catch {
      conflictCopy = null;
    }

    let release = null;
    let lockAcquired = false;
    let detail = '';

    try {
      const held = await fileLock.acquire(abs, {
        timeoutMs: Number.isSafeInteger(input.timeoutMs) ? input.timeoutMs : undefined,
      });

      release = held && typeof held.release === 'function' ? held.release : null;
      lockAcquired = release !== null;
    } catch (err) {
      detail = (err && err.message) || String(err);
      _log('warn', `降级取锁失败：${norm.value} — ${detail}`);
    }

    return {
      ok: true,
      value: {
        path: norm.value,
        absPath: abs,
        conflictCopyPath: conflictCopy,
        lockAcquired,
        release,
        detail,
        status: lockAcquired
          ? `降级到文件锁：已锁定 ${norm.value}，冲突副本目标 ${conflictCopy || '不可用'}`
          : `降级到文件锁：${norm.value} 未取得锁（${detail || '锁被占用'}），冲突副本目标 ${conflictCopy || '不可用'}`,
      },
    };
  }

  /**
   * WebSocket 消息入口。**只**处理 file_* / subscribe_files 族,其余一律返回
   * handled:false,让既有 switch 的 default 分支照旧处理 —— 老客户端零影响。
   *
   * @param {object} session { id, authenticated }
   * @param {object} data 客户端消息
   * @returns {object} { handled: boolean, reply?: object }
   */
  function handleMessage(session, data) {
    const type = data && typeof data.type === 'string' ? data.type : '';

    if (!type.startsWith('file_') && type !== 'subscribe_files' && type !== 'unsubscribe_files') {
      return { handled: false };
    }

    const sessionId = session && session.id ? String(session.id) : '';

    if (!session || session.authenticated !== true) {
      return {
        handled: true,
        reply: {
          type: 'file_op_result',
          schema: SCHEMA,
          ok: false,
          error: {
            code: engine.CODES.UNAUTHENTICATED_SESSION,
            message: '会话未认证：请先完成 auth 再使用文件级实时同步',
          },
        },
      };
    }

    switch (type) {
      case 'subscribe_files': {
        const result = subscribeFiles({
          sessionId,
          paths: data.paths,
          lastSeenVersions: data.lastSeenVersions,
        });

        return {
          handled: true,
          reply: result.ok
            ? { type: 'file_subscribed', schema: SCHEMA, ok: true, ...result.value }
            : { type: 'file_subscribed', schema: SCHEMA, ok: false, error: result.error },
        };
      }

      case 'unsubscribe_files': {
        const result = unsubscribeFiles({ sessionId, paths: data.paths });

        return {
          handled: true,
          reply: result.ok
            ? { type: 'file_unsubscribed', schema: SCHEMA, ok: true, ...result.value }
            : { type: 'file_unsubscribed', schema: SCHEMA, ok: false, error: result.error },
        };
      }

      case 'file_op': {
        const result = submitOp({ ...data, sessionId });

        if (!result.ok) {
          const reply = {
            type: 'file_op_result',
            schema: SCHEMA,
            ok: false,
            path: data.path,
            opId: data.opId,
            error: result.error,
          };

          if (
            result.error.code === engine.CODES.HISTORY_EVICTED ||
            result.error.code === engine.CODES.BASE_VERSION_AHEAD
          ) {
            const snap = snapshotFor(data.path);

            if (snap.ok) {
              reply.resync = snap.value;
            }
          }

          return { handled: true, reply };
        }

        return {
          handled: true,
          reply: {
            type: 'file_op_result',
            schema: SCHEMA,
            ok: true,
            path: result.value.path,
            opId: result.value.opId,
            version: result.value.version,
            baseVersion: result.value.baseVersion,
            duplicate: result.value.duplicate === true,
            warnings: result.value.warnings || [],
            status: result.value.status,
          },
        };
      }

      case 'file_catch_up': {
        const result = catchUp({
          sessionId,
          path: data.path,
          lastSeenVersion: data.lastSeenVersion,
        });

        if (!result.ok) {
          return {
            handled: true,
            reply: { type: 'file_op_result', schema: SCHEMA, ok: false, error: result.error },
          };
        }

        if (result.value.resync) {
          return { handled: true, reply: result.value.resync };
        }

        return {
          handled: true,
          reply: { type: 'file_catch_up_result', schema: SCHEMA, ok: true, ...result.value },
        };
      }

      case 'file_resync_required': {
        const snap = snapshotFor(data.path);

        return {
          handled: true,
          reply: snap.ok
            ? { ok: true, ...snap.value }
            : { type: 'file_resync_required', schema: SCHEMA, ok: false, error: snap.error },
        };
      }

      case 'file_lease': {
        const result = lease({ sessionId, path: data.path, action: data.action });

        return {
          handled: true,
          reply: result.ok
            ? { type: 'file_lease_state', schema: SCHEMA, ok: true, ...result.value }
            : { type: 'file_lease_state', schema: SCHEMA, ok: false, error: result.error },
        };
      }

      case 'file_chunk_manifest': {
        const result = chunkManifestFor(data.path);

        return {
          handled: true,
          reply: result.ok
            ? { type: 'file_chunk_plan', schema: SCHEMA, ok: true, ...result.value }
            : { type: 'file_chunk_plan', schema: SCHEMA, ok: false, error: result.error },
        };
      }

      case 'file_chunk_request': {
        const result = chunkPatchFor({ path: data.path, haveManifest: data.haveManifest });

        return {
          handled: true,
          reply: result.ok
            ? { type: 'file_chunk_patch', schema: SCHEMA, ok: true, ...result.value }
            : { type: 'file_chunk_patch', schema: SCHEMA, ok: false, error: result.error },
        };
      }

      case 'file_chunk_patch': {
        const result = applyChunkPatch({ sessionId, path: data.path, patch: data.patch });

        return {
          handled: true,
          reply: result.ok
            ? { type: 'file_chunk_result', schema: SCHEMA, ok: true, ...result.value }
            : { type: 'file_chunk_result', schema: SCHEMA, ok: false, error: result.error },
        };
      }

      case 'file_lock': {
        const result = lock({ sessionId, path: data.path, action: data.action });

        return {
          handled: true,
          reply: result.ok
            ? { type: 'file_lock_state', schema: SCHEMA, ok: true, ...result.value }
            : { type: 'file_lock_state', schema: SCHEMA, ok: false, error: result.error },
        };
      }

      default:
        return {
          handled: true,
          reply: {
            type: 'file_op_result',
            schema: SCHEMA,
            ok: false,
            error: {
              code: 'UNKNOWN_FILE_SYNC_TYPE',
              message: `未知的文件同步消息类型："${type}"，本实例支持 subscribe_files / unsubscribe_files / file_op / file_catch_up / file_lease / file_lock / file_chunk_manifest / file_chunk_request / file_chunk_patch`,
            },
          },
        };
    }
  }

  return {
    SCHEMA,
    registry,
    ensureFile,
    registerSession,
    restoreRegistry,
    syncRegistry,
    instanceId,
    subscribeFiles,
    unsubscribeFiles,
    catchUp,
    submitOp,
    lease,
    lock,
    fallbackToFileLock,
    handleDisconnect,
    sweep,
    stats,
    snapshotFor,
    chunkManifestFor,
    chunkPatchFor,
    applyChunkPatch,
    handleMessage,
    _files: files,
  };
}

module.exports = { SCHEMA, createBus, createDefaultPorts };
