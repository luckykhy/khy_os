'use strict';

/**
 * forge.js — `khy forge` 命令处理器:查找 / 拉取 GitHub·Gitee·GitLab 上的项目。
 *
 * 上传(push)与提交(commit)已有现成入口(`khy repo publish` / `khy repo save`、
 * tools/gitPush.js / tools/gitCommit.js),本处理器**只补真缺口**:跨平台「查找」与
 * 「拉取(clone/pull)」。所有确定性逻辑委派 services/forge/forgeCore(单一真源),
 * IO 走 services/forge/forgeClient(token 从 env 读、从不回显;git 走 execFile argv 无 shell)。
 *
 * 用法:
 *   khy forge search "<关键词>" [--platform github|gitee|gitlab] [--limit N] [--json]
 *   khy forge recon <owner/repo|git-url> [--platform ...] [--ref 分支] [--json]
 *   khy forge commits <owner/repo|git-url> [--platform ...] [--limit N] [--ref 分支] [--json]
 *   khy forge code "<查询>" [--repo owner/repo] [--limit N] [--json]   （仅 github)
 *   khy forge ratelimit [--json]                                       （仅 github)
 *   khy forge clone <owner/repo|git-url> [--platform ...] [--dir 名称] [--depth 1] [--ssh]
 *   khy forge pull [目录] [--remote origin] [--branch main]
 */

const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const { printInfo, printWarn, printError, printSuccess } = require('../formatters');

function _printHelp() {
  printInfo('khy forge — 查找 / 拉取 GitHub·Gitee·GitLab 项目（上传用 khy repo publish，提交用 khy repo save）');
  printInfo('  khy forge search "<关键词>" [--platform github|gitee|gitlab] [--limit N]');
  printInfo('  khy forge recon <owner/repo|git-url> [--platform ...] [--ref 分支]  侦察:元数据/结构/关键文件/构建·部署提示');
  printInfo('  khy forge commits <owner/repo|git-url> [--platform ...] [--limit N] [--ref 分支]  最近提交 + 提交质量评分');
  printInfo('  khy forge code "<查询>" [--repo owner/repo] [--limit N]  跨 GitHub 搜索代码(仅 github)');
  printInfo('  khy forge ratelimit  查询 API 速率限制配额(仅 github)');
  printInfo('  khy forge clone <owner/repo|git-url> [--platform ...] [--dir 名称] [--depth 1] [--ssh]');
  printInfo('  khy forge pull [目录] [--remote origin] [--branch main]');
  printInfo('  --json 机器可读输出。私有库鉴权用 GITHUB_TOKEN / GITEE_TOKEN / GITLAB_TOKEN 环境变量。');
}

function _renderSearch(res) {
  if (!res.ok) { printError(`❌ ${res.error}`); return; }
  if (!res.results.length) { printWarn(`未找到匹配「${res.query}」的仓库（${res.platform}）`); return; }
  printInfo(chalk.cyan(`🔎 ${res.platform} 上「${res.query}」的前 ${res.results.length} 个结果:`));
  for (const r of res.results) {
    const stars = r.stars ? chalk.yellow(`★${r.stars}`) : '';
    const lang = r.language ? chalk.gray(`[${r.language}]`) : '';
    printInfo(`  ${chalk.bold(r.fullName)} ${stars} ${lang}`.trimEnd());
    if (r.description) printInfo(`    ${chalk.gray(r.description)}`);
    if (r.cloneUrl) printInfo(`    ${chalk.gray(r.cloneUrl)}`);
  }
  printInfo(chalk.gray(`  拉取:khy forge clone ${res.results[0].fullName}`));
}

