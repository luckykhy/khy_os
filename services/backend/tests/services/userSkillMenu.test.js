'use strict';

/**
 * userSkillMenu.test.js — 用户自建技能进入 `/` 菜单 + 可执行的发现层回归。
 *
 * 背景(用户报 2026-07·Windows v0.1.149):khy 把技能脚手架成
 * `~/.khy/skills/<name>/{manifest.json, prompt.md}`,但 `/` 斜杠面板(REPL _getSlashCommands /
 * TUI SLASH_COMMANDS)从不枚举该约定 → 正确创建的用户技能永远不出现在菜单里、`/yt-dlp` 敲了
 * 也没反应。userSkillCommands.js 补上这条发现接缝:
 *   ① listUserSkillCommands() 扫技能根读 manifest.json,产出斜杠命令描述符;
 *   ② loadUserSkillPrompt() 读 prompt.md(回退 SKILL.md)正文供选中执行。
 *
 * 门控 KHY_USER_SKILL_MENU(默认开);绝不抛(fs/JSON 异常 → [] / null)。
 */

const { describe, test, expect, beforeEach, afterEach } = require('@jest/globals');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MOD = require.resolve('../../src/cli/repl/userSkillCommands');
function fresh() {
  delete require.cache[MOD];
  return require(MOD);
}

