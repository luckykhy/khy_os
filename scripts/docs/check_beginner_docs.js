#!/usr/bin/env node
'use strict';
/*
 * check_beginner_docs.js — 面向小白文档 + 修仙故事「单人维护体检」
 * ---------------------------------------------------------------------------
 * 目的（对齐 CLAUDE.md 章程 四「维护性 · 给弱智用户/小模型」）：
 *   docs:verify 只保证「每个 md 有 html、链接可达」这类结构正确；
 *   但一个人（或一个小模型）后续往「概念入门 / 修仙故事」里加东西时，
 *   很容易破坏作者约定的「房屋风格」而结构却仍然合法：
 *     - 新加了一篇概念/章节，却忘了在该目录的 00_INDEX 索引里挂链接（孤儿页，读者走不到）；
 *     - CONCEPT 编号跳号（读者顺读时断链心智地图）；
 *     - 故事章节漏写 `## 📒 凡人笔记`（少了「仙法→真实 AI 术语」的翻译，教材属性丢失）；
 *     - 正文成了死胡同：底部没有任何「同目录导航链接」（回索引/上一篇/下一篇），读者到页尾走投无路。
 *   本脚本把这些「房屋风格不变量」固化成体检项，让单人维护者/小模型改完一眼看红绿。
 *
 * 用法：
 *   node scripts/docs/check_beginner_docs.js            # 人类可读报告，全绿 exit 0，有问题 exit 1
 *   node scripts/docs/check_beginner_docs.js --json      # 机器可读 JSON
 *   npm run docs:check-beginner                          # 同上（package.json 已登记）
 *
 * ── HOW-TO-EXTEND（抄写式，改这里就够） ──────────────────────────────────
 *  1) 想体检一个「新的面向小白文档目录」：往下面的 SECTIONS 数组加一项：
 *       { dir: 'docs/XX_你的目录', kind: 'concept' | 'story', requireFanren: bool, numberPrefix: 'CONCEPT' | null }
 *     - dir            目录相对仓库根路径；目录内须有一个 00_INDEX*.md 作索引。
 *     - kind           仅用于报告分组文案。
 *     - requireFanren  该目录每篇内容文档是否必须含 `## 📒 凡人笔记`（故事=true，纯概念=false）。
 *     - numberPrefix   若该目录用 `[前缀-NN]` 连续编号（如 CONCEPT），填前缀做「不许跳号」检查；否则 null。
 *  2) 想加一条「新的房屋风格不变量」：在 checkSection() 里加一段 push 到 problems，
 *     并在 check_beginner_docs.test.js 补一个坏样本 + 好样本断言（坏必红、好必绿）。
 *  3) 改完必跑：node --check 本文件 && node --test scripts/docs/check_beginner_docs.test.js
 *     且 node scripts/docs/check_beginner_docs.js 对真实树须仍 exit 0。
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

/** 被体检的面向小白文档目录清单（新增目录改这里，见顶部 HOW-TO-EXTEND）。 */
const SECTIONS = [
  { dir: 'docs/02_CONCEPTS_概念入门', kind: 'concept', requireFanren: false, numberPrefix: 'CONCEPT' },
  { dir: 'docs/09_STORY_修仙学AI', kind: 'story', requireFanren: true, numberPrefix: null },
];

