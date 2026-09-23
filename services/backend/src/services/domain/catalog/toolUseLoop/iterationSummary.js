'use strict';

/**
 * domain/catalog/toolUseLoop/iterationSummary.js — per-round tool-outcome summary
 * builder, carved out of toolUseLoopCore.js runToolUseLoop main loop
 * (T-021 in-body slice #6, in-loop PURE builder — the safest in-loop shape).
 *
 * Classifies this round's toolResults into a { reads, searches, writes, commands,
 * agents } breakdown, sums elapsed ms, collects the distinct modified file paths,
 * and assembles the _iterSummary object that feeds the rich-UI iteration event +
 * the round-advance assessor.
 *
 * PURE: zero requires, zero IO, zero mutation of anything passed in. It reads a
 * handful of already-computed in-loop locals (passed as a flat deps bag) and
 * returns a fresh object; the caller may still attach `.advance` to the result
 * downstream, exactly as before. In-body convention holds — NO require back into
 * toolUseLoopCore, so M6 cycles stay 0.
 */

function buildIterationSummary(deps = {}) {
  const { toolResults, iteration, succeeded, failed, denied, deduped, allReadOnly } = deps;

  const _norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[\s_-]/g, '');
  const _iterBreakdown = {
    reads: toolResults.filter((tr) => /^(read|readfile|fileread)$/.test(_norm(tr.tool)))
      .length,
    searches: toolResults.filter((tr) =>
      /^(grep|glob|search|find|websearch|webfetch|web_search|explore)$/.test(_norm(tr.tool))
    ).length,
    writes: toolResults.filter((tr) =>
      /^(write|writefile|edit|editfile|createfile)$/.test(_norm(tr.tool))
    ).length,
    commands: toolResults.filter((tr) => /^(bash|shell|shellcommand)$/.test(_norm(tr.tool)))
      .length,
    agents: toolResults.filter((tr) => /^(agent|spawnworker|subagent)$/.test(_norm(tr.tool)))
      .length,
  };
  const _iterElapsed = toolResults.reduce((sum, tr) => sum + (Number(tr.elapsed) || 0), 0);
  const _iterModified = [
    ...new Set(
      toolResults
        .filter((tr) => /^(write|writefile|edit|editfile|createfile)$/.test(_norm(tr.tool)))
        .map((tr) => tr.params?.file_path || tr.params?.filePath || tr.params?.path || '')
        .filter(Boolean)
    ),
  ];
  return {
    iteration,
    total: toolResults.length,
    succeeded,
    failed,
    denied,
    deduped,
    readOnlyOnly: allReadOnly,
    breakdown: _iterBreakdown,
    elapsedMs: _iterElapsed,
    modifiedFiles: _iterModified,
  };
}

module.exports = { buildIterationSummary };
