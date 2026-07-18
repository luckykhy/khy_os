'use strict';

/**
 * forgeCore.js — 纯叶子:GitHub / Gitee / GitLab 仓库「查找 + 拉取」的全部确定性逻辑的单一真源。
 *
 * 背景(goal「khyos 学会查找 github/gitee/gitlab 项目能拉取、能上传、会提交」):
 *   上传(push)与提交(commit)在仓库里已有成熟实现(tools/gitPush.js / tools/gitCommit.js /
 *   cli/handlers/publish.js 多平台引擎),**绝不重造**。真缺口只有「查找(search)」与「拉取
 *   (clone/pull)」。本叶子把这两件事里**纯计算**的部分收敛为可单测真源:平台归一、slug 解析、
 *   三家 forge 的搜索请求描述符、搜索响应归一、clone URL 构造,以及最关键的 **git 参数注入防护**。
 *   真正的 IO(axios 搜索、execFile 克隆)在薄层 forgeClient.js,本叶子绝不触网/碰盘/起子进程。
 *
 * 安全(本叶子的存在理由之一):传给 `git clone` 的仓库参数若不设防,`ext::sh -c "..."` 之类的
 *   远端会让 git 执行任意命令,前导 `-` 会被当成 git 选项。故 `assertSafeRepoArg` 只放行
 *   http(s)/ssh/scp 形态与 `owner/repo` slug 的安全字符集,其余一律拒绝;clone URL **绝不内嵌
 *   token**(私有库交给用户既有 git 凭据助手),从根上避免凭据泄漏进进程表/日志。
 *
 * 契约(纯叶子):零 IO、确定性、绝不抛(校验失败返回结构化结果或 null,危险输入显式 throw 由
 *   调用方 try 包裹)、单一真源、无副作用。env 门控 `KHY_FORGE`(默认开;值为 0/false/off/no 关)。
 */

// ── 门控 ─────────────────────────────────────────────────────────────
function isEnabled(env) {
  const raw = String((env || process.env || {}).KHY_FORGE || 'on').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

// ── 平台常量(与 cli/handlers/publish.js 的 host 映射保持一致) ───────
const SUPPORTED_PLATFORMS = ['github', 'gitee', 'gitlab'];
const HOST_BY_PLATFORM = {
  github: 'github.com',
  gitee: 'gitee.com',
  gitlab: 'gitlab.com',
};
const DEFAULT_PLATFORM = 'github';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

// ── 平台归一 ─────────────────────────────────────────────────────────
/**
 * 严格归一:命中支持列表返回规范 id,否则 null(不替调用方默认)。
 * @param {string} raw
 * @returns {('github'|'gitee'|'gitlab'|null)}
 */
function normalizePlatform(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return SUPPORTED_PLATFORMS.includes(v) ? v : null;
}

/**
 * 从 URL / slug 文本推断平台(host 匹配),无法判断返回 null。
 * @param {string} text
 * @returns {('github'|'gitee'|'gitlab'|null)}
 */
function inferPlatform(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('gitee.com')) return 'gitee';
  if (t.includes('gitlab.com') || /\bgitlab\b/.test(t)) return 'gitlab';
  if (t.includes('github.com')) return 'github';
  return null;
}

/**
 * 综合解析平台:显式优先 → 从仓库输入推断 → 默认 github。
 * @param {string} rawPlatform
 * @param {string} repoInput
 * @returns {'github'|'gitee'|'gitlab'}
 */
function resolvePlatform(rawPlatform, repoInput) {
  return normalizePlatform(rawPlatform)
    || inferPlatform(repoInput)
    || DEFAULT_PLATFORM;
}

// ── slug 解析(镜像 publish.js 的 _normalizeRepoSlug,单一形态真源) ──
/**
 * 把任意仓库引用(URL / git@ / slug)归一成 `owner/repo`(去 .git、去前后斜杠)。
 * @param {string} repoInput
 * @returns {string} '' 表示无法解析
 */
