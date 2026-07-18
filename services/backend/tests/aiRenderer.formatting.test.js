'use strict';

// Force chalk into colored output so ANSI-level assertions (strikethrough,
// bold-italic, keyword coloring) are observable. All existing assertions run
// through stripAnsi() and are unaffected.
process.env.FORCE_COLOR = '3';

const { renderMarkdownLite, renderAiResponse, printToolCallStart } = require('../src/cli/aiRenderer');

function stripAnsi(text = '') {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

function captureConsoleLogs(run) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    run();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

function buildLoopbackUrl(pathname = '') {
  const host = process.env.KHY_TEST_LOOPBACK_HOST || 'localhost';
  const port = process.env.KHY_TEST_LOOPBACK_PORT || '8080';
  const normalizedPath = String(pathname || '').replace(/^\/+/, '');
  return `http://${host}:${port}/${normalizedPath}`;
}

describe('aiRenderer markdown normalization', () => {
  test('repairs split bullet list items into one full line', () => {
    const rendered = renderMarkdownLite('- \n      中美经贸磋商取得初步成果');
    const plain = stripAnsi(rendered);
    expect(plain).toContain('• 中美经贸磋商取得初步成果');
    expect(plain).not.toMatch(/•\s*\n/);
  });

  test('repairs split numbered list items into one full line', () => {
    const rendered = renderMarkdownLite('1.\n   第一条新闻说明');
    const plain = stripAnsi(rendered);
    // The ordinal is preserved (CC-aligned) and joined onto one line.
    expect(plain).toContain('1. 第一条新闻说明');
  });

  test('drops stray m prefix before long separator lines', () => {
    const rendered = renderMarkdownLite('m----------------------------');
    const plain = stripAnsi(rendered).trim();
    expect(plain.startsWith('m')).toBe(false);
    expect(plain.length).toBeGreaterThanOrEqual(10);
  });

  test('deduplicates repeated leading sentence once', () => {
    const rendered = renderMarkdownLite('搜索一下最近的新闻动态。搜索一下最近的新闻动态。以下是结果。');
    const plain = stripAnsi(rendered);
    const matches = plain.match(/搜索一下最近的新闻动态。/g) || [];
    expect(matches.length).toBe(1);
    expect(plain).toContain('以下是结果。');
  });

  test('drops dangling "好的，帮" fragment before complete follow-up line', () => {
    const rendered = renderMarkdownLite('搜索一下最近的新闻动态。\n好的，帮\n搜索网络信息\n帮你搜一下最近热点。');
    const plain = stripAnsi(rendered);
    expect(plain).not.toMatch(/\n\s*好的，帮\s*(\n|$)/);
    expect(plain).toContain('帮你搜一下最近热点。');
  });
});

describe('aiRenderer does not fabricate a step table from model prose', () => {
  // Process steps must come from structured tool_use events during the loop,
  // never from scraping tool-call-looking lines out of the model's answer.
  test('does not promote prose tool-call lines into a 工具步骤 table', () => {
    const raw = [
      '先检查连通性',
      'Bash(command="khy gateway status")',
      'Read(path="backend/src/cli/aiRenderer.js")',
      'TaskOutput(content="all checks passed")',
      '再给出结论',
    ].join('\n');
    const plain = stripAnsi(renderAiResponse(raw));

    // Surrounding prose is preserved verbatim.
    expect(plain).toContain('先检查连通性');
    expect(plain).toContain('再给出结论');
    // No fabricated authoritative step table.
    expect(plain).not.toContain('工具步骤：');
    expect(plain).not.toContain('参数摘要');
  });

  test('keeps tool-like text unchanged inside fenced code blocks', () => {
    const raw = [
      '```text',
      'Bash(command="echo hello")',
      'Read(path="./demo.txt")',
      '```',
    ].join('\n');
    const plain = stripAnsi(renderAiResponse(raw));

    expect(plain).toContain('Bash(command="echo hello")');
    expect(plain).toContain('Read(path="./demo.txt")');
    expect(plain).not.toContain('工具步骤：');
  });
});

describe('aiRenderer unicode guide decoration', () => {
  test('renders tip line as unicode callout box when enabled', () => {
    const prev = process.env.KHY_UNICODE_GUIDE;
    const prevDensity = process.env.KHY_UNICODE_GUIDE_DENSITY;
    process.env.KHY_UNICODE_GUIDE = 'on';
    process.env.KHY_UNICODE_GUIDE_DENSITY = 'box';
    try {
      const rendered = renderAiResponse('Tip: use /plan for complex tasks');
      const plain = stripAnsi(rendered);
      expect(plain).toContain('╭');
      expect(plain).toContain('✦ Tip');
      expect(plain).toContain('use /plan for complex tasks');
      expect(plain).toContain('╰');
    } finally {
      if (prev === undefined) delete process.env.KHY_UNICODE_GUIDE;
      else process.env.KHY_UNICODE_GUIDE = prev;
      if (prevDensity === undefined) delete process.env.KHY_UNICODE_GUIDE_DENSITY;
      else process.env.KHY_UNICODE_GUIDE_DENSITY = prevDensity;
    }
  });

  test('keeps output unchanged when unicode guide is disabled', () => {
    const prev = process.env.KHY_UNICODE_GUIDE;
    process.env.KHY_UNICODE_GUIDE = 'off';
    try {
      const rendered = renderAiResponse('Tip: use /plan for complex tasks');
      const plain = stripAnsi(rendered);
      expect(plain).toContain('Tip: use /plan for complex tasks');
      expect(plain).not.toContain('✦');
    } finally {
      if (prev === undefined) delete process.env.KHY_UNICODE_GUIDE;
      else process.env.KHY_UNICODE_GUIDE = prev;
    }
  });

  test('renders light density as single-line marker', () => {
    const prev = process.env.KHY_UNICODE_GUIDE;
    const prevDensity = process.env.KHY_UNICODE_GUIDE_DENSITY;
    process.env.KHY_UNICODE_GUIDE = 'on';
    process.env.KHY_UNICODE_GUIDE_DENSITY = 'light';
    try {
      const rendered = renderAiResponse('Warning: check token budget');
      const plain = stripAnsi(rendered);
      expect(plain).toContain('⚠ Warning: check token budget');
      expect(plain).not.toContain('╭');
      expect(plain).not.toContain('┏');
    } finally {
      if (prev === undefined) delete process.env.KHY_UNICODE_GUIDE;
      else process.env.KHY_UNICODE_GUIDE = prev;
      if (prevDensity === undefined) delete process.env.KHY_UNICODE_GUIDE_DENSITY;
      else process.env.KHY_UNICODE_GUIDE_DENSITY = prevDensity;
    }
  });

  test('renders heavy density with thick box borders', () => {
    const prev = process.env.KHY_UNICODE_GUIDE;
    const prevDensity = process.env.KHY_UNICODE_GUIDE_DENSITY;
    process.env.KHY_UNICODE_GUIDE = 'on';
    process.env.KHY_UNICODE_GUIDE_DENSITY = 'heavy';
    try {
      const rendered = renderAiResponse('Summary: all checks passed');
      const plain = stripAnsi(rendered);
      expect(plain).toContain('┏');
      expect(plain).toContain('✓ Summary');
      expect(plain).toContain('┛');
    } finally {
      if (prev === undefined) delete process.env.KHY_UNICODE_GUIDE;
      else process.env.KHY_UNICODE_GUIDE = prev;
      if (prevDensity === undefined) delete process.env.KHY_UNICODE_GUIDE_DENSITY;
      else process.env.KHY_UNICODE_GUIDE_DENSITY = prevDensity;
    }
  });
});

describe('aiRenderer tool call preview', () => {
  test('parses loose bash param strings and avoids dangling description fragments', () => {
    const targetUrl = buildLoopbackUrl('ssm-demo/u');
    const raw = `command=curl -s ${targetUrl}, description=Get error page content from response message`;
    const printed = captureConsoleLogs(() => {
      printToolCallStart('Bash', raw);
    });
    const plain = stripAnsi(printed);

    expect(plain).toContain('Bash(');
    expect(plain).toContain(`curl -s ${targetUrl}`);
    expect(plain).not.toContain('description=Get error');
  });

  test('prefers real command semantics over model-provided description text', () => {
    const printed = captureConsoleLogs(() => {
      printToolCallStart('Bash', {
        command: 'cat /proc/1234/fd/1',
        description: '克隆仓库并切换分支',
      });
    });
    const plain = stripAnsi(printed);

    expect(plain).toContain('查看文件内容');
    expect(plain).toContain('Bash(cat /proc/1234/fd/1)');
    expect(plain).not.toContain('克隆仓库并切换分支');
  });
});

describe('aiRenderer CJK typography (中文排版不硬断句)', () => {
  // 用户反馈:OCR 后同一句话被换行、「纯文本模型」后 deepseek 本可接着显示却被拆行。
  // 中文散文行不做硬换行,交给终端软折行——不吃边界空格、不把收尾标点甩到行首。
  function withCols(cols, run) {
    const orig = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: cols, writable: true, configurable: true });
    try { return run(); }
    finally { Object.defineProperty(process.stdout, 'columns', { value: orig, writable: true, configurable: true }); }
  }

  test('does not hard-break a Chinese sentence at a CJK↔Latin boundary', () => {
    const text = '一句话总结:你是纯文本模型 deepseek-v4-flash,不能直接识图。';
    const plain = withCols(40, () => stripAnsi(renderAiResponse(text)));
    // 「纯文本模型 deepseek-v4-flash」保持同一行(边界空格没被吃成换行)。
    expect(plain.replace(/\n/g, '')).toContain('纯文本模型 deepseek-v4-flash');
    // 没有把这句中文散文硬拆成多行(交给终端软折行 → 单一逻辑行)。
    expect(plain.trim().split('\n').length).toBe(1);
  });

  test('never strands closing CJK punctuation at the start of a wrapped line', () => {
    const text = '你可以换成支持视觉的模型(如 GLM-4V-Flash),或者用本地 OCR 提取图中的文字后再给我处理。';
    const plain = withCols(30, () => stripAnsi(renderAiResponse(text)));
    for (const line of plain.split('\n')) {
      expect(line.trim()).not.toMatch(/^[，。！？；：、）」』】》]/);
    }
  });

  test('still hard-wraps a long pure-Latin line (non-CJK behavior unchanged)', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon';
    const plain = withCols(40, () => stripAnsi(renderAiResponse(text)));
    // 无 CJK 的长英文行仍按空格硬折行 → 多行。
    expect(plain.trim().split('\n').length).toBeGreaterThan(1);
  });
});

