#!/usr/bin/env node
'use strict';

/**
 * changelog-new.js — 发版辅助:就目标版本号在 CHANGELOG.md 顶部预置一段
 * **与解析器兼容**的 stub 条目,或校验「顶部 `## <version>` == pyproject 版本」。
 *
 * 为什么存在:CHANGELOG.md 一直是纯手工维护(`## <version>` 顶置 + 摘要 + `### Highlights`
 * + `### Compatibility` + `---`)。发版时手写这段格式易漏 `### Highlights` 小节、易把
 * 版本头写成 `###`(会被 changelogParse.js 的 `_VERSION_RE = /^##\s+/` 漏掉,导致
 * releaseNotes 取不到本版说明)。本脚本用同一锚点自动写出合规 stub,并提供 `--check`
 * 让发版前能断言「CHANGELOG 顶部版本 == 发布版本」。
 *
 * 零依赖(纯 fs/path),node 直跑。绝不联网、绝不写 CHANGELOG 以外的文件。
 *
 * 用法:
 *   node scripts/release/changelog-new.js <version>            # 顶部预置 <version> stub(幂等)
 *   node scripts/release/changelog-new.js <version> --dry-run  # 只打印将要插入的内容,不写盘
 *   node scripts/release/changelog-new.js --check              # 校验顶部版本 == pyproject 版本
 *   node scripts/release/changelog-new.js --check <version>    # 校验顶部版本 == <version>
 *
 * 解析锚点(与 services/backend/src/services/changelog/changelogParse.js 一致):
 *   版本头 `^##\s+(\S.*?)\s*$` —— 两个 `#` 后紧跟空白;stub 必须写成 `## <version>`。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');
const PYPROJECT = path.join(ROOT, 'pyproject.toml');

// 与 changelogParse.js 逐字一致:`##` 后须紧跟空白(天然排除 `###`)。
const VERSION_RE = /^##\s+(\S.*?)\s*$/;

/** 读 pyproject.toml 的 [project].version(与 check-version-sync 同一真源)。 */
function readPyprojectVersion() {
  const raw = fs.readFileSync(PYPROJECT, 'utf-8');
  // Normalize line endings to handle both Unix (\n) and Windows (\r\n) files.
  const text = raw.replace(/\r\n/g, '\n');
  // Match [project] only at start of line (avoid comment false positives like
  // "# [project] version is...").  Use \z (end-of-string) not $ (end-of-line)
  // because the m flag makes $ match after every line, which would produce an
  // empty capture right after "[project]".
  const block = (text.match(/^\[project\]([\s\S]*?)(?:\n\[[^\n]+\]|\z)/m) || [])[1] || '';
  const m = block.match(/^\s*version\s*=\s*["']([^"']+)["']\s*$/m);
  return m ? m[1].trim() : '';
}

/** 取 CHANGELOG 中最顶部的 `## <version>` 版本串(无则空)。 */
function topVersion(text) {
  for (const line of text.split(/\r?\n/)) {
    const m = VERSION_RE.exec(line);
    if (m) return m[1].trim();
  }
  return '';
}

/** 宽松语义版本校验(与 publish-dual.sh 同风格:X.Y.Z[.-tag])。 */
function isValidVersion(v) {
  return /^\d+\.\d+\.\d+([.-][A-Za-z0-9.]+)?$/.test(String(v || '').trim());
}

/** 构建一段与解析器兼容的 stub 条目(含尾部 `---` 分隔线)。 */
function buildStub(version) {
  return [
    `## ${version}`,
    '',
    `khy OS ${version}:<!-- TODO 一句话摘要:这一版做了什么。 -->`,
    '',
    '### Highlights',
    '',
    '- <!-- TODO 亮点:改了哪个文件、修了什么、为什么。 -->',
    '',
    '### Compatibility',
    '',
    `- 安装 / 升级:\`pip install -U khy-os\` 或 \`npm install -g @khy-os/khy-os\`;\`khy --version\` 应报告 \`${version}\`。`,
    '',
    '---',
    '',
  ].join('\n');
}

/**
 * 在 `# Changelog` 头 + 前言块之后、第一个 `## ` 版本头之前,插入 stub。
 * 幂等:若顶部已是 `## <version>` 则不重复插。返回 { changed, text }。
 */
function insertStub(text, version) {
  if (topVersion(text) === version) {
    return { changed: false, text, reason: 'already-present' };
  }
  const lines = text.split(/\r?\n/);
  // 找第一个版本头行 —— stub 插在它之前(保持"最新在顶")。
  let idx = lines.findIndex((l) => VERSION_RE.test(l));
  if (idx === -1) {
    // 无任何既有条目:插在文件末尾(前言之后)。
    const body = text.replace(/\s*$/, '');
    return { changed: true, text: `${body}\n\n${buildStub(version)}`, reason: 'appended' };
  }
  // 回退跳过版本头前紧邻的空行,让 stub 与前言之间恰好一个空行。
  let insertAt = idx;
  while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt -= 1;
  const before = lines.slice(0, insertAt).join('\n').replace(/\s*$/, '');
  const after = lines.slice(insertAt).join('\n').replace(/^\s*/, '');
  return { changed: true, text: `${before}\n\n${buildStub(version)}${after}`, reason: 'inserted' };
}

function main(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const check = args.includes('--check');
  const positional = args.filter((a) => !a.startsWith('--'));
  const version = positional[0];

  if (check) {
    const want = version || readPyprojectVersion();
    if (!want) { console.error('[changelog:new] 无法确定期望版本(pyproject 无 version 且未传参)'); return 2; }
    const text = fs.readFileSync(CHANGELOG, 'utf-8');
    const top = topVersion(text);
    if (top === want) {
      console.log(`[changelog:new] OK — CHANGELOG 顶部 == ${want}`);
      return 0;
    }
    console.error(`[changelog:new] FAIL — CHANGELOG 顶部为 "${top || '(无)'}",期望 "${want}"`);
    return 1;
  }

  if (!version) {
    console.error('用法: node scripts/release/changelog-new.js <version> [--dry-run] | --check [<version>]');
    return 2;
  }
  if (!isValidVersion(version)) {
    console.error(`[changelog:new] 非法版本号 "${version}"(应为 X.Y.Z[.-tag])`);
    return 2;
  }

  const text = fs.readFileSync(CHANGELOG, 'utf-8');
  const { changed, text: next, reason } = insertStub(text, version);
  if (!changed) {
    console.log(`[changelog:new] 顶部已存在 ## ${version},未改动(幂等)。`);
    return 0;
  }
  if (dryRun) {
    console.log(`[changelog:new] --dry-run:将在顶部${reason === 'appended' ? '末尾追加' : '插入'}以下 stub(未写盘):\n`);
    console.log(buildStub(version));
    return 0;
  }
  fs.writeFileSync(CHANGELOG, next, 'utf-8');
  console.log(`[changelog:new] 已在 CHANGELOG.md 顶部预置 ## ${version} stub(记得填 TODO)。`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { topVersion, buildStub, insertStub, isValidVersion, readPyprojectVersion };
