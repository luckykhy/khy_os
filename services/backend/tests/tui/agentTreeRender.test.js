'use strict';

/**
 * agentTreeRender — headless ink render assertions for AgentTree, the parallel
 * sub-agent fan-out the TUI shows in place of a single agent(...) row.
 *
 * Like inkRenderSmoke this needs NODE_OPTIONS=--experimental-vm-modules (ink is
 * ESM-only, bridged via a dynamic import); it skips itself otherwise so the
 * default `npm test` stays green. Run for real with:
 *     npm run --workspace backend test:tui
 *
 * What it pins (beyond "mounts non-empty"):
 *   - live/expanded shows the ├│└ branches + header;
 *   - committed + collapsed shows ONLY the header with the (Ctrl+O 展开) hint;
 *   - a finished fan-out flips the header to "N agents finished".
 */
const { Writable } = require('stream');
const { EventEmitter } = require('events');
const React = require('react');

const rt = require('../../src/cli/tui/inkRuntime');

const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? describe : describe.skip;

if (!VM_MODULES) {
  // eslint-disable-next-line no-console
  console.warn(
    '[agentTreeRender] skipped — needs NODE_OPTIONS=--experimental-vm-modules. ' +
      'Run: npm run --workspace backend test:tui'
  );
}

function fakeStdout() {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _enc, cb) { buffer += chunk.toString(); cb(); },
  });
  stream.columns = 80;
  stream.rows = 24;
  stream.isTTY = false;
  stream.getBuffer = () => buffer;
  return stream;
}

function fakeStdin() {
  const stream = new EventEmitter();
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  stream.setEncoding = () => stream;
  stream.resume = () => stream;
  stream.pause = () => stream;
  stream.ref = () => {};
  stream.unref = () => {};
  stream.read = () => null;
  return stream;
}

describeOrSkip('AgentTree ink render', () => {
  let ink;
  let AgentTree;
  let ToolLines;

  beforeAll(async () => {
    rt.registerJsx();
    await rt.loadInk();
    ink = rt.get();
    AgentTree = require('../../src/cli/tui/ink-components/AgentTree');
    ToolLines = require('../../src/cli/tui/ink-components/ToolLines');
  });

  async function frameFor(Comp, props) {
    const stdout = fakeStdout();
    const instance = ink.render(React.createElement(Comp, props), {
      stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const frame = stdout.getBuffer();
    instance.unmount();
    return frame;
  }

  const RUNNING = [
    { id: '1', name: '基本面分析师', status: 'running', toolCalls: 5, elapsed: 2100 },
    { id: '2', name: '风控经理', status: 'running' },
  ];
  const FINISHED = [
    { id: '1', name: '基本面分析师', status: 'completed', detail: 'Done', toolCalls: 5, elapsed: 2100 },
    { id: '2', name: '风控经理', status: 'error', detail: 'timeout' },
  ];

  test('live fan-out renders the header + ├ and └ branches with agent names', async () => {
    const frame = await frameFor(AgentTree, { agents: RUNNING, live: true, expanded: false });
    expect(frame).toContain('Running 2 agents');
    expect(frame).toContain('├');
    expect(frame).toContain('└');
    expect(frame).toContain('基本面分析师');
    expect(frame).toContain('风控经理');
    expect(frame).toContain('5 tool uses');
  });

  test('committed + collapsed shows ONLY the header with the Ctrl+O hint (no branches)', async () => {
    const frame = await frameFor(AgentTree, { agents: RUNNING, live: false, expanded: false });
    expect(frame).toContain('Running 2 agents');
    expect(frame).toContain('Ctrl+O');
    expect(frame).not.toContain('├'); // tree body hidden when folded
    expect(frame).not.toContain('基本面分析师');
  });

  test('expanded reveals the full tree even when not live', async () => {
    const frame = await frameFor(AgentTree, { agents: RUNNING, live: false, expanded: true });
    expect(frame).toContain('├');
    expect(frame).toContain('基本面分析师');
    expect(frame).not.toContain('Ctrl+O'); // no false promise once expanded
  });

  test('a directory-tree preview (目录树) renders as indented sub-lines under the agent', async () => {
    const withTree = [
      {
        id: '1', name: 'Explorer', status: 'running', toolCalls: 2, elapsed: 800,
        currentTool: 'LS', currentTarget: 'src',
        detailLines: ['├ cli/', '└ tools/'],
      },
    ];
    const frame = await frameFor(AgentTree, { agents: withTree, live: true, expanded: false });
    expect(frame).toContain('cli/');
    expect(frame).toContain('tools/');
    expect(frame).toContain('LS src'); // 执行命令/目标 detail line still present
  });

  test('a finished fan-out reports "N agents finished"', async () => {
    const frame = await frameFor(AgentTree, { agents: FINISHED, live: true, expanded: false });
    expect(frame).toContain('2 agents finished');
    expect(frame).toContain('Done');
    expect(frame).toContain('timeout');
  });

  test('empty agent list renders nothing', async () => {
    const frame = await frameFor(AgentTree, { agents: [], live: true, expanded: true });
    expect(frame.trim()).toBe('');
  });

  test('ToolLines renders the tree when an agent tool carries _agentTree', async () => {
    const tools = [{ id: 'tool-A', name: 'agent', input: { prompt: 'X' }, _agentTree: RUNNING }];
    const frame = await frameFor(ToolLines, { tools, expanded: false, live: true });
    expect(frame).toContain('Running 2 agents');
    expect(frame).toContain('基本面分析师');
    // the generic single agent(...) arg-summary line is replaced by the tree
    expect(frame).not.toContain('agent(prompt');
  });

  test('ToolLines falls back to the normal row before any child spawns (_agentTree empty)', async () => {
    const tools = [{ id: 'tool-A', name: 'agent', input: { prompt: 'X' }, _agentTree: [] }];
    const frame = await frameFor(ToolLines, { tools, expanded: false, live: true });
    expect(frame).toContain('agent'); // the normal ◆ agent(...) row
    expect(frame).not.toContain('Running'); // no tree header yet
  });
});
