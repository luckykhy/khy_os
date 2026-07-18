'use strict';

/**
 * skillInstallService.js — 薄 IO 层:把外部 skill 源(GitHub 仓库等)拉取并落到 khy 的 skills 目录。
 *
 * 定位(GOAL「khy 无生态,需适配连外部;如 skill 的安装」):对齐 `npx skills add <repo>`。khy 原生已
 * 认 SKILL.md/manifest.json 并在 <dataHome>/skills 自动发现,本服务补上「从仓库拉取」这一步:
 *   1. 纯叶子 skillSourceSpec.parseSource 把源写法归一成 {url, ref, subdir…};
 *   2. 浅克隆到系统临时目录(可注入 _clone 便于离线测试);
 *   3. 在克隆树里定位含 SKILL.md / manifest.json 的 skill 目录(--skill 子目录优先,否则根/容器扫描);
 *   4. 复用 skillPackageService.importSkill 把该目录复制到 <dataHome>/skills/<name>(loader 能发现处);
 *   5. 清理临时目录。
 *
 * 契约:所有真正的 IO 在这里;判定/解析在纯叶子 skillSourceSpec。失败抛 Error(handler 负责打印)。
 * 门控关(KHY_SKILL_ADD off)→ addFromSource 抛「未启用」,不触碰任何既有 skill 子命令。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const spec = require('../skills/skillSourceSpec');
const skillPackageService = require('./skillPackageService');

const CLONE_TIMEOUT_MS = 120000;

/**
 * 默认克隆实现:浅克隆到 dest。带 ref 时克隆后 checkout。可被 opts._clone 覆盖(测试注入本地 file:// 源)。
 * @param {string} url
 * @param {string} dest
 * @param {string} [ref]
 */
function _defaultClone(url, dest, ref) {
  const args = ['clone', '--depth', '1', '--no-tags'];
  if (ref) { args.push('--branch', ref); }
  args.push('--', url, dest);
  try {
    execFileSync('git', args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: CLONE_TIMEOUT_MS });
    return;
  } catch (err) {
    // 某些 ref 是 commit sha,--branch 不认 → 回退全量克隆 + checkout。
    if (ref) {
      try {
        execFileSync('git', ['clone', '--no-tags', '--', url, dest],
          { stdio: ['ignore', 'ignore', 'pipe'], timeout: CLONE_TIMEOUT_MS });
        execFileSync('git', ['-C', dest, 'checkout', ref],
          { stdio: ['ignore', 'ignore', 'pipe'], timeout: CLONE_TIMEOUT_MS });
        return;
      } catch (err2) {
        throw new Error(`git clone 失败(${url}${ref ? ` @ ${ref}` : ''}):${_gitErr(err2) || _gitErr(err)}`);
      }
    }
    throw new Error(`git clone 失败(${url}):${_gitErr(err)}`);
  }
}

function _gitErr(err) {
  if (!err) return '未知错误';
  const stderr = err.stderr && err.stderr.toString ? err.stderr.toString().trim() : '';
  return stderr || err.message || String(err);
}

/** 一个目录是否直接是「skill 目录」(含 SKILL.md 或 manifest.json)。 */
function _isSkillDir(dir) {
  try {
    return fs.existsSync(path.join(dir, 'SKILL.md')) || fs.existsSync(path.join(dir, 'manifest.json'));
  } catch {
    return false;
  }
}

/**
 * 在克隆根下定位要安装的 skill 目录(绝对路径)。
 *   - 显式 subdir → 只认它(不存在或不是 skill 目录 → 抛,附提示)。
 *   - 否则:根本身是 skill 目录 → 根;再在常见容器目录(skill/skills/.skills)下找**第一个**命名子目录。
 * @param {string} cloneRoot - 绝对路径
 * @param {object} s - parseSource 的 spec
 * @returns {string} 绝对路径
 */
