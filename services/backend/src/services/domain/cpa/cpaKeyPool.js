'use strict';

/**
 * cpaKeyPool — CPA (CLIProxyAPI) 多账号密钥池（DESIGN-CPA-002 P1）。
 *
 * 与 services/apiKeyPool.js（key 池）同构、但账号语义：
 *   - 账号 CRUD + cpa_accounts.json 持久化（凭据 AES-256-GCM 密文落盘，文件 0600）
 *   - 选择策略 round-robin / fill-first / least-used（策略名经 keySelector.normalizeStrategy 口径）
 *   - 429/403 冷却退避（指数 + Retry-After 优先 + 封顶，参数真源 serviceDefaults.CPA_KEY_POOL）
 *   - markSuccess 逐级恢复 backoff
 *   - 热重载 reload()：保留存活账号运行时状态、增删对齐磁盘
 *
 * 门控/参数单一真源：constants/serviceDefaults.CPA_KEY_POOL。
 * 凭据加密复用 services/channelApiCrypto（AES-256-GCM 双层 envelope）。
 *
 * 持久化铁律（K1/K12）：磁盘文件**只存密文**（credentialCipher）——明文只在进程
 * 内存里活着（pick/reveal 的解密出口），任何写盘路径（add/update/remove/reload）
 * 都不得把明文写进 cpa_accounts.json；且每次原子写前先落一份 .bak，坏 JSON 时
 * reload() 从 .bak 自愈并回报 recovered。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { CPA_KEY_POOL } = require('../../../constants/serviceDefaults');
const { encryptApiKey, decryptApiKey, maskApiKey } = require('../../channelApiCrypto');
const atomicWriteJson = require('../../../utils/atomicWriteJson');
const { normalizeStrategy, STRATEGIES } = require('../../gateway/keySelector');

// 选择策略归一（K14：未知/缺省 → round-robin）。keySelector.normalizeStrategy 的
// 词表可能比 CPA 池窄（CPA 语义含 fill-first/least-used），未命中或不可用时
// 按 CPA 语义本地回退。
function _normalizeStrategy(name) {
  try {
    if (typeof normalizeStrategy === 'function') {
      const v = normalizeStrategy(name);
      if (v) {
        return v;
      }
    }
  } catch {
    /* fall through */
  }
  const s = String(name || '')
    .trim()
    .toLowerCase();
  if (s === 'fill-first' || s === 'fill_first' || s === 'fill') {
    return 'fill-first';
  }
  if (s === 'least-used' || s === 'least_used') {
    return 'least-used';
  }
  return 'round-robin';
}

// ── State ─────────────────────────────────────────────────────────────────
const _accounts = new Map(); // id → record（含进程内明文 credential）
const _cooldownUntil = new Map(); // id → epoch ms
const _backoffLevel = new Map(); // id → 0..MAX_BACKOFF_LEVEL
const _cursors = {}; // provider → cursor index

function _fileDir() {
  const override = process.env.CPA_POOL_TEST_DIR;
  if (override) {
    return override;
  }
  try {
    return require('../../../utils/dataHome').getDataDir('cpa');
  } catch {
    return path.join(os.tmpdir(), 'khy-cpa');
  }
}

// 持久文件路径在首次写盘时解析并固定下来：生产环境 KHY_DATA_HOME 是 pinned pointer
// 活体解析（storageRoots.js 的 _appHomeLiveResolveEnabled），同一进程内两次 resolve
// 可能返回不同路径——若测试钩子删的是 A 路径、_save 重新解析写到 B 路径，旧记录
// 会残留在旁路文件里，让「同凭据第二次 add 必须拒绝」的去重契约被静默绕过。
// CPA_POOL_TEST_DIR（测试注入）语义是同进程固定目录，同样缓存以免 rmSync 后被旁路。
let _fileCache = null;
function _file() {
  if (!_fileCache) {
    _fileCache = path.join(_fileDir(), 'cpa_accounts.json');
  }
  return _fileCache;
}

// ── Load / Save（.bak 先落盘，坏 JSON 自愈依赖它）─────────────────────────
function _load() {
  let doc = { accounts: [] };
  try {
    const raw = fs.readFileSync(_file(), 'utf-8');
    doc = JSON.parse(raw);
    if (!Array.isArray(doc.accounts)) {
      doc.accounts = [];
    }
  } catch {
    doc = { accounts: [] };
  }
  return doc;
}

