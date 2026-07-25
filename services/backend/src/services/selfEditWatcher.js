'use strict';

/**
 * selfEditWatcher.js —— 外部编辑器直改 khy 源码的监视器**壳**(IO;非纯叶子)。
 *
 * 用户诉求的「同时监听外部编辑器直改」一环:AI 用 khy 自己的编辑工具改 khy 源码由
 * toolUseLoop 的工具路径(§2)当场反馈;但人用 VS Code / vim 等**外部编辑器**直改磁盘时,
 * 工具路径看不到 —— 本监视器用 Node 内建 fs.watch 捕获这类变更,复用同一 selfEditAdvisory
 * 编排产出反馈,交生命周期壳(App.js / repl.js)按面投递(人 = TUI notice / REPL console,
 * AI 下一轮 = btwNoteQueue)。
 *
 * 模型 = credentialWatcherService:fs.watch 实时 + 1500ms 去抖 + SHA-256 内容哈希去重
 * (fs.watch 会因元数据 touch 误报)+ 出错 5s 重建。无第三方依赖(仓库无 chokidar)。
 *
 * 诚实边界:
 *   - 只监视 khy monorepo 的镜像源根(services/backend/src、docs、kernel/alpine),且仅当
 *     detectKhyRepoRoot 严格标记确认。非 khy 工程 → start 直接返回,零监视。
 *   - §4 去重:wasRecentlyToolEdited 命中(khy 工具刚写过)→ 跳过,避免与工具路径双重提示。
 *   - fail-open:任何 fs.watch 错误 5s 重建,绝不阻塞或崩会话。
 *   - 门控 KHY_SELF_EDIT_WATCH(子闸)或 KHY_SELF_EDIT_ADVISORY(总闸)关 → 不启动 = 今日行为。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const leaf = require('./selfEditAdvisory');
const svc = require('./selfEditAdvisoryService');

const DEBOUNCE_MS = 1500;
const POLL_INTERVAL_MS = 30_000;
// 监视的源根(相对仓库根)。services/backend 只盯 src(避开 node_modules / bundled)。
const WATCH_DIRS = ['services/backend/src', 'docs', 'kernel/alpine'];

let _started = false;
let _root = null;
let _onAdvisory = null;
/** @type {fs.FSWatcher[]} */
let _watchers = [];
let _pollTimer = null;
/** absPath → { hash, debounce } —— 内容哈希去重 + 去抖。 */
const _fileState = new Map();

function _sha256(buf) {
  try { return crypto.createHash('sha256').update(buf).digest('hex'); } catch { return ''; }
}

/** 读文件哈希;失败 → ''(当作变更/无法判定,交编排 fail-soft)。 */
function _hashFile(abs) {
  try { return _sha256(fs.readFileSync(abs)); } catch { return ''; }
}

/** 处理一次(去抖后)文件变更:去重 → §4 跳过工具写 → 编排 → 投递。永不抛。 */
function _handleChange(abs) {
  try {
    // §4:khy 工具刚写过 → 工具路径已反馈,跳过(避免双重提示)。
    if (svc.wasRecentlyToolEdited(abs)) return;
    // 内容哈希去重:元数据 touch / 无实质变更 → 静默。
    const st = _fileState.get(abs) || {};
    const h = _hashFile(abs);
    if (h && st.hash === h) return;
    st.hash = h;
    _fileState.set(abs, st);
    const adv = svc.emitForPath(abs, { cwd: _root });
    if (adv && typeof _onAdvisory === 'function') _onAdvisory(adv);
  } catch {
    /* fail-open:单次处理错误绝不影响监视 */
  }
}