function _locateSkillDir(cloneRoot, s) {
  if (s.subdir) {
    const abs = path.resolve(cloneRoot, s.subdir);
    // 越界保护:必须留在克隆根内。
    if (abs !== cloneRoot && !abs.startsWith(cloneRoot + path.sep)) {
      throw new Error(`--skill 子路径逃逸克隆目录:「${s.subdir}」。`);
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Error(`仓库内不存在子目录「${s.subdir}」。`);
    }
    if (!_isSkillDir(abs)) {
      throw new Error(`子目录「${s.subdir}」内没有 SKILL.md 或 manifest.json,不是一个 skill。`);
    }
    return abs;
  }

  // 根即 skill(单-skill 仓库)。
  if (_isSkillDir(cloneRoot)) return cloneRoot;

  // 容器目录下的第一个命名 skill 子目录(稳定字典序)。
  const containers = spec.candidateSkillDirs(s).filter(Boolean);
  const found = [];
  for (const c of containers) {
    const cdir = path.resolve(cloneRoot, c);
    if (cdir !== cloneRoot && !cdir.startsWith(cloneRoot + path.sep)) continue;
    let entries;
    try {
      if (!fs.existsSync(cdir) || !fs.statSync(cdir).isDirectory()) continue;
      entries = fs.readdirSync(cdir, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = path.join(cdir, e.name);
      if (_isSkillDir(child)) found.push({ name: e.name, dir: child });
    }
    if (found.length) break;
  }
  if (found.length === 1) return found[0].dir;
  if (found.length > 1) {
    const names = found.map((f) => f.name).sort().join(', ');
    throw new Error(`仓库含多个 skill(${names})。请用 --skill <名称> 指定要安装哪一个。`);
  }
  throw new Error('在仓库里没找到 SKILL.md 或 manifest.json。若 skill 在子目录,请用 --skill <路径> 指定。');
}

/** 递归删除临时目录(fail-soft;清理失败不影响主结果)。 */
function _rmrf(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

/**
 * 从外部源安装一个 skill。
 * @param {string} source - owner/repo | https://github.com/… | git@… (见 skillSourceSpec)
 * @param {object} [opts]
 * @param {string} [opts.skill] - `--skill <name|subpath>` 指定仓库内子目录
 * @param {object} [opts.env] - 门控用(默认 process.env)
 * @param {function} [opts._clone] - 注入克隆实现 (url, dest, ref) => void(测试/离线)
 * @param {string} [opts._tmpRoot] - 注入临时目录根(测试)
 * @returns {Promise<{name:string, dest:string, source:string, ref:string, subdir:string}>}
 */
async function addFromSource(source, opts = {}) {
  const env = opts.env || process.env;
  if (!spec.isSkillAddEnabled(env)) {
    throw new Error('`khy skill add` 未启用(KHY_SKILL_ADD 已关闭)。开启后可从 GitHub 等仓库安装 skill。');
  }

  const parsed = spec.parseSource(source, { skill: opts.skill });
  if (!parsed.ok) throw new Error(parsed.error);
  const s = parsed.spec;

  const clone = (typeof opts._clone === 'function') ? opts._clone : _defaultClone;
  const tmpRoot = opts._tmpRoot || os.tmpdir();
  const cloneRoot = fs.mkdtempSync(path.join(tmpRoot, 'khy-skill-'));

  try {
    clone(s.url, cloneRoot, s.ref || '');
    const skillDir = _locateSkillDir(cloneRoot, s);
    const result = await skillPackageService.importSkill(skillDir, {});
    return {
      name: result.name,
      dest: result.dest,
      source: s.url,
      ref: s.ref || '',
      subdir: s.subdir || '',
    };
  } finally {
    _rmrf(cloneRoot);
  }
}

module.exports = {
  addFromSource,
  _defaultClone,     // exposed for tests
  _locateSkillDir,   // exposed for tests
  _isSkillDir,       // exposed for tests
};