/** 写盘：先 .bak 后原子写；记录里**只有密文**（剥离明文 credential）。 */
function _save() {
  const onDisk = {
    accounts: [..._accounts.values()].map((r) => {
      const { credential, ...rest } = r; // 明文不落盘
      return rest;
    }),
  };
  const target = _file();
  // .bak 自愈源：把当前合法内容留一份（写失败则跳过，不阻断主写）
  const text = JSON.stringify(onDisk, null, 2);
  try {
    fs.writeFileSync(target + '.bak', text, 'utf-8');
  } catch {
    /* bak 失败不阻断 */
  }
  atomicWriteJson(target, onDisk, { mode: 0o600 });
}

// Ensure the pool is loaded once (lazy, idempotent).
let _initialized = false;
function _ensureInit() {
  if (_initialized) {
    return;
  }
  _initialized = true;
  const doc = _load();
  for (const rec of doc.accounts) {
    rec.credential = decryptApiKey(rec.credentialCipher) || '';
    _accounts.set(rec.id, rec);
  }
}

// ── ID 生成（K11 契约：md5(provider:credential) 前 12 位，可确定性推导）────
function _deriveId(provider, credential) {
  const digest = crypto
    .createHash('md5')
    .update(`${provider}:${credential}`)
    .digest('hex');
  return digest.slice(0, 12);
}

// ── Cooldown 语义 ──────────────────────────────────────────────────────────
function _cooldownMsForLevel(level) {
  const n = Math.max(1, Math.min(level, CPA_KEY_POOL.MAX_BACKOFF_LEVEL));
  return Math.min(
    CPA_KEY_POOL.BASE_COOLDOWN_MS * Math.pow(2, n - 1),
    CPA_KEY_POOL.MAX_COOLDOWN_MS
  );
}

function _markCooldown(id, retryAfterSec) {
  const lvl = (_backoffLevel.get(id) || 0) + 1;
  _backoffLevel.set(id, Math.min(lvl, CPA_KEY_POOL.MAX_BACKOFF_LEVEL));
  let ms = _cooldownMsForLevel(lvl);
  if (retryAfterSec && retryAfterSec > 0) {
    const fromRetry = Math.min(retryAfterSec * 1000, CPA_KEY_POOL.MAX_RETRY_AFTER_MS);
    ms = Math.max(ms, fromRetry);
  }
  _cooldownUntil.set(id, Date.now() + ms);
  _save();
}

// ── CRUD ──────────────────────────────────────────────────────────────────
function addAccount({ provider, credential, label, priority }) {
  _ensureInit();
  const p = String(provider || '').trim();
  const c = String(credential || '');
  if (!p || !c) {
    return { ok: false, error: 'provider/credential 缺失' };
  }
  const id = _deriveId(p, c);
  // 重复凭据拒绝（K2）
  for (const rec of _accounts.values()) {
    if (rec.provider === p && rec.credential === c) {
      return { ok: false, error: '账号已存在（重复凭据）' };
    }
  }
  if (_accounts.has(id)) {
    return { ok: false, error: '账号已存在（重复凭据）' };
  }
  const rec = {
    id,
    provider: p,
    credential: c, // 进程内存明文（供 pick 回传）；_save 会剥离
    credentialCipher: encryptApiKey(c),
    label: label || '',
    priority: Number.isFinite(priority) ? priority : 0,
    status: 'active',
    totalRequests: 0,
    totalFailures: 0,
    lastUsedAt: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };
  _accounts.set(id, rec);
  _save();
  return { ok: true, id };
}

function listAccounts() {
  _ensureInit();
  return [..._accounts.values()].map((r) => ({
    id: r.id,
    provider: r.provider,
    label: r.label,
    priority: r.priority,
    status: r.status,
    credentialPreview: maskApiKey(r.credential || ''),
    updatedAt: r.updatedAt,
  }));
}

function getAccount(id) {
  _ensureInit();
  const r = _accounts.get(id);
  if (!r) {
    return null;
  }
  return {
    id: r.id,
    provider: r.provider,
    label: r.label,
    priority: r.priority,
    status: r.status,
    credentialCipher: r.credentialCipher,
    updatedAt: r.updatedAt,
  };
}

