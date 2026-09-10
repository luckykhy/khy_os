'use strict';
/**
 * prompts.unknownProblemHandler.test.js — flag-gated system-prompt wiring for the
 * Unknown-Problem Handler (DESIGN-ARCH-043).
 *
 * Pins: the state-machine section is absent from the assembled system prompt by
 * default (zero behavior change) and present only when the flag is on. Section
 * caching keys on the flag, so the prompt builder is constructed fresh per case
 * via module-cache reset to avoid a stale cached section across cases.
 */
const FLAG = 'KHY_UNKNOWN_PROBLEM_HANDLER';
function freshPrompts() {
  // Drop cached prompts + section cache so the flag is re-read each case.
  delete require.cache[require.resolve('../../src/constants/prompts')];
  delete require.cache[require.resolve('../../src/constants/systemPromptSections')];
  return require('../../src/constants/prompts');
}
afterEach(() => { delete process.env[FLAG]; });
describe('Unknown-Problem Handler system-prompt wiring', () => {
});

describe('Prompts unknown Problem Handler', () => {
  test('default off: state-machine section is absent from the system prompt', async () => {
        delete process.env[FLAG];
        const prompts = freshPrompts();
        const sections = await prompts.getSystemPrompt({ model: 'test-model', cwd: process.cwd() });
        const joined = sections.filter(Boolean).join('\n\n');
        expect(joined).not.toMatch(/未知问题处理状态机/);
  });

  test('flag on: state-machine section is injected with its emoji structure heads', async () => {
        process.env[FLAG] = 'on';
        const prompts = freshPrompts();
        const sections = await prompts.getSystemPrompt({ model: 'test-model', cwd: process.cwd() });
        const joined = sections.filter(Boolean).join('\n\n');
        expect(joined).toMatch(/未知问题处理状态机/);
        expect(joined).toMatch(/🔍 \*\*未知点识别\*\*/);
        expect(joined).toMatch(/🧭 \*\*方案对比\*\*/);
        expect(joined).toMatch(/⚙️ \*\*执行步骤/);
        expect(joined).toMatch(/严禁输出 `\[State: X\]`/);
  });

});
