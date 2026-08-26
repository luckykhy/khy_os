'use strict';

/**
 * mirrorSyncQueue.js — 镜像补推队列的纯函数单一真源（零 IO / 确定性 / 绝不抛）
 *
 * 它补的缺口：
 * scripts/sync/push-mirrors.sh 原来的行为是「推失败 -> 打一行 WARN -> 退出 0」。
 * 于是断网、令牌过期、代理抽风这三种必然会发生的情况下，本地提交虽然保住了，
 * 但「这个提交还没推上去」这件事只活在那一行滚过去的终端输出里：换一个终端、
 * 关一次机器、或者根本没人盯着 hook 输出，落后的分支就再没人记得补推。
 *
 * 本模块把「哪些 (远端, 分支) 还欠一次推送、为什么欠、欠了多久」变成一份可持久化、
 * 可推导的队列：失败即入队，成功即出队；网络恢复 / 令牌更新后由 CLI 重放队列补推。
 *
 * 纯度边界：这里只有「分类 + 队列 reducer + 文案」，不碰 fs / child_process / 网络。
 *   - classifyPushFailure(text)  git push 的 stderr -> 失败种类与是否可重试（纯）
 *   - redactSecrets(text)        写盘前抹掉 URL 内联凭据 / 令牌样式串（纯）
 *   - upsertEntry / removeEntry  队列 reducer，按 (remote, branch) 去重（纯）
 *   - planWork({...})            待推项 + 本次目标 -> 有序工作清单（纯）
 * 真正的落盘、git 调用在 scripts/sync/mirror-sync.js 里做。
 *
 * 红线：任何写入队列文件的文本都必须先过 redactSecrets。git 的报错会原样回显远端
 * URL，而 URL 里可能内联着 https://user:token@host/... 。队列文件在 .khy/（已
 * gitignore），但「不入库」不等于「可以明文存令牌」。
 */

const QUEUE_VERSION = 1;
// 队列是「欠账清单」而不是历史：按 (remote, branch) 去重后天然很短，
// 上限只为防御异常写入把文件撑爆。
const MAX_ENTRIES = 64;
const MAX_MESSAGE_CHARS = 600;

/* 失败分类 ------------------------------------------------------------------ */

// 网络面：重试是唯一正确动作，且恢复后无需人工干预。
const NETWORK_PATTERNS = [
  /could not resolve host/i,
  /failed to connect/i,
  /couldn'?t connect to server/i,
  /connection (?:timed out|reset|refused)/i,
  /operation timed out/i,
  /timed out after/i,
  /network is (?:unreachable|down)/i,
  /temporary failure in name resolution/i,
  /gnutls_handshake|openssl|ssl_error|schannel|tls (?:connect|handshake)/i,
  /(?:recv|send) failure/i,
  /rpc failed/i,
  /early eof/i,
  /unexpected disconnect/i,
  /the remote end hung up unexpectedly/i,
  /proxy connect aborted|unable to connect to proxy/i,
  /remote error: (?:internal|unavailable)/i,
  /(?:502|503|504) (?:bad gateway|service unavailable|gateway time)/i,
];

// 凭据面：重试前必须先人工修好令牌，否则每次都会以同样的方式失败。
const AUTH_PATTERNS = [
  /authentication failed/i,
  /invalid username or password/i,
  /incorrect username or password/i,
  /could not read (?:username|password)/i,
  /terminal prompts disabled/i,
  /permission denied/i,
  /permission to .+ denied/i,
  /returned error: (?:401|403)\b/i,
  /\bhttp (?:401|403)\b/i,
  /bad credentials/i,
  /support for password authentication was removed/i,
  /(?:token|credential)s? (?:is |are |has |have )?(?:expired|invalid|revoked)/i,
  /access denied/i,
  /you are not allowed to push/i,
  /repository not found/i,
  /account is (?:suspended|blocked)/i,
];

// 分叉面：远端已经领先，重放同一次 push 只会得到同一条 rejected，必须先 rebase。
const DIVERGED_PATTERNS = [
  /non-fast-forward/i,
  /updates were rejected/i,
  /fetch first/i,
  /stale info/i,
  /cannot lock ref/i,
];

const KIND_NETWORK = 'network';
const KIND_AUTH = 'auth';
const KIND_DIVERGED = 'diverged';
const KIND_UNKNOWN = 'unknown';

