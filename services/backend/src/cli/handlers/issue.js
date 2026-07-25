'use strict';

/**
 * issue.js — `/issue` 命令薄壳:从会话上下文创建 GitHub issue / bug 报告。
 *
 * 对齐 Claude Code `/issue`。真正的「背后逻辑」(参数解析 / git remote → owner/repo /
 * transcript → issue 正文汇总 / 降级 URL 构造)在纯叶子 issueReport.js;本薄壳只做 IO:
 *   1. 解析参数(叶子);
 *   2. 读 git remote(execSync,3s 超时)→ owner/repo(叶子);
 *   3. 读会话 JSONL transcript(经 sessionPersistence.jsonlPathFor)→ 汇总正文(叶子);
 *   4. 读 .github/ISSUE_TEMPLATE 首个模板(可选);
 *   5. **降级阶梯**:gh 可用 + 有 remote → `gh issue create`(spawn,网络写);
 *      否则 → 浏览器 URL;body 超长 → 落本地草稿 getDataDir('issue-drafts')。
 *
 * **诚实边界**:实际创建 issue 需 gh CLI + GitHub 认证 + 网络;无 gh / 无 remote / 无认证 / 离线 →
 * **绝不假装已创建**,而是给出浏览器 URL + 本地草稿路径,并提示 `gh auth login`。
 * 复用既有 `prCreateService.detectPlatform()` 探测 gh(不另写)。绝不硬编码 host/path
 * (远端 host/owner/repo 全来自 git remote;草稿路径走 getDataDir)。
 *
 * 门控 KHY_ISSUE 默认开;关 → 命令不接管(字节回退到「无此命令」的历史世界)。
 *
 * 用法:
 *   /issue <标题...>
 *   /issue --label bug -l urgent --assignee alice <标题...>
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { printInfo, printError, printWarn, printSuccess } = require('../formatters');
const issueReport = require('../../services/issue/issueReport');

const MAX_TRANSCRIPT_LINES = 20000; // OOM 帽,与 perfIssue 同

/** 读 git remote origin URL(fail-soft)。 */
function _gitRemoteUrl(cwd) {
  try {
    return execSync('git remote get-url origin', { cwd, encoding: 'utf-8', timeout: 3000 }).trim();
  } catch {
    return '';
  }
}