let TMP;
function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'khy-userskill-'));
}
function writeSkill(root, name, manifest, promptBody) {
  const dir = path.join(root, '.khy', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  if (promptBody != null) fs.writeFileSync(path.join(dir, 'prompt.md'), promptBody, 'utf-8');
  return dir;
}

beforeEach(() => { TMP = mkTmp(); });
afterEach(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('listUserSkillCommands — 发现用户技能为斜杠命令', () => {
  test('~/.khy/skills/yt-dlp 有 manifest+prompt → 列出 /yt-dlp,标签/描述正确', () => {
    writeSkill(TMP, 'yt-dlp', {
      name: 'yt-dlp',
      command: '/yt-dlp',
      description: '下载视频',
    }, '# yt-dlp\nUse `yt-dlp -f best`.');
    const mod = fresh();
    const list = mod.listUserSkillCommands({ home: TMP, cwd: TMP, builtinDir: path.join(TMP, '__no_builtin__') });
    const hit = list.find((c) => c.cmd === '/yt-dlp');
    expect(hit).toBeTruthy();
    expect(hit.label).toBe('yt-dlp');
    expect(hit.desc).toBe('下载视频');
    expect(hit._skillDir).toBe(path.join(TMP, '.khy', 'skills', 'yt-dlp'));
  });

  test('manifest 用 trigger(无前导斜杠) → 归一为 /…', () => {
    writeSkill(TMP, 'cli-yt-dlp', {
      name: 'CLI yt-dlp',
      trigger: 'cli-yt-dlp',
      description: 'x',
      aliases: ['ytd', '/ytdl'],
    }, 'body');
    const mod = fresh();
    const list = mod.listUserSkillCommands({ home: TMP, cwd: TMP, builtinDir: path.join(TMP, '__no_builtin__') });
    const hit = list.find((c) => c.cmd === '/cli-yt-dlp');
    expect(hit).toBeTruthy();
    expect(hit._aliases).toEqual(['/ytd', '/ytdl']);
  });

  test('缺 prompt.md → 命令仍列出;loadUserSkillPrompt 返回 null', () => {
    const dir = writeSkill(TMP, 'noprompt', { name: 'noprompt', command: '/noprompt' }, null);
    const mod = fresh();
    const list = mod.listUserSkillCommands({ home: TMP, cwd: TMP, builtinDir: path.join(TMP, '__no_builtin__') });
    expect(list.find((c) => c.cmd === '/noprompt')).toBeTruthy();
    expect(mod.loadUserSkillPrompt(dir)).toBeNull();
  });

  test('loadUserSkillPrompt 读 prompt.md 正文;prompt 缺失回退 SKILL.md', () => {
    const dir = writeSkill(TMP, 'withprompt', { name: 'withprompt', command: '/withprompt' }, 'PROMPT BODY');
    const mod = fresh();
    expect(mod.loadUserSkillPrompt(dir)).toBe('PROMPT BODY');
    // prompt.md 缺失 → 回退 SKILL.md
    const dir2 = path.join(TMP, '.khy', 'skills', 'skillmd');
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, 'manifest.json'), JSON.stringify({ name: 'x', command: '/x' }), 'utf-8');
    fs.writeFileSync(path.join(dir2, 'SKILL.md'), 'FALLBACK BODY', 'utf-8');
    expect(mod.loadUserSkillPrompt(dir2)).toBe('FALLBACK BODY');
  });

  test('项目 <cwd>/.khy/skills 也被扫描', () => {
    const proj = mkTmp();
    try {
      writeSkill(proj, 'projskill', { name: 'projskill', command: '/projskill' }, 'body');
      const mod = fresh();
      const list = mod.listUserSkillCommands({ home: path.join(proj, '__nohome__'), cwd: proj, builtinDir: path.join(proj, '__no_builtin__') });
      expect(list.find((c) => c.cmd === '/projskill')).toBeTruthy();
    } finally {
      try { fs.rmSync(proj, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});

describe('userSkillMenu — 门控与鲁棒性', () => {
  test('KHY_USER_SKILL_MENU=off → [](字节回退:不枚举用户技能)', () => {
    writeSkill(TMP, 'yt-dlp', { name: 'yt-dlp', command: '/yt-dlp' }, 'body');
    const mod = fresh();
    const list = mod.listUserSkillCommands({ env: { KHY_USER_SKILL_MENU: 'off' }, home: TMP, cwd: TMP, builtinDir: path.join(TMP, '__no_builtin__') });
    expect(list).toEqual([]);
    expect(mod.userSkillMenuEnabled({ KHY_USER_SKILL_MENU: 'off' })).toBe(false);
    expect(mod.userSkillMenuEnabled({})).toBe(true);
  });

  test('manifest.json 损坏(非法 JSON) → 跳过该技能,绝不抛', () => {
    const dir = path.join(TMP, '.khy', 'skills', 'broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{ not json', 'utf-8');
    const mod = fresh();
    expect(() => mod.listUserSkillCommands({ home: TMP, cwd: TMP, builtinDir: path.join(TMP, '__no_builtin__') })).not.toThrow();
    const list = mod.listUserSkillCommands({ home: TMP, cwd: TMP, builtinDir: path.join(TMP, '__no_builtin__') });
    expect(list.find((c) => c._skillName === 'broken')).toBeFalsy();
  });

  test('技能根目录不存在 → [],绝不抛', () => {
    const mod = fresh();
    const nope = path.join(TMP, 'does', 'not', 'exist');
    expect(() => mod.listUserSkillCommands({ home: nope, cwd: nope, builtinDir: nope })).not.toThrow();
    expect(mod.listUserSkillCommands({ home: nope, cwd: nope, builtinDir: nope })).toEqual([]);
  });

  test('loadUserSkillPrompt(无效入参) → null,绝不抛', () => {
    const mod = fresh();
    expect(mod.loadUserSkillPrompt(null)).toBeNull();
    expect(mod.loadUserSkillPrompt(123)).toBeNull();
    expect(mod.loadUserSkillPrompt('/no/such/dir')).toBeNull();
  });

  test('同名命令去重(先命中者胜,不重复列出)', () => {
    // 家目录与项目目录各放一个同名 /dup — 只应出现一次。
    writeSkill(TMP, 'dup', { name: 'dup-home', command: '/dup' }, 'home');
    const proj = TMP; // 同一 root 下项目与家目录都指向 TMP → 天然同一目录只一次
    const mod = fresh();
    const list = mod.listUserSkillCommands({ home: TMP, cwd: proj, builtinDir: path.join(TMP, '__no_builtin__') });
    const dups = list.filter((c) => c.cmd === '/dup');
    expect(dups.length).toBe(1);
  });
});