function _renderRecon(res) {
  if (!res.ok) { printError(`❌ ${res.error}`); return; }
  const m = res.meta || {};
  printInfo(chalk.cyan(`🔬 ${res.platform} 仓库侦察:${chalk.bold(m.fullName || '')}`));
  if (m.description) printInfo(`  ${chalk.gray(m.description)}`);
  const facts = [];
  if (m.stars != null) facts.push(chalk.yellow(`★${m.stars}`));
  if (m.forks != null) facts.push(chalk.gray(`⑂${m.forks}`));
  if (m.language) facts.push(chalk.gray(`[${m.language}]`));
  if (m.license) facts.push(chalk.gray(m.license));
  if (m.defaultBranch) facts.push(chalk.gray(`@${m.defaultBranch}`));
  if (facts.length) printInfo(`  ${facts.join('  ')}`);
  if (Array.isArray(m.topics) && m.topics.length) printInfo(`  ${chalk.gray('topics: ' + m.topics.join(', '))}`);

  const tree = Array.isArray(res.tree) ? res.tree : [];
  if (tree.length) {
    const top = tree.slice(0, 24).map((e) => (e.type === 'dir' ? chalk.blue(e.name + '/') : e.name)).join('  ');
    printInfo(chalk.cyan('  顶层结构:'));
    printInfo(`    ${top}${tree.length > 24 ? chalk.gray(` …(+${tree.length - 24})`) : ''}`);
  }

  const keys = res.keyFiles && typeof res.keyFiles === 'object' ? Object.keys(res.keyFiles) : [];
  if (keys.length) printInfo(chalk.cyan(`  已读关键文件:${keys.join(', ')}`));

  const h = res.hints || {};
  const tags = [];
  if (h.isMonorepo) tags.push('monorepo');
  if (h.hasAgentGuide) tags.push('agent 指南');
  if (h.hasDocker) tags.push('Docker');
  if (h.packageManager) tags.push(h.packageManager);
  if (tags.length) printInfo(chalk.cyan(`  洞见:`) + ' ' + tags.join(' · '));
  if (Array.isArray(h.buildCommands) && h.buildCommands.length) {
    printInfo(chalk.cyan('  构建/运行:'));
    for (const c of h.buildCommands) printInfo(`    ${chalk.green(c)}`);
  }
  if (Array.isArray(h.deployHints) && h.deployHints.length) {
    printInfo(chalk.cyan('  部署线索:'));
    for (const c of h.deployHints) printInfo(`    ${chalk.gray(c)}`);
  }
  if (Array.isArray(h.notes) && h.notes.length) {
    for (const n of h.notes) printInfo(`  ${chalk.gray('· ' + n)}`);
  }
  printInfo(chalk.gray(`  作参考克隆:khy forge clone ${m.fullName || '<owner/repo>'}`));
}

function _gradeColor(grade) {
  if (grade === 'A' || grade === 'B') return chalk.green;
  if (grade === 'C') return chalk.yellow;
  return chalk.red;
}

function _renderCommits(res) {
  if (!res.ok) { printError(`❌ ${res.error}`); return; }
  const q = res.quality || {};
  const commits = Array.isArray(res.commits) ? res.commits : [];
  const gc = _gradeColor(q.grade);
  printInfo(chalk.cyan(`📜 ${res.platform} 最近 ${commits.length} 条提交 — 质量评分 `) + gc(`${q.score != null ? q.score : '?'}/100 (${q.grade || 'N/A'})`));
  if (Array.isArray(q.notes)) for (const n of q.notes) printInfo(`  ${chalk.gray('· ' + n)}`);
  const show = commits.slice(0, 12);
  for (const c of show) {
    const sha = c.sha ? chalk.yellow(String(c.sha).slice(0, 7)) : '';
    const author = c.author ? chalk.gray(`(${c.author})`) : '';
    printInfo(`  ${sha} ${c.subject || ''} ${author}`.trimEnd());
  }
  if (commits.length > show.length) printInfo(chalk.gray(`  …(+${commits.length - show.length})`));
}

function _renderCode(res) {
  if (!res.ok) { printError(`❌ ${res.error}`); return; }
  const results = Array.isArray(res.results) ? res.results : [];
  if (!results.length) { printWarn(`未找到匹配「${res.query}」的代码(${res.platform})`); return; }
  printInfo(chalk.cyan(`🔎 ${res.platform} 代码搜索「${res.query}」前 ${results.length} 个结果:`));
  for (const r of results) {
    printInfo(`  ${chalk.bold(r.repo)} ${chalk.gray(r.path)}`);
    if (r.url) printInfo(`    ${chalk.gray(r.url)}`);
  }
}

