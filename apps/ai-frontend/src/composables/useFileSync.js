import { ref, computed } from 'vue';
import request from '@/api/request';

/**
 * File-level realtime sync client ("共享开发实时更新") for the `file_*` WebSocket
 * event family served by services/backend/src/services/file_sync_bus.js (T-008).
 *
 * Wire contract (schema `khy-file-sync/1`) — the client half of it:
 *   → subscribe_files   { paths, lastSeenVersions }
 *   → file_op           { path, opId, baseVersion, operations }
 *   → file_catch_up     { path, lastSeenVersion }
 *   → file_lease        { path, action: acquire|renew|release }
 *   ← file_subscribed / file_op_result / file_changed / file_resync_required
 *   ← file_catch_up_result / file_lease_state / file_lock_state
 *
 * Design notes:
 *  - The reducer (`applyEvent`) is a pure function over a plain state object, so
 *    ordering, dedup and eviction behaviour are unit-testable without a socket.
 *  - Every op declares `baseVersion`; we never guess. On MERGE_CONFLICT the local
 *    text is left untouched and the caller decides (retry rebased, or degrade).
 *  - Reconnect replays `lastSeenVersions`, so the server sends only the missing
 *    increments; a `resync` payload wins over increments and resets the baseline.
 *  - Lease renewal is activity-based: we push the lease on local edits rather
 *    than on a fixed timer that would hard-kill a slow editor.
 */

export const FILE_SYNC_SCHEMA = 'khy-file-sync/1';

// Server-side reply types this client understands. Anything else is ignored so a
// newer backend can add events without breaking an older frontend.
const KNOWN_TYPES = [
  'file_subscribed',
  'file_unsubscribed',
  'file_op_result',
  'file_changed',
  'file_resync_required',
  'file_catch_up_result',
  'file_lease_state',
  'file_lock_state',
];

export function isFileSyncMessage(msg) {
  const type = msg && typeof msg.type === 'string' ? msg.type : '';
  return KNOWN_TYPES.includes(type);
}

