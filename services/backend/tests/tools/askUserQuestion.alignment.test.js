/**
 * AskUserQuestionTool — Claude Code alignment test.
 *
 * Validates that KHY's AskUserQuestion tool conforms to Claude Code's specification:
 * - questions array (1-4 questions)
 * - header field (short chip/tag, max 12 chars)
 * - options (2-4 per question)
 * - preview field support
 * - metadata and annotations fields
 * - Constraint validation
 */
const AskUserQuestionTool = require('../../src/tools/AskUserQuestionTool');

describe('AskUserQuestionTool — Claude Code alignment', () => {
  describe('Schema validation', () => {
    test('accepts valid questions array with all fields', async () => {
      const params = {
        questions: [
          {
            question: 'Which authentication method should we use?',
            header: 'Auth method',
            options: [
              { label: 'OAuth2', description: 'Industry standard, requires setup' },
              { label: 'JWT', description: 'Simple, stateless tokens' },
            ],
            multiSelect: false,
          },
        ],
        metadata: { source: 'remember' },
        annotations: {},
      };

      const result = await AskUserQuestionTool.execute(params, {});
      expect(result.success).toBe(true);
      expect(result.type).toBe('question');
      expect(result.questions).toHaveLength(1);
      expect(result.questions[0].header).toBe('Auth method');
      expect(result.metadata).toEqual({ source: 'remember' });
    });

    test('accepts preview field in options', async () => {
      const params = {
        questions: [
          {
            question: 'Choose layout?',
            header: 'Layout',
            options: [
              {
                label: 'Grid',
                description: '2x2 grid layout',
                preview: '┌─┬─┐\n├─┼─┤\n└─┴─┘',
              },
              {
                label: 'List',
                description: 'Vertical list',
                preview: '━\n━\n━',
              },
            ],
            multiSelect: false,
          },
        ],
      };

      const result = await AskUserQuestionTool.execute(params, {});
      expect(result.success).toBe(true);
      expect(result.questions[0].options[0].preview).toBe('┌─┬─┐\n├─┼─┤\n└─┴─┘');
    });

    test('rejects 0 questions', async () => {
      const result = await AskUserQuestionTool.execute({ questions: [] }, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('1-4 questions');
    });

    test('rejects >4 questions', async () => {
      const questions = Array(5).fill(null).map((_, i) => ({
        question: `Question ${i + 1}?`,
        header: `Q${i + 1}`,
        options: [
          { label: 'Yes', description: 'Confirm' },
          { label: 'No', description: 'Decline' },
        ],
        multiSelect: false,
      }));

      const result = await AskUserQuestionTool.execute({ questions }, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('1-4 questions');
    });

    test('rejects <2 options', async () => {
      const params = {
        questions: [
          {
            question: 'Only one option?',
            header: 'Test',
            options: [{ label: 'Only', description: 'One choice' }],
            multiSelect: false,
          },
        ],
      };

      const result = await AskUserQuestionTool.execute(params, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('2-4 options');
    });

    test('rejects >4 options', async () => {
      const params = {
        questions: [
          {
            question: 'Too many options?',
            header: 'Test',
            options: [
              { label: 'A', description: 'First' },
              { label: 'B', description: 'Second' },
              { label: 'C', description: 'Third' },
              { label: 'D', description: 'Fourth' },
              { label: 'E', description: 'Fifth' },
            ],
            multiSelect: false,
          },
        ],
      };

      const result = await AskUserQuestionTool.execute(params, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('2-4 options');
    });
  });

  describe('Backward compatibility', () => {
    test('normalizes legacy single-question params', async () => {
      const params = {
        question: 'Legacy question?',
        options: [
          { label: 'Yes', description: 'Confirm' },
          { label: 'No', description: 'Decline' },
        ],
        multiSelect: false,
      };

      const result = await AskUserQuestionTool.execute(params, {});
      expect(result.success).toBe(true);
      expect(result.questions).toHaveLength(1);
      expect(result.questions[0].question).toBe('Legacy question?');
      expect(result.questions[0].header).toBe('Question');
    });

    test('trims long header to 12 chars', async () => {
      const params = {
        question: 'Test?',
        header: 'VeryLongHeaderThatExceedsTwelveCharacters',
        options: [
          { label: 'A', description: 'First' },
          { label: 'B', description: 'Second' },
        ],
        multiSelect: false,
      };

      const result = await AskUserQuestionTool.execute(params, {});
      expect(result.success).toBe(true);
      expect(result.questions[0].header).toHaveLength(12);
      expect(result.questions[0].header).toBe('VeryLongHead');
    });
  });

  describe('Multi-round questions', () => {
    test('accepts 4 questions (max)', async () => {
      const questions = Array(4).fill(null).map((_, i) => ({
        question: `Question ${i + 1}?`,
        header: `Q${i + 1}`,
        options: [
          { label: 'Yes', description: 'Confirm' },
          { label: 'No', description: 'Decline' },
        ],
        multiSelect: false,
      }));

      const result = await AskUserQuestionTool.execute({ questions }, {});
      expect(result.success).toBe(true);
      expect(result.questions).toHaveLength(4);
    });
  });

  describe('Metadata and annotations', () => {
    test('preserves metadata object', async () => {
      const params = {
        questions: [
          {
            question: 'Test?',
            header: 'Test',
            options: [
              { label: 'A', description: 'First' },
              { label: 'B', description: 'Second' },
            ],
            multiSelect: false,
          },
        ],
        metadata: { source: 'remember', sessionId: 'abc123' },
      };

      const result = await AskUserQuestionTool.execute(params, {});
      expect(result.metadata).toEqual({ source: 'remember', sessionId: 'abc123' });
    });

    test('preserves annotations object', async () => {
      const params = {
        questions: [
          {
            question: 'Test?',
            header: 'Test',
            options: [
              { label: 'A', description: 'First' },
              { label: 'B', description: 'Second' },
            ],
            multiSelect: false,
          },
        ],
        annotations: { 'Test?': 'User noted preference for A' },
      };

      const result = await AskUserQuestionTool.execute(params, {});
      expect(result.annotations).toEqual({ 'Test?': 'User noted preference for A' });
    });

    test('defaults metadata and annotations to empty objects', async () => {
      const params = {
        questions: [
          {
            question: 'Test?',
            header: 'Test',
            options: [
              { label: 'A', description: 'First' },
              { label: 'B', description: 'Second' },
            ],
            multiSelect: false,
          },
        ],
      };

      const result = await AskUserQuestionTool.execute(params, {});
      expect(result.metadata).toEqual({});
      expect(result.annotations).toEqual({});
    });
  });
});