describe('aiRenderer table rendering', () => {
  test('renders single table with box-drawing borders', () => {
    const plain = stripAnsi(renderAiResponse('| A | B |\n|---|---|\n| 1 | 2 |'));
    expect(plain).toContain('╭');
    expect(plain).toContain('│ A');
    expect(plain).toContain('│ B');
    expect(plain).toContain('├');
    expect(plain).toContain('│ 1');
    expect(plain).toContain('│ 2');
    expect(plain).toContain('╰');
  });

  test('renders two adjacent tables with unified column widths on narrow terminal', () => {
    const origCols = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 80, writable: true, configurable: true });
    try {
      const input = '| 维度 | 得分 |\n|------|------|\n| 安全 | 4/5 |\n\n| 维度 | 目标 |\n|------|------|\n| 安全 | 5/5 |';
      const plain = stripAnsi(renderAiResponse(input));
      const topBorders = (plain.match(/╭/g) || []).length;
      const bottomBorders = (plain.match(/╰/g) || []).length;
      expect(topBorders).toBe(2);
      expect(bottomBorders).toBe(2);
      expect(plain).toContain('得分');
      expect(plain).toContain('目标');
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: origCols, writable: true, configurable: true });
    }
  });

  test('renders two adjacent tables side-by-side on wide terminal', () => {
    const origCols = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 160, writable: true, configurable: true });
    try {
      const input = '| A | B |\n|---|---|\n| 1 | 2 |\n\n| C | D |\n|---|---|\n| 3 | 4 |';
      const plain = stripAnsi(renderAiResponse(input));
      const firstLine = plain.split('\n').find(l => l.includes('╭'));
      const topCount = (firstLine.match(/╭/g) || []).length;
      expect(topCount).toBe(2);
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: origCols, writable: true, configurable: true });
    }
  });

  test('non-adjacent tables render independently', () => {
    const plain = stripAnsi(renderAiResponse('| A | B |\n|---|---|\n| 1 | 2 |\n\n文字段落说明\n\n| C | D |\n|---|---|\n| 3 | 4 |'));
    expect(plain).toContain('文字段落说明');
    const topBorders = (plain.match(/╭/g) || []).length;
    expect(topBorders).toBe(2);
  });

  test('CJK content aligns correctly in table columns', () => {
    const plain = stripAnsi(renderAiResponse('| 名称 | 值 |\n|------|----|\n| 确认安全性 | 4/5 |'));
    const rows = plain.split('\n').filter(l => l.includes('│'));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});