// Mirror KhyOsTerminal.vue's resolveWsUrl so every view shares the /ws endpoint
// and its origin/baseURL derivation instead of hardcoding a host or port.
export function resolveWsUrl(path) {
  const normalizedPath = `/${String(path || '/ws').replace(/^\/+/, '')}`;
  if (typeof window === 'undefined') return normalizedPath;
  const origin = String(window.location.origin || '').trim();
  const base = String(request.defaults.baseURL || '').trim();
  const url = base ? new URL(base, origin) : new URL(origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = normalizedPath;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * Apply one text operation batch to a string. Mirrors the server's operation
 * vocabulary: `{ insert, position }` and `{ delete, position }` / `{ range }`.
 * Positions refer to the text *before* this batch, so we apply right-to-left to
 * keep earlier offsets valid.
 */
export function applyOperations(text, operations) {
  const ops = Array.isArray(operations) ? operations.slice() : [];
  let out = String(text == null ? '' : text);

  const ordered = ops
    .map((op, i) => ({ op, i }))
    .sort((a, b) => {
      const pa = positionOf(a.op);
      const pb = positionOf(b.op);
      if (pa !== pb) return pb - pa;
      return b.i - a.i;
    });

  for (const { op } of ordered) {
    if (!op || typeof op !== 'object') continue;
    const at = positionOf(op);
    if (at < 0 || at > out.length) continue;

    if (typeof op.insert === 'string') {
      out = out.slice(0, at) + op.insert + out.slice(at);
      continue;
    }

    const len = deleteLengthOf(op);
    if (len > 0) out = out.slice(0, at) + out.slice(at + len);
  }

  return out;
}

function positionOf(op) {
  if (!op || typeof op !== 'object') return -1;
  if (Number.isInteger(op.position)) return op.position;
  if (op.range && Number.isInteger(op.range.start)) return op.range.start;
  return -1;
}

function deleteLengthOf(op) {
  if (!op || typeof op !== 'object') return 0;
  if (Number.isInteger(op.delete) && op.delete > 0) return op.delete;
  if (typeof op.delete === 'string') return op.delete.length;
  if (op.range && Number.isInteger(op.range.start) && Number.isInteger(op.range.end)) {
    return Math.max(0, op.range.end - op.range.start);
  }
  return 0;
}

export function createFileState(path) {
  return {
    path: String(path || ''),
    text: '',
    version: 0,
    subscribed: false,
    seenOpIds: [],
    lease: null,
    lockedBy: null,
    lastError: null,
    resyncedAt: null,
  };
}

// Bounded dedup ring: an opId we already applied must never be applied twice,
// but the list must not grow without limit on a long editing session.
const SEEN_LIMIT = 512;

function rememberOp(file, opId) {
  const id = String(opId || '');
  if (!id) return false;
  if (file.seenOpIds.includes(id)) return true;
  file.seenOpIds.push(id);
  if (file.seenOpIds.length > SEEN_LIMIT) {
    file.seenOpIds.splice(0, file.seenOpIds.length - SEEN_LIMIT);
  }
  return false;
}

/**
 * Pure reducer: fold one server event into the file map. Returns
 * `{ ok:true, value:{ changed, files } }` or `{ ok:false, error }` — fail-soft,
 * never throws, so a malformed frame from a newer backend cannot break the view.
 *
 * @param {object} files  path → file state (mutated in place, also returned)
 * @param {object} msg    a decoded `file_*` frame
 */
export function applyEvent(files, msg) {
  if (!files || typeof files !== 'object') {
    return { ok: false, error: { code: 'INVALID_STATE', message: '同步状态表不可用' } };
  }
  if (!isFileSyncMessage(msg)) {
    return { ok: false, error: { code: 'UNKNOWN_EVENT', message: '未识别的同步事件，已忽略' } };
  }

  const type = msg.type;

  if (type === 'file_subscribed') {
    if (msg.ok !== true) return failEvent(msg);
    for (const entry of Array.isArray(msg.results) ? msg.results : []) {
      const path = String(entry && entry.path ? entry.path : '');
      if (!path) continue;
      const file = files[path] || (files[path] = createFileState(path));

      if (entry.ok === false) {
        file.lastError = entry.error || null;
        continue;
      }

      file.subscribed = true;
      file.lastError = null;

      // A resync payload supersedes increments: it carries the authoritative
      // text plus the version it belongs to.
      if (entry.resync) {
        adoptResync(file, entry.resync);
        continue;
      }
      if (Number.isInteger(entry.version) && entry.version > file.version && !entry.increments) {
        file.version = entry.version;
        if (typeof entry.text === 'string') file.text = entry.text;
      }
      for (const inc of Array.isArray(entry.increments) ? entry.increments : []) {
        adoptChange(file, inc);
      }
    }
    return { ok: true, value: { changed: true, files } };
  }

  if (type === 'file_unsubscribed') {
    for (const path of Array.isArray(msg.paths) ? msg.paths : []) {
      const file = files[String(path)];
      if (file) file.subscribed = false;
    }
    return { ok: true, value: { changed: true, files } };
  }

  if (type === 'file_changed') {
    const file = fileFor(files, msg.path);
    if (!file) return { ok: false, error: { code: 'INVALID_PATH', message: '事件缺少文件路径' } };
    const applied = adoptChange(file, msg);
    return { ok: true, value: { changed: applied, files } };
  }

  if (type === 'file_resync_required') {
    const file = fileFor(files, msg.path);
    if (!file) return { ok: false, error: { code: 'INVALID_PATH', message: '事件缺少文件路径' } };
    if (msg.ok === false) return failEvent(msg);
    adoptResync(file, msg);
    return { ok: true, value: { changed: true, files } };
  }

  if (type === 'file_catch_up_result') {
    const file = fileFor(files, msg.path);
    if (!file) return { ok: false, error: { code: 'INVALID_PATH', message: '事件缺少文件路径' } };
    if (msg.resync) {
      adoptResync(file, msg.resync);
      return { ok: true, value: { changed: true, files } };
    }
    let changed = false;
    for (const inc of Array.isArray(msg.increments) ? msg.increments : []) {
      if (adoptChange(file, inc)) changed = true;
    }
    return { ok: true, value: { changed, files } };
  }

  if (type === 'file_op_result') {
    const file = fileFor(files, msg.path);
    if (!file) return { ok: false, error: { code: 'INVALID_PATH', message: '事件缺少文件路径' } };

    if (msg.ok === true) {
      // Our own accepted op: remember the version, and the opId so the broadcast
      // echo of the very same batch is not applied a second time.
      rememberOp(file, msg.opId);
      if (Number.isInteger(msg.version) && msg.version > file.version) file.version = msg.version;
      file.lastError = null;
      return { ok: true, value: { changed: true, files } };
    }

    file.lastError = msg.error || null;
    if (msg.resync) adoptResync(file, msg.resync);
    return { ok: true, value: { changed: Boolean(msg.resync), files } };
  }

  if (type === 'file_lease_state') {
    const file = fileFor(files, msg.path);
    if (!file) return { ok: false, error: { code: 'INVALID_PATH', message: '事件缺少文件路径' } };
    file.lease = msg.ok === true ? msg.lease || null : null;
    if (msg.ok !== true) file.lastError = msg.error || null;
    return { ok: true, value: { changed: true, files } };
  }

  // file_lock_state — the degradation path is authoritative about who holds the
  // pessimistic lock, so surface it rather than silently continuing to merge.
  const file = fileFor(files, msg.path);
  if (!file) return { ok: false, error: { code: 'INVALID_PATH', message: '事件缺少文件路径' } };
  file.lockedBy = msg.ok === true ? msg.lock || null : null;
  if (msg.ok !== true) file.lastError = msg.error || null;
  return { ok: true, value: { changed: true, files } };
}

function fileFor(files, rawPath) {
  const path = String(rawPath == null ? '' : rawPath);
  if (!path) return null;
  return files[path] || (files[path] = createFileState(path));
}

function failEvent(msg) {
  return {
    ok: false,
    error: msg.error || { code: 'EVENT_FAILED', message: '同步事件被服务端拒绝' },
  };
}

// Fold one `file_changed`-shaped increment. Returns false when it was a duplicate
// or an out-of-order frame we must not apply (the caller then asks for catch-up).
function adoptChange(file, event) {
  if (!event || typeof event !== 'object') return false;
  if (!Number.isInteger(event.version)) return false;
  if (event.version <= file.version) return false;
  if (rememberOp(file, event.opId)) return false;

  // Gap detected: this increment does not build on what we hold. Do not apply a
  // partial edit — leave the text alone and let the caller catch up by version.
  if (Number.isInteger(event.baseVersion) && event.baseVersion > file.version) {
    file.lastError = {
      code: 'VERSION_GAP',
      message: `增量缺口：${file.path} 本地 v${file.version}，收到基于 v${event.baseVersion} 的批次，需要补齐`,
    };
    return false;
  }

  file.text = applyOperations(file.text, event.operations);
  file.version = event.version;
  file.lastError = null;
  return true;
}

function adoptResync(file, event) {
  if (!event || typeof event !== 'object') return;
  if (typeof event.text === 'string') file.text = event.text;
  if (Number.isInteger(event.version)) file.version = event.version;
  file.seenOpIds = [];
  file.lastError = null;
  file.resyncedAt = event.timestamp || null;
}

/**
 * Build the `subscribe_files` frame, carrying every version we already hold so a
 * reconnect gets increments instead of a full resend.
 */
export function buildSubscribeFrame(files, paths) {
  const list = (Array.isArray(paths) ? paths : []).map((p) => String(p || '')).filter(Boolean);
  const lastSeenVersions = {};

  for (const path of list) {
    const file = files && files[path];
    if (file && Number.isInteger(file.version) && file.version > 0) {
      lastSeenVersions[path] = file.version;
    }
  }

  return { type: 'subscribe_files', paths: list, lastSeenVersions };
}

let opCounter = 0;

// Deterministic-enough client op id. crypto.randomUUID when available; otherwise a
// counter + time suffix, which is still unique per session and is what the server
// dedups on.
function nextOpId(sessionTag) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  opCounter += 1;
  return `${sessionTag || 'client'}-${opCounter}-${Date.now().toString(36)}`;
}

/**
 * Vue-facing wrapper. `send` is injected so a view can hand in its existing
 * authenticated `/ws` socket instead of this composable opening a second one —
 * the backend keys leases and subscriptions by WS session id, so reusing the
 * view's socket is what keeps the lease attached to the right session.
 *
 * @param {object} options { send, sessionTag }
 */
export function useFileSync(options = {}) {
  const files = ref({});
  const connected = ref(false);
  const lastError = ref(null);
  const sessionTag = String(options.sessionTag || 'ai-frontend');

  let sender = typeof options.send === 'function' ? options.send : null;

  const subscribedPaths = computed(() =>
    Object.keys(files.value)
      .filter((p) => files.value[p] && files.value[p].subscribed)
      .sort()
  );

  // 状态文本遵循「动作 + 目标 + 进度」：不使用「正在工作 / 处理中 / Loading」。
  const statusText = computed(() => {
    const paths = subscribedPaths.value;
    if (!connected.value) return '等待接入实时同步通道（未连接）';
    if (paths.length === 0) return '已接入实时同步通道，尚未订阅文件（0 个）';
    const versions = paths.map((p) => `${p} v${files.value[p].version}`);
    return `同步 ${paths.length} 个文件：${versions.join('、')}`;
  });

  function attach(send) {
    sender = typeof send === 'function' ? send : null;
    connected.value = Boolean(sender);
    return connected.value;
  }

  function detach() {
    sender = null;
    connected.value = false;
    // Leases are released server-side on disconnect; mirror that locally so the
    // UI never shows a stale "you hold the lease" badge.
    for (const path of Object.keys(files.value)) {
      files.value[path].lease = null;
      files.value[path].subscribed = false;
    }
  }

  function emit(frame) {
    if (!sender) {
      lastError.value = { code: 'NOT_CONNECTED', message: '实时同步通道未连接，操作未发出' };
      return { ok: false, error: lastError.value };
    }
    try {
      sender(frame);
      return { ok: true, value: frame };
    } catch (err) {
      lastError.value = {
        code: 'SEND_FAILED',
        message: `发送 ${frame.type} 失败：${err && err.message ? err.message : '通道异常'}`,
      };
      return { ok: false, error: lastError.value };
    }
  }

  function subscribe(paths) {
    const frame = buildSubscribeFrame(files.value, paths);
    for (const path of frame.paths) {
      if (!files.value[path]) files.value[path] = createFileState(path);
    }
    return emit(frame);
  }

  function unsubscribe(paths) {
    const list = (Array.isArray(paths) ? paths : [paths]).map((p) => String(p || '')).filter(Boolean);
    return emit({ type: 'unsubscribe_files', paths: list });
  }

  /**
   * Submit an edit batch. `baseVersion` is always the version we actually hold —
   * never a guess — so the server can reject a stale base instead of last-writer-
   * wins overwriting someone else's work.
   */
  function submitOps(path, operations) {
    const key = String(path || '');
    const file = files.value[key] || (files.value[key] = createFileState(key));
    const opId = nextOpId(sessionTag);

    // Activity-based lease renewal: local editing is the activity signal.
    if (file.lease) renewLease(key);

    return emit({
      type: 'file_op',
      path: key,
      opId,
      baseVersion: file.version,
      operations: Array.isArray(operations) ? operations : [operations],
    });
  }

  function catchUp(path) {
    const key = String(path || '');
    const file = files.value[key];
    return emit({
      type: 'file_catch_up',
      path: key,
      lastSeenVersion: file && Number.isInteger(file.version) ? file.version : 0,
    });
  }

  function requestResync(path) {
    return emit({ type: 'file_resync_required', path: String(path || '') });
  }

  function acquireLease(path) {
    return emit({ type: 'file_lease', path: String(path || ''), action: 'acquire' });
  }

  function renewLease(path) {
    return emit({ type: 'file_lease', path: String(path || ''), action: 'renew' });
  }

  function releaseLease(path) {
    return emit({ type: 'file_lease', path: String(path || ''), action: 'release' });
  }

  /**
   * Feed a decoded `/ws` frame in. Returns false when the frame is not ours, so
   * the host view can fall through to its own switch — this is what keeps
   * terminal streams, desktop frames and task polling untouched.
   */
  function handleMessage(msg) {
    if (!isFileSyncMessage(msg)) return false;

    const result = applyEvent(files.value, msg);

    if (!result.ok) {
      lastError.value = result.error;
      return true;
    }

    // A detected gap resolves itself by asking for the missing increments rather
    // than by re-downloading the whole document.
    const path = String(msg.path || '');
    const file = path ? files.value[path] : null;
    if (file && file.lastError && file.lastError.code === 'VERSION_GAP') catchUp(path);

    return true;
  }

  return {
    files,
    connected,
    lastError,
    subscribedPaths,
    statusText,
    attach,
    detach,
    subscribe,
    unsubscribe,
    submitOps,
    catchUp,
    requestResync,
    acquireLease,
    renewLease,
    releaseLease,
    handleMessage,
  };
}

export default useFileSync;