/** 去抖包装:同一文件 1500ms 内多次事件合并为一次处理。 */
function _debouncedChange(abs) {
  const st = _fileState.get(abs) || {};
  if (st.debounce) clearTimeout(st.debounce);
  st.debounce = setTimeout(() => {
    const cur = _fileState.get(abs) || {};
    cur.debounce = null;
    _fileState.set(abs, cur);
    _handleChange(abs);
  }, DEBOUNCE_MS);
  // setTimeout 不 ref 住进程退出。
  if (st.debounce && typeof st.debounce.unref === 'function') st.debounce.unref();
  _fileState.set(abs, st);
}

/** 为单个目录建 recursive watch,出错 5s 重建。 */
function _watchDir(absDir) {
  let watcher = null;
  try {
    watcher = fs.watch(absDir, { persistent: false, recursive: true }, (_event, filename) => {
      if (!filename) return;
      try {
        const abs = path.resolve(absDir, filename);
        const rel = svc.toRepoRel(abs, _root);
        if (!rel) return;
        // 只对镜像源文件反应(排除 bundled/、测试文件等)。
        if (!leaf.isMirroredSourcePath(rel).mirrored) return;
        _debouncedChange(abs);
      } catch { /* per-event fail-open */ }
    });
    watcher.on('error', () => {
      try { watcher && watcher.close(); } catch { /* ignore */ }
      _watchers = _watchers.filter((w) => w !== watcher);
      // 5s 后重建(仍在运行时)。
      const t = setTimeout(() => { if (_started) _addWatcher(absDir); }, 5000);
      if (typeof t.unref === 'function') t.unref();
    });
    _watchers.push(watcher);
  } catch {
    /* 建 watch 失败(目录不存在等)→ 跳过该目录,不阻塞其余 */
  }
}

function _addWatcher(absDir) {
  try {
    if (fs.existsSync(absDir)) _watchDir(absDir);
  } catch { /* ignore */ }
}

/** 轮询兜底:覆盖 NFS / 容器 / fs.watch 盲区。仅对已知 state 的文件重算哈希。 */
function _startPoll() {
  _pollTimer = setInterval(() => {
    if (!_started) return;
    try {
      for (const abs of [..._fileState.keys()]) {
        const st = _fileState.get(abs) || {};
        const h = _hashFile(abs);
        if (h && st.hash && st.hash !== h) _debouncedChange(abs);
      }
    } catch { /* poll fail-open */ }
  }, POLL_INTERVAL_MS);
  if (_pollTimer && typeof _pollTimer.unref === 'function') _pollTimer.unref();
}

/**
 * 启动监视器。仅当门控开 + root 是 khy monorepo 时真正启动。永不抛。
 * @param {object} p
 * @param {string} p.root      仓库根(通常来自 detectKhyRepoRoot)
 * @param {(adv:{humanLine:string,aiNote:string})=>void} p.onAdvisory
 * @returns {boolean}  是否真正启动
 */
function start(p = {}) {
  try {
    if (_started) return true;
    if (!leaf.selfEditAdvisoryEnabled(process.env)) return false; // 总闸关
    if (!leaf.selfEditWatchEnabled(process.env)) return false;    // 子闸关
    const root = p && p.root;
    if (!root) return false;
    _root = root;
    _onAdvisory = typeof p.onAdvisory === 'function' ? p.onAdvisory : null;
    _started = true;
    for (const rel of WATCH_DIRS) _addWatcher(path.join(root, rel));
    _startPoll();
    return true;
  } catch {
    _started = false;
    return false;
  }
}

/** 停止监视器,清 watcher / 去抖 / 轮询。永不抛。 */
function stop() {
  try {
    _started = false;
    for (const w of _watchers) { try { w.close(); } catch { /* ignore */ } }
    _watchers = [];
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    for (const st of _fileState.values()) {
      if (st && st.debounce) { try { clearTimeout(st.debounce); } catch { /* ignore */ } }
    }
    _fileState.clear();
    _root = null;
    _onAdvisory = null;
  } catch { /* ignore */ }
}

function isRunning() {
  return _started;
}

module.exports = { start, stop, isRunning };
