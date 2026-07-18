'use strict';

/**
 * forgeClient.js — 薄 IO 层:在 forgeCore 的确定性逻辑之上,真正发起 forge 搜索(axios)与
 * 仓库克隆/更新(execFile git)。所有「什么算合法/安全/请求长什么样/响应怎么归一」都委派给
 * forgeCore(单一真源),本文件只做 IO + 读环境变量里的 token(从不回显、从不写日志)。
 *
 * 凭据纪律:
 *   · 搜索 token 从 env 读出后仅作为请求头/查询参数交给 axios,绝不打印、绝不进返回值。
 *   · clone URL 绝不内嵌 token —— 私有库由用户既有 git 凭据助手处理,避免泄漏进进程表。
 *   · git clone/pull 走 execFile(argv 数组,无 shell),并用 `--` 终结选项,杜绝参数注入。
 */

const { execFile } = require('child_process');
const forgeCore = require('./forgeCore');

const GIT_TIMEOUT_MS = 10 * 60 * 1000; // 克隆大库可能较久;给足 10 分钟。

// ── token 读取(平台 → 环境变量,优先级从高到低) ─────────────────────
const TOKEN_ENV_KEYS = {
  github: ['GITHUB_TOKEN', 'GH_TOKEN'],
  gitee: ['GITEE_TOKEN'],
  gitlab: ['GITLAB_TOKEN', 'GL_TOKEN'],
};

function _readToken(platform) {
  const keys = TOKEN_ENV_KEYS[platform] || [];
  for (const k of keys) {
    const v = String(process.env[k] || '').trim();
    if (v) return v;
  }
  return '';
}

// ── 搜索 ─────────────────────────────────────────────────────────────
/**
 * 在某 forge 上搜索仓库。返回 { ok, platform, query, results } 或 { ok:false, error }。
 * @param {{platform?: string, query: string, limit?: number, repoHint?: string}} opts
 * @param {object} [deps] - 可注入 { axios } 便于测试
 * @returns {Promise<object>}
 */