function _renderRateLimit(res) {
  if (!res.ok) { printError(`❌ ${res.error}`); return; }
  const rate = res.rate || {};
  const core = rate.core || {};
  const search = rate.search || {};
  // reset(unix 秒)→ 人读时刻。收敛到 ccFormat SSOT(对齐 CC formatResetTime:
  // 距重置 >24h 补月日、≤24h 仅时间、整点省分钟、跨年补年;门控 KHY_CC_FORMAT 关
  // 时逐字节回退旧 ISO-UTC 串)。ccFormat 是纯叶子,Date.now() 在此 call-site 读。
  const cc = require('../ccFormat');
  const _nowMs = Date.now();
  const fmtReset = (sec) => {
    if (!sec) return '';
    let legacy;
    try { legacy = new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'; } catch { legacy = String(sec); }
    return cc.ccFormatResetTimeOr(sec, _nowMs, legacy, process.env);
  };
  printInfo(chalk.cyan(`⏱️  ${res.platform} API 速率限制${rate.hasToken ? chalk.green('(已鉴权)') : chalk.yellow('(匿名)')}`));
  printInfo(`  核心:${chalk.bold(core.remaining)} / ${core.limit} 剩余` + (core.reset ? chalk.gray(`  重置于 ${fmtReset(core.reset)}`) : ''));
  printInfo(`  搜索:${chalk.bold(search.remaining)} / ${search.limit} 剩余` + (search.reset ? chalk.gray(`  重置于 ${fmtReset(search.reset)}`) : ''));
  if (!rate.hasToken) printInfo(chalk.gray('  提示:设置 GITHUB_TOKEN 环境变量可大幅提升配额并解锁代码搜索。'));
}

/**
 * 处理 `khy forge` 命令。
 * @param {string} subCommand - 'search' | 'recon' | 'clone' | 'pull' | 'help'
 * @param {string[]} args
 * @param {object} options - 解析后的 flags
 * @param {object} [deps] - 测试注入:{ searchRepos, reconRepo, cloneRepo, pullRepo }
 * @returns {Promise<boolean>}
 */
async function handleForge(subCommand, args = [], options = {}, deps = {}) {
  const sub = String(subCommand || 'help').toLowerCase();

  if (sub === 'help' || options.help) { _printHelp(); return true; }

  const client = require('../../services/forge/forgeClient');
  const searchRepos = deps.searchRepos || client.searchRepos;
  const cloneRepo = deps.cloneRepo || client.cloneRepo;
  const pullRepo = deps.pullRepo || client.pullRepo;
  const reconRepo = deps.reconRepo || client.reconRepo;
  const getCommits = deps.getCommits || client.getCommits;
  const searchCode = deps.searchCode || client.searchCode;
  const checkRateLimit = deps.checkRateLimit || client.checkRateLimit;

  // ── search ────────────────────────────────────────────────────────
  if (sub === 'search' || sub === 'find') {
    const query = args.join(' ').trim() || String(options.query || '').trim();
    if (!query) { printError('❌ 用法:khy forge search "<关键词>"'); return true; }
    let res;
    try {
      res = await searchRepos({
        platform: options.platform || options.provider,
        query,
        limit: options.limit,
      });
    } catch (err) { res = { ok: false, error: (err && err.message) || String(err) }; }
    if (options.json) { process.stdout.write(JSON.stringify(res) + '\n'); return true; }
    _renderSearch(res);
    return true;
  }

  // ── recon (侦察:从宽到窄探查一个仓库)──────────────────────────────
  if (sub === 'recon' || sub === 'inspect' || sub === 'explore') {
    const repo = String(args[0] || options.repo || '').trim();
    if (!repo) { printError('❌ 用法:khy forge recon <owner/repo 或 git URL>'); return true; }
    if (!options.json) printInfo(chalk.cyan(`🔬 正在侦察 ${repo} …`));
    let res;
    try {
      res = await reconRepo({
        input: repo,
        platform: options.platform || options.provider,
        ref: options.ref || options.branch,
      });
    } catch (err) { res = { ok: false, error: (err && err.message) || String(err) }; }
    if (options.json) { process.stdout.write(JSON.stringify(res) + '\n'); return true; }
    _renderRecon(res);
    return true;
  }

  // ── commits (最近提交 + 提交质量评分)──────────────────────────────
  if (sub === 'commits' || sub === 'log' || sub === 'history') {
    const repo = String(args[0] || options.repo || '').trim();
    if (!repo) { printError('❌ 用法:khy forge commits <owner/repo 或 git URL>'); return true; }
    if (!options.json) printInfo(chalk.cyan(`📜 正在读取 ${repo} 的提交历史 …`));
    let res;
    try {
      res = await getCommits({
        input: repo,
        platform: options.platform || options.provider,
        limit: options.limit,
        ref: options.ref || options.branch,
        path: options.path,
      });
    } catch (err) { res = { ok: false, error: (err && err.message) || String(err) }; }
    if (options.json) { process.stdout.write(JSON.stringify(res) + '\n'); return true; }
    _renderCommits(res);
    return true;
  }

  // ── code (跨 GitHub 搜索代码)──────────────────────────────────────
  if (sub === 'code' || sub === 'code-search' || sub === 'grep') {
    const query = args.join(' ').trim() || String(options.query || '').trim();
    if (!query) { printError('❌ 用法:khy forge code "<查询>" [--repo owner/repo]'); return true; }
    if (!options.json) printInfo(chalk.cyan(`🔎 正在搜索代码「${query}」…`));
    let res;
    try {
      res = await searchCode({
        query,
        repo: options.repo,
        platform: options.platform || options.provider,
        limit: options.limit,
      });
    } catch (err) { res = { ok: false, error: (err && err.message) || String(err) }; }
    if (options.json) { process.stdout.write(JSON.stringify(res) + '\n'); return true; }
    _renderCode(res);
    return true;
  }

  // ── ratelimit (API 配额)──────────────────────────────────────────
  if (sub === 'ratelimit' || sub === 'rate-limit' || sub === 'rate' || sub === 'quota') {
    let res;
    try {
      res = await checkRateLimit({ platform: options.platform || options.provider });
    } catch (err) { res = { ok: false, error: (err && err.message) || String(err) }; }
    if (options.json) { process.stdout.write(JSON.stringify(res) + '\n'); return true; }
    _renderRateLimit(res);
    return true;
  }

  // ── clone ─────────────────────────────────────────────────────────
  if (sub === 'clone' || sub === 'pull-down' || sub === 'get') {
    const repo = String(args[0] || options.repo || '').trim();
    if (!repo) { printError('❌ 用法:khy forge clone <owner/repo 或 git URL>'); return true; }
    if (!options.json) printInfo(chalk.cyan(`⬇️  正在克隆 ${repo} …`));
    let res;
    try {
      res = await cloneRepo({
        input: repo,
        platform: options.platform || options.provider,
        dir: options.dir || args[1],
        depth: options.depth,
        ssh: options.ssh === true,
        onActivity: options.json ? undefined : (line) => { if (line) printInfo(chalk.gray(`  ${line}`)); },
      });
    } catch (err) { res = { ok: false, error: (err && err.message) || String(err) }; }
    if (options.json) { process.stdout.write(JSON.stringify(res) + '\n'); return true; }
    if (res.ok) { printSuccess(`✅ 已克隆到 ${res.dir || '当前目录'}（${res.url}）`); }
    else { printError(`❌ 克隆失败:${res.error}`); }
    return true;
  }

  // ── pull (update existing) ────────────────────────────────────────
  if (sub === 'update' || sub === 'pull') {
    const dir = String(args[0] || options.dir || process.cwd()).trim();
    if (!options.json) printInfo(chalk.cyan(`🔄 正在更新 ${dir} …`));
    let res;
    try {
      res = await pullRepo({ dir, remote: options.remote, branch: options.branch,
        onActivity: options.json ? undefined : (line) => { if (line) printInfo(chalk.gray(`  ${line}`)); } });
    } catch (err) { res = { ok: false, error: (err && err.message) || String(err) }; }
    if (options.json) { process.stdout.write(JSON.stringify(res) + '\n'); return true; }
    if (res.ok) { printSuccess(`✅ 已更新 ${res.dir}`); if (res.output) printInfo(chalk.gray(res.output)); }
    else { printError(`❌ 更新失败:${res.error}`); }
    return true;
  }

  printWarn(`未知子命令:forge ${subCommand}`);
  _printHelp();
  return true;
}

module.exports = { handleForge };
