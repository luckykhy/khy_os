'use strict';

/**
 * gitSoftExec.js — 「软失败式 git 子命令执行」共享 helper(非纯·spawn git)。
 *
 * 收敛 2 处 body 逐字节相同的私有 `_gitSoft(args, cwd)`(作者已注明「镜像」)——
 *   services/docsFreshness/docsFreshnessRunner(`../../utils/gitSoftExec`·仍经 module.exports 导出)·
 *   services/precommitCheck(`../utils/gitSoftExec`)。
 *
 * ⚠️ 刻意不并入 tools/repoAudit._gitSoft(经 `_git` 助手+读 err.stderr·分叉)与
 *   cli/handlers/repo._gitSoft(sig `(args, options={})`·不同签名)——均属 C 組。
 *
 * 语义:execFileSync('git', args, {cwd, utf-8, 15s 超时, stdio ignore/pipe/pipe})·
 *   成功→{ ok:true, out: trim };异常→{ ok:false, out:'', err: e.message }·**绝不抛**。
 *
 * 契约:非纯(spawn git 子进程)·fail-soft 绝不抛·不 mutate 入参。
 *   各消费方保留同名本地 `const _gitSoft = require('.../gitSoftExec')` → 调用点逐字节不变。
 */

const { execFileSync } = require('child_process');

function gitSoftExec(args, cwd) {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, out: '', err: (e && e.message) || String(e) };
  }
}

module.exports = gitSoftExec;