function parseRepoSlug(repoInput) {
  const raw = String(repoInput || '').trim();
  if (!raw) return '';
  let slug = raw;
  slug = slug.replace(/^git@[^:]+:/i, '');
  slug = slug.replace(/^ssh:\/\/git@[^/]+\//i, '');
  slug = slug.replace(/^[a-z]+:\/\/[^/]+\//i, '');
  slug = slug.replace(/^\/*/, '').replace(/\/*$/, '');
  slug = slug.replace(/\.git$/i, '');
  return slug;
}

// ── 注入防护(安全核心) ──────────────────────────────────────────────
// 只放行这些 scheme 的完整 URL;ext::/file:///fd:: 等会让 git 执行命令或读本地,一律拒绝。
const SAFE_URL_SCHEME_RE = /^(https?|ssh|git):\/\//i;
// scp 形态:git@host:owner/repo(.git)
const SAFE_SCP_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._/~-]+$/;
// slug 形态:owner/repo —— 仅安全字符,且不以 '-' 开头(避免被当成 git 选项)。
const SAFE_SLUG_RE = /^[A-Za-z0-9_.][A-Za-z0-9_./-]*\/[A-Za-z0-9_.][A-Za-z0-9_./-]*$/;

/**
 * 判定一个仓库参数是否可安全交给 git。纯谓词,绝不抛。
 * @param {string} repoInput
 * @returns {boolean}
 */
function isSafeRepoArg(repoInput) {
  const raw = String(repoInput || '').trim();
  if (!raw) return false;
  if (raw.startsWith('-')) return false;                 // 杜绝选项注入
  if (/\s/.test(raw)) return false;                      // 含空白一律拒
  if (/^(ext|fd|file|sso)::?/i.test(raw)) return false;  // 危险/本地 transport
  if (SAFE_URL_SCHEME_RE.test(raw)) {
    // 已是 http(s)/ssh/git URL:再确认不含 shell 元字符
    return !/[\s;'"`$()<>|\\^]/.test(raw);
  }
  if (SAFE_SCP_RE.test(raw)) return true;
  return SAFE_SLUG_RE.test(raw);
}

/**
 * 校验仓库参数,危险则 throw(调用方 try 包裹)。把「什么算危险」收成单一真源。
 * @param {string} repoInput
 * @returns {string} 原始 trim 后的参数
 */
function assertSafeRepoArg(repoInput) {
  const raw = String(repoInput || '').trim();
  if (!isSafeRepoArg(raw)) {
    throw new Error(`不安全或不合法的仓库参数: ${JSON.stringify(repoInput)}（仅支持 owner/repo 或 http(s)/ssh git URL)`);
  }
  return raw;
}

// ── clone URL 构造(绝不内嵌 token) ─────────────────────────────────
/**
 * 解析仓库引用为可克隆的 URL。已是受支持 URL 则原样返回;slug 则按平台拼 https/ssh。
 * 先经 assertSafeRepoArg 防注入。
 * @param {string} repoInput
 * @param {string} platform
 * @param {{ssh?: boolean}} [options]
 * @returns {string}
 */
function buildCloneUrl(repoInput, platform, options = {}) {
  const raw = assertSafeRepoArg(repoInput);

  // 已是完整 URL / scp 形态:直接用(不改协议、不嵌 token)。
  if (SAFE_URL_SCHEME_RE.test(raw) || SAFE_SCP_RE.test(raw)) {
    return raw;
  }

  const slug = parseRepoSlug(raw);
  if (!slug.includes('/')) {
    throw new Error(`仓库格式不合法: ${repoInput}（示例: owner/repo)`);
  }
  const host = HOST_BY_PLATFORM[platform] || HOST_BY_PLATFORM[DEFAULT_PLATFORM];
  const preferSsh = options.ssh === true || String(options.protocol || '').toLowerCase() === 'ssh';
  return preferSsh
    ? `git@${host}:${slug}.git`
    : `https://${host}/${slug}.git`;
}

// ── 搜索请求描述符(三家 forge 的 REST 端点) ───────────────────────
function clampLimit(n) {
  const v = Number.parseInt(n, 10);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_LIMIT;
  return Math.min(v, MAX_LIMIT);
}

/**
 * 构造一次仓库搜索的请求描述符(method/url/headers/params)。纯计算,不发请求。
 * token 由调用方从 env 读出后传入(本叶子绝不读密钥环境变量、绝不回显)。
 * @param {string} platform - 'github'|'gitee'|'gitlab'
 * @param {string} query
 * @param {{limit?: number, token?: string}} [opts]
 * @returns {{method:string, url:string, headers:object, params:object}|null}
 */
function buildSearchRequest(platform, query, opts = {}) {
  const p = normalizePlatform(platform);
  const q = String(query || '').trim();
  if (!p || !q) return null;
  const limit = clampLimit(opts.limit);
  const token = String(opts.token || '').trim();

  if (p === 'github') {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'khyos-forge',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return {
      method: 'GET',
      url: 'https://api.github.com/search/repositories',
      headers,
      params: { q, per_page: limit, sort: 'stars', order: 'desc' },
    };
  }

  if (p === 'gitee') {
    // Gitee v5 用 access_token 查询参数鉴权。
    const params = { q, per_page: limit, sort: 'stars_count', order: 'desc' };
    if (token) params.access_token = token;
    return {
      method: 'GET',
      url: 'https://gitee.com/api/v5/search/repositories',
      headers: { 'User-Agent': 'khyos-forge' },
      params,
    };
  }

  // gitlab
  const headers = { 'User-Agent': 'khyos-forge' };
  if (token) headers['PRIVATE-TOKEN'] = token;
  return {
    method: 'GET',
    url: 'https://gitlab.com/api/v4/projects',
    headers,
    params: { search: q, per_page: limit, order_by: 'star_count', sort: 'desc' },
  };
}

// ── 搜索响应归一(三家 → 统一 shape) ───────────────────────────────
// 有限数强转家族单一真源 utils/finiteNumber(见 finiteNumber.js)。
const _num = require('../../utils/finiteNumber').toFiniteOr0;

/**
 * 把某平台的原始搜索响应体归一成统一仓库数组。绝不抛,无法解析返回 []。
 * 统一字段:{ platform, fullName, owner, name, description, stars, language, url, cloneUrl }
 * @param {string} platform
 * @param {*} body - 已解析的 JSON(对象或数组)
 * @returns {Array<object>}
 */
function parseSearchResults(platform, body) {
  const p = normalizePlatform(platform);
  if (!p || body == null) return [];

  // github: { items: [...] };gitee/gitlab: 顶层就是数组。
  const rows = Array.isArray(body)
    ? body
    : (Array.isArray(body.items) ? body.items : []);
  if (!Array.isArray(rows)) return [];

  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    let item;
    if (p === 'github') {
      const fullName = String(r.full_name || '');
      item = {
        platform: p,
        fullName,
        owner: r.owner && r.owner.login ? String(r.owner.login) : fullName.split('/')[0] || '',
        name: String(r.name || fullName.split('/')[1] || ''),
        description: r.description ? String(r.description) : '',
        stars: _num(r.stargazers_count),
        language: r.language ? String(r.language) : '',
        url: String(r.html_url || ''),
        cloneUrl: String(r.clone_url || (fullName ? `https://github.com/${fullName}.git` : '')),
      };
    } else if (p === 'gitee') {
      const fullName = String(r.full_name || r.path_with_namespace || '');
      const htmlUrl = String(r.html_url || '');
      item = {
        platform: p,
        fullName,
        owner: r.namespace && r.namespace.path ? String(r.namespace.path) : fullName.split('/')[0] || '',
        name: String(r.name || r.path || fullName.split('/')[1] || ''),
        description: r.description ? String(r.description) : '',
        stars: _num(r.stargazers_count),
        language: r.language ? String(r.language) : '',
        url: htmlUrl,
        cloneUrl: String(r.html_url ? `${htmlUrl}.git` : (fullName ? `https://gitee.com/${fullName}.git` : '')),
      };
    } else {
      // gitlab
      const fullName = String(r.path_with_namespace || '');
      const ns = r.namespace && (r.namespace.full_path || r.namespace.path);
      item = {
        platform: p,
        fullName,
        owner: ns ? String(ns) : fullName.split('/').slice(0, -1).join('/'),
        name: String(r.path || r.name || fullName.split('/').pop() || ''),
        description: r.description ? String(r.description) : '',
        stars: _num(r.star_count),
        language: '',
        url: String(r.web_url || ''),
        cloneUrl: String(r.http_url_to_repo || (fullName ? `https://gitlab.com/${fullName}.git` : '')),
      };
    }
    if (item.fullName || item.cloneUrl) out.push(item);
  }
  return out;
}

// ── 仓库侦察(recon):从宽到窄地「探查」一个仓库 ─────────────────────
//
// 设计意图(goal「让 khy 像我探索 GitHub 那样,把目标仓库当作要新建项目的参考、或要部署
// 的项目」):一个可信工程师评估陌生仓库的方法是**从宽到窄**——先看元数据(规模/活跃度/
// 许可证)、再看顶层结构(monorepo?)、再精读关键文件(README/CLAUDE.md/CONTRIBUTING/
// package.json),而非随机翻阅。本段把这套侦察里**纯计算**的部分(三端点请求描述符、响应
// 归一、关键文件名册、路径防护、确定性洞见)收敛为单一真源;真正的 axios IO 在 forgeClient。
// search/clone 已有(上一轮),此处只补**缺失的 recon**,绝不重造平台 plumbing。

// 「金矿」关键文件名册(单一真源):理解一个项目「怎么建、怎么跑、怎么部署、对 agent 友好否」
// 最该精读的文件。大小写不敏感匹配顶层条目;reconRepo 只拉取**实际存在**的(像我:先列目录
// 再按已知路径取文件,比盲拉快得多)。
const KEY_RECON_FILES = [
  'README.md', 'README', 'README.rst',
  'CLAUDE.md', 'AGENTS.md', '.cursorrules',           // agent / AI 协作指南
  'CONTRIBUTING.md',
  'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  'Makefile', '.env.example',
];

const RECON_FILE_MAX_BYTES = 256 * 1024;             // 单个关键文件拉取上界(防超大文件)
const RECON_MAX_KEY_FILES = 12;                      // 一次 recon 最多精读多少个关键文件

// 路径防护:contents/file 路径会拼进 REST URL。拒绝 `..`、绝对路径与 shell/URL 危险/控制
// 字符;允许空串(顶层)。白名单收尾顺带排除一切控制字符。纯谓词,绝不抛。
function isSafeReconPath(p) {
  const s = String(p == null ? '' : p).trim();
  if (s === '') return true;                          // 顶层
  if (s.startsWith('/')) return false;                // 绝对路径
  if (s.includes('..')) return false;                 // 目录穿越
  if (/[\s;'"`$()<>|\\^?#%]/.test(s)) return false;   // 危险/会破坏 URL 的字符
  return /^[A-Za-z0-9_.\-/]+$/.test(s);
}

// 把已 trim 的 owner/repo slug 校验为可安全拼进 URL 的形态(复用 SAFE_SLUG_RE 单一真源)。
function _safeSlugForUrl(repoInput) {
  const slug = parseRepoSlug(repoInput);
  if (!slug.includes('/') || !SAFE_SLUG_RE.test(slug)) {
    throw new Error(`仓库格式不合法: ${JSON.stringify(repoInput)}（示例: owner/repo)`);
  }
  return slug;
}

function _encPath(p) {
  // 逐段编码,保留 '/' 作为分隔符。
  return String(p || '').split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

/**
 * 构造「仓库元数据」请求描述符(method/url/headers/params)。纯计算。
 * @param {string} platform
 * @param {string} repoInput - owner/repo 或 URL
 * @param {{token?: string}} [opts]
 * @returns {{method,url,headers,params}|null}
 */
function buildRepoMetaRequest(platform, repoInput, opts = {}) {
  const p = normalizePlatform(platform);
  if (!p) return null;
  const slug = _safeSlugForUrl(repoInput);
  const token = String(opts.token || '').trim();
  if (p === 'github') {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'khyos-forge' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return { method: 'GET', url: `https://api.github.com/repos/${slug}`, headers, params: {} };
  }
  if (p === 'gitee') {
    const params = {};
    if (token) params.access_token = token;
    return { method: 'GET', url: `https://gitee.com/api/v5/repos/${slug}`, headers: { 'User-Agent': 'khyos-forge' }, params };
  }
  // gitlab:项目以 URL 编码的 owner/repo 作 id
  const headers = { 'User-Agent': 'khyos-forge' };
  if (token) headers['PRIVATE-TOKEN'] = token;
  return { method: 'GET', url: `https://gitlab.com/api/v4/projects/${encodeURIComponent(slug)}`, headers, params: {} };
}

/**
 * 归一仓库元数据 → 统一 shape。绝不抛,无法解析返回 null。
 * @returns {{platform,fullName,description,defaultBranch,stars,forks,openIssues,language,license,topics,url,cloneUrl,pushedAt}|null}
 */
function parseRepoMeta(platform, body) {
  const p = normalizePlatform(platform);
  if (!p || !body || typeof body !== 'object') return null;
  const r = body;
  if (p === 'github') {
    const fullName = String(r.full_name || '');
    return {
      platform: p,
      fullName,
      description: r.description ? String(r.description) : '',
      defaultBranch: String(r.default_branch || 'main'),
      stars: _num(r.stargazers_count),
      forks: _num(r.forks_count),
      openIssues: _num(r.open_issues_count),
      language: r.language ? String(r.language) : '',
      license: r.license && r.license.spdx_id ? String(r.license.spdx_id) : (r.license && r.license.name ? String(r.license.name) : ''),
      topics: Array.isArray(r.topics) ? r.topics.map(String) : [],
      url: String(r.html_url || ''),
      cloneUrl: String(r.clone_url || (fullName ? `https://github.com/${fullName}.git` : '')),
      pushedAt: String(r.pushed_at || r.updated_at || ''),
    };
  }
  if (p === 'gitee') {
    const fullName = String(r.full_name || r.path_with_namespace || '');
    return {
      platform: p,
      fullName,
      description: r.description ? String(r.description) : '',
      defaultBranch: String(r.default_branch || 'master'),
      stars: _num(r.stargazers_count),
      forks: _num(r.forks_count),
      openIssues: _num(r.open_issues_count),
      language: r.language ? String(r.language) : '',
      license: r.license ? String(r.license) : '',
      topics: Array.isArray(r.topics) ? r.topics.map(String) : [],
      url: String(r.html_url || ''),
      cloneUrl: String(r.html_url ? `${r.html_url}.git` : (fullName ? `https://gitee.com/${fullName}.git` : '')),
      pushedAt: String(r.pushed_at || r.updated_at || ''),
    };
  }
  // gitlab
  const fullName = String(r.path_with_namespace || '');
  return {
    platform: p,
    fullName,
    description: r.description ? String(r.description) : '',
    defaultBranch: String(r.default_branch || 'main'),
    stars: _num(r.star_count),
    forks: _num(r.forks_count),
    openIssues: _num(r.open_issues_count),
    language: '',
    license: r.license && r.license.name ? String(r.license.name) : '',
    topics: Array.isArray(r.topics) ? r.topics.map(String) : (Array.isArray(r.tag_list) ? r.tag_list.map(String) : []),
    url: String(r.web_url || ''),
    cloneUrl: String(r.http_url_to_repo || (fullName ? `https://gitlab.com/${fullName}.git` : '')),
    pushedAt: String(r.last_activity_at || ''),
  };
}

/**
 * 构造「目录内容/树」请求描述符。path 为空 = 顶层。先经路径防护。
 * @param {string} platform
 * @param {string} repoInput
 * @param {string} [path]
 * @param {{ref?: string, token?: string, projectId?: string|number}} [opts]
 * @returns {{method,url,headers,params}|null}
 */
function buildContentsRequest(platform, repoInput, path = '', opts = {}) {
  const p = normalizePlatform(platform);
  if (!p) return null;
  const safePath = String(path || '').trim();
  if (!isSafeReconPath(safePath)) throw new Error(`不安全的路径: ${JSON.stringify(path)}`);
  const slug = _safeSlugForUrl(repoInput);
  const token = String(opts.token || '').trim();
  const ref = String(opts.ref || '').trim();
  if (p === 'github') {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'khyos-forge' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const params = {};
    if (ref) params.ref = ref;
    return { method: 'GET', url: `https://api.github.com/repos/${slug}/contents/${_encPath(safePath)}`, headers, params };
  }
  if (p === 'gitee') {
    const params = {};
    if (token) params.access_token = token;
    if (ref) params.ref = ref;
    return { method: 'GET', url: `https://gitee.com/api/v5/repos/${slug}/contents/${_encPath(safePath)}`, headers: { 'User-Agent': 'khyos-forge' }, params };
  }
  // gitlab tree:project id(URL 编码 slug)+ path/ref 查询参
  const headers = { 'User-Agent': 'khyos-forge' };
  if (token) headers['PRIVATE-TOKEN'] = token;
  const params = { per_page: 100 };
  if (safePath) params.path = safePath;
  if (ref) params.ref = ref;
  return { method: 'GET', url: `https://gitlab.com/api/v4/projects/${encodeURIComponent(slug)}/repository/tree`, headers, params };
}

/**
 * 归一目录内容 → [{type:'file'|'dir', name, path, size}]。绝不抛,无法解析返回 []。
 */
function parseContents(platform, body) {
  const p = normalizePlatform(platform);
  if (!p || body == null) return [];
  const rows = Array.isArray(body) ? body : (Array.isArray(body.tree) ? body.tree : []);
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    let type;
    if (p === 'gitlab') type = (r.type === 'tree') ? 'dir' : 'file';
    else type = (r.type === 'dir' || r.type === 'tree') ? 'dir' : 'file';
    const name = String(r.name || '');
    if (!name) continue;
    out.push({ type, name, path: String(r.path || name), size: _num(r.size) });
  }
  return out;
}

/**
 * 构造「单文件内容」请求描述符。gitlab 需 ref(由 reconRepo 传默认分支)。
 * @returns {{method,url,headers,params}|null}
 */
function buildFileRequest(platform, repoInput, path, opts = {}) {
  const p = normalizePlatform(platform);
  if (!p) return null;
  const safePath = String(path || '').trim();
  if (!safePath || !isSafeReconPath(safePath)) throw new Error(`不安全的路径: ${JSON.stringify(path)}`);
  const slug = _safeSlugForUrl(repoInput);
  const token = String(opts.token || '').trim();
  const ref = String(opts.ref || '').trim();
  if (p === 'github') {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'khyos-forge' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const params = {};
    if (ref) params.ref = ref;
    return { method: 'GET', url: `https://api.github.com/repos/${slug}/contents/${_encPath(safePath)}`, headers, params };
  }
  if (p === 'gitee') {
    const params = {};
    if (token) params.access_token = token;
    if (ref) params.ref = ref;
    return { method: 'GET', url: `https://gitee.com/api/v5/repos/${slug}/contents/${_encPath(safePath)}`, headers: { 'User-Agent': 'khyos-forge' }, params };
  }
  // gitlab raw:files/{urlencoded filepath}/raw?ref=
  const headers = { 'User-Agent': 'khyos-forge' };
  if (token) headers['PRIVATE-TOKEN'] = token;
  const params = {};
  if (ref) params.ref = ref;
  return { method: 'GET', url: `https://gitlab.com/api/v4/projects/${encodeURIComponent(slug)}/repository/files/${encodeURIComponent(safePath)}/raw`, headers, params };
}

/**
 * 归一单文件响应 → { text, truncated }。github/gitee 返回 base64;gitlab raw 直接是文本。
 * 绝不抛;无法解析返回 { text:'', truncated:false }。
 * @param {string} platform
 * @param {*} body
 * @param {{maxBytes?: number}} [opts]
 */
function parseFileContent(platform, body, opts = {}) {
  const p = normalizePlatform(platform);
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : RECON_FILE_MAX_BYTES;
  try {
    let text = '';
    if (p === 'github' || p === 'gitee') {
      if (body && typeof body === 'object' && typeof body.content === 'string'
        && String(body.encoding || '').toLowerCase() === 'base64') {
        text = Buffer.from(body.content.replace(/\s+/g, ''), 'base64').toString('utf8');
      } else if (typeof body === 'string') {
        text = body;
      }
    } else {
      // gitlab raw:body 即文本(axios 可能给字符串或已解析对象)
      text = typeof body === 'string' ? body : (body == null ? '' : String(body));
    }
    let truncated = false;
    if (text.length > maxBytes) { text = text.slice(0, maxBytes); truncated = true; }
    return { text, truncated };
  } catch {
    return { text: '', truncated: false };
  }
}

/**
 * 从顶层条目里挑出实际存在的关键文件(大小写不敏感,按 KEY_RECON_FILES 顺序、去重、封顶)。
 * @param {Array<{type,name,path}>} contents
 * @returns {Array<{name, path}>}
 */
function pickKeyFiles(contents) {
  const rows = Array.isArray(contents) ? contents : [];
  const byLower = new Map();
  for (const r of rows) {
    if (r && r.type === 'file' && r.name) byLower.set(String(r.name).toLowerCase(), r);
  }
  const out = [];
  const seen = new Set();
  for (const key of KEY_RECON_FILES) {
    const hit = byLower.get(key.toLowerCase());
    if (hit && !seen.has(hit.path)) {
      out.push({ name: hit.name, path: hit.path });
      seen.add(hit.path);
      if (out.length >= RECON_MAX_KEY_FILES) break;
    }
  }
  return out;
}

/**
 * 从顶层结构 + 已读关键文件里**确定性**提炼可作参考/部署的洞见(就是我「看到 packages/ 就知道
 * 是 monorepo、看到 CLAUDE.md 就知道有 agent 指南」那套判断的代码化)。纯函数,绝不抛。
 * @param {{tree?: Array, keyFiles?: object}} input
 * @returns {{isMonorepo, hasAgentGuide, hasDocker, packageManager, buildCommands, deployHints, notes}}
 */
function deriveReconHints(input = {}) {
  const tree = Array.isArray(input.tree) ? input.tree : [];
  const keyFiles = (input.keyFiles && typeof input.keyFiles === 'object') ? input.keyFiles : {};
  const dirNames = new Set(tree.filter((e) => e && e.type === 'dir').map((e) => String(e.name).toLowerCase()));
  const fileNames = new Set(tree.filter((e) => e && e.type === 'file').map((e) => String(e.name).toLowerCase()));
  // keyFiles 的键按原文件名(可能含大小写,如 CLAUDE.md);建小写索引便于大小写不敏感命中。
  const keyByLower = new Map(Object.keys(keyFiles).map((k) => [k.toLowerCase(), keyFiles[k]]));
  const has = (n) => fileNames.has(n) || keyByLower.has(n);
  const keyText = (n) => { const v = keyByLower.get(n); return v && typeof v.text === 'string' ? v.text : ''; };

  const hints = {
    isMonorepo: dirNames.has('packages') || dirNames.has('apps'),
    hasAgentGuide: has('claude.md') || has('agents.md') || dirNames.has('.claude'),
    hasDocker: has('dockerfile') || has('docker-compose.yml') || has('docker-compose.yaml'),
    packageManager: '',
    buildCommands: [],
    deployHints: [],
    notes: [],
  };

  // package.json scripts → 构建/运行/部署命令(只读取,绝不执行)。
  const pkgRaw = keyText('package.json');
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      hints.packageManager = pkg.packageManager ? String(pkg.packageManager) : 'npm';
      if (pkg.workspaces) hints.isMonorepo = true;
      const scripts = (pkg.scripts && typeof pkg.scripts === 'object') ? pkg.scripts : {};
      for (const k of ['build', 'start', 'dev', 'test', 'deploy', 'serve']) {
        if (scripts[k]) hints.buildCommands.push(`npm run ${k}`);
      }
      if (scripts.deploy || scripts.serve) hints.deployHints.push('package.json 含 deploy/serve 脚本');
    } catch { hints.notes.push('package.json 解析失败(可能含注释或非标准 JSON)'); }
  }
  if (has('pyproject.toml') || has('requirements.txt')) hints.notes.push('Python 项目(pip / pyproject)');
  if (has('cargo.toml')) hints.notes.push('Rust 项目(cargo build / cargo run)');
  if (has('go.mod')) hints.notes.push('Go 项目(go build / go run)');
  if (hints.hasDocker) hints.deployHints.push('可用 Docker 部署(docker build / docker compose up)');
  if (has('makefile')) hints.notes.push('含 Makefile(make 目标可能封装构建/部署)');
  if (hints.hasAgentGuide) hints.notes.push('含 agent 协作指南(CLAUDE.md/AGENTS.md)——优先精读其构建/测试/提交规范');
  return hints;
}

// ── 提交历史 + 提交质量评估 ───────────────────────────────────────────
//
// 设计意图(goal「参考 GitHub 对接,让 khy 真的能评估一个仓库」):一个可信工程师判断陌生
// 仓库「值不值得参考 / 维护得好不好」时,除了看 star/许可证,还会读**最近的提交历史**——
// 提交信息是否规范(Conventional Commits)、是否笼统(wip/update/fix)、节奏如何。本段把
// 「取最近提交」的三端点请求描述符、响应归一,以及最有价值的**提交质量确定性评分**收成单一
// 真源;真正的 axios IO 在 forgeClient。质量评分是纯计算,故放在叶子里可单测、零假阳性。

const COMMITS_DEFAULT_LIMIT = 20;
const COMMITS_MAX_LIMIT = 100;

// Conventional Commits 类型册(单一真源):feat/fix/… 之外的前缀不计入「规范」。
const CONVENTIONAL_TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'];
// `type(scope)!: subject` —— scope/`!` 可选,冒号后须有非空描述。
const CONVENTIONAL_RE = new RegExp(`^(${CONVENTIONAL_TYPES.join('|')})(\\([^)]*\\))?(!)?: .+`, 'i');
// 笼统/低信息量主题(整行即这些词,或纯标点)——这类提交信息几乎不传达意图。
const VAGUE_SUBJECT_RE = /^(wip|update|updates|updated|fix|fixes|fixed|misc|minor|changes|change|stuff|temp|tmp|cleanup|test|tests|\.+|-+)$/i;
const SUBJECT_MAX_LEN = 72;                          // 主题超过此长度按「过长」计(git 惯例)

function _clampCommitsLimit(n) {
  const v = Number.parseInt(n, 10);
  if (!Number.isFinite(v) || v <= 0) return COMMITS_DEFAULT_LIMIT;
  return Math.min(v, COMMITS_MAX_LIMIT);
}

/**
 * 构造「最近提交历史」请求描述符。纯计算,不发请求。
 * @param {string} platform
 * @param {string} repoInput - owner/repo 或 URL
 * @param {{limit?: number, ref?: string, path?: string, token?: string}} [opts]
 * @returns {{method,url,headers,params}|null}
 */
function buildCommitsRequest(platform, repoInput, opts = {}) {
  const p = normalizePlatform(platform);
  if (!p) return null;
  const slug = _safeSlugForUrl(repoInput);
  const limit = _clampCommitsLimit(opts.limit);
  const token = String(opts.token || '').trim();
  const ref = String(opts.ref || '').trim();
  const path = String(opts.path || '').trim();
  if (path && !isSafeReconPath(path)) throw new Error(`不安全的路径: ${JSON.stringify(opts.path)}`);
  if (p === 'github') {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'khyos-forge' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const params = { per_page: limit };
    if (ref) params.sha = ref;
    if (path) params.path = path;
    return { method: 'GET', url: `https://api.github.com/repos/${slug}/commits`, headers, params };
  }
  if (p === 'gitee') {
    const params = { per_page: limit };
    if (token) params.access_token = token;
    if (ref) params.sha = ref;
    if (path) params.path = path;
    return { method: 'GET', url: `https://gitee.com/api/v5/repos/${slug}/commits`, headers: { 'User-Agent': 'khyos-forge' }, params };
  }
  // gitlab
  const headers = { 'User-Agent': 'khyos-forge' };
  if (token) headers['PRIVATE-TOKEN'] = token;
  const params = { per_page: limit };
  if (ref) params.ref_name = ref;
  if (path) params.path = path;
  return { method: 'GET', url: `https://gitlab.com/api/v4/projects/${encodeURIComponent(slug)}/repository/commits`, headers, params };
}

/**
 * 归一提交历史 → [{sha, message, subject, author, date, url, isMerge}]。绝不抛,无法解析返回 []。
 */
function parseCommits(platform, body) {
  const p = normalizePlatform(platform);
  if (!p || !Array.isArray(body)) return [];
  const out = [];
  for (const r of body) {
    if (!r || typeof r !== 'object') continue;
    let sha = '', message = '', author = '', date = '', url = '';
    if (p === 'github' || p === 'gitee') {
      const c = r.commit && typeof r.commit === 'object' ? r.commit : {};
      sha = String(r.sha || '');
      message = String(c.message || '');
      author = (c.author && c.author.name) ? String(c.author.name)
        : (r.author && r.author.login ? String(r.author.login) : '');
      date = (c.author && c.author.date) ? String(c.author.date) : '';
      url = String(r.html_url || '');
    } else {
      // gitlab
      sha = String(r.id || r.short_id || '');
      message = String(r.message || r.title || '');
      author = String(r.author_name || '');
      date = String(r.created_at || r.committed_date || '');
      url = String(r.web_url || '');
    }
    if (!sha && !message) continue;
    const subject = message.split('\n')[0].trim();
    out.push({ sha, message, subject, author, date, url, isMerge: /^merge[\s:]/i.test(subject) });
  }
  return out;
}

/**
 * 评估一组提交的**信息质量**——把「这个项目提交规范吗、信息有意义吗」这套判断确定性代码化。
 * 纯函数,绝不抛。合并提交不计入评分分母(它们由工具生成,不反映人写信息的习惯)。
 *
 * 评分(0–100):规范度(Conventional Commits 占比,权重 70)+ 清晰度(非笼统主题占比,权重 30),
 * 再对「主题过长」扣分。等级 A≥85 / B≥70 / C≥55 / D≥40 / F<40。
 * @param {Array<{subject?, message?, isMerge?}>} commits
 * @returns {{total, scored, merges, conventional, vague, tooLong, conventionalRatio, score, grade, notes}}
 */
function evaluateCommitQuality(commits) {
  const rows = Array.isArray(commits) ? commits.filter((c) => c && typeof c === 'object') : [];
  const total = rows.length;
  const merges = rows.filter((c) => c.isMerge === true).length;
  const scoredRows = rows.filter((c) => c.isMerge !== true);
  const scored = scoredRows.length;

  const empty = {
    total, scored, merges: total - scored,
    conventional: 0, vague: 0, tooLong: 0,
    conventionalRatio: 0, score: 0, grade: 'N/A', notes: ['没有可评分的提交'],
  };
  if (scored === 0) return empty;

  let conventional = 0, vague = 0, tooLong = 0;
  for (const c of scoredRows) {
    const subject = String(c.subject != null ? c.subject : String(c.message || '').split('\n')[0]).trim();
    if (CONVENTIONAL_RE.test(subject)) conventional += 1;
    if (subject.length < 6 || VAGUE_SUBJECT_RE.test(subject)) vague += 1;
    if (subject.length > SUBJECT_MAX_LEN) tooLong += 1;
  }
  const conventionalRatio = conventional / scored;
  const vagueRatio = vague / scored;
  const longRatio = tooLong / scored;
  let score = Math.round(70 * conventionalRatio + 30 * (1 - vagueRatio) - 10 * longRatio);
  if (score < 0) score = 0; if (score > 100) score = 100;
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F';

  const notes = [];
  notes.push(`${conventional}/${scored} 条遵循 Conventional Commits(${Math.round(conventionalRatio * 100)}%)`);
  if (vague > 0) notes.push(`${vague} 条主题过于笼统(wip/update/fix 等),信息量低`);
  if (tooLong > 0) notes.push(`${tooLong} 条主题超过 ${SUBJECT_MAX_LEN} 字符`);
  if (merges > 0) notes.push(`${merges} 条合并提交(不计入评分)`);
  if (conventionalRatio >= 0.8) notes.push('提交规范优良:可作为提交信息风格的参考');
  else if (conventionalRatio < 0.2) notes.push('几乎不使用规范化提交前缀');

  return { total, scored, merges: total - scored, conventional, vague, tooLong, conventionalRatio, score, grade, notes };
}

// ── 代码搜索 + 速率限制(目前仅 GitHub 提供干净的公开端点)──────────────
//
// 诚实边界:GitHub 有 `/search/code` 与 `/rate_limit` 两个稳定公开端点;Gitee 无对等的代码
// 搜索 API,GitLab 的代码搜索依赖实例配置(常需高级版/管理员)。故此二者**仅支持 github**,
// 其它平台返回 null,由 forgeClient 给出清晰的「暂不支持」提示,绝不伪造能力。

/**
 * 构造「代码搜索」请求描述符(GitHub `/search/code`)。仅 github;其它平台返回 null。
 * @param {string} platform
 * @param {string} query - 代码搜索表达式(可含 `repo:owner/name`、`language:` 等限定符)
 * @param {{limit?: number, repo?: string, token?: string}} [opts]
 * @returns {{method,url,headers,params}|null}
 */
function buildCodeSearchRequest(platform, query, opts = {}) {
  const p = normalizePlatform(platform);
  if (p !== 'github') return null;                   // 仅 github 提供干净的代码搜索端点
  let q = String(query || '').trim();
  if (!q) return null;
  const repo = String(opts.repo || '').trim();
  if (repo) {
    // 限定到某仓库:owner/repo 须安全(复用 slug 真源),再拼 `repo:` 限定符。
    const slug = parseRepoSlug(repo);
    if (slug.includes('/') && SAFE_SLUG_RE.test(slug) && !/\brepo:/i.test(q)) {
      q = `${q} repo:${slug}`;
    }
  }
  const limit = clampLimit(opts.limit);
  const token = String(opts.token || '').trim();
  const headers = { Accept: 'application/vnd.github.text-match+json', 'User-Agent': 'khyos-forge' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return { method: 'GET', url: 'https://api.github.com/search/code', headers, params: { q, per_page: limit } };
}

/**
 * 归一代码搜索响应 → [{repo, path, name, url}]。绝不抛,无法解析返回 []。
 */
function parseCodeSearchResults(platform, body) {
  if (normalizePlatform(platform) !== 'github' || body == null) return [];
  const rows = Array.isArray(body.items) ? body.items : [];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const repo = r.repository && r.repository.full_name ? String(r.repository.full_name) : '';
    out.push({
      repo,
      path: String(r.path || ''),
      name: String(r.name || ''),
      url: String(r.html_url || ''),
    });
  }
  return out;
}

/**
 * 构造「速率限制查询」请求描述符(GitHub `/rate_limit`)。仅 github;其它平台返回 null。
 * @param {string} platform
 * @param {{token?: string}} [opts]
 * @returns {{method,url,headers,params}|null}
 */
function buildRateLimitRequest(platform, opts = {}) {
  if (normalizePlatform(platform) !== 'github') return null;
  const token = String(opts.token || '').trim();
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'khyos-forge' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return { method: 'GET', url: 'https://api.github.com/rate_limit', headers, params: {} };
}

/**
 * 归一速率限制响应 → { core:{limit,remaining,reset,used}, search:{...}, hasToken }。
 * 绝不抛,无法解析返回 null。reset 为 epoch 秒(原样透出,展示层格式化)。
 */
function parseRateLimit(platform, body) {
  if (normalizePlatform(platform) !== 'github' || !body || typeof body !== 'object') return null;
  const res = body.resources && typeof body.resources === 'object' ? body.resources : {};
  const pick = (g) => {
    const o = g && typeof g === 'object' ? g : {};
    return { limit: _num(o.limit), remaining: _num(o.remaining), reset: _num(o.reset), used: _num(o.used) };
  };
  const core = pick(res.core || body.rate);
  return {
    core,
    search: pick(res.search),
    // limit>60 是 GitHub 对已鉴权请求的配额信号(匿名为 60);不回显 token 本身。
    hasToken: core.limit > 60,
  };
}

module.exports = {
  isEnabled,
  SUPPORTED_PLATFORMS,
  HOST_BY_PLATFORM,
  DEFAULT_PLATFORM,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  normalizePlatform,
  inferPlatform,
  resolvePlatform,
  parseRepoSlug,
  isSafeRepoArg,
  assertSafeRepoArg,
  buildCloneUrl,
  clampLimit,
  buildSearchRequest,
  parseSearchResults,
  // recon
  KEY_RECON_FILES,
  RECON_FILE_MAX_BYTES,
  RECON_MAX_KEY_FILES,
  isSafeReconPath,
  buildRepoMetaRequest,
  parseRepoMeta,
  buildContentsRequest,
  parseContents,
  buildFileRequest,
  parseFileContent,
  pickKeyFiles,
  deriveReconHints,
  // commits + 质量
  COMMITS_DEFAULT_LIMIT,
  COMMITS_MAX_LIMIT,
  CONVENTIONAL_TYPES,
  buildCommitsRequest,
  parseCommits,
  evaluateCommitQuality,
  // 代码搜索 + 速率限制(仅 github)
  buildCodeSearchRequest,
  parseCodeSearchResults,
  buildRateLimitRequest,
  parseRateLimit,
};
