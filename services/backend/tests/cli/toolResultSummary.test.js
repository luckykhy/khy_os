'use strict';

/**
 * summarizeToolResult — the single source of truth for a tool's one-line
 * success summary, shared by the classic REPL (_formatToolResult) and the ink
 * TUI bridge (projectToolResultForView). These tests pin the per-tool phrasing
 * and, crucially, that the summary can be derived from EITHER the raw tool
 * result (output/content) or a view-projected result (text only) — so the TUI
 * surfaces the same "已读取 N 行 / 找到 N 个匹配 / 已在后台运行" data the REPL always has.
 */

const path = require('path');
const { summarizeToolResult, _displayPath } = require('../../src/cli/toolResultSummary');

describe('summarizeToolResult', () => {
  test('read: file basename + line count', () => {
    const s = summarizeToolResult('read', { success: true, lines: 42, path: 'a.js' }, {});
    expect(s).toBe('已读取 a.js（42 行）');
  });

  test('read: falls back to counting newlines when no lines field', () => {
    const s = summarizeToolResult('readfile', { success: true, output: 'l1\nl2\nl3' }, {});
    expect(s).toBe('已读取 3 行');
  });

  // ── Read: CC-aligned content-type-aware summary (KHY_READ_TYPE_SUMMARY, on) ──
  // CC FileReadTool/UI.tsx renders per output.type: image → "Read image (SIZE)",
  // text → "Read N lines". Khy's read result carries {type:'image', size}; the old
  // mode-blind summary counted newlines of the (empty) image output → a bogus
  // "已读取 a.png（1 行）". Image reads must report size, not a fake line count.
  describe('read content-type-aware summary (CC parity)', () => {
    test('image read → 已读取图片(大小), not a bogus 1 行', () => {
      const res = { success: true, type: 'image', size: 250000, file: 'logo.png' };
      // 250000 bytes → ccFormatFileSize → 244.1KB
      expect(summarizeToolResult('read', res, {})).toBe('已读取图片 logo.png（244.1KB）');
    });

    test('image read without a path still reports size', () => {
      const res = { success: true, type: 'image', size: 1536 };
      expect(summarizeToolResult('read', res, {})).toBe('已读取图片（1.5KB）');
    });

    test('image read falls back to params.file_path for the basename', () => {
      const res = { success: true, type: 'image', size: 2048 };
      expect(summarizeToolResult('read', res, { file_path: 'pic.jpg' })).toBe('已读取图片 pic.jpg（2KB）');
    });

    test('text read is unaffected (still 已读取 N 行)', () => {
      const res = { success: true, lines: 42, path: 'a.js' };
      expect(summarizeToolResult('read', res, {})).toBe('已读取 a.js（42 行）');
    });

    test('OCR-fallback read (text with lines, no image type) stays a line count', () => {
      const res = { success: true, content: 'a\nb\nc', size: 999, lines: 3, _ocrFallback: true };
      expect(summarizeToolResult('read', res, { file_path: 'scan.png' })).toBe('已读取 scan.png（3 行）');
    });
  });

  describe('read gate KHY_READ_TYPE_SUMMARY=0 → byte-identical legacy', () => {
    const withGateOff = (fn) => {
      const prev = process.env.KHY_READ_TYPE_SUMMARY;
      process.env.KHY_READ_TYPE_SUMMARY = '0';
      try { return fn(); } finally {
        if (prev === undefined) delete process.env.KHY_READ_TYPE_SUMMARY;
        else process.env.KHY_READ_TYPE_SUMMARY = prev;
      }
    };

    test('image read → legacy line-count summary (the pre-slice behavior)', () => {
      withGateOff(() => {
        // No lines field, no string output → outStr '' → 1 line, basename from file_path.
        const res = { success: true, type: 'image', size: 250000, file: 'logo.png' };
        expect(summarizeToolResult('read', res, { file_path: 'logo.png' })).toBe('已读取 logo.png（1 行）');
      });
    });

    test('text read unchanged when gate off', () => {
      withGateOff(() => {
        const res = { success: true, lines: 42, path: 'a.js' };
        expect(summarizeToolResult('read', res, {})).toBe('已读取 a.js（42 行）');
      });
    });
  });

  // ── Read: CC-aligned truncation marker (KHY_READ_TRUNCATE_MARKER, default on) ──
  // CC AttachmentMessage renders `${numLines}${truncated ? '+' : ''} lines`, so a
  // read that hit the line cap shows "Read foo.js (2000+ lines)". Khy's read result
  // carries lines (read), totalLines (full), truncated (byte-cap); when the file has
  // more lines than were read the summary must append `+`, else a capped 2000-line
  // read is indistinguishable from a full 2000-line file.
  describe('read truncation marker (CC parity)', () => {
    test('line-capped read (totalLines > lines) → 行数带 + 标记', () => {
      const res = { success: true, lines: 2000, totalLines: 5000, path: 'big.js' };
      expect(summarizeToolResult('read', res, {})).toBe('已读取 big.js（2000+ 行）');
    });

    test('byte-oversize read (truncated:true) → 行数带 + 标记', () => {
      const res = { success: true, lines: 1800, truncated: true, path: 'huge.log' };
      expect(summarizeToolResult('read', res, {})).toBe('已读取 huge.log（1800+ 行）');
    });

    test('untruncated read (totalLines === lines) → 无 + 标记', () => {
      const res = { success: true, lines: 2000, totalLines: 2000, path: 'exact.js' };
      expect(summarizeToolResult('read', res, {})).toBe('已读取 exact.js（2000 行）');
    });

    test('read without totalLines/truncated → 无 + 标记(逐字节旧行为)', () => {
      const res = { success: true, lines: 42, path: 'a.js' };
      expect(summarizeToolResult('read', res, {})).toBe('已读取 a.js（42 行）');
    });

    test('marker also applies to the no-path form', () => {
      const res = { success: true, lines: 2000, totalLines: 9000 };
      expect(summarizeToolResult('read', res, {})).toBe('已读取 2000+ 行');
    });

    test('gate KHY_READ_TRUNCATE_MARKER=0 → 逐字节回退无 +', () => {
      const prev = process.env.KHY_READ_TRUNCATE_MARKER;
      process.env.KHY_READ_TRUNCATE_MARKER = '0';
      try {
        const res = { success: true, lines: 2000, totalLines: 5000, path: 'big.js' };
        expect(summarizeToolResult('read', res, {})).toBe('已读取 big.js（2000 行）');
      } finally {
        if (prev === undefined) delete process.env.KHY_READ_TRUNCATE_MARKER;
        else process.env.KHY_READ_TRUNCATE_MARKER = prev;
      }
    });
  });

  // ── Grep: CC-aligned mode-aware summary (KHY_GREP_MODE_SUMMARY, default on) ──
  // CC GrepTool/UI.tsx renderToolResultMessage reports per output_mode:
  //   content            → "Found N lines"
  //   count              → "Found N matches across M files"
  //   files_with_matches → "Found N files"
  // Khy's GrepTool result shape encodes the mode (content={matches[],count},
  // count={counts[],total}, files_with_matches={files[],count}); the summary
  // must mirror CC instead of the old mode-blind "找到 N 个匹配".
  describe('grep mode-aware summary (CC parity)', () => {
    test('content mode: 匹配行数 → 找到 N 行', () => {
      const res = {
        success: true,
        matches: [
          { file: 'a.js', line: 3, content: 'foo' },
          { file: 'a.js', line: 7, content: 'foo' },
          { file: 'b.js', line: 1, content: 'foo' },
        ],
        count: 3,
      };
      expect(summarizeToolResult('grep', res, { output_mode: 'content' })).toBe('找到 3 行');
    });

    test('count mode: 总匹配数 + 跨文件数 → 找到 N 个匹配,跨 M 个文件', () => {
      const res = {
        success: true,
        counts: [{ file: 'a.js', count: 5 }, { file: 'b.js', count: 2 }],
        total: 7,
      };
      expect(summarizeToolResult('grep', res, { output_mode: 'count' })).toBe('找到 7 个匹配，跨 2 个文件');
    });

    test('files_with_matches mode: 文件数 → 找到 N 个文件', () => {
      const res = { success: true, files: ['a.js', 'b.js'], count: 2 };
      expect(summarizeToolResult('grep', res, { output_mode: 'files_with_matches' })).toBe('找到 2 个文件');
    });

    test('mode inferred from result shape when output_mode param absent', () => {
      // counts+total → count mode
      expect(
        summarizeToolResult('grep', { success: true, counts: [{ file: 'a', count: 4 }], total: 4 }, {})
      ).toBe('找到 4 个匹配，跨 1 个文件');
      // files array → files_with_matches mode
      expect(
        summarizeToolResult('search', { success: true, files: ['x', 'y', 'z'], count: 3 }, {})
      ).toBe('找到 3 个文件');
      // non-empty matches → content mode
      expect(
        summarizeToolResult('grep', { success: true, matches: ['a', 'b', 'c'], count: 3 }, {})
      ).toBe('找到 3 行');
    });

    test('empty default-mode search → 找到 0 个文件 (GrepTool default is files_with_matches)', () => {
      // Empty sentinel {matches:[],count:0} carries no discriminating array; with
      // no output_mode it must read as the real default mode, not "0 行".
      const s = summarizeToolResult('grep', { success: true, count: 0, message: 'No matches found' }, {});
      expect(s).toBe('找到 0 个文件');
    });

    test('empty count-mode search → 找到 0 个匹配,跨 0 个文件 (output_mode is authoritative)', () => {
      const s = summarizeToolResult(
        'grep',
        { success: true, count: 0, message: 'No matches found' },
        { output_mode: 'count' }
      );
      expect(s).toBe('找到 0 个匹配，跨 0 个文件');
    });
  });

  describe('grep gate KHY_GREP_MODE_SUMMARY=0 → byte-identical legacy', () => {
    const withGateOff = (fn) => {
      const prev = process.env.KHY_GREP_MODE_SUMMARY;
      process.env.KHY_GREP_MODE_SUMMARY = '0';
      try { return fn(); } finally {
        if (prev === undefined) delete process.env.KHY_GREP_MODE_SUMMARY;
        else process.env.KHY_GREP_MODE_SUMMARY = prev;
      }
    };

    test('scalar count → legacy 找到 N 个匹配', () => {
      withGateOff(() => {
        expect(summarizeToolResult('grep', { success: true, count: 7 }, {})).toBe('找到 7 个匹配');
      });
    });

    test('empty result → legacy 找到 0 个匹配', () => {
      withGateOff(() => {
        const s = summarizeToolResult('grep', { success: true, count: 0, message: 'No matches found' }, {});
        expect(s).toBe('找到 0 个匹配');
      });
    });

    test('matches-array fallback → legacy 找到 N 个匹配', () => {
      withGateOff(() => {
        const s = summarizeToolResult('search', { success: true, matches: ['a', 'b', 'c'] }, {});
        expect(s).toBe('找到 3 个匹配');
      });
    });
  });

  test('glob: file count', () => {
    expect(summarizeToolResult('glob', { success: true, count: 12 }, {})).toBe('找到 12 个文件');
  });

  test('ls: entry count', () => {
    expect(summarizeToolResult('ls', { success: true, count: 5 }, {})).toBe('列出 5 个条目');
  });

  test('bash: background indicator', () => {
    expect(summarizeToolResult('bash', { success: true, _background: true }, {})).toBe('已在后台运行（↓ 管理）');
  });

  test('bash: non-zero exit code is tagged', () => {
    const s = summarizeToolResult('shell', { success: true, exitCode: 2, output: 'a\nb\nc\nd' }, {});
    expect(s).toBe('命令输出 4 行 [退出码 2]');
  });

  test('bash: short output is shown inline without exit tag on 0', () => {
    const s = summarizeToolResult('command', { success: true, exitCode: 0, output: 'done' }, {});
    expect(s).toBe('done');
  });

  test('websearch: scalar count fallback (arrays dropped by the TUI projection)', () => {
    expect(summarizeToolResult('websearch', { success: true, count: 4 }, {})).toBe('搜索到 4 条网页结果');
  });

  test('websearch: results-array branch', () => {
    // A results array is a SEARCH shape (webfetch never returns one); the count
    // branch belongs to websearch. webfetch now reports received size instead.
    expect(summarizeToolResult('websearch', { success: true, results: [1, 2] }, {})).toBe('搜索到 2 条网页结果');
  });

  // ── WebFetch: CC-aligned received-size summary (KHY_WEB_RESULT_SUMMARY, on) ──
  // CC WebFetchTool/UI.tsx renders "Received {formatFileSize(bytes)} (code text)"
  // where bytes = Buffer.byteLength(content). Khy's fetch result carries content/
  // contentLength but no status, so the old combined branch fell through to a
  // bogus "网络搜索完成" (a SEARCH message for a FETCH) and dropped the size.
  describe('webfetch received-size summary (CC parity)', () => {
    test('reports fetched content byte size, not a bogus 网络搜索完成', () => {
      // 'x'.repeat(2048) → 2048 bytes → ccFormatFileSize → 2KB
      const res = { success: true, url: 'https://e.com', content: 'x'.repeat(2048), contentLength: 2048 };
      expect(summarizeToolResult('webfetch', res, {})).toBe('已获取网页（2KB）');
    });

    test('multibyte content uses true UTF-8 byte length (not char count)', () => {
      // 3 chars × 3 bytes each (CJK) = 9 bytes → "9 bytes"
      const res = { success: true, content: '你好吗', contentLength: 3 };
      expect(summarizeToolResult('webfetch', res, {})).toBe('已获取网页（9 bytes）');
    });

    test('falls back to contentLength when content field is absent', () => {
      const res = { success: true, url: 'https://e.com', contentLength: 1536 };
      expect(summarizeToolResult('webfetch', res, {})).toBe('已获取网页（1.5KB）');
    });

    test('no size derivable → 已获取网页 (never a search message)', () => {
      const res = { success: true, url: 'https://e.com' };
      expect(summarizeToolResult('webfetch', res, {})).toBe('已获取网页');
    });

    test('websearch is unaffected (still 搜索到 N 条网页结果)', () => {
      expect(summarizeToolResult('websearch', { success: true, count: 4 }, {})).toBe('搜索到 4 条网页结果');
    });
  });

  describe('web gate KHY_WEB_RESULT_SUMMARY=0 → byte-identical legacy', () => {
    const withGateOff = (fn) => {
      const prev = process.env.KHY_WEB_RESULT_SUMMARY;
      process.env.KHY_WEB_RESULT_SUMMARY = '0';
      try { return fn(); } finally {
        if (prev === undefined) delete process.env.KHY_WEB_RESULT_SUMMARY;
        else process.env.KHY_WEB_RESULT_SUMMARY = prev;
      }
    };

    test('webfetch with content but no search fields → legacy 网络搜索完成 (the pre-slice behavior)', () => {
      withGateOff(() => {
        const res = { success: true, url: 'https://e.com', content: 'x'.repeat(2048), contentLength: 2048 };
        expect(summarizeToolResult('webfetch', res, {})).toBe('网络搜索完成');
      });
    });

    test('websearch count unchanged when gate off', () => {
      withGateOff(() => {
        expect(summarizeToolResult('websearch', { success: true, count: 4 }, {})).toBe('搜索到 4 条网页结果');
      });
    });
  });

  test('write: basename, lines (from params.content) and bytes', () => {
    const s = summarizeToolResult('write', { success: true, path: 'x.txt', bytes: 30 }, { content: 'a\nb' });
    expect(s).toBe('已写入 x.txt（2 行，30 bytes）');
  });

  // ── Write: CC-aligned line count (KHY_WRITE_COUNT_LINES_CC, default on) ──
  // CC FileWriteTool/UI.tsx countLines treats a trailing '\n' as a terminator
  // (parts.length - 1), matching editor line numbering. Khy's old bare
  // split('\n').length over-counted by 1 for the common trailing-newline case.
  describe('write CC-aligned line count (CC parity)', () => {
    test('trailing newline is a terminator, not a new empty line (+1 over-count fixed)', () => {
      // 'a\nb\nc\n' → 3 real lines (CC: parts=['a','b','c',''], endsWith\n → 4-1=3).
      const s = summarizeToolResult('write', { success: true, path: 'x.txt', bytes: 6 }, { content: 'a\nb\nc\n' });
      expect(s).toBe('已写入 x.txt（3 行，6 bytes）');
    });

    test('no trailing newline is unchanged (parts.length)', () => {
      // 'a\nb\nc' → 3 lines either way; this case never differed from legacy.
      const s = summarizeToolResult('write', { success: true, path: 'x.txt', bytes: 5 }, { content: 'a\nb\nc' });
      expect(s).toBe('已写入 x.txt（3 行，5 bytes）');
    });

    test('a single trailing newline counts as 1 line', () => {
      // 'one\n' → parts=['one',''], endsWith\n → 2-1=1.
      const s = summarizeToolResult('write', { success: true, path: 'x.txt', bytes: 4 }, { content: 'one\n' });
      expect(s).toBe('已写入 x.txt（1 行，4 bytes）');
    });

    test('empty content still omits the line segment (product behavior unchanged)', () => {
      const s = summarizeToolResult('write', { success: true, path: 'x.txt', bytes: 0 }, { content: '' });
      expect(s).toBe('已写入 x.txt（0 bytes）');
    });
  });

  describe('write gate KHY_WRITE_COUNT_LINES_CC=0 → byte-identical legacy', () => {
    const withGateOff = (fn) => {
      const prev = process.env.KHY_WRITE_COUNT_LINES_CC;
      process.env.KHY_WRITE_COUNT_LINES_CC = '0';
      try { return fn(); } finally {
        if (prev === undefined) delete process.env.KHY_WRITE_COUNT_LINES_CC;
        else process.env.KHY_WRITE_COUNT_LINES_CC = prev;
      }
    };

    test('trailing newline → legacy over-count (split length, the pre-slice behavior)', () => {
      withGateOff(() => {
        // 'a\nb\nc\n' → split('\n').length === 4 (legacy counts the trailing newline).
        const s = summarizeToolResult('write', { success: true, path: 'x.txt', bytes: 6 }, { content: 'a\nb\nc\n' });
        expect(s).toBe('已写入 x.txt（4 行，6 bytes）');
      });
    });

    test('no trailing newline unchanged when gate off', () => {
      withGateOff(() => {
        const s = summarizeToolResult('write', { success: true, path: 'x.txt', bytes: 3 }, { content: 'a\nb' });
        expect(s).toBe('已写入 x.txt（2 行，3 bytes）');
      });
    });
  });

  // ── Write: CC-aligned byte-size humanize (KHY_WRITE_SIZE_CCFORMAT, default on) ──
  // CC formatFileSize renders bytes as "30 bytes"/"5KB"/"1.5MB". Khy already routes
  // image-read and webfetch summaries through the ccFormatFileSize SSOT; the write
  // summary was the lone orphan printing raw `${bytes}B` (e.g. 51200B, unreadable).
  describe('write CC-aligned byte-size humanize (CC parity)', () => {
    test('sub-1KB bytes render as "N bytes" (family口径)', () => {
      const s = summarizeToolResult('write', { success: true, path: 'x.txt', bytes: 512 }, { content: 'a\nb' });
      expect(s).toBe('已写入 x.txt（2 行，512 bytes）');
    });

    test('large writes humanize to KB instead of raw bytes (the real win)', () => {
      // 51200 bytes was the unreadable orphan; ccFormatFileSize → "50KB".
      const s = summarizeToolResult('write', { success: true, path: 'big.bin', bytes: 51200 }, { content: 'a\nb' });
      expect(s).toBe('已写入 big.bin（2 行，50KB）');
    });

    test('fractional KB keeps one decimal (CC parity)', () => {
      const s = summarizeToolResult('write', { success: true, path: 'x.txt', bytes: 1536 }, { content: 'a\nb' });
      expect(s).toBe('已写入 x.txt（2 行，1.5KB）');
    });
  });

  describe('write gate KHY_WRITE_SIZE_CCFORMAT=0 → byte-identical legacy `NB`', () => {
    const withSizeGateOff = (fn) => {
      const prev = process.env.KHY_WRITE_SIZE_CCFORMAT;
      process.env.KHY_WRITE_SIZE_CCFORMAT = '0';
      try { return fn(); } finally {
        if (prev === undefined) delete process.env.KHY_WRITE_SIZE_CCFORMAT;
        else process.env.KHY_WRITE_SIZE_CCFORMAT = prev;
      }
    };

    test('gate off → raw `${bytes}B` (the pre-cut behavior)', () => {
      withSizeGateOff(() => {
        expect(summarizeToolResult('write', { success: true, path: 'x.txt', bytes: 30 }, { content: 'a\nb' }))
          .toBe('已写入 x.txt（2 行，30B）');
        expect(summarizeToolResult('write', { success: true, path: 'big.bin', bytes: 51200 }, { content: 'a\nb' }))
          .toBe('已写入 big.bin（2 行，51200B）');
      });
    });
  });

  test('edit: replacements + ±diff from params', () => {
    const s = summarizeToolResult(
      'edit',
      { success: true, file: 'y.js', replacements: 1 },
      { old_string: 'a', new_string: 'a\nb\nc' }
    );
    expect(s).toBe('已修改 y.js，1 处替换（+2）');
  });

  // CC backend-logic parity: the ±line count is the REAL added/removed from a
  // line-level diff (CC FileEditToolUpdatedMessage counts +/- patch lines), not a
  // net-line-delta heuristic. A 3-for-3 replacement is +3/-3, never a collapsed ~3.
  test('edit: a 3-for-3 replacement reports real +3/-3 (CC parity), not ~3', () => {
    const s = summarizeToolResult(
      'edit',
      { success: true, file: 'y.js', replacements: 1 },
      { old_string: 'x\ny\nz', new_string: 'p\nq\nr' }
    );
    expect(s).toBe('已修改 y.js，1 处替换（+3/-3）');
  });

  test('edit: a mixed edit reports both additions and removals (+3/-1)', () => {
    const s = summarizeToolResult(
      'edit',
      { success: true, file: 'y.js', replacements: 1 },
      { old_string: 'a\nb', new_string: 'a\nB\nc\nd' }
    );
    expect(s).toBe('已修改 y.js，1 处替换（+3/-1）');
  });

  test('edit: gate off (KHY_EDIT_DIFF_STAT_CC=0) → legacy net heuristic (~3)', () => {
    const prev = process.env.KHY_EDIT_DIFF_STAT_CC;
    process.env.KHY_EDIT_DIFF_STAT_CC = '0';
    try {
      const s = summarizeToolResult(
        'edit',
        { success: true, file: 'y.js', replacements: 1 },
        { old_string: 'x\ny\nz', new_string: 'p\nq\nr' }
      );
      expect(s).toBe('已修改 y.js，1 处替换（~3）');
    } finally {
      if (prev === undefined) delete process.env.KHY_EDIT_DIFF_STAT_CC;
      else process.env.KHY_EDIT_DIFF_STAT_CC = prev;
    }
  });

  // ── File-path display logic (KHY_DISPLAY_PATH_CC, default on) ──
  // CC getDisplayPath (src/utils/file.ts:155): a path inside cwd → cwd-relative,
  // inside home → ~ notation, otherwise the full absolute path. Khy's old
  // summaries used a bare path.basename, which collapses same-name files in
  // different dirs to one ambiguous label ("config.js"). These pin the three
  // branches + the collision-disambiguation the relative form exists to provide.
  describe('_displayPath (CC getDisplayPath parity, default on)', () => {
    test('a file inside cwd renders as a cwd-relative path, not a bare basename', () => {
      expect(_displayPath('/repo/src/cli/foo.js', process.env, '/repo')).toBe('src/cli/foo.js');
    });

    test('two same-name files in different dirs stay distinguishable (the whole point)', () => {
      expect(_displayPath('/repo/a/config.js', process.env, '/repo')).toBe('a/config.js');
      expect(_displayPath('/repo/b/config.js', process.env, '/repo')).toBe('b/config.js');
    });

    test('a file under home renders with ~ notation', () => {
      expect(_displayPath('/home/u/notes/x.txt', process.env, '/repo', '/home/u')).toBe('~/notes/x.txt');
    });

    test('an out-of-tree file (neither cwd nor home) renders as the full absolute path', () => {
      expect(_displayPath('/etc/hosts', process.env, '/repo', '/home/u')).toBe('/etc/hosts');
    });

    test('cwd takes precedence over home when the file is nested under both', () => {
      expect(_displayPath('/home/u/repo/src/a.js', process.env, '/home/u/repo', '/home/u')).toBe('src/a.js');
    });

    test('a bare relative input resolves under cwd → itself (basename-equivalent)', () => {
      expect(_displayPath('x.txt', process.env, '/repo')).toBe('x.txt');
    });

    test('empty / null input → empty string (caller omits the name segment)', () => {
      expect(_displayPath('', process.env, '/repo')).toBe('');
      expect(_displayPath(null, process.env, '/repo')).toBe('');
    });
  });

  describe('_displayPath gate KHY_DISPLAY_PATH_CC=0 → byte-identical legacy basename', () => {
    test('falls back to path.basename', () => {
      expect(_displayPath('/repo/src/cli/foo.js', { KHY_DISPLAY_PATH_CC: '0' }, '/repo')).toBe('foo.js');
      expect(_displayPath('/home/u/notes/x.txt', { KHY_DISPLAY_PATH_CC: '0' }, '/repo', '/home/u')).toBe('x.txt');
    });

    test('other falsy gate spellings also fall back', () => {
      for (const v of ['false', 'off', 'no']) {
        expect(_displayPath('/repo/a/b/c.js', { KHY_DISPLAY_PATH_CC: v }, '/repo')).toBe('c.js');
      }
    });
  });

  // Integration: a real cwd-nested path surfaces its relative form in the
  // read/write/edit summary — proves the 4 basename sites are actually wired to
  // _displayPath (not just the helper in isolation).
  describe('summary path display is CC-relative end-to-end (CC parity)', () => {
    const nested = path.join(process.cwd(), 'sub', 'dir', 'file.js');

    test('read summary shows the cwd-relative path', () => {
      expect(summarizeToolResult('read', { success: true, lines: 5, path: nested }, {}))
        .toBe('已读取 sub/dir/file.js（5 行）');
    });

    test('write summary shows the cwd-relative path', () => {
      expect(summarizeToolResult('write', { success: true, path: nested, bytes: 10 }, { content: 'a\nb' }))
        .toBe('已写入 sub/dir/file.js（2 行，10 bytes）');
    });

    test('edit summary shows the cwd-relative path', () => {
      expect(summarizeToolResult('edit', { success: true, file: nested, replacements: 1 }, { old_string: 'a', new_string: 'a\nb' }))
        .toBe('已修改 sub/dir/file.js，1 处替换（+1）');
    });

    test('gate off → bare basename end-to-end', () => {
      const prev = process.env.KHY_DISPLAY_PATH_CC;
      process.env.KHY_DISPLAY_PATH_CC = '0';
      try {
        expect(summarizeToolResult('read', { success: true, lines: 5, path: nested }, {}))
          .toBe('已读取 file.js（5 行）');
      } finally {
        if (prev === undefined) delete process.env.KHY_DISPLAY_PATH_CC;
        else process.env.KHY_DISPLAY_PATH_CC = prev;
      }
    });
  });

  test('todowrite: count', () => {
    expect(summarizeToolResult('todowrite', { success: true, count: 3 }, {})).toBe('已更新 3 条待办');
  });

  test('agent: first 90 chars of message', () => {
    expect(summarizeToolResult('task', { success: true, message: 'sub done' }, {})).toBe('sub done');
  });

  test('derives the same summary from a projected result (text instead of output)', () => {
    // The TUI hands a result whose output/content was collapsed into `text`.
    const s = summarizeToolResult('bash', { success: true, text: 'one\ntwo\nthree' }, {});
    expect(s).toBe('命令输出 3 行');
  });

  test('null result degrades to 完成', () => {
    expect(summarizeToolResult('read', null, {})).toBe('完成');
  });

  test('generic tool: truncation suffix', () => {
    const s = summarizeToolResult('unknownTool', { success: true, output: 'blob', truncated: true, truncatedChars: 120 }, {});
    expect(s).toBe('blob [已截断 120 字符]');
  });
});
