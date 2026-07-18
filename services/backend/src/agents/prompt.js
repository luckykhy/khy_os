'use strict';

/**
 * Agent tool prompt builder.
 * Aligned with Claude Code's AgentTool/prompt.ts.
 *
 * Generates the system prompt for the Agent tool, including
 * the agent listing, usage notes, examples, and when-not-to-use guidance.
 */

const { formatAgentLine } = require('./builtInAgents');

const AGENT_TOOL_NAME = 'Agent';
const FILE_READ_TOOL_NAME = 'Read';
const FILE_WRITE_TOOL_NAME = 'Write';
const GLOB_TOOL_NAME = 'Glob';
const SEND_MESSAGE_TOOL_NAME = 'SendMessage';

/**
 * Build the Agent tool prompt.
 *
 * @param {Array<import('./types').AgentDefinition>} agentDefinitions
 * @param {object} [opts]
 * @param {boolean} [opts.isCoordinator] - Slim prompt for coordinator mode
 * @param {string[]} [opts.allowedAgentTypes] - Restrict to specific agent types
 * @returns {string}
 */
function getAgentToolPrompt(agentDefinitions, opts = {}) {
  const { isCoordinator = false, allowedAgentTypes } = opts;

  const effectiveAgents = allowedAgentTypes
    ? agentDefinitions.filter(a => allowedAgentTypes.includes(a.agentType))
    : agentDefinitions;

  const agentListSection = `Available agent types and the tools they have access to:
${effectiveAgents.map(agent => formatAgentLine(agent)).join('\n')}`;

  const shared = `Launch a new agent to handle complex, multi-step tasks autonomously.

The ${AGENT_TOOL_NAME} tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

${agentListSection}

When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.`;

  // Coordinator mode gets the slim prompt
  if (isCoordinator) {
    return shared;
  }

  const whenNotToUseSection = `
When NOT to use the ${AGENT_TOOL_NAME} tool:
- If you want to read a specific file path, use the ${FILE_READ_TOOL_NAME} tool or the ${GLOB_TOOL_NAME} tool instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the ${GLOB_TOOL_NAME} tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the ${FILE_READ_TOOL_NAME} tool instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above
`;

  const usageNotes = `
Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
- When a task touches multiple files, shared interfaces, or architecture, consider using the Plan agent first to map the work before delegating implementation.
- Before delegating implementation, define the acceptance condition and the smallest owned slice so the worker does not broaden the task unnecessarily.
- For multi-step work in the main thread, keep task tracking current: one major item in progress at a time unless work is truly parallel, and update the list as soon as a step finishes or a blocker appears.
- If a blocker survives 2-3 adjusted attempts, stop the loop, update the task status or blocker details, and report what you tried plus the next recovery option instead of pushing more speculative fixes.
- Use agents for independent sidecar work, not for the next critical-path step that you are blocked on right now.
- When delegating implementation or verification, assign clear ownership: name the files, modules, or responsibilities the agent owns, and whether it should write code or only research.
- After non-trivial implementation work, consider using the verification agent to validate the result before you report completion. Pass the original task, files changed, and approach taken.
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed — e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel.
- To continue a previously spawned agent, use ${SEND_MESSAGE_TOOL_NAME} with the agent's ID or name as the \`to\` field. The agent resumes with its full context preserved. Each Agent invocation starts fresh — provide a complete task description.
- Provide clear, detailed prompts so the agent can work autonomously and return exactly the information you need.
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple ${AGENT_TOOL_NAME} tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.
- You can optionally set \`isolation: "worktree"\` to run the agent in a temporary git worktree, giving it an isolated copy of the repository. The worktree is automatically cleaned up if the agent makes no changes; if changes are made, the worktree path and branch are returned in the result.`;

  // boss 侧「怎么写派发提示词」教学的单一真源在纯叶子 delegationPromptPolicy
  // (门控 KHY_DELEGATION_PROMPT 默认开;关闭则逐字节回退到下方既有文案)。require
  // 失败(如尚未重建的 bundled 副本拿不到该叶子)时退回内联 legacy 文案,保证字节回退。
  let writingThePromptSection;
  try {
    writingThePromptSection = require('../services/agents/delegationPromptPolicy')
      .resolveWritingThePromptSection();
  } catch {
    writingThePromptSection = `

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.
**Never duplicate delegated work.** If an agent is already researching a slice of the problem, do not repeat the same searches locally unless the returned result is incomplete or conflicting.
`;
  }

  const examples = `Example usage:

<example_agent_descriptions>
"test-runner": use this agent after you are done writing code to run tests
"greeting-responder": use this agent to respond to user greetings with a friendly joke
</example_agent_descriptions>

<example>
user: "Please write a function that checks if a number is prime"
assistant: I'm going to use the ${FILE_WRITE_TOOL_NAME} tool to write the following code:
<code>
function isPrime(n) {
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}
</code>
<commentary>
Since a significant piece of code was written and the task was completed, now use the test-runner agent to run the tests
</commentary>
assistant: Uses the ${AGENT_TOOL_NAME} tool to launch the test-runner agent
</example>

<example>
user: "Hello"
<commentary>
Since the user is greeting, use the greeting-responder agent to respond with a friendly joke
</commentary>
assistant: "I'm going to use the ${AGENT_TOOL_NAME} tool to launch the greeting-responder agent"
</example>
`;

  return `${shared}
${whenNotToUseSection}
${usageNotes}${writingThePromptSection}
${examples}`;
}

module.exports = { getAgentToolPrompt };
