'use strict';

const {
  flushAsync,
  setupCliHarness,
} = require('./replTestHarness');

describe('repl input frame resize guards', () => {
  const activeReadlines = [];
  const originalOutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const originalRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  let originalInputFrame;
  let originalPromptFooter;
  let originalPlainTtyUi;
  let originalNoColor;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'columns', { configurable: true, writable: true, value: 80 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, writable: true, value: 24 });

    originalInputFrame = process.env.KHY_INPUT_FRAME;
    originalPromptFooter = process.env.KHY_PROMPT_FOOTER;
    originalPlainTtyUi = process.env.KHY_PLAIN_TTY_UI;
    originalNoColor = process.env.NO_COLOR;

    process.env.KHY_INPUT_FRAME = '1';
    process.env.KHY_PROMPT_FOOTER = '1';
    delete process.env.KHY_PLAIN_TTY_UI;
    delete process.env.NO_COLOR;
  });

  afterEach(() => {
    while (activeReadlines.length > 0) {
      const rl = activeReadlines.pop();
      try { rl.close(); } catch { /* ignore */ }
    }

    jest.useRealTimers();
    jest.restoreAllMocks();

    if (originalOutTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalOutTTY);
    } else {
      delete process.stdout.isTTY;
    }
    if (originalColumns) {
      Object.defineProperty(process.stdout, 'columns', originalColumns);
    } else {
      delete process.stdout.columns;
    }
    if (originalRows) {
      Object.defineProperty(process.stdout, 'rows', originalRows);
    } else {
      delete process.stdout.rows;
    }

    if (originalInputFrame === undefined) delete process.env.KHY_INPUT_FRAME;
    else process.env.KHY_INPUT_FRAME = originalInputFrame;
    if (originalPromptFooter === undefined) delete process.env.KHY_PROMPT_FOOTER;
    else process.env.KHY_PROMPT_FOOTER = originalPromptFooter;
    if (originalPlainTtyUi === undefined) delete process.env.KHY_PLAIN_TTY_UI;
    else process.env.KHY_PLAIN_TTY_UI = originalPlainTtyUi;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  });

  async function startFullRepl() {
    const { rl } = await setupCliHarness({
      mode: 'full',
      startOptions: {
        claudeUi: false,
        enablePluginAutoload: false,
        showGettingStarted: false,
        startupModelPicker: false,
      },
    });
    activeReadlines.push(rl);
    return rl;
  }

  test('full repl keeps the plain prompt even when input frame opt-in is requested', async () => {
    const rl = await startFullRepl();

    const writeSpy = process.stdout.write;
    const baseline = writeSpy.mock.calls.length;
    const promptBaseline = rl.setPrompt.mock.calls.length;

    rl.prompt();
    await flushAsync();

    const writes = writeSpy.mock.calls.slice(baseline).map((call) => String(call[0] || ''));

    expect(rl.setPrompt.mock.calls.length).toBeGreaterThan(promptBaseline);
    expect(rl.setPrompt.mock.calls[rl.setPrompt.mock.calls.length - 1][0]).toBe('❯ ');
    expect(writes.some((text) => /─+/.test(text))).toBe(false);
  });

  test('resizing an active prompt does not emit frame borders or frame cleanup escapes', async () => {
    const rl = await startFullRepl();

    rl.line = 'resize regression coverage';
    rl.cursor = rl.line.length;

    const writeSpy = process.stdout.write;
    const baseline = writeSpy.mock.calls.length;

    process.stdout.columns = 48;
    process.stdout.emit('resize');
    await flushAsync();

    const writes = writeSpy.mock.calls.slice(baseline).map((call) => String(call[0] || ''));

    expect(writes.some((text) => /─+/.test(text))).toBe(false);
    expect(writes.some((text) => /\x1b\[\d+A\x1b\[1G\x1b\[J/.test(text))).toBe(false);
  });

  test('rapid resizes with wrapped input never reintroduce boxed prompt painting', async () => {
    const rl = await startFullRepl();

    rl.line = 'x'.repeat(96);
    rl.cursor = rl.line.length;

    const writeSpy = process.stdout.write;
    const baseline = writeSpy.mock.calls.length;

    for (const width of [62, 41, 79, 33]) {
      process.stdout.columns = width;
      process.stdout.emit('resize');
    }
    await flushAsync();

    const writes = writeSpy.mock.calls.slice(baseline).map((call) => String(call[0] || ''));

    expect(writes.some((text) => /─+/.test(text))).toBe(false);
    expect(writes.some((text) => /\x1b\[\d+A\x1b\[1G\x1b\[J/.test(text))).toBe(false);
  });

  test('the next prompt cycle after resize is still plain and border-free', async () => {
    const rl = await startFullRepl();

    process.stdout.columns = 52;
    process.stdout.emit('resize');
    await flushAsync();

    const writeSpy = process.stdout.write;
    const baseline = writeSpy.mock.calls.length;
    const promptBaseline = rl.setPrompt.mock.calls.length;

    rl.prompt();
    await flushAsync();

    const writes = writeSpy.mock.calls.slice(baseline).map((call) => String(call[0] || ''));

    expect(rl.setPrompt.mock.calls.length).toBeGreaterThan(promptBaseline);
    expect(rl.setPrompt.mock.calls[rl.setPrompt.mock.calls.length - 1][0]).toBe('❯ ');
    expect(writes.some((text) => /─+/.test(text))).toBe(false);
  });
});
