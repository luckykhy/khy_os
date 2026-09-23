'use strict';

/**
 * docsPaths.js — 文档路径常量的**单一真源**（[MGMT-PLAN-009] B4b）
 *
 * 背景（方案 §1.6 / 红线 DR7）：`docs/07_OPS_运维/` 下的手册**编号被脚本当路径常量用**
 * —— 既要写回（`--gen-doc`），又要打印给用户看。此前目录名 `'07_OPS_运维'` 在
 * 23 个文件里各硬编码一次（`scripts/restore/*` 18 + `scripts/docs/gen-evolution-prompts.js`
 * + `extensions/scripts/**` 4），运维目录一旦改名就要改 23 处，且分散在 `scripts/` 与
 * `extensions/` 两个根下，极易漏改。
 *
 * 收敛后：目录名只在本文件出现一次。
 *
 * 用法：
 *   const { opsDocPath, opsDocRelPath } = require('./docsPaths');
 *   const DOC_PATH = opsDocPath('[OPS-MAN-068] 离机还原自检清单.md');   // 绝对路径，用于读写
 *   out += `详情见：${opsDocRelPath('[OPS-MAN-068] 离机还原自检清单.md')}`; // 相对路径，用于展示
 *
 * 改动纪律：**运维目录改名只改本文件的 `OPS_DIR`**，不要在各脚本里再写字面量。
 */

const path = require('path');

/** 仓库根（scripts/lib/ 的上两级） */
const ROOT = path.resolve(__dirname, '..', '..');

/** docs/ 目录名 */
const DOCS_DIR = 'docs';

/** 运维阶段目录名 —— docs/ 编号轴的第 07 轴 */
const OPS_DIR = '07_OPS_运维';

/**
 * 运维手册子目录名 —— 2026-09-18 `965b8371`（B9 按标签归夹）把 `[OPS-MAN-*]`
 * 全部从 `docs/07_OPS_运维/` 平铺迁入 `docs/07_OPS_运维/OPS-MAN/`。
 * 手册文件名带 `[编号]`，被脚本当路径常量用，迁移后此处若不跟着改，
 * `--gen-doc` 会写到已不存在的路径、测试读盘一律 ENOENT。
 */
const OPS_MAN_DIR = 'OPS-MAN';

/** docs/ 绝对路径 */
function docsDir() {
  return path.join(ROOT, DOCS_DIR);
}

/** docs/07_OPS_运维 绝对路径（阶段根，含 OPS-MAN/ 子目录） */
function opsDocsDir() {
  return path.join(ROOT, DOCS_DIR, OPS_DIR);
}

/** docs/07_OPS_运维/OPS-MAN 绝对路径（手册实际所在子目录） */
function opsManDir() {
  return path.join(ROOT, DOCS_DIR, OPS_DIR, OPS_MAN_DIR);
}

/** 运维手册的**绝对路径**（用于 fs 读写） */
function opsDocPath(fileName) {
  return path.join(ROOT, DOCS_DIR, OPS_DIR, OPS_MAN_DIR, fileName);
}

/** 运维手册的**仓库相对路径**（用于打印给用户看；分隔符恒为 `/`） */
function opsDocRelPath(fileName) {
  return `${DOCS_DIR}/${OPS_DIR}/${OPS_MAN_DIR}/${fileName}`.replace(/\\/g, '/');
}

module.exports = {
  ROOT,
  DOCS_DIR,
  OPS_DIR,
  OPS_MAN_DIR,
  docsDir,
  opsDocsDir,
  opsManDir,
  opsDocPath,
  opsDocRelPath,
};