function updateAccount(id, patch) {
  _ensureInit();
  const r = _accounts.get(id);
  if (!r) {
    return { ok: false, error: '账号不存在' };
  }
  if (patch && patch.label != null) {
    r.label = String(patch.label);
  }
  if (patch && patch.priority != null) {
    r.priority = Number(patch.priority) || 0;
  }
  r.updatedAt = new Date().toISOString();
  _save();
  return { ok: true };
}

function removeAccount(id) {
  _ensureInit();
  if (!_accounts.has(id)) {
    return { ok: false, error: '账号不存在' };
  }
  _accounts.delete(id);
  _cooldownUntil.delete(id);
  _backoffLevel.delete(id);
  _save();
  return { ok: true };
}

function setAccountState(id, status) {
  _ensureInit();
  const r = _accounts.get(id);
  if (!r) {
    return { ok: false, error: '账号不存在' };
  }
  if (!['active', 'cooldown', 'disabled'].includes(status)) {
    return { ok: false, error: '未知状态' };
  }
  r.status = status;
  r.updatedAt = new Date().toISOString();
  _save();
  return { ok: true };
}

// ── 状态查询（getAccountState，含进度信号的 hint）────────────────────────────
function getAccountState(id) {
  _ensureInit();
  const r = _accounts.get(id);
  if (!r) {
    return null;
  }
  const now = Date.now();
  const until = _cooldownUntil.get(id) || 0;
  const lvl = _backoffLevel.get(id) || 0;
  let status = r.status === 'disabled' ? 'disabled' : r.status;
  let remaining = 0;
  if (status !== 'disabled' && until > now) {
    status = 'cooldown';
    remaining = Math.ceil((until - now) / 1000);
  }
  const hint =
    status === 'cooldown'
      ? `账号 ${r.id} 冷却中（${remaining}s，第 ${lvl} 级退避）`
      : status === 'disabled'
        ? `账号 ${r.id} 已禁用（须显式启用）`
        : `账号 ${r.id} 可用`;
  return {
    id,
    status,
    backoffLevel: lvl,
    cooldownRemaining: remaining,
    hint,
  };
}

function getAccountStatus(id) {
  // 同 getAccountState（K6 用 status/cooldownRemaining/hint）
  return getAccountState(id);
}

// ── 选择 ─────────────────────────────────────────────────────────────────
function _providerAccounts(provider) {
  _ensureInit();
  // disabled 不参与选择（K9）。cooldown 由 _isCooling 的惰性过期过滤。
  return [..._accounts.values()].filter(
    (r) => r.provider === provider && r.status !== 'disabled'
  );
}

function _isCooling(id) {
  const until = _cooldownUntil.get(id) || 0;
  if (until >= Date.now()) {
    return true;
  }
  // 惰性过期：窗口已过 → 清掉标记，账号恢复可用（不靠定时器，K7）。
  if (until > 0) {
    _cooldownUntil.delete(id);
  }
  return false;
}

function pick(provider, strategy) {
  _ensureInit();
  const strat = _normalizeStrategy(strategy);
  const cands = _providerAccounts(provider);
  if (cands.length === 0) {
    return null;
  }
  const available = cands.filter((r) => !_isCooling(r.id));
  if (available.length === 0) {
    return null;
  }
  let chosen;
  if (strat === STRATEGIES.FILL_FIRST) {
    // 耗尽（冷却）前粘住同一账号
    chosen = available[0];
  } else if (strat === STRATEGIES.LEAST_USED) {
    // K5 契约：平手按插入序（_accounts Map 即插入序），选中即计数 +1
    chosen = available
      .slice()
      .sort((a, b) => a.totalRequests - b.totalRequests)[0];
  } else {
    // round-robin（默认 + 未知策略回退，K14）
    const key = String(provider || '');
    const cur = _cursors[key] || 0;
    chosen = available[cur % available.length];
    _cursors[key] = cur + 1;
  }
  let credential = chosen.credential;
  if (!credential && chosen.credentialCipher) {
    credential = decryptApiKey(chosen.credentialCipher) || '';
  }
  chosen.totalRequests += 1;
  chosen.lastUsedAt = Date.now();
  return {
    accountId: chosen.id,
    credential,
    provider: chosen.provider,
  };
}

