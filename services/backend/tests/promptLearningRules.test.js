'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('prompt learning rules', () => {
  test('execution discipline section includes read-first and complete-delivery rules', () => {
    const { getExecutionDisciplineSection } = require('../src/constants/prompts');
    const section = getExecutionDisciplineSection();

    assert.match(section, /Before editing a file, inspect its current contents first\./);
    assert.match(section, /Do not leave TODO placeholders, half-wired code paths, or unfinished migrations/);
    assert.match(section, /Be honest about uncertainty\./);
  });

  test('scope minimization section encodes smallest-sufficient scope and stop conditions', () => {
    const { getScopeMinimizationSection } = require('../src/constants/prompts');
    const section = getScopeMinimizationSection();

    assert.match(section, /define the completion condition in one sentence/i);
    assert.match(section, /Choose the smallest sufficient scope/i);
    assert.match(section, /Read the smallest useful context first/i);
    assert.match(section, /Do not mix the fix with cleanup, renaming, abstraction, documentation, or speculative hardening/i);
    assert.match(section, /Verify with the narrowest convincing check/i);
    assert.match(section, /Stop when the acceptance condition is met/i);
  });

  test('planning and recovery section includes assumption and verification guidance', () => {
    const { getPlanningAndRecoverySection } = require('../src/constants/prompts');
    const section = getPlanningAndRecoverySection();

    assert.match(section, /state one concrete assumption and proceed/i);
    assert.match(section, /2-3 attempts/);
    assert.match(section, /prefer tests, builds, or a verification workflow/);
  });

  test('planning and verification section encodes plan triggers and residual-risk reporting', () => {
    const { getPlanningAndVerificationSection } = require('../src/constants/prompts');
    const section = getPlanningAndVerificationSection();

    assert.match(section, /touches 3 or more files, shared interfaces, architecture, schema\/migration work, dependency changes/i);
    assert.match(section, /A good plan should name the goal, impacted files or modules, ordered implementation steps, key risks, and how the result will be validated\./);
    assert.match(section, /After non-trivial changes, verify before declaring success\./);
    assert.match(section, /Reading code is not verification\./);
    assert.match(section, /state exactly what you did verify, what could not run, and what residual risks remain\./);
  });

  test('task and progress management section encodes single-active-step tracking', () => {
    const { getTaskAndProgressManagementSection } = require('../src/constants/prompts');
    const section = getTaskAndProgressManagementSection();

    assert.match(section, /keep an explicit task list/i);
    assert.match(section, /check whether an equivalent task already exists/i);
    assert.match(section, /Keep one major task in_progress at a time unless work is truly happening in parallel\./);
    assert.match(section, /Update task status immediately after each major step\./);
    assert.match(section, /record the blocker explicitly or use dependency fields such as blocks\/blockedBy/i);
  });

  test('error handling and fallback section encodes stop conditions and report structure', () => {
    const { getErrorHandlingAndFallbackSection } = require('../src/constants/prompts');
    const section = getErrorHandlingAndFallbackSection();

    assert.match(section, /Stop after 2-3 meaningful attempts instead of looping on the same failure\./i);
    assert.match(section, /permissions errors, missing files, unavailable APIs, broken assumptions, and unclear root causes/i);
    assert.match(section, /include four things: what you tried, what error happened, your best current explanation of the cause, and the next step or fallback option/i);
    assert.match(section, /aim at the root cause instead of the surface symptom/i);
    assert.match(section, /If a fix introduces a new failure or regression, stop stacking speculative patches/i);
  });

  test('multi-agent collaboration section encodes delegation boundaries and reuse', () => {
    const { getMultiAgentCollaborationSection } = require('../src/constants/prompts');
    const section = getMultiAgentCollaborationSection();

    assert.match(section, /Use specialized agents for well-scoped subtasks that are independent, bounded, and materially advance the work\./);
    assert.match(section, /Do not delegate trivial lookups or the next blocking step that you should handle locally\./);
    assert.match(section, /Use Explore agents as strict read-only researchers/i);
    assert.match(section, /give each agent explicit ownership/i);
    assert.match(section, /continue that agent instead of spawning a duplicate/i);
    assert.match(section, /Background agents are for genuinely independent work/i);
    assert.match(section, /avoid redoing the same searches or edits yourself/i);
  });

  test('session memory and context section encodes durable-state and compaction rules', () => {
    const { getSessionMemoryAndContextSection } = require('../src/constants/prompts');
    const section = getSessionMemoryAndContextSection();

    assert.match(section, /Keep carry-forward context focused on durable information/i);
    assert.match(section, /Do not turn memory into a raw transcript/i);
    assert.match(section, /preserve the required heading structure/i);
    assert.match(section, /summarize only the recent portion instead of restating the entire conversation/i);
    assert.match(section, /an <analysis> block followed by a <summary> block/i);
    assert.match(section, /current status, confirmed facts, unresolved issues, and exact next steps/i);
  });

  test('security and permission boundaries section encodes least-privilege and confirmation rules', () => {
    const { getSecurityAndPermissionBoundariesSection } = require('../src/constants/prompts');
    const section = getSecurityAndPermissionBoundariesSection();

    assert.match(section, /Follow the least-privilege principle/i);
    assert.match(section, /For read-only tasks, stay read-only/i);
    assert.match(section, /Treat \.env files, credential stores, private keys, tokens, and connection strings as sensitive/i);
    assert.match(section, /Before any irreversible or high-blast-radius action/i);
    assert.match(section, /Generate code with secure defaults: validate untrusted input, prefer parameterized queries, avoid command injection patterns/i);
    assert.match(section, /Before staging, committing, exporting, or uploading content/i);
  });

  test('sensitive data section requires redaction and forbids hardcoded secrets', () => {
    const { getSensitiveDataSection } = require('../src/constants/prompts');
    const section = getSensitiveDataSection();

    assert.match(section, /Never print secrets in full\./);
    assert.match(section, /Do not hardcode secrets, passwords, or fixed credentials/);
  });

  test('file operations section includes read-first, exact-edit, and complete-write rules', () => {
    const { getFileOperationsSection } = require('../src/constants/prompts');
    const section = getFileOperationsSection();

    assert.match(section, /Use absolute paths for file operations\./);
    assert.match(section, /Before editing a file or overwriting an existing file, read it first\./);
    assert.match(section, /copy old_string verbatim from the Read result/i);
    assert.match(section, /write complete UTF-8 content/i);
    assert.match(section, /Independent read-only file inspections may run in parallel\./);
  });

  test('command execution section encodes tool-first shell usage and failure handling', () => {
    const { getCommandExecutionSection } = require('../src/constants/prompts');
    const section = getCommandExecutionSection();

    assert.match(section, /Prefer dedicated tools over shell commands when a tool already exists for the job\./);
    assert.match(section, /affects shared or production systems, or is hard to reverse/i);
    assert.match(section, /builds, tests, installs, and other potentially long-running commands/i);
    assert.match(section, /surface the important stdout or stderr lines/i);
    assert.match(section, /use the exit status and stderr to diagnose the cause before retrying/i);
    assert.match(section, /On Windows, prefer syntax compatible with the configured shell/i);
  });

  test('search and exploration section encodes tool split and unfamiliar-repo workflow', () => {
    const { getSearchAndExplorationSection } = require('../src/constants/prompts');
    const section = getSearchAndExplorationSection();

    assert.match(section, /Use Glob to find files by name or path pattern, Grep to search text inside files, and Read when you already know the exact file you need\./);
    assert.match(section, /Do not route search work through Bash when dedicated tools can answer it\./);
    assert.match(section, /Do not use Glob as a substitute for content search\./);
    assert.match(section, /start with README, package\.json, pyproject\.toml, or equivalent project manifests/i);
    assert.match(section, /If a search returns too many matches, narrow the scope\./);
    assert.match(section, /Independent read-only searches and file reads may run in parallel/i);
    assert.match(section, /the search scope you used \(paths, patterns, or filters\)/i);
  });

  test('response formatting section encodes response shape, sources, and progress style', () => {
    const { getResponseFormattingSection } = require('../src/constants/prompts');
    const section = getResponseFormattingSection();

    assert.match(section, /Simple questions should get a short direct answer without unnecessary headings or lists/i);
    assert.match(section, /complex tasks may use short headings and flat bullet lists/i);
    assert.match(section, /what changed, why it changed, and how it was verified/i);
    assert.match(section, /fenced markdown code blocks with an appropriate language tag/i);
    assert.match(section, /end with a `Sources:` section/i);
    assert.match(section, /Avoid vague status-only lines/i);
    assert.match(section, /Avoid decorative over-formatting/i);
  });

  test('using-tools section teaches task tool workflow when task tools are enabled', () => {
    const { getUsingYourToolsSection } = require('../src/constants/prompts');
    const section = getUsingYourToolsSection(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite']);

    assert.match(section, /Use the task-tracking tools proactively for multi-step work/i);
    assert.match(section, /Use TaskCreate to capture the work, then TaskUpdate to move tasks through pending -> in_progress -> completed/i);
    assert.match(section, /Use TaskList to review progress/i);
    assert.match(section, /Use TaskGet before updating a task/i);
    assert.match(section, /If TodoWrite is the available checklist tool, keep the list fully synchronized/i);
  });

  test('using-tools section teaches agent collaboration workflow when agent tools are enabled', () => {
    const { getUsingYourToolsSection } = require('../src/constants/prompts');
    const section = getUsingYourToolsSection(['Agent', 'SendMessage']);

    assert.match(section, /Use Agent for independent, well-scoped subtasks/i);
    assert.match(section, /give each spawned agent explicit ownership or read-only scope/i);
    assert.match(section, /split only truly independent work/i);
    assert.match(section, /continue it with SendMessage instead of spawning a duplicate/i);
  });

  test('system prompt assembly includes the new learning sections', async () => {
    const { getSystemPrompt, assembleSystemPrompt } = require('../src/constants/prompts');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-prompt-learning-'));

    try {
      const sections = await getSystemPrompt({ cwd: tmpDir, enabledTools: ['Read', 'Edit', 'Bash'] });
      const prompt = assembleSystemPrompt(sections);

      assert.match(prompt, /# Execution discipline/);
      assert.match(prompt, /# Scope minimization and sufficient execution/);
      assert.match(prompt, /# Planning and recovery/);
      assert.match(prompt, /# Planning and verification/);
      assert.match(prompt, /# Task and progress management/);
      assert.match(prompt, /# Error handling and fallback/);
      assert.match(prompt, /# Multi-agent collaboration/);
      assert.match(prompt, /# Session memory and context/);
      assert.match(prompt, /# Executing actions with care/);
      assert.match(prompt, /# Security and permission boundaries/);
      assert.match(prompt, /# Response formatting/);
      assert.match(prompt, /# Sensitive data/);
      assert.match(prompt, /# File operations/);
      assert.match(prompt, /# Command execution/);
      assert.match(prompt, /# Search and exploration/);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('agent and tool prompts emphasize file-operation and exploration discipline', async () => {
    const { getAgentToolPrompt } = require('../src/agents/prompt');
    const { getBuiltInAgents } = require('../src/agents/builtInAgents');
    const { GENERAL_PURPOSE_AGENT } = require('../src/agents/built-in/generalPurposeAgent');
    const { AGENT_ROLES } = require('../src/services/cliAgentRunner');
    const fileReadTool = require('../src/tools/FileReadTool');
    const fileEditTool = require('../src/tools/FileEditTool');
    const fileWriteTool = require('../src/tools/FileWriteTool');
    const exploreAgent = require('../src/agents/built-in/exploreAgent');
    const planAgent = require('../src/agents/built-in/planAgent');
    const verificationAgent = require('../src/agents/built-in/verificationAgent');
    const globTool = require('../src/tools/GlobTool');
    const grepTool = require('../src/tools/GrepTool');
    const shellCommandTool = require('../src/tools/shellCommand');
    const taskCreateTool = require('../src/tools/TaskCreateTool');
    const taskUpdateTool = require('../src/tools/TaskUpdateTool');
    const taskListTool = require('../src/tools/TaskListTool');
    const TodoWriteTool = require('../src/tools/TodoWriteTool');
    const agentTool = require('../src/tools/AgentTool');
    const sendMessageTool = require('../src/tools/SendMessageTool');

    const builtInAgents = getBuiltInAgents();
    const agentPrompt = getAgentToolPrompt(builtInAgents);
    const generalPrompt = GENERAL_PURPOSE_AGENT.getSystemPrompt();
    const generalRolePrompt = AGENT_ROLES['general-purpose'].systemPrompt;
    const implementPrompt = AGENT_ROLES.implement.systemPrompt;
    const exploreRolePrompt = AGENT_ROLES.explore.systemPrompt;
    const explorePrompt = exploreAgent.EXPLORE_AGENT.getSystemPrompt();
    const planPrompt = planAgent.PLAN_AGENT.getSystemPrompt();
    const verifyPrompt = verificationAgent.VERIFICATION_AGENT.getSystemPrompt();
    const readPrompt = fileReadTool.prompt();
    const editPrompt = fileEditTool.prompt();
    const writePrompt = fileWriteTool.prompt();
    const globPrompt = globTool.prompt();
    const grepPrompt = grepTool.prompt();
    const shellPrompt = await shellCommandTool.prompt();
    const taskCreatePrompt = taskCreateTool.prompt();
    const taskUpdatePrompt = taskUpdateTool.prompt();
    const taskListPrompt = taskListTool.prompt();
    const todoWritePrompt = new TodoWriteTool().prompt();
    const agentToolPrompt = agentTool.prompt();
    const sendMessagePrompt = sendMessageTool.prompt();
    const agentToolSchema = agentTool.inputSchema;

    assert.match(agentPrompt, /consider using the Plan agent first/i);
    assert.match(agentPrompt, /define the acceptance condition and the smallest owned slice/i);
    assert.match(agentPrompt, /keep task tracking current/i);
    assert.match(agentPrompt, /If a blocker survives 2-3 adjusted attempts/i);
    assert.match(agentPrompt, /Use agents for independent sidecar work, not for the next critical-path step/i);
    assert.match(agentPrompt, /assign clear ownership/i);
    assert.match(agentPrompt, /Never duplicate delegated work\./i);
    assert.match(agentPrompt, /consider using the verification agent/i);
    assert.match(generalPrompt, /Leave no TODO placeholders or half-finished paths/i);
    assert.match(generalPrompt, /Prefer dedicated read\/search\/edit tools over shell equivalents/i);
    assert.match(generalPrompt, /the smallest sufficient scope, and the acceptance condition/i);
    assert.match(generalPrompt, /keep task tracking current/i);
    assert.match(generalPrompt, /After 2-3 adjusted attempts on one blocker/i);
    assert.match(generalPrompt, /NEVER paper over a symptom\. Fix the root cause/i);
    assert.match(generalPrompt, /Keep working context lean\./i);
    assert.match(generalPrompt, /Put code or commands in fenced markdown blocks with language tags/i);
    assert.match(generalPrompt, /add a Sources section when web facts are part of the answer/i);
    assert.match(generalPrompt, /Use the least privilege necessary\./i);
    assert.match(generalPrompt, /redact secrets instead of echoing them/i);
    assert.match(generalPrompt, /explicit confirmation before irreversible or high-blast-radius actions/i);
    assert.match(generalPrompt, /NEVER expand the task/i);
    assert.match(generalPrompt, /Use specialized agents only for independent sidecar work/i);
    assert.match(generalPrompt, /run focused verification/i);
    assert.match(generalRolePrompt, /Keep carry-forward context focused on durable facts, decisions, blockers, and next steps instead of raw logs/i);
    assert.match(generalRolePrompt, /Define completion and choose the smallest sufficient scope before broadening the work/i);
    assert.match(generalRolePrompt, /Format simple results directly and complex ones with compact headings or flat bullets/i);
    assert.match(generalRolePrompt, /add a Sources section for web-based facts/i);
    assert.match(generalRolePrompt, /Use the least privilege necessary, stay read-only on read-only tasks, redact secrets, and require explicit confirmation before irreversible or high-blast-radius actions/i);
    assert.match(implementPrompt, /copy exact old_string from the read result/i);
    assert.match(implementPrompt, /Define completion and choose the smallest sufficient scope before you edit/i);
    assert.match(implementPrompt, /do not mix the requested change with cleanup unless it is required for a safe completion/i);
    assert.match(implementPrompt, /inspect stderr plus exit code before retrying/i);
    assert.match(implementPrompt, /Keep task progress current for multi-step work/i);
    assert.match(implementPrompt, /After 2-3 adjusted attempts on the same blocker/i);
    assert.match(implementPrompt, /Fix root causes rather than layering patches/i);
    assert.match(exploreRolePrompt, /start with README or project manifests/i);
    assert.match(exploreRolePrompt, /Stay strictly read-only/i);
    assert.match(exploreRolePrompt, /Avoid shell grep\/find\/cat loops when dedicated tools can answer directly/i);
    assert.match(exploreRolePrompt, /search scope, result counts/i);
    assert.match(explorePrompt, /start with README, package manifests/i);
    assert.match(explorePrompt, /Do NOT use Bash for grep, rg, find, cat, head, or tail/i);
    assert.match(explorePrompt, /which paths\/patterns\/filters you searched/i);
    assert.match(planPrompt, /task-sized so they can be tracked one at a time/i);
    assert.match(planPrompt, /which steps can run in parallel and which must stay sequential/i);
    assert.match(planPrompt, /### Validation Strategy/);
    assert.match(verifyPrompt, /Treat the original task description as the contract/);
    assert.match(verifyPrompt, /say what you tried, exactly what blocked it, the likely cause, and what risk remains/i);
    assert.match(readPrompt, /Prefer the smallest useful read/i);
    assert.match(readPrompt, /avoid reading unrelated files or unrelated regions/i);
    assert.match(readPrompt, /independent file reads can happen in parallel/i);
    assert.match(editPrompt, /Choose the smallest sufficient edit/i);
    assert.match(editPrompt, /Prefer one focused replacement per call\./);
    assert.match(editPrompt, /Do not combine a requested fix with unrelated cleanup/i);
    assert.match(writePrompt, /write complete UTF-8 content/i);
    assert.match(globPrompt, /Do NOT use this tool to search file contents/i);
    assert.match(globPrompt, /Do NOT fall back to Bash find\/ls loops/i);
    assert.match(globPrompt, /mention the pattern\/path you searched and how many files matched/i);
    assert.match(grepPrompt, /Use Grep to find functions, classes, routes, identifiers/i);
    assert.match(grepPrompt, /NEVER invoke `grep` or `rg` as a Bash command/i);
    assert.match(grepPrompt, /name the path\/glob\/type filters you used and surface relevant match counts/i);
    assert.match(shellPrompt, /Prefer dedicated tools over this tool whenever possible/i);
    assert.match(shellPrompt, /Choose the narrowest sufficient command or check/i);
    assert.match(shellPrompt, /inspect the exit code and stderr before retrying/i);
    assert.match(shellPrompt, /After 2-3 adjusted attempts on the same failing command path/i);
    assert.match(shellPrompt, /Do not jump to a broader command like a full test suite, full build, or repo-wide scan/i);
    assert.match(shellPrompt, /Prefer root-cause fixes over command-line band-aids/i);
    assert.match(shellPrompt, /do not assume PowerShell 7-only features are available/i);
    assert.match(taskCreatePrompt, /Prefer task-sized steps that can move cleanly from pending to in_progress to completed/i);
    assert.match(taskUpdatePrompt, /Keep one major task in_progress at a time unless work is truly happening in parallel/i);
    assert.match(taskUpdatePrompt, /use blocks\/blockedBy or the task description to record that blocker explicitly/i);
    assert.match(taskListPrompt, /Review the list after each completed step/i);
    assert.match(todoWritePrompt, /Keep one major item in_progress at a time unless work is truly happening in parallel/i);
    assert.match(agentToolPrompt, /Keep immediate blocking work local/i);
    assert.match(agentToolPrompt, /Explore is strictly read-only research/i);
    assert.match(agentToolPrompt, /assign explicit ownership/i);
    assert.match(agentToolPrompt, /Use the `subtasks` array only for truly independent subtasks/i);
    assert.match(agentToolPrompt, /continue it with SendMessage instead of spawning a duplicate/i);
    assert.match(agentToolPrompt, /Background agents are for genuinely independent work/i);
    assert.match(sendMessagePrompt, /continue an existing worker instead of spawning a duplicate agent/i);
    assert.match(sendMessagePrompt, /Prefer this over spawning a new agent when the existing worker already has the most relevant context/i);
    assert.match(agentToolPrompt, /"verification" — alias of "verify"/i);
    assert.ok(builtInAgents.some((agent) => agent.agentType === 'verification'));
    assert.ok(agentToolSchema.properties.subagent_type.enum.includes('verification'));
  });

  test('compact prompts enforce no-tool analysis-summary carry-forward format', () => {
    const {
      getCompactPrompt,
      getPartialCompactPrompt,
      getAnchoredCompactPrompt,
    } = require('../src/services/compact/prompt');

    const fullPrompt = getCompactPrompt();
    const partialPrompt = getPartialCompactPrompt();
    const anchoredPrompt = getAnchoredCompactPrompt({ previousSummary: '## Goal\nKeep working' });

    assert.match(fullPrompt, /Do NOT call any tools/i);
    assert.match(fullPrompt, /an <analysis> block followed by a <summary> block/i);
    assert.match(fullPrompt, /Record why decisions were made, not just that they happened/i);
    assert.match(fullPrompt, /only the code snippets that are essential for continuation/i);
    assert.match(fullPrompt, /Preserve only the durable context needed to continue work accurately/i);
    assert.match(partialPrompt, /The earlier messages are being kept intact and do NOT need to be summarized/i);
    assert.match(partialPrompt, /preserve new constraints, decisions, blockers, and next steps/i);
    assert.match(anchoredPrompt, /Update the anchored summary below using the conversation history above\./i);
    assert.match(anchoredPrompt, /Preserve still-true details, remove stale details, and merge in the new facts\./i);
  });
});