const KIND_META = Object.freeze({
  [KIND_NETWORK]: Object.freeze({
    retryable: true,
    label: '网络不可达',
    hint: '网络恢复后会自动补推，也可手动执行 npm run sync:mirrors:retry',
  }),
  [KIND_AUTH]: Object.freeze({
    retryable: true,
    label: '凭据/令牌被拒',
    hint: '更新远端令牌后执行 npm run sync:mirrors:retry 补推',
  }),
  [KIND_DIVERGED]: Object.freeze({
    // 可重放，但重放前必须先 rebase：单纯重推会拿到同一条 rejected。
    // 「本地分支动过」是 rebase 已发生的可观测信号，planWork 会据此自动放行一次。
    retryable: false,
    label: '远端已领先（需先 rebase）',
    hint: '先 git fetch && git rebase，改动落地后 npm run sync:mirrors:retry 会自动补推',
  }),
  [KIND_UNKNOWN]: Object.freeze({
    retryable: true,
    label: '未归类失败',
    hint: '查看 lastError 后执行 npm run sync:mirrors:retry 重试',
  }),
});

/**
 * 把 git push 的输出归类成可行动的四种失败。
 * @param {string} text git 的 stderr + stdout
 * @returns {{kind: string, retryable: boolean, label: string, hint: string}}
 */
function classifyPushFailure(text) {
  const raw = typeof text === 'string' ? text : '';
  let kind = KIND_UNKNOWN;
  // 顺序即优先级：网络断了就没到鉴权那一步；鉴权过了才可能谈分叉。
  if (NETWORK_PATTERNS.some(re => re.test(raw))) kind = KIND_NETWORK;
  else if (AUTH_PATTERNS.some(re => re.test(raw))) kind = KIND_AUTH;
  else if (DIVERGED_PATTERNS.some(re => re.test(raw))) kind = KIND_DIVERGED;
  return describeKind(kind);
}

/**
 * 取某个失败种类的元信息（未知种类回落到 unknown，绝不抛）。
 */
function describeKind(kind) {
  const meta = KIND_META[kind] || KIND_META[KIND_UNKNOWN];
  return {
    kind: KIND_META[kind] ? kind : KIND_UNKNOWN,
    retryable: meta.retryable,
    label: meta.label,
    hint: meta.hint,
  };
}

/* 凭据抹除 ------------------------------------------------------------------ */

const CREDENTIAL_URL_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+)(?::([^/\s@]*))?@/gi;
const TOKEN_LIKE_RE =
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|[A-Fa-f0-9]{40,}|[A-Za-z0-9_-]{32,})\b/g;

/**
 * 抹掉 URL 内联凭据与令牌样式串。写盘 / 回显前必过。
 * @param {string} text
 * @returns {string}
 */
function redactSecrets(text) {
  const raw = typeof text === 'string' ? text : '';
  return raw
    .replace(CREDENTIAL_URL_RE, (match, scheme) => `${scheme}***:***@`)
    .replace(TOKEN_LIKE_RE, '***');
}

/* 队列 reducer -------------------------------------------------------------- */

