'use strict';

// BUG-118 regression: clipboard relay `list` must align the url column across
// rows regardless of whether the service name is CJK or ASCII. The shipped bug
// padded the name column with String.padEnd (UTF-16 length), so CJK names
// rendered ~2× their length and shoved their url right into a ragged staircase.

const path = require('path');
const { stripAnsi, displayWidth } = require('../../../src/cli/formatters.js');
const { createClipboardCommands } = require('../../../src/cli/repl/clipboardCommands.js');

function renderList(services, preferred) {
  const c = new Proxy({}, { get: () => (s) => String(s) });
  const captured = [];
  const realLog = console.log;
  console.log = (...a) => captured.push(a.join(' '));
  const cmds = createClipboardCommands({
    c,
    printInfo: () => {},
    printSuccess: () => {},
    printError: () => {},
    fsmFire: () => {},
    setBusy: () => {},
    startBusyPromptKeepalive: () => {},
  });
  return cmds
    .handleClipboardRelayCommand('list', {
      getServices: () => services,
      getPreferredService: () => preferred,
    })
    .then(() => {
      console.log = realLog;
      return captured.map((l) => stripAnsi(l)).filter((l) => l.includes('http'));
    });
}

describe('clipboard relay list url-column alignment (BUG-118)', () => {
  const SERVICES = {
    zhipu: { name: '智谱清言 (GLM)', url: 'https://chatglm.cn' },
    deepseek: { name: 'DeepSeek 网页版', url: 'https://chat.deepseek.com' },
    github: { name: 'GitHub Copilot Chat', url: 'https://github.com/copilot' },
    trae: { name: 'Trae', url: 'https://www.trae.ai' },
    kimi: { name: 'Kimi (月之暗面)', url: 'https://kimi.moonshot.cn' },
    tongyi: { name: '通义千问', url: 'https://tongyi.aliyun.com/qianwen' },
  };

  it('puts every row\'s url at the same display column (CJK == ASCII)', async () => {
    const rows = await renderList(SERVICES, 'github');
    expect(rows.length).toBe(6);
    const starts = rows.map((r) => displayWidth(r.slice(0, r.indexOf('http'))));
    // Mixed CJK/ASCII names must all share one start column.
    expect([...new Set(starts)]).toHaveLength(1);
  });

  it('does not regress the pre-fix ragged layout', async () => {
    // Guard against a vacuous pass: a naive padEnd(20) of these names yields
    // differing widths, proving the fixture actually exercises CJK drift.
    const widths = Object.values(SERVICES).map(
      (s) => displayWidth(s.name.padEnd(20))
    );
    expect([...new Set(widths)].length).toBeGreaterThan(1);
  });

  it('pads a lone CJK name field to exactly url column 34', async () => {
    const rows = await renderList({ x: { name: '通义千问', url: 'https://a.b' } }, 'x');
    const line = rows[0];
    // url begins right after "  " + key(10) + " " + name(20) + " " = 34 cols,
    // the very column the ASCII rows use — proving the CJK field no longer drifts.
    expect(displayWidth(line.slice(0, line.indexOf('http')))).toBe(34);
  });
});
