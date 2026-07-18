/**
 * AskUserQuestionTool — structured user interaction, aligned with Claude Code's AskUserQuestion tool.
 *
 * Allows the AI to ask the user multiple-choice or free-form questions
 * during execution. Supports multi-select and recommended options.
 */
const { BaseTool } = require('../_baseTool');
const _questionQuality = require('../../services/questionQuality');

class AskUserQuestionTool extends BaseTool {
  static toolName = 'AskUserQuestion';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['ask_user', 'ask_question', 'prompt_user'];
  static searchHint = 'ask user question clarify confirm choice';
  static alwaysLoad = true;

  isReadOnly() { return true; }
  isConcurrencySafe() { return false; }

  prompt() {
    return `Use this tool only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the code, or sensible defaults.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Write high-quality questions:
- Ask the smallest number of questions that actually unblock you — one focused decision per question, not a survey.
- The question must be specific and answerable in one read: name the concrete choice at stake, not "What do you want?".
- Options must be mutually exclusive and jointly cover the realistic space — no overlap, no "it depends" catch-alls (the user always has "Other").
- Give each option a short distinct label (1-5 words) plus a description that states the concrete consequence of choosing it, so options can be told apart at a glance.
- Recommend one option when you genuinely have a lean: put it first, mark it "(Recommended)", and let its description say WHY it is the safer/faster default. If you truly have no lean, do not fabricate a recommendation.
- When you ask more than one question, make the cards ORTHOGONAL — each a distinct axis (e.g. goal / scope / format), so the answers COMBINE into one coherent decision. Avoid cards whose answers can contradict each other; after the user answers, you will synthesize the whole set and adjust direction, so design them to compose.
- Do not ask about things you can verify yourself (read the code), nor about conventional defaults — pick the obvious choice and proceed.

Plan mode note: To switch into plan mode, use EnterPlanMode (not this tool). Once in plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?", "Should I proceed?", or otherwise reference "the plan" in questions — the user cannot see the plan until you call ExitPlanMode for approval.

Reserve this for decisions where the user's answer changes what you do next — not for choices with a conventional default or facts you can verify in the codebase yourself. In those cases pick the obvious option, mention it in your response, and proceed.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'Questions to ask the user (1-4 questions)',
          items: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The complete question to ask the user. Should be clear, specific, and end with a question mark.',
              },
              header: {
                type: 'string',
                description: 'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".',
              },
              options: {
                type: 'array',
                description: 'The available choices for this question. Must have 2-4 options.',
                items: {
                  type: 'object',
                  properties: {
                    label: {
                      type: 'string',
                      description: 'The display text for this option (1-5 words).',
                    },
                    description: {
                      type: 'string',
                      description: 'Explanation of what this option means or what will happen if chosen.',
                    },
                    preview: {
                      type: 'string',
                      description: 'Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons.',
                    },
                  },
                  required: ['label', 'description'],
                },
                minItems: 2,
                maxItems: 4,
              },
              multiSelect: {
                type: 'boolean',
                description: 'Set to true to allow multiple options to be selected (default: false).',
              },
            },
            required: ['question', 'header', 'options', 'multiSelect'],
          },
          minItems: 1,
          maxItems: 4,
        },
        answers: {
          type: 'object',
          description: 'User answers collected by the permission component',
        },
        metadata: {
          type: 'object',
          description: 'Optional metadata for tracking and analytics purposes. Not displayed to user.',
          properties: {
            source: {
              type: 'string',
              description: 'Optional identifier for the source of this question (e.g., "remember" for /remember command).',
            },
          },
        },
        annotations: {
          type: 'object',
          description: 'Optional per-question annotations from the user (e.g., notes on preview selections). Keyed by question text.',
        },
      },
      required: ['questions'],
    };
  }

  getActivityDescription(input) {
    const preview = (input.question || '').slice(0, 40);
    return `向用户提问：${preview}`;
  }

  async execute(params, _context) {
    // This tool no longer performs its own console/readline I/O. Interactive
    // rendering is owned by the host: the ink TUI (QuestionPrompt) and the
    // classic REPL (handleControlRequest → aiRenderer.askInlineQuestion). The
    // agentic loop (toolUseLoop) intercepts this structured result and surfaces
    // it through the host's onControlRequest channel, then replaces the result
    // with the user's answers before feeding it back to the model. Doing its
    // own readline here would race the ink raw-mode input and the REPL readline.

    // Normalize legacy single-question params to the canonical questions array.
    let questions = Array.isArray(params.questions) && params.questions.length
      ? params.questions
      : [];

    // Backward compatibility: if no `questions` array but old-style `question` field exists, normalize it.
    if (questions.length === 0 && params.question) {
      questions = [{
        question: String(params.question || ''),
        header: String(params.header || '').slice(0, 12) || 'Question',
        options: Array.isArray(params.options) ? params.options : [],
        multiSelect: !!params.multiSelect,
      }];
    }

    // Validate constraints per Claude Code spec.
    if (questions.length === 0 || questions.length > 4) {
      return {
        success: false,
        error: 'AskUserQuestion requires 1-4 questions',
      };
    }

    for (const q of questions) {
      const opts = Array.isArray(q.options) ? q.options : [];
      if (opts.length < 2 || opts.length > 4) {
        return {
          success: false,
          error: `Question "${q.question}" requires 2-4 options, got ${opts.length}`,
        };
      }
    }

    // Deterministically guarantee "recommended option first": if the model marked
    // an option "(Recommended)"/"(推荐)" but placed it out of position, promote it
    // to index 0 so every host (ink TUI + REPL) renders it first — instead of
    // relying solely on the prompt instruction. No marker → byte-identical passthrough.
    // Gated KHY_QUESTION_RECOMMENDED_FIRST (default on); never throws.
    try {
      questions = _questionQuality.normalizeQuestions(questions, { env: process.env });
    } catch { /* fail-soft: keep model-supplied order */ }

    return {
      success: true,
      type: 'question',
      questions,
      metadata: params.metadata || {},
      annotations: params.annotations || {},
      // Echo the first question's fields for backward-compatible single-question consumers.
      question: questions[0].question,
      options: questions[0].options,
      multiSelect: questions[0].multiSelect,
      // When no host channel handles the question (e.g. a subagent loop with no
      // onControlRequest), the loop's output extractor surfaces this message to
      // the model — preserving today's non-interactive fallback behavior.
      message: 'Question queued for user',
    };
  }
}

module.exports = new AskUserQuestionTool();
module.exports.AskUserQuestionTool = AskUserQuestionTool;