/** 把 markdown 链接目标归一成「同目录文件名」：解码 %20、去 ./、去锚点/查询、取 basename。 */
function normalizeLinkTarget(target) {
  let t = String(target).trim();
  try { t = decodeURIComponent(t); } catch { /* 保留原样 */ }
  t = t.split('#')[0].split('?')[0];
  t = t.replace(/^\.\//, '');
  return path.basename(t);
}

/**
 * 抽取一个 md 文件里所有 markdown 行内链接，返回 [{ basename, sibling }]。
 * sibling=true 表示该链接指向「同目录兄弟文件」（原始 target 去掉 ./ 后不含 /）——
 * 只有同目录链接才纳入本目录的孤儿/坏链体检；跨目录链接（含 ../ 或 子路径）交给 docs:verify。
 */
function extractLinks(absFile) {
  const src = fs.readFileSync(absFile, 'utf8');
  const out = [];
  const re = /\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const rawTrimmed = String(m[1]).trim().replace(/^\.\//, '');
    const sibling = !rawTrimmed.includes('/');
    out.push({ basename: normalizeLinkTarget(m[1]), sibling });
  }
  return out;
}

/** 体检单个目录，返回 problems 数组（空=该目录健康）。 */
function checkSection(repoRoot, section) {
  const problems = [];
  const absDir = path.join(repoRoot, section.dir);
  if (!fs.existsSync(absDir)) {
    problems.push({ dir: section.dir, kind: 'missing-dir', detail: `目录不存在: ${section.dir}` });
    return problems;
  }
  const mdFiles = fs.readdirSync(absDir).filter((f) => f.endsWith('.md'));
  const indexFile = mdFiles.find((f) => /^00_INDEX/.test(f));
  if (!indexFile) {
    problems.push({ dir: section.dir, kind: 'missing-index', detail: `缺少 00_INDEX*.md 索引` });
    return problems;
  }
  const contentFiles = mdFiles.filter((f) => f !== indexFile);
  const indexLinks = extractLinks(path.join(absDir, indexFile));
  const indexSiblingBasenames = new Set(indexLinks.filter((l) => l.sibling).map((l) => l.basename));

  // 1) 孤儿页：内容文档没被索引以「同目录链接」挂上。
  for (const f of contentFiles) {
    if (!indexSiblingBasenames.has(f)) {
      problems.push({ dir: section.dir, kind: 'orphan', file: f, detail: `未在 ${indexFile} 中挂链接（读者走不到）` });
    }
  }

  // 2) 索引里指向本目录不存在的同目录文件（坏索引项）。跨目录链接不在此列（docs:verify 管）。
  for (const l of indexLinks) {
    if (l.sibling && l.basename.endsWith('.md') && !/^00_INDEX/.test(l.basename) && !mdFiles.includes(l.basename)) {
      problems.push({ dir: section.dir, kind: 'dead-index-link', file: l.basename, detail: `${indexFile} 链接到本目录不存在的文件` });
    }
  }

  // 3) 不许成为死胡同：每篇内容文档须至少有一条「指向同目录另一篇 .md」的导航链接
  //    （回索引 00_INDEX、或顺读链 👉 下一篇、或 👈 上一篇 都算）——读者到页尾总有下一步可走。
  for (const f of contentFiles) {
    const links = extractLinks(path.join(absDir, f));
    const hasSiblingNav = links.some((l) => l.sibling && l.basename.endsWith('.md'));
    if (!hasSiblingNav) {
      problems.push({ dir: section.dir, kind: 'dead-end', file: f, detail: `正文无任何同目录导航链接（读者到页尾无处可去；回索引/上一篇/下一篇任一即可）` });
    }
  }

  // 4) 凡人笔记：故事类目录每篇必须含 `## 📒`（仙法→真实术语的翻译）。
  if (section.requireFanren) {
    for (const f of contentFiles) {
      const s = fs.readFileSync(path.join(absDir, f), 'utf8');
      if (!/##\s*📒/u.test(s)) {
        problems.push({ dir: section.dir, kind: 'no-fanren', file: f, detail: `缺 \`## 📒 凡人笔记\`（教材属性丢失）` });
      }
    }
  }

  // 5) 连续编号：若用 [PREFIX-NN] 编号，不许跳号。
  if (section.numberPrefix) {
    const nums = new Set();
    const re = new RegExp('\\[' + section.numberPrefix + '-(\\d+)\\]');
    for (const f of mdFiles) {
      const m = f.match(re);
      if (m) nums.add(Number(m[1]));
    }
    if (nums.size > 0) {
      const max = Math.max(...nums);
      const gaps = [];
      for (let i = 1; i <= max; i++) if (!nums.has(i)) gaps.push(i);
      if (gaps.length) {
        problems.push({ dir: section.dir, kind: 'number-gap', detail: `${section.numberPrefix} 编号跳号，缺: ${gaps.join(', ')}` });
      }
    }
  }

  return problems;
}

/** 对整棵树跑体检，返回 { ok, problems, sections }。 */
function checkBeginnerDocs(repoRoot) {
  const all = [];
  for (const section of SECTIONS) {
    all.push(...checkSection(repoRoot, section));
  }
  return { ok: all.length === 0, problems: all, sections: SECTIONS.map((s) => s.dir) };
}

function main(argv) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const asJson = argv.includes('--json');
  const result = checkBeginnerDocs(repoRoot);

  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.ok ? 0 : 1);
  }

  console.log('[docs:check-beginner] 面向小白文档 + 修仙故事 · 单人维护体检');
  console.log('[docs:check-beginner] 体检目录: ' + result.sections.join(' , '));
  if (result.ok) {
    console.log('[docs:check-beginner] ✅ 全部通过：无孤儿页、编号连续、故事均有凡人笔记、正文均有底部导航。');
    process.exit(0);
  }
  console.error(`[docs:check-beginner] ❌ 发现 ${result.problems.length} 处房屋风格问题：`);
  for (const p of result.problems) {
    const loc = p.file ? `${p.dir}/${p.file}` : p.dir;
    console.error(`  - [${p.kind}] ${loc} :: ${p.detail}`);
  }
  process.exit(1);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { checkBeginnerDocs, checkSection, normalizeLinkTarget, extractLinks, SECTIONS };