describe('aiRenderer mermaid mindmap rendering', () => {
  test('renders mermaid mindmap as ASCII tree', () => {
    const input = '```mermaid\nmindmap\n  Root\n    Child1\n      Grandchild\n    Child2\n```';
    const plain = stripAnsi(renderAiResponse(input));
    // Root in bordered box
    expect(plain).toContain('╭');
    expect(plain).toContain('Root');
    expect(plain).toContain('╰');
    // Tree branches
    expect(plain).toContain('├');
    expect(plain).toContain('└');
    expect(plain).toContain('Child1');
    expect(plain).toContain('Grandchild');
    expect(plain).toContain('Child2');
    // Leaf markers
    expect(plain).toContain('·');
    // Stats footer
    expect(plain).toContain('节点');
  });

  test('strips mermaid shape markers from labels', () => {
    const input = '```mermaid\nmindmap\n  root((Central))\n    a[Box]\n    b(Round)\n```';
    const plain = stripAnsi(renderAiResponse(input));
    expect(plain).toContain('Central');
    expect(plain).toContain('Box');
    expect(plain).toContain('Round');
    expect(plain).not.toContain('((');
    expect(plain).not.toContain('[Box]');
  });

  test('unsupported mermaid type falls back to code block', () => {
    const input = '```mermaid\nerDiagram\n  USER ||--o{ ORDER : places\n```';
    const plain = stripAnsi(renderAiResponse(input));
    expect(plain).toContain('╭─');
    expect(plain).toContain('╰');
    expect(plain).toContain('erDiagram');
  });

  test('empty mermaid mindmap falls back to code block', () => {
    const input = '```mermaid\nmindmap\n```';
    const plain = stripAnsi(renderAiResponse(input));
    expect(plain).toContain('╭─');
    expect(plain).toContain('mindmap');
  });
});

