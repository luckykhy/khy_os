'use strict';

/**
 * RecordProgress — let the model CHECKPOINT cross-session learning/work progress.
 *
 * WHY THIS EXISTS (the real defect it fixes):
 *   The user builds a project folder (e.g. exam prep) and asks the assistant to teach
 *   them over many sessions, but nothing ever records "where we got to" — next session
 *   starts from scratch, the loop never closes. Durable memory can't fill this: its
 *   write triggers only regex the user's literal message, and the memory prompt
 *   explicitly FORBIDS saving "in-progress work / current conversation state" (a
 *   load-bearing anti-noise rule). This tool gives the model a first-class, project-
 *   scoped, append-only progress log — distinct from durable memory — so a later
 *   session can resume via the "where you left off" recall section.
 *
 *   Writes go through memdir.appendProjectProgress → the per-project PROGRESS.md
 *   (isolated by project root), whose latest-per-topic checkpoints are injected at
 *   session start. This closes the write→resume loop.
 *
 * Gate: KHY_PROGRESS_LOG (default ON). Also honors KHY_DISABLE_MEMORY.
 */

const { defineTool } = require('./_baseTool');

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function _progressEnabled(env) {
  const e = env || process.env;
  const disabled = String(e.KHY_DISABLE_MEMORY || '').trim().toLowerCase();
  if (disabled === '1' || disabled === 'true') return false;
  const raw = String(e.KHY_PROGRESS_LOG == null ? '' : e.KHY_PROGRESS_LOG).trim().toLowerCase();
  return !OFF_VALUES.includes(raw);
}

module.exports = defineTool({
  name: 'RecordProgress',
  description:
    'Checkpoint cross-session learning/work progress for the current project folder, so a '
    + 'later session can resume instead of starting over. Use this at a natural milestone '
    + '(finished a chapter/topic, completed a step, agreed on what comes next) when the work '
    + 'spans multiple sessions — e.g. tutoring the user through a study plan. Appends to a '
    + 'project-scoped progress log (isolated per folder); it does NOT replace durable memory '
    + '(identity/preferences) — it records resumable progress that durable memory intentionally '
    + 'excludes. Provide the topic, what was covered this session, and the next step to resume from.',
  category: 'system',
  risk: 'low',
  aliases: ['recordProgress', 'checkpoint', 'saveProgress'],
  isReadOnly: () => false,
  isConcurrencySafe: false,
  isEnabled: () => _progressEnabled(process.env),
  inputSchema: {
    topic: {
      type: 'string',
      required: true,
      description: 'The learning/work track this checkpoint belongs to (e.g. "考公-行测", "React 教程"). '
        + 'Reuse the same topic string across sessions so progress accumulates on one track.',
    },
    covered: {
      type: 'string',
      required: true,
      description: 'What was covered / learned / accomplished in THIS session for this topic.',
    },
    next: {
      type: 'string',
      required: false,
      description: 'The next step to resume from — where the next session should pick up.',
    },
  },
  async execute(params, _context) {
    if (!_progressEnabled(process.env)) {
      return { success: false, error: 'RecordProgress is disabled (KHY_PROGRESS_LOG=off or memory disabled).' };
    }
    const topic = String((params && params.topic) || '').trim();
    const covered = String((params && params.covered) || '').trim();
    const next = params && params.next ? String(params.next).trim() : '';

    if (!topic) return { success: false, error: 'topic is required (the learning/work track).' };
    if (!covered) return { success: false, error: 'covered is required (what was covered this session).' };

    let memdir;
    try {
      memdir = require('../memdir');
    } catch (e) {
      return { success: false, error: 'memory store unavailable: ' + ((e && e.message) || e) };
    }

    try {
      const res = memdir.appendProjectProgress({ topic, covered, next });
      if (!res || !res.ok) {
        return { success: false, error: (res && res.enabled === false)
          ? 'progress log is disabled'
          : 'failed to append progress checkpoint' };
      }
      return { success: true, data: { topic, path: res.path, created: res.created } };
    } catch (err) {
      return { success: false, error: (err && err.message) || String(err) };
    }
  },
});
