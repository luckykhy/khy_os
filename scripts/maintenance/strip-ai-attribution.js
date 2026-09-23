#!/usr/bin/env node
/**
 * 清除提交历史里的 AI 署名尾注（B 方案执行器）
 *
 * 用法：
 *   node scripts/maintenance/strip-ai-attribution.js                      # 干跑，只报告
 *   node scripts/maintenance/strip-ai-attribution.js --apply              # 真跑（会打印待执行命令）
 *   node scripts/maintenance/strip-ai-attribution.js --apply --push       # 真跑并强推
 *
 * 背景与为什么需要它
 * ------------------
 * 本仓历史里有 61 处提交尾注形如：
 *     Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
 *     Co-authored-by: CommandCodeBot <noreply@commandcode.ai>
 * 这些是 **commit message 里的一行文本**，不是 git 的 co-author 字段。
 * GitHub 渲染提交页时，尾注邮箱匹配到已注册账号，就把对方挂进仓库 Contributors 名单。
 * 由于显示名与头像由对方账号自己控制，**无法从名单里移除**；唯一出路是让这些
 * 尾注不再存在于历史中——即改写提交历史。
 *
 * 重要约束（本脚本遵守）
 * ----------------------
 * 1. **不在当前仓库原地改写。** 本地对象库缺失 380 个对象、三个分支断链
 *    （git log 无法遍历），原地重写会把残缺状态固化下去。
 *    故要求在一个**全新的孤立克隆**里执行：本脚本会检查对象库健康度并拒绝就地运行。
 * 2. 改写范围**只限 message**，不碰任何 tree/blob，因此文件内容零变化。
 * 3. 改写前后做逐条比对，确认「只少了署名行」。
 * 4. 强推前必须存在 backup 引用（回退动作，且不依赖任何未提交的代码 —— PP-4）。
 *
 * 与既有机制的关系
 * ----------------
 * - `scripts/ci/check-commit-message.js`：**前置拦截**，防新增（已在 pre-commit 生效）。
 * - `scripts/ci/check-copyright-readiness.js`：基线统计（S1 观察者，不阻断）。
 * - 本脚本：**一次性历史治理**，不参与日常门禁，故放在 maintenance/ 而非 ci/。
 *
 * 依据：PROCESS-010 C-M、[DESIGN-IP-001]、[DESIGN-PROCESS-002] PP-4。
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const PUSH = process.argv.includes('--push');
const ROOT = process.cwd();

/** AI 署名形态。必须与 scripts/ci/check-commit-message.js 的 AI_NAMES 同源。 */
const AI_NAMES =
  'claude|gpt|copilot|cursor|anthropic|openai|commandcode|codebuddy|gemini|qwen|deepseek';

/**
 * 逐行判定：这一行是不是「真署名」。
 * 与 pre-commit 拦截器保持同一判据 —— 必须带 <邮箱>，避免误删正文里
 * 讨论「禁止 Co-Authored-By: Claude」这类正当文本。
 */
const AI_LINE_RES = [
  new RegExp(`^\\s*co-authored-by:\\s*[^\\n<]*(?:${AI_NAMES})[^\\n]*<[^>]+>\\s*$`, 'i'),
  new RegExp(`^\\s*generated with\\s+\\[?(?:${AI_NAMES})`, 'i'),
  /^\s*🤖\s*generated/i,
];

const isAiAttributionLine = (line) => AI_LINE_RES.some((re) => re.test(line));

/** 从 message 中剥离 AI 署名行；返回 {next, removed}。 */
function stripMessage(message) {
  const lines = message.split('\n');
  const kept = [];
  const removed = [];
  for (const line of lines) {
    if (isAiAttributionLine(line)) removed.push(line);
    else kept.push(line);
  }
  if (!removed.length) return { next: message, removed };
  // 剥掉尾部因此产生的多余空行，但不动正文内部的空行结构
  let next = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/, '');
  if (!next.endsWith('\n')) next += '\n';
  return { next, removed };
}