describe('aiRenderer mermaid pie chart rendering', () => {
  test('renders pie chart with stacked bar and legend', () => {
    const input = '```mermaid\npie title Budget\n  "Rent" : 50\n  "Food" : 30\n  "Other" : 20\n```';
    const plain = stripAnsi(renderAiResponse(input));
    expect(plain).toContain('Budget');
    expect(plain).toContain('Rent');
    expect(plain).toContain('Food');
    expect(plain).toContain('Other');
    expect(plain).toContain('50.0%');
    expect(plain).toContain('30.0%');
    expect(plain).toContain('20.0%');
    expect(plain).toContain('合计: 100');
  });

  test('renders pie chart without title', () => {
    const input = '```mermaid\npie\n  "A" : 60\n  "B" : 40\n```';
    const plain = stripAnsi(renderAiResponse(input));
    expect(plain).toContain('A');
    expect(plain).toContain('B');
    expect(plain).toContain('60.0%');
  });
});

describe('aiRenderer mermaid flowchart rendering', () => {
  test('renders flowchart with nodes and edges', () => {
    const input = '```mermaid\ngraph TD\n  A[Start] --> B[Process]\n  B --> C[End]\n```';
    const plain = stripAnsi(renderAiResponse(input));
    expect(plain).toContain('Start');
    expect(plain).toContain('Process');
    expect(plain).toContain('End');
    expect(plain).toContain('╭');
    expect(plain).toContain('▼');
    expect(plain).toContain('节点');
  });

  test('renders flowchart with edge labels', () => {
    const input = '```mermaid\nflowchart TD\n  A{Decision} -->|Yes| B[Action]\n  A -->|No| C[Skip]\n```';
    const plain = stripAnsi(renderAiResponse(input));
    expect(plain).toContain('Decision');
    expect(plain).toContain('Action');
    expect(plain).toContain('Yes');
  });
});

describe('aiRenderer mermaid sequence diagram rendering', () => {
  test('renders sequence diagram with participants and messages', () => {
    const input = '```mermaid\nsequenceDiagram\n  participant A\n  participant B\n  A->>B: Hello\n  B-->>A: Hi\n```';
    const plain = stripAnsi(renderAiResponse(input));
    expect(plain).toContain('A');
    expect(plain).toContain('B');
    expect(plain).toContain('Hello');
    expect(plain).toContain('Hi');
    expect(plain).toContain('▶');
    expect(plain).toContain('参与者');
  });
});

describe('aiRenderer mermaid gantt chart rendering', () => {
  test('renders gantt chart with sections and tasks', () => {
    const input = '```mermaid\ngantt\n  title Plan\n  section Dev\n    API : done, a1, 2024-01-01, 5d\n    Logic : active, a2, after a1, 10d\n  section Test\n    Unit : crit, t1, after a2, 3d\n```';
    const plain = stripAnsi(renderAiResponse(input));
    expect(plain).toContain('Plan');
    expect(plain).toContain('Dev');
    expect(plain).toContain('API');
    expect(plain).toContain('Logic');
    expect(plain).toContain('Test');
    expect(plain).toContain('Unit');
    expect(plain).toContain('✓');
    expect(plain).toContain('▶');
    expect(plain).toContain('!');
    expect(plain).toContain('任务');
  });
});