function _str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function _int(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 规范化磁盘上读到的任意 JSON：字段缺失、类型错乱、条目重复都收敛成合法队列。
 * @param {any} raw
 * @returns {{version: number, updatedAt: string, entries: object[]}}
 */
function normalizeQueue(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(source.entries) ? source.entries : [];
  const seen = new Set();
  const entries = [];
  for (const item of list) {
    const entry = _normalizeEntry(item);
    if (!entry) continue;
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    if (entries.length >= MAX_ENTRIES) break;
  }
  return {
    version: QUEUE_VERSION,
    updatedAt: _str(source.updatedAt),
    entries,
  };
}

function _normalizeEntry(item) {
  const source = item && typeof item === 'object' ? item : {};
  const remote = _str(source.remote);
  const branch = _str(source.branch);
  if (!remote || !branch) return null;
  return {
    remote,
    branch,
    commit: _str(source.commit),
    kind: describeKind(_str(source.kind)).kind,
    attempts: _int(source.attempts) || 1,
    firstFailedAt: _str(source.firstFailedAt),
    lastAttemptAt: _str(source.lastAttemptAt),
    lastError: redactSecrets(_str(source.lastError)).slice(0, MAX_MESSAGE_CHARS),
  };
}

/**
 * (远端, 分支) 是队列的主键：同一分支欠的是「一次推送」，不是「每个提交一条」。
 */
function entryKey(entry) {
  const source = entry && typeof entry === 'object' ? entry : {};
  return `${_str(source.remote)} ${_str(source.branch)}`;
}

/**
 * 记一次失败：新目标入队，老目标累加 attempts 并刷新种类 / 提交 / 时间。
 * @returns {{version: number, updatedAt: string, entries: object[]}} 新队列（不改入参）
 */
function upsertEntry(queue, failure) {
  const current = normalizeQueue(queue);
  const remote = _str(failure && failure.remote);
  const branch = _str(failure && failure.branch);
  if (!remote || !branch) return current;

  const at = _str(failure && failure.at);
  const kind = describeKind(_str(failure && failure.kind)).kind;
  const message = redactSecrets(_str(failure && failure.message)).slice(0, MAX_MESSAGE_CHARS);
  const commit = _str(failure && failure.commit);
  const key = `${remote} ${branch}`;
  const previous = current.entries.find(entry => entryKey(entry) === key);

  const next = {
    remote,
    branch,
    commit: commit || (previous ? previous.commit : ''),
    kind,
    attempts: (previous ? previous.attempts : 0) + 1,
    firstFailedAt: (previous && previous.firstFailedAt) || at,
    lastAttemptAt: at,
    lastError: message,
  };

  const entries = current.entries.filter(entry => entryKey(entry) !== key);
  entries.push(next);
  return {
    version: QUEUE_VERSION,
    updatedAt: at || current.updatedAt,
    entries: entries.slice(-MAX_ENTRIES),
  };
}

/**
 * 推成功（或本地分支已消失）时清账。
 */
function removeEntry(queue, target) {
  const current = normalizeQueue(queue);
  const key = entryKey(target);
  const entries = current.entries.filter(entry => entryKey(entry) !== key);
  if (entries.length === current.entries.length) return current;
  return {
    version: QUEUE_VERSION,
    updatedAt: _str(target && target.at) || current.updatedAt,
    entries,
  };
}

/**
 * 本次要推哪些 (远端, 分支)：队列欠账优先（先补历史），再推本次目标。
 *
 * diverged（远端已领先）条目默认只上报不重放 —— 它需要人先 rebase，每次提交都盲目
 * 重放一遍只会刷出同样的 rejected 噪声。但「人已经 rebase 过了」是可观测的：本地分支
 * 的 tip 变了。所以 tips 里 tip 与失败时记录的 commit 不同的 diverged 条目自动放行一次
 * —— 否则用户照着 hint 执行 rebase + retry 之后什么都不会发生，还得自己想起加 --force。
 *
 * @param {object} options
 * @param {object} options.queue     当前队列
 * @param {object[]} options.targets 本次显式目标 [{remote, branch}]
 * @param {object} [options.tips]    分支名 -> 当前本地 tip（用于判断 rebase 是否已发生）
 * @param {boolean} [options.force]  连未变动的 diverged 一起重放
 * @returns {{work: object[], held: object[]}}
 */
function planWork(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const queue = normalizeQueue(opts.queue);
  const force = Boolean(opts.force);
  const targets = Array.isArray(opts.targets) ? opts.targets : [];
  const tips = opts.tips && typeof opts.tips === 'object' ? opts.tips : {};

  const work = [];
  const held = [];
  const seen = new Set();

  for (const entry of queue.entries) {
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    if (!force && !describeKind(entry.kind).retryable && !_movedSinceFailure(entry, tips)) {
      held.push(entry);
      continue;
    }
    seen.add(key);
    work.push({
      remote: entry.remote,
      branch: entry.branch,
      reason: 'queued',
      kind: entry.kind,
      attempts: entry.attempts,
    });
  }

  for (const target of targets) {
    const remote = _str(target && target.remote);
    const branch = _str(target && target.branch);
    if (!remote || !branch) continue;
    const key = `${remote} ${branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    work.push({ remote, branch, reason: 'current', kind: '', attempts: 0 });
  }

  return { work, held };
}

/**
 * 失败当时记下的 tip 与现在的 tip 不同 = 本地分支动过（rebase / 新提交），值得再试一次。
 * 缺任一侧信息时保守判否，宁可让人显式 --force，也不要刷无意义的重放。
 */
function _movedSinceFailure(entry, tips) {
  const recorded = _str(entry && entry.commit);
  const now = _str(tips && tips[_str(entry && entry.branch)]);
  return Boolean(recorded && now && recorded !== now);
}

/**
 * 队列 -> 可读行（CLI 状态输出与 hook 提示共用同一份措辞）。
 * @returns {string[]}
 */
function describeQueue(queue) {
  const current = normalizeQueue(queue);
  if (current.entries.length === 0) return [];
  return current.entries.map((entry, index) => {
    const meta = describeKind(entry.kind);
    const position = `${index + 1}/${current.entries.length}`;
    const since = entry.firstFailedAt ? `，自 ${entry.firstFailedAt}` : '';
    return `[${position}] ${entry.remote}/${entry.branch} 待补推 —— ${meta.label}`
      + `（已尝试 ${entry.attempts} 次${since}）：${meta.hint}`;
  });
}

module.exports = {
  QUEUE_VERSION,
  MAX_ENTRIES,
  MAX_MESSAGE_CHARS,
  KIND_NETWORK,
  KIND_AUTH,
  KIND_DIVERGED,
  KIND_UNKNOWN,
  classifyPushFailure,
  describeKind,
  redactSecrets,
  normalizeQueue,
  entryKey,
  upsertEntry,
  removeEntry,
  planWork,
  describeQueue,
};