const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
const trySh = (cmd, fallback = '') => {
  try {
    return sh(cmd);
  } catch {
    return fallback;
  }
};

/**
 * 跑一条「允许非零退出码」的命令，同时拿到 stdout + stderr。
 *
 * 为什么需要它：`git fsck` 在发现任何损坏时**退出码非 0**（本仓实测为 10），
 * 而且它的诊断信息走 stdout、git 自身的 error 走 stderr。早期版本用 trySh 包住它，
 * 于是「非零退出」被当成「命令不可用」而返回空串 —— 损坏被静默吞掉，
 * 健康检查恒报「✅ 对象库健康」。这是**假阴性**，比不做检查更危险：
 * 它会让人在一个残缺仓库上启动历史改写。
 * 故这里必须显式并取两个流、且不把非零退出码当作失败。
 */
function runCapture(cmd) {
  try {
    const out = execSync(cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
    return { stdout: out, stderr: '', status: 0 };
  } catch (e) {
    return {
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : '',
      status: typeof e.status === 'number' ? e.status : 1,
    };
  }
}

// ── 门 0：必须在健康的仓库里跑 ────────────────────────────────────────────
console.log('🔍 B 方案 · 清除历史 AI 署名尾注');
console.log('='.repeat(64));

const headSha = trySh('git rev-parse HEAD');
if (!headSha) {
  console.error('❌ 当前目录不是 git 仓库。');
  process.exit(2);
}

// ① shallow / 部分克隆 一律拒绝：原地重写会把残缺固化
if (fs.existsSync(path.join(ROOT, '.git', 'shallow'))) {
  console.error('❌ 这是浅克隆（.git/shallow 存在），历史不完整，禁止原地重写。');
  console.error('   请在一个全新的完整克隆里执行本脚本。');
  process.exit(2);
}

/**
 * ② 对象库连通性体检。
 *
 * 判据必须覆盖 **commit 与 tree 两类**。本仓实测：commit 链断了 3 处，
 * 但 tree 之间的 broken link 有上百处 —— 只查 commit 会漏掉绝大多数损坏。
 * 同时 `git rev-list` 能否遍历 HEAD 也要单独查：它是最贴近「重写会不会崩」
 * 的判据，且失败信息在 stderr。
 *
 * ⚠ 不要用「退出码是否为 0」当唯一判据：`git fsck` 损坏时退出码是 10，
 * 而 `git rev-list` 断链时也是非 0 —— 两者都要显式捕获并取回两个输出流。
 */
const fsck = runCapture('git fsck --connectivity-only');
const fsckAll = fsck.stdout + '\n' + fsck.stderr;
const brokenLinks = (fsckAll.match(/broken link/gi) || []).length;
const invalidSha = (fsckAll.match(/invalid sha1 pointer/gi) || []).length;
const couldNotRead = (fsckAll.match(/Could not read/gi) || []).length;
const missingObj = (fsckAll.match(/missing (?:commit|tree|blob|tag)/gi) || []).length;

const revlist = runCapture('git rev-list --count HEAD');
const canTraverse = revlist.status === 0;

const healthy = brokenLinks === 0 && invalidSha === 0 && couldNotRead === 0 && missingObj === 0 && canTraverse;

if (!healthy) {
  console.error('❌ 对象库不健康，禁止在此仓库上改写历史。');
  console.error('');
  console.error(`   broken link（含 tree/commit 断链）：${brokenLinks}`);
  console.error(`   invalid sha1 pointer（索引 cache-tree 失效）：${invalidSha}`);
  console.error(`   Could not read（父提交不可读）：${couldNotRead}`);
  console.error(`   missing 对象：${missingObj}`);
  console.error(`   git rev-list HEAD 可遍历：${canTraverse ? '是' : '否'}`);
  console.error('');
  console.error('   为什么必须拒绝：对象缺失时 filter-repo 无法重建完整的新历史，');
  console.error('   改写会把残缺状态固化，且新历史无法与旧历史逐条比对；');
  console.error('   更糟的是「静默丢内容」—— 看起来成功了，实际少了若干变化。');
  console.error('');
  console.error('   正确做法（在全新克隆里跑，不动当前目录）：');
  console.error('     cd ..');
  console.error('     git clone https://github.com/luckykhy/khy_os.git khy-os-rewrite');
  console.error('     cd khy-os-rewrite');
  console.error('     node scripts/maintenance/strip-ai-attribution.js --apply');
  console.error('');
  console.error('   注：新克隆也会带上本脚本，因为本脚本已随提交进入仓库。');
  process.exit(2);
}
console.log(`✅ 对象库健康（HEAD ${headSha.slice(0, 8)}，提交数 ${revlist.stdout.trim()}）`);

// ── 门 1：统计待清除的署名 ────────────────────────────────────────────────
console.log('\n📋 扫描全历史署名尾注…');

const raw = trySh("git log --all --format=%H%x01%B%x02");
const commits = raw
  .split('\x02')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * 改写前的 tree 快照，供改写后做「文件内容零变化」校验。
 * message 改写只应改动 commit 对象；tree/blob 一个都不该动。
 * 若改写后出现改写前不存在的 tree，说明误改了内容 —— 必须拦下。
 */
const beforeTreesFile = path.join(ROOT, '.git', 'khy_strip_before_trees.txt');
try {
  // ⚠ 不用 `--format='%H %T'`：在 Windows + Git Bash 下，execSync 的引号处理会让
  // `%T` 被 shell 拆成独立参数（git 报 `ambiguous argument '%T''`）。
  // 改用 `%x00` 显式分隔，命令里不出现任何需要 shell 引号保护的空格。
  // 这个坑会让快照静默失败、自检退化为「跳过」——正是最该避免的「看起来正常」。
  const heads = trySh('git for-each-ref --format=%(refname:short) refs/heads/')
    .split('\n')
    .filter((b) => b && !/^backup\/ai-strip-\d{8}\//.test(b))
    .join(' ');
  const trees = sh(`git log --format=%H%x00%T ${heads}`);
  fs.writeFileSync(beforeTreesFile, trees + '\n', 'utf8');
} catch {
  // 分支列举失败不阻断；自检会明确显示「跳过」而不是误报
}let hitCount = 0;
let lineCount = 0;
const byKind = {};
const samples = [];

for (const block of commits) {
  const sep = block.indexOf('\x01');
  if (sep < 0) continue;
  const hash = block.slice(0, sep);
  const message = block.slice(sep + 1);
  const { removed } = stripMessage(message);
  if (!removed.length) continue;
  hitCount++;
  lineCount += removed.length;
  for (const l of removed) {
    const kind = /commandcode/i.test(l)
      ? 'CommandCodeBot'
      : /claude|anthropic/i.test(l)
        ? 'Claude'
        : '其它 AI';
    byKind[kind] = (byKind[kind] || 0) + 1;
  }
  if (samples.length < 5) samples.push(`${hash.slice(0, 10)}  ${removed[0].trim().slice(0, 56)}`);
}

if (!hitCount) {
  console.log('✅ 全历史未发现 AI 署名尾注，无需改写。');
  process.exit(0);
}

console.log(`   受影响提交：${hitCount} 条`);
console.log(`   待删行数：  ${lineCount} 行`);
console.log('   按来源：');
for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
  console.log(`     ${k.padEnd(16)} ${v} 行`);
}
console.log('\n   样本：');
samples.forEach((s) => console.log(`     ${s}`));

// ── 门 2：列出会被改写的分支与回退动作 ────────────────────────────────────
// ⚠ 默认必须覆盖**所有分支**，不能只清 main。
// 原因：GitHub 的 Contributors 是按**整个仓库**统计的，只要还有任意分支
// （含长期存在的 feature/backup 分支）留着署名尾注，名单就清不干净。
// 实测 khy-os 远端 8 个分支里，`chore/repo-layer-taxonomy` 头部提交就带署名。
// `--only-main` 仅供「先小范围试水」用，试完必须补跑全部分支。
const ONLY_MAIN = process.argv.includes('--only-main');
const branches = trySh('git for-each-ref --format=%(refname:short) refs/heads/')
  .split('\n')
  .filter(Boolean);

// ⚠ 只排除**本脚本自己建的临时回退引用**（backup/ai-strip-*），不能排除所有 backup/*：
// `backup/main-pre-reset-20260820` 是仓库里真实存在的长期备份分支，也含署名尾注。
// 早前按 `startsWith('backup/')` 粗筛会把它漏掉，导致名单清不干净。
const isTempBackupRef = (b) => /^backup\/ai-strip-\d{8}\//.test(b);
let localBranches = branches.filter((b) => !isTempBackupRef(b));
if (ONLY_MAIN) localBranches = localBranches.filter((b) => b === 'main');

// 顺带报出哪些分支真的含署名，让范围决策有据可依
const branchesWithAttribution = localBranches.filter((b) => {
  const out = trySh(`git log ${b} --format=%B`);
  return out.split('\n').some(isAiAttributionLine);
});

console.log(`\n🌿 会被改写的本地分支（${localBranches.length}${ONLY_MAIN ? '，已限定 main' : ''} / 共 ${branches.length} 个）：`);
localBranches.forEach((b) => {
  const n = trySh(`git rev-list --count ${b}`, '?');
  const hit = branchesWithAttribution.includes(b) ? '  ← 含署名' : '';
  console.log(`     ${b.padEnd(46)} ${String(n).padStart(4)} commits${hit}`);
});

if (ONLY_MAIN && branchesWithAttribution.some((b) => b !== 'main')) {
  console.log('\n⚠️  提示：其它分支也含署名，名单不会被清干净。试水后请补跑全量。');
}
const missedBranches = branches.filter((b) => !isTempBackupRef(b) && !localBranches.includes(b));
if (missedBranches.length) {
  console.log(`\n⚠️  以下分支不会被动到，其署名尾注将保留：${missedBranches.join(' / ')}`);
}

console.log('\n🛟 需要的回退动作（PP-4：回退不依赖未提交代码）：');
localBranches.forEach((b) => {
  console.log(`     git branch backup/ai-strip-$(date +%Y%m%d)/${b.replace(/\//g, '--')} ${b}`);
});
console.log('     git push origin "refs/heads/backup/*:refs/heads/backup/*"');

// ── 干跑到此结束 ──────────────────────────────────────────────────────────
if (!APPLY) {
  console.log('\n' + '='.repeat(64));
  console.log('🔸 干跑模式，未做任何改动。');
  console.log('   复查上面清单无误后，加 --apply 执行。');
  console.log('   建议先在备份副本上跑一遍。');
  process.exit(0);
}

// ── 真跑 ──────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(64));
console.log('⚠️  即将改写提交历史。同一仓库的所有 clone/fork 会失效。');

// 回退引用必须先建立（filter-repo 之后旧 SHA 就难找了）
// ⚠ 命名用「打平」形式（`/` 换成 `--`）：分支名本身含 `/`（如 dependabot/pip/xxx）
// 若直接拼成 `backup/ai-strip-<日期>/dependabot/pip/xxx`，会形成多层嵌套 ref，
// 推送时 glob 匹配易出错、且人工核对困难。
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const backupNameFor = (b) => `backup/ai-strip-${stamp}/${b.replace(/\//g, '--')}`;

// ⚠ 回退引用必须**只在不存在时创建**，绝不 `git branch -f` 覆盖。
//
// 踩过的坑：脚本第一次跑失败（只改了一部分分支），重跑时无条件 `-f` 重建备份，
// 于是已经改写成功那些分支的「原始 SHA」被覆盖成了「改写后的 SHA」——
// 回退点当场失效。备份的语义是「第一次动手前的样子」，只认第一次。
let backupOk = true;
let backupCreated = 0;
let backupKept = 0;
for (const b of localBranches) {
  const ref = `refs/heads/${backupNameFor(b)}`;
  const existing = trySh(`git rev-parse --verify --quiet ${ref}`);
  if (existing) {
    backupKept++;
    continue; // 已存在 → 保留首次记录的原始 SHA，不覆盖
  }
  try {
    sh(`git branch ${backupNameFor(b)} ${b}`);
    backupCreated++;
  } catch (e) {
    backupOk = false;
    console.error(`   ❌ 备份 ${b} 失败：${e.message.split('\n')[0]}`);
  }
}
if (!backupOk) {
  console.error('\n❌ 备份未全部成功，中止改写。');
  process.exit(1);
}
console.log(
  `✅ 回退引用就绪：backup/ai-strip-${stamp}/*（新建 ${backupCreated} 个，沿用已有 ${backupKept} 个）`
);
if (backupKept > 0) {
  console.log('   （已有的不覆盖：备份语义是「首次动手前的 SHA」，重跑不能污染它）');
}

// git filter-repo 是否可用
const hasFilterRepo = (() => {
  try {
    sh('git filter-repo --version');
    return true;
  } catch {
    return false;
  }
})();

/**
 * 生成 filter-repo 的 message-callback。
 *
 * ⚠ 四个实测约束（全部踩过，勿"简化"）：
 *  ① filter-repo 的 BODY 会 `exec` 成 `def callback(message): <BODY>`，
 *     且校验条件是 **`'return ' in code_string`（带空格）**。
 *     缺 `return ` 字面量就直接 `Error: --message-callback should have a return statement`。
 *  ② **BODY 参数若是一个已存在文件路径，filter-repo 会读取该文件内容当 BODY**
 *     （`if os.path.exists(code_string): code_string = f.read()`）。
 *     这是最可靠的传参方式 —— 绕开 shell 引号/换行/转义的全部坑。
 *     故这里把 BODY 写进 .git/ 下的文件，再把**路径**传给 --message-callback。
 *  ③ `commit.message` 是 **bytes**（FastExport 层全用 bytes），不是 str。
 *     helper 必须 bytes 进出；正则要用 `br"..."`。
 *  ④ BODY 只做 import + 调用，清洗逻辑留在 helper 模块里（便于单测）。
 *
 * 另外：`bdy.splitlines()` 会被逐行缩进后 join，所以文件里**可以有多行**，
 * 只要整体构成一个合法函数体（可以是 import 语句 + return 语句）。
 */
const helperFile = path.join(ROOT, '.git', 'khy_strip_ai_attr.py');
fs.writeFileSync(
  helperFile,
  [
    '# 由 scripts/maintenance/strip-ai-attribution.js 生成；不进版本库。',
    '# 供 filter-repo 的 --message-callback 调用（BODY 只做 import + return）。',
    'import re',
    '',
    '_AI = br"claude|gpt|copilot|cursor|anthropic|openai|commandcode|codebuddy|gemini|qwen|deepseek"',
    '_LINE_RES = [',
    '    re.compile(br"^\\s*co-authored-by:\\s*[^\\n<]*(?:" + _AI + br")[^\\n]*<[^>]+>\\s*$", re.I),',
    '    re.compile(br"^\\s*generated with\\s+\\[?(?:" + _AI + br")", re.I),',
    '    re.compile(br"^\\s*\\xf0\\x9f\\xa4\\x96\\s*generated", re.I),  # 机器人 emoji + generated',
    ']',
    '',
    'def strip(text):',
    '    # text 是 bytes（filter-repo 的 message 恒为 bytes）',
    '    if isinstance(text, str):',
    '        text = text.encode("utf-8", "surrogateescape")',
    '    parts = text.split(b"\\n")',
    '    kept = [l for l in parts if not any(r.search(l) for r in _LINE_RES)]',
    '    if len(kept) == len(parts):',
    '        return text  # 未命中则原样返回，保证 message 字节完全不变',
    '    out = b"\\n".join(kept)',
    '    while b"\\n\\n\\n" in out:',
    '        out = out.replace(b"\\n\\n\\n", b"\\n\\n")',
    '    return out.rstrip() + b"\\n"',
    '',
    'def callback(message):',
    '    return strip(message)',
    '',
  ].join('\n'),
  'utf8'
);

/**
 * BODY 文件：多行、以 return 结尾。filter-repo 会读这个文件当函数体。
 * 注意 `return ` 必须带空格（校验是字面量 `'return '`）。
 */
const bodyFile = path.join(ROOT, '.git', 'khy_strip_body.py');
fs.writeFileSync(
  bodyFile,
  [
    'import os, sys',
    `sys.path.insert(0, r"${path.join(ROOT, '.git').replace(/\\/g, '/')}")`,
    'import khy_strip_ai_attr',
    'return khy_strip_ai_attr.callback(message)',
    '',
  ].join('\n'),
  'utf8'
);

const branchArgs = localBranches.flatMap((b) => ['--refs', b]).join(' ');

console.log('\n🔧 生成改写 helper：.git/khy_strip_ai_attr.py');
console.log('🔧 生成回调 BODY：.git/khy_strip_body.py');
console.log('\n要执行的命令（filter-repo，BODY 以文件路径传入）：');
console.log(`   git filter-repo --force --message-callback .git/khy_strip_body.py ${branchArgs}`);

if (!hasFilterRepo) {
  console.log('\n⚠️  本机未安装 git-filter-repo。安装方式：');
  console.log('     pip install git-filter-repo');
  console.log('   或参考 https://github.com/newren/git-filter-repo/blob/main/INSTALL.md');
  console.log('\n   两个文件已生成，安装后手动执行上面那条命令即可。');
  process.exit(3);
}

// ⚠ 必须**逐分支**调用 filter-repo，绝不把多个 --refs 塞进同一条命令。
//
// 实测（filter-repo a40bce548d2c）：一次调用里传 3 个互不连通的 --refs，
// 它只 fast-export 了**其中一支**（日志 `Parsed 83 commits` 后即
// `New history written`），随后静默退出，另外两支原封不动 ——
// 而整条命令退出码仍是 0，所以外面完全看不出「只做了一部分」。
// 本仓 8 个分支彼此**没有共同祖先**（merging 之前各自独立成史），
// 正好命中这个行为，于是首轮只改掉了 main。
//
// 逐分支跑还顺带解决第二件事：filter-repo 每次都会重写整个 ref 空间，
// 单分支调用时它的「已处理」判定不会污染下一支。
let rewriteFailed = null;
for (const b of localBranches) {
  try {
    sh(`git filter-repo --force --message-callback .git/khy_strip_body.py --refs ${b}`);
    process.stdout.write(`   ✅ ${b}\n`);
  } catch (e) {
    const detail = e.stderr ? e.stderr.toString().trim().split('\n').slice(-3).join(' | ') : e.message.split('\n')[0];
    rewriteFailed = `${b} → ${detail}`;
    break;
  }
}

if (rewriteFailed) {
  console.error('❌ filter-repo 执行失败：' + rewriteFailed);
  console.error('   回退（全部）：git push --force origin "refs/heads/backup/ai-strip-*/<分支>:<分支>"');
  console.error('   回退（本地）：git branch -f <分支> backup/ai-strip-' + stamp + '/<分支打平名>');
  process.exit(1);
}
console.log('✅ 历史改写完成。');

// ── 改写后自检 ────────────────────────────────────────────────────────────
// ⚠ 自检范围只能是**被改写的分支**。早期版本用 `git log --all`，
// 会把 `refs/remotes/origin/*`（未重写的远端跟踪引用）算进来，于是恒报
// 「残留 73 条」而让人误以为改写失败 —— 实际 main 分支已经是 0 处。
// filter-repo 不会自动更新 remote-tracking refs，这是它的既定行为，不是错误。
// 逐分支统计残留，便于一眼看出「是哪几支没被改写」。
// 这个细分很重要：早期观察到「多 --refs 一条命令」时 filter-repo 只做一支就退出，
// 表现为「残留数不为 0 但每支看起来都该成功」，没有分支配对就很难定位。
const residualByBranch = [];
let afterHits = 0;
const afterCounts = [];
for (const b of localBranches) {
  const out = trySh(`git log ${b} --format=%H%x01%B%x02`);
  const hits = out
    .split('\x02')
    .filter((blk) => {
      const s = blk.indexOf('\x01');
      return s >= 0 && blk.slice(s + 1).split('\n').some(isAiAttributionLine);
    }).length;
  afterHits += hits;
  afterCounts.push(`${b}:${trySh(`git rev-list --count ${b}`, '?')}`);
  if (hits > 0) residualByBranch.push(`${b}(${hits})`);
}

console.log(`\n🔎 改写后自检`);
console.log(`   残留署名提交（仅限被改写分支）：${afterHits} 条 ${afterHits === 0 ? '✅' : '❌'}`);
if (residualByBranch.length) console.log(`   未清干净的分支：${residualByBranch.join('  ')}`);
console.log(`   各分支提交数（应与改写前一致）：${afterCounts.join('  ')}`);

// 代码零变化的硬证据：改写前后每个提交的 tree hash 必须一一对应。
// message 改写只动 commit 对象，tree 不变 —— 若 tree 变了，说明误改了文件内容。
let treeChanged = 0;
try {
  const afterRaw = trySh(`git log --format=%T ${localBranches.join(' ')}`);
  const afterList = afterRaw.split('\n').filter(Boolean).map((l) => l.trim());
  // 快照格式是 `%H%x00%T`，取第二段为 tree
  const beforeList = fs
    .readFileSync(beforeTreesFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => (l.includes('\x00') ? l.split('\x00')[1] : l.trim().split(/\s+/)[1]))
    .filter(Boolean);
  const beforeSet = new Set(beforeList);
  const notIn = afterList.filter((t) => !beforeSet.has(t));
  treeChanged = notIn.length;
  console.log(`   文件内容零变化校验：${treeChanged === 0 ? '✅ tree 全部与改写前一致' : `❌ ${treeChanged} 个 tree 与改写前不符`}`);
} catch (e) {
  console.log(`   文件内容零变化校验：跳过（${e.message.split('\n')[0]}）`);
}

if (afterHits !== 0) {
  console.error('\n❌ 被改写分支上仍有残留，请勿推送。');
  console.error('   排查方向（按可能性排序）：');
  console.error('   1) filter-repo 只处理了部分分支 —— 本脚本已改为**逐分支**调用；');
  console.error('      若你手工跑的是「多 --refs 一条命令」，这正是已知的静默半途退出。');
  console.error('   2) helper 的 _LINE_RES 未覆盖该署名形态（看上面「未清干净的分支」列出的样本）。');
  process.exit(1);
}
if (treeChanged !== 0) {
  console.error('\n❌ 检出文件内容被改动，这不是「只改 message」应有的结果。');
  console.error(`   请回退：git branch -f <分支> backup/ai-strip-${stamp}/<分支>`);
  process.exit(1);
}

// ── 推送 ──────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(64));

/**
 * 推送目标。
 * khy-os 有 3 个 remote，强推必须逐个处理，否则镜像会与主仓历史分叉：
 *   origin      ghfast 代理 fetch → GitHub push
 *   khy-mirror  main 的 pushurl 指向 GitHub
 *   gitee       Gitee 镜像
 * 用 `--remotes` 显式指定；默认只推 origin，避免误动镜像。
 * 注意 ghfast 是**拉取**代理，推送走 pushurl（GitHub 直连）。
 */
const PUSH_REMOTES = (() => {
  const explicit = process.argv.find((a) => a.startsWith('--remotes='));
  if (explicit) return explicit.split('=')[1].split(',').filter(Boolean);
  return ['origin'];
})();

const pushCmds = localBranches.map((b) => `git push --force-with-lease ${PUSH_REMOTES[0]} ${b}`);

if (!PUSH) {
  console.log('🔸 未加 --push，历史已改写但未推送。');
  console.log('   推送前请确认：');
  console.log('     1) 上面自检全绿；');
  console.log('     2) 无人（含 CI、fork）还依赖旧 SHA；');
  console.log(`     3) 回退引用 backup/ai-strip-${stamp}/* 已推至远端。`);
  console.log('\n   ① 先推回退引用（这一步最该先做，出错才有得退）：');
  PUSH_REMOTES.forEach((r) => {
    console.log(`     git push ${r} "refs/heads/backup/ai-strip-${stamp}/*:refs/heads/backup/ai-strip-${stamp}/*"`);
  });
  console.log('\n   ② 再强推分支：');
  pushCmds.forEach((c) => console.log(`     ${c}`));
  if (PUSH_REMOTES.length === 1) {
    console.log('\n   ③ 镜像远端（需另行显式指定，默认不动）：');
    console.log(`     npm run strip:ai-attribution -- --push --remotes=origin,khy-mirror,gitee`);
  }
  console.log('\n   ⚠️  用 --force-with-lease 而非 --force：前者在远端有意外更新时会拒绝。');
  console.log(`   ⚠️  本次改写了 ${localBranches.length} 个分支，远端同名的都要推，否则名单清不干净。`);
  process.exit(0);
}

console.log(`🚀 推送中（${PUSH_REMOTES.join(' / ')}，使用 --force-with-lease）…`);
console.log('   ① 回退引用…');
for (const r of PUSH_REMOTES) {
  try {
    sh(`git push ${r} "refs/heads/backup/ai-strip-${stamp}/*:refs/heads/backup/ai-strip-${stamp}/*"`);
    console.log(`      ✅ ${r} 回退引用已推`);
  } catch (e) {
    console.error(`      ❌ ${r} 回退引用推送失败：${e.message.split('\n')[0]}`);
    console.error('      → 回退引用没上去就不要继续强推。已中止。');
    process.exit(1);
  }
}

console.log('   ② 分支…');
for (const r of PUSH_REMOTES) {
  for (const b of localBranches) {
    try {
      sh(`git push --force-with-lease ${r} ${b}`);
      console.log(`      ✅ ${r} ${b}`);
    } catch (e) {
      console.error(`      ❌ ${r} ${b} 失败：${e.message.split('\n')[0]}`);
      console.error(`      → 回退该分支：git push --force ${r} ${backupNameFor(b)}:${b}`);
      process.exit(1);
    }
  }
}

console.log('\n🎉 完成。GitHub Contributors 名单会在几分钟后刷新。');
console.log('   注：claude / CommandCodeBot 的账号本身未被修改（也改不了），');
console.log('   只是历史里不再有指向它们的尾注，名单因而不再包含它们。');
console.log('\n   收尾建议：');
console.log('     1) 本地原仓库的对象库残缺，建议重新完整克隆，别继续在残库上工作；');
console.log(`     2) 确认名单后删除回退引用：git push origin --delete "refs/heads/backup/ai-strip-${stamp}/*"`);
