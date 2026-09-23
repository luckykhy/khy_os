#!/usr/bin/env node
/**
 * 检查 commit message 是否符合规范
 * 用法：node check-commit-message.js <commit-msg-file>
 * 
 * 格式：<type>(<scope>): <中文描述>
 * 
 * Type: feat|fix|docs|style|refactor|perf|test|chore|ci|revert
 * Scope: 可选，小写字母+连字符
 * 描述: 中文，不超过 72 字符
 */

const fs = require('fs');

const COMMIT_MSG_FILE = process.argv[2];
if (!COMMIT_MSG_FILE || COMMIT_MSG_FILE === '--help' || COMMIT_MSG_FILE === '-h') {
  console.log('用法: node check-commit-message.js <commit-msg-file>');
  console.log('');
  console.log('检查 commit message 是否符合 Conventional Commits 规范');
  console.log('');
  console.log('格式: <type>(<scope>): <中文描述>');
  console.log('');
  console.log('Type: feat|fix|docs|style|refactor|perf|test|chore|ci|revert');
  console.log('Scope: 可选，小写字母+连字符');
  console.log('描述: 中文，不超过 72 字符');
  process.exit(0);
}

let msg = fs.readFileSync(COMMIT_MSG_FILE, 'utf8');
// 移除 BOM（Windows UTF-8 文件可能有）
if (msg.charCodeAt(0) === 0xFEFF) {
  msg = msg.slice(1);
}
const firstLine = msg.split('\n')[0];

// Conventional Commits 正则
const PATTERN = /^(feat|fix|docs|style|refactor|perf|test|chore|ci|revert)(\([a-z0-9-]+\))?: .+/;

if (!PATTERN.test(firstLine)) {
  console.error('❌ Commit message 格式不正确');
  console.error('');
  console.error('正确格式: <type>(<scope>): <中文描述>');
  console.error('');
  console.error('Type 类型:');
  console.error('  feat     新功能');
  console.error('  fix      修复 bug');
  console.error('  docs     文档更新');
  console.error('  style    代码格式');
  console.error('  refactor 重构');
  console.error('  perf     性能优化');
  console.error('  test     测试');
  console.error('  chore    构建/工具');
  console.error('  ci       CI/CD');
  console.error('  revert   回滚');
  console.error('');
  console.error('示例:');
  console.error('  feat(gateway): 新增 DeepSeek 适配器');
  console.error('  fix(cli): 修复中文别名匹配失败');
  console.error('  docs: 更新 CONTRIBUTING.md');
  process.exit(1);
}

// 检查描述长度
const description = firstLine.replace(/^(feat|fix|docs|style|refactor|perf|test|chore|ci|revert)(\([a-z0-9-]+\))?: /, '');
if (description.length > 72) {
  console.error(`❌ 描述部分超过 72 字符（当前 ${description.length} 字符）`);
  process.exit(1);
}

// 检查描述是否为空
if (description.trim().length === 0) {
  console.error('❌ 描述部分不能为空');
  process.exit(1);
}

// ── 禁止 AI 署名尾注（PROCESS-010 C-M 的硬拦截层）──────────────────────
// 为什么在这里拦、而不是只靠 check-copyright-readiness.js：
//   后者当前 STAGE=S1（观察者），按 PP-3 恒 exit 0，**不会**拦住提交。
//   而 AI 署名一旦进了历史就是既成事实——它会被 GitHub 渲染进 Contributors
//   名单，且清掉它的唯一办法是改写全部历史。所以署名必须在「写入历史之前」挡住，
//   这是本仓唯一必须前置到 pre-commit 的判据，不能只挂在 PR 门上。
//
// 判据形态（两条，都是「真署名」而非「正文提及」）：
//   A) `Co-Authored-By:` 后**必须跟上 <邮箱>** —— 这是 git/GitHub 认 co-author 的形状。
//      本仓大量提交在正文里讨论「禁止 Co-Authored-By: Claude」这条规矩，
//      若只匹配关键词会把这类正当提交全部误拦，故必须要求邮箱在场。
//   B) `Generated with ...` 徽章行，或 🤖 + generated 组合。
// 所以形如 `docs: 补充禁止 Co-Authored-By: Claude 的规定` 会被放行（无邮箱、
// 且 AI 词后无邮箱），而 `Co-Authored-By: Claude <noreply@anthropic.com>` 会拦下。
//
// 与 check-copyright-readiness.js 的 AI_RE 同源（同一份 AI 标识词表）。
// 两处词表必须同步增删，否则判据会各说各话；本文件是「更严的形态判据」，
// 那边的 AI_RE 是「全文出现即算」的基线统计口径，二者有意不同，不要强行合一。
const AI_NAMES =
  'claude|gpt|copilot|cursor|anthropic|openai|commandcode|codebuddy|gemini|qwen|deepseek';
const AI_ATTRIBUTION_PATTERNS = [
  // A) 真署名：Co-Authored-By: <AI 名> <邮箱>（邮箱是 GitHub 认亲的关键）
  new RegExp(`co-authored-by:\\s*[^\\n<]*(?:${AI_NAMES})[^\\n]*<[^>]+>`, 'i'),
  // B) 徽章行 / 机器人署名
  new RegExp(`generated with\\s+\\[?(?:${AI_NAMES})`, 'i'),
  /🤖\s*generated/i,
];

if (AI_ATTRIBUTION_PATTERNS.some((re) => re.test(msg))) {
  const offenders = msg
    .split('\n')
    .filter((l) => AI_ATTRIBUTION_PATTERNS.some((re) => re.test(l)))
    .map((l) => '    ' + l.trim());
  console.error('❌ Commit message 含 AI 署名尾注（禁止把 AI 列为作者/共同作者）');
  console.error('');
  console.error('检测到：');
  console.error(offenders.join('\n'));
  console.error('');
  console.error('修法：**删掉上面这些行即可，代码完全不用动。**');
  console.error('  依据 PROCESS-010 约束 C-M（docs/10_规范/registry/RULES-REGISTRY.json）');
  console.error('');
  console.error('为什么必须删：该尾注邮箱会被 GitHub 渲染进仓库 Contributors 名单，');
  console.error('且一旦进入提交历史，清除它只能靠改写全部历史（破坏既有 SHA 与镜像）。');
  console.error('');
  console.error('根治：AI 工具侧的自动署名开关。');
  console.error('  Claude Code → ~/.claude.json 设 "includeCoAuthoredBy": false');
  console.error('commit-msg 文件：' + COMMIT_MSG_FILE);
  process.exit(1);
}

console.log('✅ Commit message 格式正确');
