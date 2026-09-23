'use strict';

/**
 * replayArtifactGuards.js — pre/post-execution artifact-state guards (防呆⑥ precondition,
 * 防呆③ verify), extracted behavior-neutral from replayEngine.js. Pure leaf over a step
 * object: depends only on fs + sibling ./artifactHash (which does NOT require back),
 * zero references to replayEngine (no cycle). replayEngine re-requires so its public
 * surface stays byte-identical.
 */

const fs = require('fs');
const artifactHash = require('./artifactHash');

/**
 * Pre-execution guard (防呆⑥): inspect on-disk state vs. the recorded artifact.
 * @returns {{decision:'proceed'|'satisfied'|'halt', reason?:string, detail?:object}}
 */
function _preconditionCheck(step) {
  const arts = Array.isArray(step.artifacts) ? step.artifacts : [];
  for (const a of arts) {
    if (!a || !a.path) {
      continue;
    }
    const before =
      step.writeDiff && step.writeDiff.beforeHash != null ? step.writeDiff.beforeHash : null;
    const current = artifactHash.hashFile(a.path); // null if file absent

    // Already at the recorded terminal state → nothing to do.
    if (a.op === 'delete') {
      if (current === null) {
        return { decision: 'satisfied', reason: '目标已不存在' };
      }
    } else if (a.sha256 && current === a.sha256) {
      return { decision: 'satisfied', reason: '产物已是目标状态' };
    }

    // Overwrite/delete with an unexpected prior state → refuse (never clobber
    // un-recorded data). A create over a *missing* file (before=null,current=null)
    // is fine; a create over an existing different file is a divergence.
    const isMutation = a.op === 'modify' || a.op === 'delete';
    if (isMutation && before !== null && current !== null && current !== before) {
      return {
        decision: 'halt',
        reason: '前置状态分歧：目标当前内容与录制时不一致',
        detail: { path: a.path, expected: before, actual: current },
      };
    }
    if (
      a.op === 'create' &&
      current !== null &&
      before === null &&
      a.sha256 &&
      current !== a.sha256
    ) {
      return {
        decision: 'halt',
        reason: '前置状态分歧：将创建的目标已存在且内容不同',
        detail: { path: a.path, expected: null, actual: current },
      };
    }
  }
  return { decision: 'proceed' };
}

/**
 * Post-execution verify (防呆③): recompute each artifact hash and compare.
 * @returns {{ok:true}|{ok:false, detail:object}}
 */
function _verifyArtifacts(step) {
  const arts = Array.isArray(step.artifacts) ? step.artifacts : [];
  for (const a of arts) {
    if (!a || !a.path) {
      continue;
    }
    if (a.op === 'delete') {
      if (fs.existsSync(a.path)) {
        return { ok: false, detail: { path: a.path, expected: '(deleted)', actual: '(exists)' } };
      }
      continue;
    }
    if (!a.sha256) {
      continue;
    }
    const actual = artifactHash.hashFile(a.path);
    if (actual !== a.sha256) {
      return { ok: false, detail: { path: a.path, expected: a.sha256, actual } };
    }
  }
  return { ok: true };
}

module.exports = {
  _preconditionCheck,
  _verifyArtifacts,
};
