/**
 * authzFailureLedger.js — 授权作用域解析失败台账「纯叶子 / pure-leaf」。
 *
 * 送别礼（[DESIGN-AGENT-002] A2-7）：权限判定的失败**禁止**静默降级。此前
 * `aiMessageBuilder` 的 `try/catch` 会把「工具作用域解析失败」变成
 * `toolDefs = undefined` —— 现象上像「无工具」，实际是把一次**授权故障**
 * 吞掉了，运维侧无从发现。
 *
 * 本叶只做一件事：把这类失败**旁路记录**到 `.khy/ruleguard/authz-failures.jsonl`，
 * 供 S1 观察期统计样本量与误报率（`PROCESS-008`：S1/S2 只记录不阻断）。
 *
 * 契约：
 *   - **绝不抛**：任何 IO / 参数异常都被吞掉。记录是尽力而为，不得影响主流程。
 *   - **不阻断**：本叶没有返回值语义，调用方不依赖它做决策。
 *   - **不上报敏感内容**：只记 `where` / `role` / `toolFilter` / `message`，
 *     不记 prompt、参数或文件内容。
 *   - 目录 `.khy/` 是 gitignore 的本机态（见 AGENTS.md「数据存储位置」）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LEDGER_REL = path.join('.khy', 'ruleguard', 'authz-failures.jsonl');

/**
 * 解析台账绝对路径：优先 `KHY_AUTHZ_LEDGER`（测试注入用），否则相对 cwd。
 * @returns {string}
 */
function _ledgerPath() {
  const override = process.env.KHY_AUTHZ_LEDGER;
  if (override && typeof override === 'string') {
    return override;
  }
  return path.resolve(process.cwd(), LEDGER_REL);
}

/**
 * 追加一条授权失败记录。**绝不抛。**
 *
 * @param {{where:string, role?:string|null, toolFilter?:string|null, message?:string}} entry
 * @returns {boolean} true = 已写入；false = 写入失败（已吞）
 */
function recordAuthzFailure(entry) {
  try {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    const row = {
      ts: new Date().toISOString(),
      where: String(entry.where || 'unknown'),
      role: entry.role == null ? null : String(entry.role),
      toolFilter: entry.toolFilter == null ? null : String(entry.toolFilter),
      message: entry.message == null ? '' : String(entry.message).slice(0, 500),
    };
    const target = _ledgerPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, JSON.stringify(row) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取台账全部记录（供 S1 统计脚本与测试使用）。**绝不抛**，失败返回 `[]`。
 * @returns {object[]}
 */
function readAuthzFailures() {
  try {
    const target = _ledgerPath();
    if (!fs.existsSync(target)) {
      return [];
    }
    return fs
      .readFileSync(target, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = { recordAuthzFailure, readAuthzFailures, LEDGER_REL };