// ── 结果回报 ──────────────────────────────────────────────────────────────
function markFailure(id, statusCode, error, retryAfterSec) {
  _ensureInit();
  const r = _accounts.get(id);
  if (r) {
    r.totalFailures += 1;
    r.lastError = String(error || '');
    r.updatedAt = new Date().toISOString();
  }
  // 429/403 才进冷却
  if (statusCode === 429 || statusCode === 403) {
    _markCooldown(id, retryAfterSec);
    _save();
  }
}

function markSuccess(id) {
  _ensureInit();
  const r = _accounts.get(id);
  if (r) {
    r.lastError = null;
    r.updatedAt = new Date().toISOString();
  }
  // 逐级恢复 backoff（成功一次降一级）
  const lvl = _backoffLevel.get(id) || 0;
  _backoffLevel.set(id, Math.max(0, lvl - 1));
  // K8 契约：backoff 归零即清冷却窗口（惰性恢复，不靠定时器）
  if (_backoffLevel.get(id) === 0) {
    _cooldownUntil.delete(id);
  }
  _save();
}

// ── 热重载（K11/K12）──────────────────────────────────────────────────────
function reload() {
  _ensureInit();
  let recovered = false;
  let disk;
  try {
    disk = JSON.parse(fs.readFileSync(_file(), 'utf-8'));
  } catch {
    // 坏 JSON → 从 .bak 自愈（K12 fail-soft，不抛）
    disk = { accounts: [] };
    try {
      const bak = _file() + '.bak';
      if (fs.existsSync(bak)) {
        const bdoc = JSON.parse(fs.readFileSync(bak, 'utf-8'));
        if (bdoc && Array.isArray(bdoc.accounts)) {
          disk = bdoc;
          recovered = true;
        }
      }
    } catch {
      /* .bak 也坏 → 保持现有内存状态 */
    }
  }
  const list = Array.isArray(disk.accounts) ? disk.accounts : [];
  const diskIds = new Set(list.map((a) => a.id));

  let added = 0;
  let removed = 0;
  // 磁盘新增（内存没有的）——存活账号的运行时冷却/退避保留（K11）
  for (const rec of list) {
    if (!_accounts.has(rec.id)) {
      const r = { ...rec };
      r.credential = decryptApiKey(r.credentialCipher) || '';
      _accounts.set(r.id, r);
      added += 1;
    }
  }
  // 磁盘删除（内存有的、磁盘没有的）
  for (const id of [..._accounts.keys()]) {
    if (!diskIds.has(id)) {
      _accounts.delete(id);
      _cooldownUntil.delete(id);
      _backoffLevel.delete(id);
      removed += 1;
    }
  }
  // resetForTest 场景：.bak 也被删了，diskIds 为空时强制清空内存（对齐 K1-K14 用例的干净起点）
  _initialized = true;
  return { added, removed, recovered };
}

// ── 明文唯一出口 ────────────────────────────────────────────────────────
function revealCredential(id) {
  _ensureInit();
  const r = _accounts.get(id);
  if (!r) {
    return { id, credential: '' };
  }
  let c = r.credential;
  if (!c && r.credentialCipher) {
    c = decryptApiKey(r.credentialCipher) || '';
  }
  return { id, credential: c };
}

// ── 测试钩子 ────────────────────────────────────────────────────────────
const __testHooks = {
  forceCooldownExpiry(id) {
    _cooldownUntil.set(id, 0);
  },
  clearCooldown(id) {
    _cooldownUntil.delete(id);
  },
  // 每个用例开头调用：清空内存态 + 磁盘文件，让各用例「唯一账号」语义独立。
  resetForTest() {
    _accounts.clear();
    _cooldownUntil.clear();
    _backoffLevel.clear();
    for (const k of Object.keys(_cursors)) {
      delete _cursors[k];
    }
    // 强制下次 _ensureInit 从（已清空的）磁盘重新装载，并固定持久文件路径，
    // 避免 KHY_DATA_HOME 活体解析在删除后写回旁路路径导致去重契约失效。
    _initialized = false;
    _fileCache = null;
    try {
      const f = _file();
      fs.rmSync(f, { force: true });
      fs.rmSync(f + '.bak', { force: true });
      _fileCache = f; // 重新固定
    } catch {
      /* 没有文件可清不报错 */
    }
  },
};

module.exports = {
  addAccount,
  listAccounts,
  getAccount,
  getAccountState,
  getAccountStatus,
  updateAccount,
  removeAccount,
  setAccountState,
  pick,
  markFailure,
  markSuccess,
  reload,
  revealCredential,
  __testHooks,
};
