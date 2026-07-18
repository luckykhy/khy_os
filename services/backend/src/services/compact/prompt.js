/**
 * Compaction Prompt Templates — structured conversation summarization.
 *
 * Matches Claude Code's 9-section summary format:
 *   1. Primary Request and Intent
 *   2. Key Technical Concepts
 *   3. Files and Code Sections
 *   4. Errors and Solutions
 *   5. Problem Solving
 *   6. All User Messages
 *   7. Pending Tasks
 *   8. Current Work
 *   9. Optional Next Step
 *
 * Two prompt variants:
 *   - BASE: Full conversation compaction (scoped to "the conversation")
 *   - PARTIAL: Incremental compaction (scoped to "the recent messages")
 *
 * The <analysis> block is a drafting scratchpad that formatCompactSummary()
 * strips before the summary reaches context.
 */
'use strict';

// ── No-tools preamble ──────────────────────────────────────────────────

/**
 * Aggressive no-tools preamble. Placed FIRST so the model sees it before
 * any cached tool definitions. On adaptive-thinking models, the model
 * sometimes attempts a tool call despite a weaker trailer instruction.
 * With maxTurns: 1, a denied tool call means no text output.
 */
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
- Preserve only the durable context needed to continue work accurately; do not dump a raw transcript when a concise carry-forward summary is enough.

`;

/**
 * Trailing reminder (placed after the prompt body) to reinforce the no-tools rule.
 */
const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — ' +
  'an <analysis> block followed by a <summary> block. ' +
  'Tool calls will be rejected and you will fail the task.';

// ── Analysis instructions ──────────────────────────────────────────────

const ANALYSIS_INSTRUCTION_BASE = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.
3. Prefer durable carry-forward context over noise: keep the current goal, constraints, key decisions with rationale, active files, blockers, and next steps; omit repetitive chatter and verbose logs unless they are necessary to avoid losing important detail.`;

const ANALYSIS_INSTRUCTION_PARTIAL = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Analyze the recent messages chronologically. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.
3. Prefer durable carry-forward context over noise: keep the current goal, constraints, key decisions with rationale, active files, blockers, and next steps; omit repetitive chatter and verbose logs unless they are necessary to avoid losing important detail.`;

// ── Base compact prompt (full conversation) ────────────────────────────

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.
Record why decisions were made, not just that they happened. Keep the summary dense with carry-forward value rather than replaying the full transcript.

${ANALYSIS_INSTRUCTION_BASE}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include only the code snippets that are essential for continuation, plus a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and only the code snippets that materially affect the next step.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.

There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary. Examples of instructions include:
<example>
## Compact Instructions
When summarizing the conversation focus on typescript code changes and also remember the mistakes you made and how you fixed them.
</example>

<example>
# Summary instructions
When you are using compact - please focus on test output and code changes. Include file reads verbatim.
</example>
`;

// ── Partial compact prompt (recent messages only) ──────────────────────

const PARTIAL_COMPACT_PROMPT = `Your task is to create a detailed summary of the RECENT portion of the conversation — the messages that follow earlier retained context. The earlier messages are being kept intact and do NOT need to be summarized. Focus your summary on what was discussed, learned, and accomplished in the recent messages only.
Keep the summary dense with carry-forward value: preserve new constraints, decisions, blockers, and next steps rather than replaying every exchange verbatim.

${ANALYSIS_INSTRUCTION_PARTIAL}

Your summary should include the following sections:

1. Primary Request and Intent: Capture the user's explicit requests and intents from the recent messages
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks discussed recently.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include only the code snippets that are essential for continuation and include a summary of why this file read or edit is important.
4. Errors and fixes: List errors encountered and how they were fixed.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages from the recent portion that are not tool results.
7. Pending Tasks: Outline any pending tasks from the recent messages.
8. Current Work: Describe precisely what was being worked on immediately before this summary request.
9. Optional Next Step: List the next step related to the most recent work. Include direct quotes from the most recent conversation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Important Code Snippet]

4. Errors and fixes:
    - [Error description]:
      - [How you fixed it]

5. Problem Solving:
   [Description]

6. All user messages:
    - [Detailed non tool use user message]

7. Pending Tasks:
   - [Task 1]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the RECENT messages only (after the retained earlier context), following this structure and ensuring precision and thoroughness in your response.
`;

// ── Prompt builders ────────────────────────────────────────────────────

/**
 * Get the full-conversation compact prompt.
 *
 * @param {string} [customInstructions] - Additional summarization instructions
 * @returns {string}
 */
