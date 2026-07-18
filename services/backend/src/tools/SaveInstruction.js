'use strict';

/**
 * SaveInstruction — let the model PROPOSE a durable project-level instruction
 * to be written into an instruction file (khy.md / agent.md), subject to user review.
 *
 * WHY THIS EXISTS (the goal it serves):
 *   goal「让 khy 学会在合适时机写 khy.md / agent.md」. Instruction files are injected
 *   into EVERY turn's system prompt, so a durable project convention ("this repo uses
 *   pnpm", "run tests before commit", the agreed build command / code style) belongs
 *   there — not in the per-user memory store that SaveMemory writes.
 *
 *   Division of labour vs SaveMemory:
 *     - SaveMemory     → personal facts / preferences / ongoing project FACTS → memory store.
 *     - SaveInstruction→ project-level RULES / conventions / commands → instruction file.
 *
 * SAFETY (why it does NOT write directly):
 *   Because an instruction file shapes every future turn, a mis-judged write would
 *   silently steer the assistant. So this tool NEVER writes the file. It enqueues the
 *   proposal into instructionReviewStore's pending queue; the write happens only when
 *   the user approves it via `/instructions approve <id>` (which re-scans for prompt
 *   injection through appendQuickMemory). The model is told exactly this in the result.
 *
 * Gate: KHY_SAVE_INSTRUCTION_TOOL (default ON). Also honors KHY_DISABLE_MEMORY.
 */

const { defineTool } = require('./_baseTool');

const OFF_VALUES = ['0', 'false', 'off', 'no'];
const VALID_TARGETS = ['khy', 'agent'];
const VALID_SCOPES = ['project', 'global'];

function _saveInstructionEnabled(env) {
  const e = env || process.env;
  const disabled = String(e.KHY_DISABLE_MEMORY || '').trim().toLowerCase();
  if (disabled === '1' || disabled === 'true') return false;
  const raw = String(e.KHY_SAVE_INSTRUCTION_TOOL == null ? '' : e.KHY_SAVE_INSTRUCTION_TOOL).trim().toLowerCase();
  return !OFF_VALUES.includes(raw);
}

module.exports = defineTool({
  name: 'SaveInstruction',
  description:
    'Propose a durable PROJECT-LEVEL instruction/convention to be written into an '
    + 'instruction file (khy.md or agent.md) that is injected into every future turn. '
    + 'Use this when the user establishes a lasting rule for this project — build/test '
    + 'commands, code style, contribution conventions, or agreed working style — as '
    + 'opposed to a personal fact/preference (use SaveMemory for those). '
    + 'The proposal is NOT written immediately; it enters a review queue and is only '
    + 'written after the user approves it via /instructions. '
    + 'target: khy|agent (default khy). scope: project|global (default project).',
  category: 'system',
  risk: 'medium',
  aliases: ['saveInstruction', 'rememberRule', 'writeInstruction'],
  isReadOnly: () => false,
  isConcurrencySafe: false,
  isEnabled: () => _saveInstructionEnabled(process.env),
  inputSchema: {
    note: {
      type: 'string',
      required: true,
      description: 'The project-level rule/convention to record, in one concise imperative line.',
    },
    target: {
      type: 'string',
      required: false,
      enum: VALID_TARGETS,
      description: 'khy = write to khy.md (default); agent = write to agent.md.',
    },
    scope: {
      type: 'string',
      required: false,
      enum: VALID_SCOPES,
      description: 'project = this repo (default); global = the user-global instruction file.',
    },
  },
  async execute(params, _context) {
    if (!_saveInstructionEnabled(process.env)) {
      return { success: false, error: 'SaveInstruction is disabled (KHY_SAVE_INSTRUCTION_TOOL=off or memory disabled).' };
    }
    const note = String((params && params.note) || '').trim();
    if (!note) return { success: false, error: 'note is required (the project-level rule to record).' };

    const target = VALID_TARGETS.includes(params && params.target) ? params.target : 'khy';
    const scope = VALID_SCOPES.includes(params && params.scope) ? params.scope : 'project';

    let store;
    try {
      store = require('../services/instructionReviewStore');
    } catch (e) {
      return { success: false, error: 'instruction review store unavailable: ' + ((e && e.message) || e) };
    }

    const res = store.enqueue({ note, target, scope, source: 'tool' });
    if (!res || !res.success) {
      return { success: false, error: (res && res.error) || 'failed to queue instruction', threats: res && res.threats };
    }
    if (res.skipped) {
      return { success: true, data: { queued: false, duplicate: true, target, scope }, message: '该约定已在待审核队列中（未重复入队）。' };
    }

    const file = target === 'agent' ? 'agent.md' : 'khy.md';
    return {
      success: true,
      data: { queued: true, id: res.id, target, scope },
      message: `已加入待审核队列（id ${res.id}）。用户经 /instructions approve ${res.id} 批准后写入 ${file}。此工具不会直接写入指令文件。`,
    };
  },
});