/** 解析会话 JSONL → 条目数组(fail-soft;逐行 JSON.parse;>上限只取尾部)。 */
function _readTranscript(file) {
  let raw;
  try {
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return [];
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  let lines = raw.split('\n');
  if (lines.length > MAX_TRANSCRIPT_LINES) lines = lines.slice(-MAX_TRANSCRIPT_LINES);
  const out = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

/** 读 .github/ISSUE_TEMPLATE 首个 .md 模板(fail-soft;可空)。 */
function _detectTemplate(cwd) {
  try {
    const dir = path.join(cwd, '.github', 'ISSUE_TEMPLATE');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return '';
    const md = fs.readdirSync(dir).filter((f) => /\.md$/i.test(f)).sort();
    if (!md.length) return '';
    return fs.readFileSync(path.join(dir, md[0]), 'utf-8');
  } catch {
    return '';
  }
}

/** gh 是否可用(复用既有 prCreateService.detectPlatform,不另写探测)。 */
function _ghAvailable() {
  try {
    const { detectPlatform } = require('../../services/prCreateService');
    return detectPlatform() === 'github';
  } catch {
    return false;
  }
}

/**
 * @param {string} subCommand 第一个位置参数
 * @param {string[]} args 其余参数
 * @returns {Promise<boolean>}
 */
async function handleIssue(subCommand, args = [], _options = {}) {
  if (!issueReport.isEnabled(process.env)) {
    printInfo('issue 上报功能已关闭(KHY_ISSUE)。');
    return false;
  }

  // 合并 subCommand + args 为完整参数序列(router 把首词拆给 subCommand)。
  const allArgs = [subCommand, ...(Array.isArray(args) ? args : [])]
    .map((a) => String(a == null ? '' : a))
    .filter((a) => a.length > 0);

  const parsed = issueReport.parseIssueArgs(allArgs);
  if (!parsed.valid) {
    printWarn(`参数无效:${parsed.parseError || '缺少标题'}`);
    printInfo('用法:/issue [--label <l>]* [--assignee <u>]* <标题...>');
    return true;
  }

  const cwd = process.cwd();

  // git remote → owner/repo。
  const remoteUrl = _gitRemoteUrl(cwd);
  const repoInfo = issueReport.parseRemoteOwnerRepo(remoteUrl);

  // 会话 transcript → 正文汇总。
  let transcript = [];
  try {
    const sessionPersistence = require('../../services/sessionPersistence');
    const recent = sessionPersistence.listPersistedSessions({ limit: 1 }) || [];
    const sid = recent.length && recent[0] ? recent[0].sessionId : null;
    if (sid) transcript = _readTranscript(sessionPersistence.jsonlPathFor(sid));
  } catch (e) {
    printWarn(`无法读取会话 transcript:${e && e.message ? e.message : e}`);
  }

  const template = _detectTemplate(cwd);
  const body = issueReport.buildIssueBody({ transcript, template, title: parsed.title });

  // ── 降级阶梯 ──────────────────────────────────────────────
  const hasRepo = !!(repoInfo && repoInfo.owner && repoInfo.repo);

  // 分支 A:gh 可用 + 有 remote → 真创建(网络写)。
  if (hasRepo && _ghAvailable()) {
    const ghArgs = ['issue', 'create', '--title', parsed.title, '--body', body,
      '--repo', `${repoInfo.owner}/${repoInfo.repo}`];
    for (const l of parsed.labels) ghArgs.push('--label', l);
    for (const a of parsed.assignees) ghArgs.push('--assignee', a);
    try {
      const r = spawnSync('gh', ghArgs, { cwd, encoding: 'utf-8', timeout: 30000 });
      if (r.status === 0) {
        const out = String(r.stdout || '').trim();
        printSuccess('issue 已创建。');
        if (out) printInfo(out);
        return true;
      }
      printWarn(`gh issue create 失败:${String(r.stderr || '').trim() || `exit ${r.status}`}`);
      printInfo('可能需要先 `gh auth login`。下面给出浏览器链接降级方案:');
    } catch (e) {
      printWarn(`gh 调用异常:${e && e.message ? e.message : e}`);
    }
  }

  // 分支 B:降级为浏览器 URL(+ body 超长落本地草稿)。
  if (hasRepo) {
    const { url, bodyTruncated } = issueReport.buildIssueUrl({
      host: repoInfo.host, owner: repoInfo.owner, repo: repoInfo.repo,
      title: parsed.title, body, labels: parsed.labels,
    });
    printInfo('在浏览器中打开以下链接创建 issue:');
    printInfo(url);
    if (bodyTruncated) {
      const draftPath = _writeDraft(parsed.title, body);
      if (draftPath) {
        printWarn('正文较长,URL 中已截断;完整正文已存为本地草稿:');
        printInfo(draftPath);
      }
    }
    if (!_ghAvailable()) printInfo('提示:安装并 `gh auth login` 后,/issue 可直接创建。');
    return true;
  }

  // 分支 C:无 remote → 只能落本地草稿。
  const draftPath = _writeDraft(parsed.title, body);
  printWarn('未检测到 git remote(origin),无法定位仓库。');
  if (draftPath) {
    printInfo('已将 issue 草稿存到本地:');
    printInfo(draftPath);
  }
  return true;
}

/** 落本地草稿到 getDataDir('issue-drafts')(绝不硬编码路径)。fail-soft 返回路径或 null。 */
function _writeDraft(title, body) {
  try {
    const { getDataDir } = require('../../utils/dataHome');
    const dir = getDataDir('issue-drafts');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(dir, `issue-${stamp}.md`);
    const content = `# ${title}\n\n${body}\n`;
    fs.writeFileSync(outPath, content, 'utf-8');
    return outPath;
  } catch (e) {
    printError(`保存草稿失败:${e && e.message ? e.message : e}`);
    return null;
  }
}

module.exports = { handleIssue, _readTranscript, _detectTemplate, _gitRemoteUrl };
