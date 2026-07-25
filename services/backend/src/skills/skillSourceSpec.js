'use strict';

/**
 * skillSourceSpec.js — 纯叶子:把「外部 skill 源字符串」解析成规范化克隆规格(单一真源)。
 *
 * 定位(GOAL「khy 无生态,需适配连外部;如 skill 的安装」):khy 原生已认 SKILL.md/manifest.json
 * 并在 <dataHome>/skills 下自动发现,唯一缺口是「从一个 GitHub 仓库把 skill 拉下来落盘」。本叶子只做
 * **无 IO 的字符串解析与派生**(把用户给的各种源写法归一成 {url, ref, host, owner, repo}),真正的
 * git clone / 文件复制交给薄 IO 层 skillInstallService。
 *
 * 支持的源写法(对齐 `npx skills add <repo>`):
 *   - owner/repo                         → https://github.com/owner/repo.git
 *   - owner/repo#ref                     → 带 ref(分支/tag/commit)
 *   - https://github.com/owner/repo      → 归一 .git
 *   - https://github.com/owner/repo.git
 *   - https://github.com/owner/repo/tree/<ref>[/<subdir…>]  → 拆出 ref + subdir
 *   - git@github.com:owner/repo.git      → SSH
 *   - 任意 http(s)/git/ssh 的 .git URL   → 原样透传(host/owner/repo 尽力解析)
 *
 * 契约:零 IO(只读 process.env 做门控)、确定性、绝不抛(非法输入 → {ok:false, error})。
 */

