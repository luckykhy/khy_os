'use strict';

/**
 * topologyPanel — headless ink render assertions for TopologyPanel, the 会话拓扑
 * 「森林」(/topology) the TUI renders in place of the classic REPL text tree.
 *
 * Like inkRenderSmoke / agentTreeRender this needs NODE_OPTIONS=--experimental-vm-modules
 * (ink is ESM-only, bridged via a dynamic import); it skips itself otherwise so the
 * default `npm test` stays green. Run for real with:
 *     npm run --workspace backend test:tui
 *
 * What it pins (beyond "mounts non-empty"):
 *   - the forest header (节点 / 主干 counts) + the ├│└ branch glyphs from the
 *     shared sessionTopology SSOT (buildForestRows / nodeDisplayText);
 *   - the current node carries the「← you are here」marker;
 *   - turn count + status surface per node;
 *   - degraded (门控关) shows the honest 平铺 warning;
 *   - empty forest shows the「先聊几句 / /fork」hint, no glyphs.
 */
const { Writable } = require('stream');
const { EventEmitter } = require('events');
const React = require('react');

const rt = require('../../src/cli/tui/inkRuntime');
const topo = require('../../src/cli/sessionTopology');

const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? describe : describe.skip;

if (!VM_MODULES) {
  // eslint-disable-next-line no-console
  console.warn(
    '[topologyPanel] skipped — needs NODE_OPTIONS=--experimental-vm-modules. ' +
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

describeOrSkip('TopologyPanel ink render', () => {
  let ink;
  let TopologyPanel;

  beforeAll(async () => {
    rt.registerJsx();
    await rt.loadInk();
    ink = rt.get();
    TopologyPanel = require('../../src/cli/tui/ink-components/TopologyPanel');
  });

  async function frameFor(props) {
    const stdout = fakeStdout();
    const instance = ink.render(React.createElement(TopologyPanel, props), {
      stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const frame = stdout.getBuffer();
    instance.unmount();
    return frame;
  }

  function sampleForest() {
    // root「根分支」→「岔路A」(current) +「岔路B」
    return topo.buildForest([
      { id: 'root', parentId: null, label: '根分支', turnCount: 3, status: 'active', updatedAt: 100 },
      { id: 'a', parentId: 'root', label: '岔路A', turnCount: 7, status: 'active', updatedAt: 90 },
      { id: 'b', parentId: 'root', label: '岔路B', turnCount: 1, status: 'archived', updatedAt: 80 },
    ]);
  }

  test('renders the forest header + ├└ glyphs + node labels from the shared SSOT', async () => {
    const frame = await frameFor({ forest: sampleForest(), currentId: 'a' });
    expect(frame).toContain('会话拓扑');
    expect(frame).toContain('3 个节点'); // node count
    expect(frame).toContain('根分支');
    expect(frame).toContain('岔路A');
    expect(frame).toContain('岔路B');
    expect(frame).toContain('├'); // first child branch glyph
    expect(frame).toContain('└'); // last child branch glyph
  });

  test('the current node carries 「← you are here」 + turn count + status surface', async () => {
    const frame = await frameFor({ forest: sampleForest(), currentId: 'a' });
    expect(frame).toContain('← you are here');
    expect(frame).toContain('7 turns'); // current node turnCount
    expect(frame).toContain('active');
    expect(frame).toContain('archived'); // idle/archived status surfaced too
  });

  test('degraded (门控关) surfaces the honest 平铺 warning', async () => {
    const frame = await frameFor({ forest: sampleForest(), currentId: 'a', degraded: true });
    expect(frame).toContain('退化');
    expect(frame).toContain('根分支'); // still renders the nodes
  });

  test('empty forest shows the「先聊几句 / /fork」hint, no glyphs', async () => {
    const frame = await frameFor({ forest: { roots: [], nodes: [] } });
    expect(frame).toContain('暂无持久化会话');
    expect(frame).toContain('/fork');
    expect(frame).not.toContain('├');
  });

  test('missing / malformed forest prop falls back to the empty hint (never throws)', async () => {
    const frame = await frameFor({});
    expect(frame).toContain('暂无持久化会话');
  });
});