function getCompactPrompt(customInstructions) {
  let prompt = NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT;

  if (customInstructions && customInstructions.trim()) {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`;
  }

  prompt += NO_TOOLS_TRAILER;
  return prompt;
}

/**
 * Get the partial (incremental) compact prompt.
 *
 * @param {string} [customInstructions] - Additional summarization instructions
 * @returns {string}
 */
function getPartialCompactPrompt(customInstructions) {
  let prompt = NO_TOOLS_PREAMBLE + PARTIAL_COMPACT_PROMPT;

  if (customInstructions && customInstructions.trim()) {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`;
  }

  prompt += NO_TOOLS_TRAILER;
  return prompt;
}

// ── Summary formatting ─────────────────────────────────────────────────

/**
 * Format a compact summary by stripping the <analysis> scratchpad
 * and replacing <summary> XML tags with readable section headers.
 *
 * @param {string} summary - Raw summary from the model
 * @returns {string} Formatted summary
 */
function formatCompactSummary(summary) {
  let formatted = summary;

  // Strip analysis section — drafting scratchpad, no informational value
  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/, '');

  // Extract and format summary section
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    const content = summaryMatch[1] || '';
    formatted = formatted.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${content.trim()}`,
    );
  }

  // Clean up extra whitespace
  formatted = formatted.replace(/\n\n+/g, '\n\n');

  return formatted.trim();
}

/**
 * Build the user-facing summary message for a continued session.
 *
 * @param {string} summary              - The formatted summary
 * @param {object} [options]
 * @param {boolean} [options.suppressFollowUp] - Skip follow-up questions
 * @param {string}  [options.transcriptPath]   - Path to full transcript
 * @param {boolean} [options.recentPreserved]  - Whether recent messages are kept
 * @returns {string}
 */
function getCompactUserMessage(summary, options = {}) {
  const formatted = formatCompactSummary(summary);

  let message = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${formatted}`;

  if (options.transcriptPath) {
    message += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${options.transcriptPath}`;
  }

  if (options.recentPreserved) {
    message += '\n\nRecent messages are preserved verbatim.';
  }

  if (options.suppressFollowUp) {
    message += '\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.';
  }

  return message;
}

// ── Phase R2-3C: Anchored summary (incremental update) ─────────────────

/**
 * Anchored Summary Template.
 * Learned from OC's compaction.ts `buildPrompt()`:
 * When a previous summary exists, instruct the model to UPDATE it
 * (preserve still-true details, remove stale details, merge new facts)
 * instead of regenerating from scratch.
 *
 * This is more efficient (shorter output) and preserves continuity
 * across multiple compaction cycles.
 */
const ANCHORED_SUMMARY_TEMPLATE = `## Goal
[What the user is trying to accomplish — single sentence]

## Constraints & Preferences
[User-specified rules, style preferences, tool restrictions]

## Progress
### Done
- [Completed items with key details]
### In Progress
- [Currently active work]
### Blocked
- [Items waiting on dependencies or user input]

## Key Decisions
- [Architectural or design choices made, with rationale]

## Next Steps
- [Ordered list of what should happen next]

## Critical Context
[Non-obvious facts that would be lost without this summary — error patterns, user corrections, domain knowledge]

## Relevant Files
- [File paths with one-line descriptions of their role/state]`;

/**
 * Build an anchored compact prompt that incrementally updates a previous summary.
 *
 * @param {object} opts
 * @param {string} [opts.previousSummary] - Previous compaction summary (if any)
 * @param {string[]} [opts.context] - Additional context lines to include
 * @param {string} [opts.customInstructions] - User custom instructions
 * @returns {string}
 */
function getAnchoredCompactPrompt({ previousSummary, context = [], customInstructions } = {}) {
  const anchor = previousSummary
    ? [
        'Update the anchored summary below using the conversation history above.',
        'Preserve still-true details, remove stale details, and merge in the new facts.',
        '',
        '<previous-summary>',
        previousSummary,
        '</previous-summary>',
      ].join('\n')
    : 'Create a new anchored summary from the conversation history above.';

  let prompt = NO_TOOLS_PREAMBLE
    + `Your task is to create a structured summary following the anchored summary format.\n\n`
    + anchor
    + '\n\n'
    + ANCHORED_SUMMARY_TEMPLATE;

  if (context.length > 0) {
    prompt += '\n\nAdditional context:\n' + context.join('\n');
  }
  if (customInstructions && customInstructions.trim()) {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`;
  }

  prompt += NO_TOOLS_TRAILER;
  return prompt;
}

module.exports = {
  NO_TOOLS_PREAMBLE,
  NO_TOOLS_TRAILER,
  BASE_COMPACT_PROMPT,
  PARTIAL_COMPACT_PROMPT,
  ANCHORED_SUMMARY_TEMPLATE,
  getCompactPrompt,
  getPartialCompactPrompt,
  getAnchoredCompactPrompt,
  formatCompactSummary,
  getCompactUserMessage,
};
