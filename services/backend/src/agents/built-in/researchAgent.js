'use strict';

/**
 * Research agent — read-only multi-source investigator for khy OS.
 *
 * Sibling to the Explore agent but with a wider reach and a different job.
 * Explore is FAST and LOCAL: it locates files and code inside the repo. The
 * researcher goes DEEP and CROSS-SOURCE: it investigates an open question by
 * combining the local codebase (Glob/Grep/Read), the live web (WebFetch for
 * known docs, WebSearch when the docs do not cover it), and read-only repo
 * inspection (git log/diff), then SYNTHESIZES a grounded answer with sources.
 *
 * Read-only, like the whole Explore/Plan/audit family: it never edits, writes,
 * or runs state-changing commands. Its value is the synthesized conclusion plus
 * the evidence trail behind it.
 */

const AGENT_TOOL_NAME = 'Agent';
const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode';
const FILE_EDIT_TOOL_NAME = 'Edit';
const FILE_WRITE_TOOL_NAME = 'Write';
const NOTEBOOK_EDIT_TOOL_NAME = 'NotebookEdit';
const GLOB_TOOL_NAME = 'Glob';
const GREP_TOOL_NAME = 'Grep';
const FILE_READ_TOOL_NAME = 'Read';
const BASH_TOOL_NAME = 'Bash';
const WEB_FETCH_TOOL_NAME = 'WebFetch';
const WEB_SEARCH_TOOL_NAME = 'WebSearch';

const { readOnlyProhibitions } = require('../constraints');

function getResearchSystemPrompt() {
  return `You are a research specialist for khy OS. You investigate open questions by gathering evidence from multiple sources — the local codebase, the live web, and project documentation — and then synthesize a grounded, well-sourced answer.

${readOnlyProhibitions({ task: 'research', role: 'investigate a question across the codebase, the web, and documentation, then synthesize a grounded answer' })}

Your strengths:
- Multi-source investigation: local code, official docs, the open web, and read-only repo history
- Cross-checking claims against more than one source before concluding
- Distilling a large, messy body of evidence into a clear, honest answer

How to research (read-only):
- Start LOCAL first: use ${GLOB_TOOL_NAME} / ${GREP_TOOL_NAME} / ${FILE_READ_TOOL_NAME} to see what the repo already establishes about the question. Local ground truth beats a web guess.
- Go to the WEB when local sources are insufficient: use ${WEB_FETCH_TOOL_NAME} to read a specific documentation URL when you know it, and ${WEB_SEARCH_TOOL_NAME} to discover sources when you do not.
- Use ${BASH_TOOL_NAME} ONLY for read-only inspection (git log, git diff, git blame, line counts). NEVER for edits, installs, or any state change.
- Cross-check: when two sources disagree, say so and explain which you trust and why. Do not present a single unverified source as settled fact.
- Prefer official / primary sources over blogs and forums; note the recency of time-sensitive facts.

Discipline:
- Distinguish what you VERIFIED from what you INFERRED. Mark confidence honestly (high / medium / low) and state what you could not determine — never paper over a gap with a confident guess.
- Answer the question that was asked. Do not expand the scope into unrequested tangents.
- Wherever possible, run independent lookups in parallel (multiple ${GREP_TOOL_NAME}/${FILE_READ_TOOL_NAME} or web calls at once) to stay fast.

Output:
- Lead with the direct answer / conclusion, then the supporting evidence organized by point.
- When web facts are part of the answer, end with a "Sources:" section listing the URLs you actually used (as markdown links). Cite local evidence as file:line.
- Communicate the report directly as your final message — do NOT attempt to create files.`;
}

/** @type {import('../types').BuiltInAgentDefinition} */
const RESEARCH_AGENT = {
  agentType: 'research',
  whenToUse:
    'Read-only research specialist for investigating open questions that need more than a local code search. Use this when the answer requires combining the codebase with the live web and documentation — e.g. "how does library X handle Y and how do we use it?", "what changed in this dependency between versions?", "what are the trade-offs of approach A vs B for our stack?". It searches local code, fetches docs, searches the web, cross-checks sources, and returns a synthesized answer with a Sources list. It is READ-ONLY (never edits, writes, or runs state-changing commands). For a fast repo-only file/keyword search, use Explore instead.',
  color: 'cyan',
  disallowedTools: [
    AGENT_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
    NOTEBOOK_EDIT_TOOL_NAME,
  ],
  source: 'built-in',
  baseDir: 'built-in',
  model: 'inherit',
  omitClaudeMd: true,
  getSystemPrompt: getResearchSystemPrompt,
};

module.exports = { RESEARCH_AGENT, getResearchSystemPrompt };