describe('aiRenderer nested list tree rendering', () => {
  test('converts 3+ level nested list to tree', () => {
    const input = '- Root\n  - Child1\n    - Grandchild1\n    - Grandchild2\n  - Child2\n    - Grandchild3';
    const plain = stripAnsi(renderAiResponse(input));
    expect(plain).toContain('├');
    expect(plain).toContain('└');
    expect(plain).toContain('Root');
    expect(plain).toContain('Child1');
    expect(plain).toContain('Grandchild1');
  });

  test('keeps 2-level list as bullets', () => {
    const input = '- First\n- Second\n- Third';
    const plain = stripAnsi(renderAiResponse(input));
    expect(plain).not.toContain('├');
    expect(plain).not.toContain('└');
  });
});

describe('aiRenderer CC-aligned markdown coverage', () => {
  test('preserves ordered list numbering instead of collapsing to a bullet', () => {
    const plain = stripAnsi(renderMarkdownLite('1. alpha\n2. beta\n3. gamma'));
    expect(plain).toContain('1.');
    expect(plain).toContain('2.');
    expect(plain).toContain('3.');
    expect(plain).not.toContain('›');
  });

  test('renders task list checkboxes for [ ] and [x]', () => {
    const plain = stripAnsi(renderMarkdownLite('- [ ] todo item\n- [x] done item'));
    expect(plain).toContain('☐');
    expect(plain).toContain('☑');
    expect(plain).toContain('todo item');
    expect(plain).toContain('done item');
    expect(plain).not.toContain('[ ]');
    expect(plain).not.toContain('[x]');
  });

  test('renders images as labelled link without a leading bang', () => {
    const plain = stripAnsi(renderMarkdownLite('![architecture diagram](https://example.com/a.png)'));
    expect(plain).toContain('▦');
    expect(plain).toContain('architecture diagram');
    expect(plain).toContain('(https://example.com/a.png)');
    expect(plain.trim().startsWith('!')).toBe(false);
  });

  test('renders strikethrough with an ANSI strikethrough sequence', () => {
    const raw = renderMarkdownLite('this is ~~removed~~ text');
    expect(raw).toContain('\x1b[9m'); // chalk strikethrough open
    const plain = stripAnsi(raw);
    expect(plain).toContain('removed');
    expect(plain).not.toContain('~~');
  });

  test('renders bold-italic ***text*** with both ANSI attributes', () => {
    const raw = renderMarkdownLite('a ***strong emphasis*** b');
    expect(raw).toContain('\x1b[1m'); // bold open
    expect(raw).toContain('\x1b[3m'); // italic open
    const plain = stripAnsi(raw);
    expect(plain).toContain('strong emphasis');
    expect(plain).not.toContain('***');
  });

  test('supports + as a bullet marker', () => {
    const plain = stripAnsi(renderMarkdownLite('+ first\n+ second'));
    expect(plain).toContain('•');
    expect(plain).not.toMatch(/^\s*\+/m);
  });

  test('renders nested blockquotes with one bar per depth', () => {
    const plain = stripAnsi(renderMarkdownLite('> outer\n>> inner'));
    const innerLine = plain.split('\n').find(l => l.includes('inner')) || '';
    const barCount = (innerLine.match(/│/g) || []).length;
    expect(barCount).toBeGreaterThanOrEqual(2);
  });

  test('does not reinterpret markdown markers inside inline code', () => {
    const plain = stripAnsi(renderMarkdownLite('use `a*b*c` and `x_y_z` literally'));
    expect(plain).toContain('a*b*c');
    expect(plain).toContain('x_y_z');
  });

  test('does not apply JS keyword coloring to unknown languages', () => {
    const yaml = renderMarkdownLite('```yaml\nclass: function\nvar: return\n```');
    const js = renderMarkdownLite('```js\nclass function var return\n```');
    expect(js).toContain('\x1b[35m');
    expect(yaml).not.toContain('\x1b[35m');
  });

  test('honors per-column alignment markers in tables', () => {
    const input = [
      '| Name | Score |',
      '| :--- | ----: |',
      '| Al | 5 |',
      '| Bo | 100 |',
    ].join('\n');
    const plain = stripAnsi(renderMarkdownLite(input));
    const scoreRow = plain.split('\n').find(l => l.includes('Al'));
    expect(scoreRow).toBeTruthy();
    // Right-aligned "5" must carry left padding before it inside its cell.
    expect(scoreRow).toMatch(/\s5\s*│/);
  });
});