// ── 门控(KHY_SKILL_ADD,default-on,CANON off)──────────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * `khy skill add` 是否启用。flagRegistry 优先,注册表不可用 → 本地 CANON(4 词)回退。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isSkillAddEnabled(env = process.env) {
  const e = env || {};
  try {
    const reg = require('../services/flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_SKILL_ADD', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_SKILL_ADD;
  return !(v !== undefined && v !== null && _FALSY.has(String(v).trim().toLowerCase()));
}

// ── 解析辅助 ──────────────────────────────────────────────────────────────────
// 单个路径段:字母数字开头,允许 . _ -(挡住 .. 遍历与分隔符)。
const _SEG_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const _REPO_TRIM_RE = /\.git$/i;

function _stripDotGit(s) {
  return String(s || '').replace(_REPO_TRIM_RE, '');
}

/** 校验 owner/repo 段安全(非空、单段、无 .. / 分隔符)。 */
function _validSeg(s) {
  return typeof s === 'string' && s.length > 0 && s !== '.' && s !== '..' && _SEG_RE.test(s);
}

/**
 * 把 `--skill <name>` / 子目录路径归一为安全的相对子路径(用于在克隆后定位 skill 目录)。
 * 拒绝绝对路径、`..` 遍历、盘符;空 → null。
 * @param {string} sub
 * @returns {string|null}
 */
function normalizeSubdir(sub) {
  const raw = String(sub == null ? '' : sub).trim().replace(/\\/g, '/');
  if (!raw) return null;
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null;
  const parts = raw.split('/').filter((p) => p && p !== '.');
  if (!parts.length) return null;
  for (const p of parts) {
    if (p === '..' || !_SEG_RE.test(p)) return null;
  }
  return parts.join('/');
}

/**
 * 由源写法推断 skill 名(落盘目录名的兜底;真正的名以 SKILL.md/manifest 为准)。
 * subdir 末段优先(`--skill foo` → foo),否则 repo 名。非法 → null。
 * @param {{repo?:string, subdir?:string}} spec
 * @returns {string|null}
 */
function inferSkillName(spec = {}) {
  const sub = spec.subdir ? String(spec.subdir).split('/').filter(Boolean) : [];
  if (sub.length) {
    const last = sub[sub.length - 1];
    if (_validSeg(last)) return last;
  }
  if (_validSeg(spec.repo)) return spec.repo;
  return null;
}

/**
 * 解析一个源字符串为规范克隆规格。
 * @param {string} source
 * @param {{skill?:string}} [opts] - opts.skill = `--skill <name>` 显式子目录
 * @returns {{ok:true, spec:object}|{ok:false, error:string}}
 *   spec: { url, ref, host, owner, repo, subdir, kind }
 */
function parseSource(source, opts = {}) {
  const raw = String(source == null ? '' : source).trim();
  if (!raw) return { ok: false, error: 'skill 源不能为空(用法:khy skill add <owner/repo | https://github.com/…> [--skill <name>])。' };

  const explicitSub = opts && opts.skill ? normalizeSubdir(opts.skill) : null;
  if (opts && opts.skill && explicitSub == null) {
    return { ok: false, error: `非法的 --skill 子路径「${opts.skill}」(不允许绝对路径、盘符或 .. 遍历)。` };
  }

  let host = '';
  let owner = '';
  let repo = '';
  let ref = '';
  let subdir = explicitSub || '';
  let url = '';
  let kind = '';

  // ── git@host:owner/repo(.git) ── SSH 短写 ──
  const ssh = /^git@([^:]+):(.+)$/.exec(raw);
  if (ssh) {
    host = ssh[1];
    const rest = ssh[2].replace(/^\/+/, '');
    const segs = _stripDotGit(rest).split('/').filter(Boolean);
    if (segs.length < 2) return { ok: false, error: `无法从 SSH 源解析 owner/repo:「${raw}」。` };
    owner = segs[0];
    repo = segs[1];
    url = raw;
    kind = 'ssh';
  } else if (/^(https?|git|ssh):\/\//i.test(raw)) {
    // ── 完整 URL ──
    let rest = raw.replace(/^[a-z]+:\/\//i, '');
    const slash = rest.indexOf('/');
    if (slash < 0) return { ok: false, error: `URL 缺少仓库路径:「${raw}」。` };
    host = rest.slice(0, slash).replace(/^[^@]*@/, ''); // 去掉可能的 user@
    const pathPart = rest.slice(slash + 1).replace(/^\/+/, '');
    const segs = pathPart.split('/').filter(Boolean);
    if (segs.length < 2) return { ok: false, error: `URL 无法解析 owner/repo:「${raw}」。` };
    owner = segs[0];
    repo = _stripDotGit(segs[1]);
    // github 风格 /tree/<ref>/<subdir…>
    if (segs[2] === 'tree' && segs[3]) {
      ref = segs[3];
      if (!explicitSub && segs.length > 4) {
        const sub = normalizeSubdir(segs.slice(4).join('/'));
        if (sub) subdir = sub;
      }
    }
    url = `${raw.match(/^[a-z]+:\/\//i)[0]}${host}/${owner}/${repo}.git`;
    kind = 'url';
  } else if (/^[^/\s]+\/[^/\s#]+/.test(raw)) {
    // ── owner/repo(#ref) 短写(默认 GitHub)──
    let body = raw;
    const hashAt = body.indexOf('#');
    if (hashAt >= 0) {
      ref = body.slice(hashAt + 1).trim();
      body = body.slice(0, hashAt);
    }
    const segs = body.split('/').filter(Boolean);
    if (segs.length < 2) return { ok: false, error: `短写需形如 owner/repo:「${raw}」。` };
    host = 'github.com';
    owner = segs[0];
    repo = _stripDotGit(segs[1]);
    // owner/repo/sub/dir → 其余段作为子目录(除非 --skill 已指定)
    if (!explicitSub && segs.length > 2) {
      const sub = normalizeSubdir(segs.slice(2).join('/'));
      if (sub) subdir = sub;
    }
    url = `https://github.com/${owner}/${repo}.git`;
    kind = 'shorthand';
  } else {
    return { ok: false, error: `无法识别的 skill 源:「${raw}」(支持 owner/repo、https://github.com/…、git@…)。` };
  }

  if (!_validSeg(owner) || !_validSeg(repo)) {
    return { ok: false, error: `owner/repo 含非法字符:「${owner}/${repo}」。` };
  }
  if (ref && !/^[A-Za-z0-9._/-]+$/.test(ref)) {
    return { ok: false, error: `非法的 ref「${ref}」。` };
  }

  return {
    ok: true,
    spec: {
      url,
      ref: ref || '',
      host,
      owner,
      repo,
      subdir: subdir || '',
      kind,
    },
  };
}

/**
 * 在克隆根目录下,列出「可能是 skill 目录」的候选相对路径(按优先级)。仅返回相对路径字符串;
 * 是否真存在由 IO 层核对。显式 subdir → 只它;否则 [根, skills/*(留给 IO 扫描), .] 的稳定序。
 * @param {object} spec - parseSource 的 spec
 * @returns {string[]} 相对路径候选(''=克隆根)
 */
function candidateSkillDirs(spec = {}) {
  if (spec && spec.subdir) return [spec.subdir];
  // 根优先(单-skill 仓库),其次常见容器目录名(IO 层会在其下再找命名子目录)。
  return ['', 'skill', 'skills', '.skills'];
}

module.exports = {
  isSkillAddEnabled,
  parseSource,
  normalizeSubdir,
  inferSkillName,
  candidateSkillDirs,
  _validSeg,   // exposed for tests
};