async function searchRepos(opts = {}, deps = {}) {
  if (!forgeCore.isEnabled()) {
    return { ok: false, error: 'forge 能力已被 KHY_FORGE 关闭' };
  }
  const platform = forgeCore.resolvePlatform(opts.platform, opts.repoHint || opts.query);
  const query = String(opts.query || '').trim();
  if (!query) return { ok: false, error: '缺少搜索关键词' };

  const token = _readToken(platform);
  const req = forgeCore.buildSearchRequest(platform, query, { limit: opts.limit, token });
  if (!req) return { ok: false, error: `无法为平台 ${platform} 构造搜索请求` };

  const axios = deps.axios || require('axios');
  try {
    const resp = await axios({
      method: req.method,
      url: req.url,
      headers: req.headers,
      params: req.params,
      timeout: 30000,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (resp.status >= 400) {
      // 不回显 token;只透出平台返回的简短信息。
      const msg = (resp.data && (resp.data.message || resp.data.error)) || `HTTP ${resp.status}`;
      return { ok: false, error: `搜索失败(${platform}): ${msg}`, status: resp.status };
    }
    const results = forgeCore.parseSearchResults(platform, resp.data);
    return { ok: true, platform, query, results };
  } catch (err) {
    return { ok: false, error: `搜索请求出错(${platform}): ${(err && err.message) || String(err)}` };
  }
}

// ── 克隆 ─────────────────────────────────────────────────────────────
function _runGit(args, { cwd, onActivity } = {}, deps = {}) {
  const runner = deps.execFile || execFile;
  return new Promise((resolve) => {
    let child;
    try {
      child = runner('git', args, { cwd: cwd || process.cwd(), timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            resolve({ ok: false, error: (stderr || err.message || String(err)).toString().trim() });
          } else {
            resolve({ ok: true, output: (stdout || stderr || '').toString().trim() });
          }
        });
    } catch (err) {
      resolve({ ok: false, error: (err && err.message) || String(err) });
      return;
    }
    if (onActivity && child && child.stderr) {
      // git 把进度写到 stderr;按行透传给调用方做进度展示。
      child.stderr.on('data', (chunk) => {
        try { onActivity(String(chunk).trim()); } catch { /* fail-soft */ }
      });
    }
  });
}

/**
 * 克隆一个仓库到本地目录。input 可为 owner/repo 或完整 git URL。
 * 经 forgeCore.buildCloneUrl 防注入 + 解析,clone URL 绝不内嵌 token。
 * @param {{input: string, platform?: string, dir?: string, ssh?: boolean, depth?: number, cwd?: string, onActivity?: function}} opts
 * @param {object} [deps]
 * @returns {Promise<object>} { ok, url, dir } 或 { ok:false, error }
 */
async function cloneRepo(opts = {}, deps = {}) {
  if (!forgeCore.isEnabled()) {
    return { ok: false, error: 'forge 能力已被 KHY_FORGE 关闭' };
  }
  const input = String(opts.input || '').trim();
  if (!input) return { ok: false, error: '缺少要克隆的仓库(owner/repo 或 git URL)' };

  const platform = forgeCore.resolvePlatform(opts.platform, input);
  let url;
  try {
    url = forgeCore.buildCloneUrl(input, platform, { ssh: opts.ssh === true });
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }

  // `--` 终结选项,url 之后才是目标目录,杜绝以 '-' 开头的参数被当 git 选项。
  const args = ['clone'];
  const depth = Number.parseInt(opts.depth, 10);
  if (Number.isFinite(depth) && depth > 0) args.push('--depth', String(depth));
  args.push('--', url);
  const dir = String(opts.dir || '').trim();
  if (dir) {
    if (!forgeCore.isSafeRepoArg(dir) && /[\s;'"`$()<>|]/.test(dir)) {
      return { ok: false, error: `不安全的目标目录: ${JSON.stringify(opts.dir)}` };
    }
    args.push(dir);
  }

  const res = await _runGit(args, { cwd: opts.cwd, onActivity: opts.onActivity }, deps);
  if (!res.ok) return { ok: false, error: res.error, url };
  return { ok: true, url, dir: dir || forgeCore.parseRepoSlug(input).split('/').pop() || '', output: res.output };
}

/**
 * 在已存在的本地仓库目录里执行 git pull(更新)。
 * @param {{dir?: string, remote?: string, branch?: string, onActivity?: function}} opts
 * @param {object} [deps]
 * @returns {Promise<object>}
 */
async function pullRepo(opts = {}, deps = {}) {
  if (!forgeCore.isEnabled()) {
    return { ok: false, error: 'forge 能力已被 KHY_FORGE 关闭' };
  }
  const dir = String(opts.dir || process.cwd()).trim();
  const args = ['-C', dir, 'pull'];
  const remote = String(opts.remote || '').trim();
  const branch = String(opts.branch || '').trim();
  // remote/branch 经安全字符校验后才追加(它们也会成为 git 参数)。
  if (remote && /^[A-Za-z0-9._/-]+$/.test(remote)) {
    args.push(remote);
    if (branch && /^[A-Za-z0-9._/-]+$/.test(branch)) args.push(branch);
  }
  const res = await _runGit(args, { onActivity: opts.onActivity }, deps);
  if (!res.ok) return { ok: false, error: res.error, dir };
  return { ok: true, dir, output: res.output };
}

// ── 仓库侦察(recon):从宽到窄探查一个仓库,产出可作「新建参考 / 部署依据」的结构化情报 ──
//
// 三个原子 IO(元数据 / 目录树 / 单文件)+ 一个编排 reconRepo,全部复用 forgeCore 的请求描述符与
// 归一(单一真源)。凭据纪律同搜索:token 只进请求头/查询参,绝不进返回值、绝不打印。

async function _axiosGet(req, deps, { responseType } = {}) {
  const axios = deps.axios || require('axios');
  const cfg = {
    method: req.method, url: req.url, headers: req.headers, params: req.params,
    timeout: 30000, validateStatus: (s) => s >= 200 && s < 500,
  };
  if (responseType) cfg.responseType = responseType;
  const resp = await axios(cfg);
  return resp;
}

function _httpErr(platform, resp, what) {
  const msg = (resp && resp.data && (resp.data.message || resp.data.error)) || `HTTP ${resp && resp.status}`;
  return { ok: false, error: `${what}失败(${platform}): ${msg}`, status: resp && resp.status };
}

/**
 * 取仓库元数据(规模/默认分支/许可证/topics…)。
 * @param {{input:string, platform?:string}} opts
 * @param {object} [deps]
 */
async function getRepoMeta(opts = {}, deps = {}) {
  if (!forgeCore.isEnabled()) return { ok: false, error: 'forge 能力已被 KHY_FORGE 关闭' };
  const input = String(opts.input || '').trim();
  if (!input) return { ok: false, error: '缺少仓库(owner/repo 或 git URL)' };
  const platform = forgeCore.resolvePlatform(opts.platform, input);
  let req;
  try { req = forgeCore.buildRepoMetaRequest(platform, input, { token: _readToken(platform) }); }
  catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  if (!req) return { ok: false, error: `无法为平台 ${platform} 构造元数据请求` };
  try {
    const resp = await _axiosGet(req, deps);
    if (resp.status >= 400) return _httpErr(platform, resp, '获取元数据');
    const meta = forgeCore.parseRepoMeta(platform, resp.data);
    if (!meta) return { ok: false, error: `元数据解析失败(${platform})` };
    return { ok: true, platform, meta };
  } catch (err) {
    return { ok: false, error: `元数据请求出错(${platform}): ${(err && err.message) || String(err)}` };
  }
}

/**
 * 列出某目录(默认顶层)内容。
 * @param {{input:string, platform?:string, path?:string, ref?:string}} opts
 */
async function listContents(opts = {}, deps = {}) {
  if (!forgeCore.isEnabled()) return { ok: false, error: 'forge 能力已被 KHY_FORGE 关闭' };
  const input = String(opts.input || '').trim();
  if (!input) return { ok: false, error: '缺少仓库' };
  const platform = forgeCore.resolvePlatform(opts.platform, input);
  let req;
  try { req = forgeCore.buildContentsRequest(platform, input, opts.path || '', { ref: opts.ref, token: _readToken(platform) }); }
  catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  if (!req) return { ok: false, error: `无法为平台 ${platform} 构造目录请求` };
  try {
    const resp = await _axiosGet(req, deps);
    if (resp.status >= 400) return _httpErr(platform, resp, '列出目录');
    return { ok: true, platform, path: String(opts.path || ''), entries: forgeCore.parseContents(platform, resp.data) };
  } catch (err) {
    return { ok: false, error: `目录请求出错(${platform}): ${(err && err.message) || String(err)}` };
  }
}

/**
 * 取单个文件文本(base64 自动解码;大小封顶)。
 * @param {{input:string, platform?:string, path:string, ref?:string, maxBytes?:number}} opts
 */
async function getFile(opts = {}, deps = {}) {
  if (!forgeCore.isEnabled()) return { ok: false, error: 'forge 能力已被 KHY_FORGE 关闭' };
  const input = String(opts.input || '').trim();
  const path = String(opts.path || '').trim();
  if (!input || !path) return { ok: false, error: '缺少仓库或文件路径' };
  const platform = forgeCore.resolvePlatform(opts.platform, input);
  let req;
  try { req = forgeCore.buildFileRequest(platform, input, path, { ref: opts.ref, token: _readToken(platform) }); }
  catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  if (!req) return { ok: false, error: `无法为平台 ${platform} 构造文件请求` };
  try {
    // gitlab raw 端点返回纯文本;github/gitee 返回含 base64 的 JSON。统一交给 parseFileContent。
    const resp = await _axiosGet(req, deps);
    if (resp.status >= 400) return _httpErr(platform, resp, '读取文件');
    const { text, truncated } = forgeCore.parseFileContent(platform, resp.data, { maxBytes: opts.maxBytes });
    return { ok: true, platform, path, text, truncated };
  } catch (err) {
    return { ok: false, error: `文件请求出错(${platform}): ${(err && err.message) || String(err)}` };
  }
}

/**
 * 仓库侦察编排:从宽到窄。元数据 → 顶层目录树 → 只拉取**实际存在**的关键文件(并发) →
 * 确定性洞见。任一步失败 fail-soft(尽量返回已拿到的部分,绝不抛)。
 * @param {{input:string, platform?:string, ref?:string}} opts
 * @param {object} [deps]
 * @returns {Promise<{ok, platform, meta, tree, keyFiles, hints} | {ok:false,error}>}
 */
async function reconRepo(opts = {}, deps = {}) {
  if (!forgeCore.isEnabled()) return { ok: false, error: 'forge 能力已被 KHY_FORGE 关闭' };
  const input = String(opts.input || '').trim();
  if (!input) return { ok: false, error: '缺少仓库(owner/repo 或 git URL)' };
  const platform = forgeCore.resolvePlatform(opts.platform, input);

  // 第 1 层:元数据(也给出默认分支,供 gitlab raw 文件读取用 ref)。
  const metaRes = await getRepoMeta({ input, platform }, deps);
  if (!metaRes.ok) return { ok: false, error: metaRes.error, platform };
  const meta = metaRes.meta;
  const ref = String(opts.ref || meta.defaultBranch || '').trim();

  // 第 2 层:顶层目录树。
  const treeRes = await listContents({ input, platform }, deps);
  const entries = treeRes.ok ? treeRes.entries : [];

  // 第 3 层:只精读实际存在的关键文件(并发;像列目录后按已知路径取文件)。
  const picks = forgeCore.pickKeyFiles(entries);
  const keyFiles = {};
  const fetched = await Promise.all(picks.map((f) =>
    getFile({ input, platform, path: f.path, ref }, deps)
      .then((r) => ({ name: f.name, r }))
      .catch((err) => ({ name: f.name, r: { ok: false, error: (err && err.message) || String(err) } }))));
  for (const { name, r } of fetched) {
    if (r && r.ok) keyFiles[name] = { text: r.text, truncated: r.truncated, path: r.path };
  }

  // 第 4 层:确定性洞见(monorepo / agent 指南 / 构建·部署命令)。
  const hints = forgeCore.deriveReconHints({ tree: entries, keyFiles });
  return { ok: true, platform, meta, tree: entries, keyFiles, hints };
}

// ── 提交历史 + 代码搜索 + 速率限制 ───────────────────────────────────
// 同样把「请求长什么样 / 响应怎么归一 / 质量怎么评」委派给 forgeCore(单一真源),本层只 IO。

/**
 * 取仓库最近提交并评估提交信息质量(Conventional Commits 规范度等)。
 * @param {{input:string, platform?:string, limit?:number, ref?:string, path?:string}} opts
 * @param {object} [deps]
 * @returns {Promise<{ok, platform, commits, quality} | {ok:false,error}>}
 */
async function getCommits(opts = {}, deps = {}) {
  if (!forgeCore.isEnabled()) return { ok: false, error: 'forge 能力已被 KHY_FORGE 关闭' };
  const input = String(opts.input || '').trim();
  if (!input) return { ok: false, error: '缺少仓库(owner/repo 或 git URL)' };
  const platform = forgeCore.resolvePlatform(opts.platform, input);
  let req;
  try {
    req = forgeCore.buildCommitsRequest(platform, input, {
      limit: opts.limit, ref: opts.ref, path: opts.path, token: _readToken(platform),
    });
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  if (!req) return { ok: false, error: `无法为平台 ${platform} 构造提交请求` };
  try {
    const resp = await _axiosGet(req, deps);
    if (resp.status >= 400) return _httpErr(platform, resp, '获取提交历史');
    const commits = forgeCore.parseCommits(platform, resp.data);
    const quality = forgeCore.evaluateCommitQuality(commits);
    return { ok: true, platform, commits, quality };
  } catch (err) {
    return { ok: false, error: `提交请求出错(${platform}): ${(err && err.message) || String(err)}` };
  }
}

/**
 * 跨 GitHub 搜索代码(目前仅 github 提供干净的公开端点)。
 * @param {{query:string, platform?:string, repo?:string, limit?:number}} opts
 * @param {object} [deps]
 * @returns {Promise<{ok, platform, query, results} | {ok:false,error}>}
 */
async function searchCode(opts = {}, deps = {}) {
  if (!forgeCore.isEnabled()) return { ok: false, error: 'forge 能力已被 KHY_FORGE 关闭' };
  const query = String(opts.query || '').trim();
  if (!query) return { ok: false, error: '缺少代码搜索关键词' };
  const platform = forgeCore.resolvePlatform(opts.platform, opts.repo || '');
  const token = _readToken(platform);
  const req = forgeCore.buildCodeSearchRequest(platform, query, { repo: opts.repo, limit: opts.limit, token });
  if (!req) {
    return { ok: false, error: `代码搜索暂仅支持 github(${platform} 无对等的公开代码搜索端点)` };
  }
  try {
    const resp = await _axiosGet(req, deps);
    if (resp.status >= 400) {
      // 代码搜索匿名常被拒;给出可操作提示(配置 GITHUB_TOKEN 提升配额/解锁)。
      const base = _httpErr(platform, resp, '代码搜索');
      if (resp.status === 401 || resp.status === 403) {
        base.error += '(代码搜索通常需要鉴权:设置 GITHUB_TOKEN 环境变量)';
      }
      return base;
    }
    const results = forgeCore.parseCodeSearchResults(platform, resp.data);
    return { ok: true, platform, query, results };
  } catch (err) {
    return { ok: false, error: `代码搜索出错(${platform}): ${(err && err.message) || String(err)}` };
  }
}

/**
 * 查询 API 速率限制配额(目前仅 github)。用于「对接前先看还剩多少额度」。
 * @param {{platform?:string}} opts
 * @param {object} [deps]
 * @returns {Promise<{ok, platform, rate} | {ok:false,error}>}
 */
async function checkRateLimit(opts = {}, deps = {}) {
  if (!forgeCore.isEnabled()) return { ok: false, error: 'forge 能力已被 KHY_FORGE 关闭' };
  const platform = forgeCore.resolvePlatform(opts.platform, '');
  const req = forgeCore.buildRateLimitRequest(platform, { token: _readToken(platform) });
  if (!req) return { ok: false, error: `速率限制查询暂仅支持 github(${platform} 无对等端点)` };
  try {
    const resp = await _axiosGet(req, deps);
    if (resp.status >= 400) return _httpErr(platform, resp, '查询速率限制');
    const rate = forgeCore.parseRateLimit(platform, resp.data);
    if (!rate) return { ok: false, error: `速率限制解析失败(${platform})` };
    return { ok: true, platform, rate };
  } catch (err) {
    return { ok: false, error: `速率限制请求出错(${platform}): ${(err && err.message) || String(err)}` };
  }
}

module.exports = {
  searchRepos,
  cloneRepo,
  pullRepo,
  getRepoMeta,
  listContents,
  getFile,
  reconRepo,
  getCommits,
  searchCode,
  checkRateLimit,
  _readToken, // 导出供测试(验证不回显);返回值仅作请求,绝不进展示层
};
