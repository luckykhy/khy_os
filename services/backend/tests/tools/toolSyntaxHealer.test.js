'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { healSource, healFile, HEAL_PATTERNS, _isEnabled } = require('../../src/tools/_toolSyntaxHealer');
// ── Env gating helper ─────────────────────────────────────────────────
function withEnv(key, val, fn) {
  const prev = process.env[key];
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}
// ── Pattern count ─────────────────────────────────────────────────────
// ── Env gate ──────────────────────────────────────────────────────────
// ── healSource: static field colon �?equals ───────────────────────────
// ── healSource: idempotency ───────────────────────────────────────────
// ── healFile: IO behavior ─────────────────────────────────────────────
// ── Line number tracking ──────────────────────────────────────────────

describe('Tool Syntax Healer', () => {
  test('HEAL_PATTERNS has at least one pattern', () => {
      expect(HEAL_PATTERNS.length >= 1).toBeTruthy();
      for (const p of HEAL_PATTERNS) {
        expect(p.name).toBeTruthy();
        expect(p.regex).toBeTruthy();
        expect(p.replacement).toBeTruthy();
      }
  });

  test('_isEnabled returns true by default', () => {
      withEnv('KHY_TOOL_SYNTAX_HEAL', undefined, () => {
        expect(_isEnabled()).toBe(true);
      });
  });

  test('_isEnabled returns false when env=0', () => {
      withEnv('KHY_TOOL_SYNTAX_HEAL', '0', () => {
        expect(_isEnabled()).toBe(false);
      });
  });

  test('_isEnabled returns false when env=off', () => {
      withEnv('KHY_TOOL_SYNTAX_HEAL', 'off', () => {
        expect(_isEnabled()).toBe(false);
      });
  });

  test('healSource repairs single-quoted static field', () => {
      const input = `class Foo {
      static searchHint: 'some hint';
    }`;
      const { source, changes } = healSource(input);
      expect(source).toContain("static searchHint = 'some hint'");
      expect(changes.length).toBe(1);
      expect(changes[0].pattern).toBe('static-field-colon-instead-of-equals');
  });

  test('healSource repairs double-quoted static field', () => {
      const input = `class Foo {
      static searchHint: "some hint";
    }`;
      const { source, changes } = healSource(input);
      expect(source).toContain('static searchHint = "some hint"');
      expect(changes.length).toBe(1);
  });

  test('healSource repairs template-literal static field', () => {
      const input = 'class Foo {\n  static searchHint: `some hint`;\n}';
      const { source, changes } = healSource(input);
      expect(source).toContain('static searchHint = `some hint`');
      expect(changes.length).toBe(1);
  });

  test('healSource repairs numeric static field', () => {
      const input = 'class Foo {\n  static timeoutMs: 30000;\n}';
      const { source, changes } = healSource(input);
      expect(source).toContain('static timeoutMs = 30000');
      expect(changes.length).toBe(1);
  });

  test('healSource repairs boolean static field', () => {
      const input = 'class Foo {\n  static shouldDefer: false;\n}';
      const { source, changes } = healSource(input);
      expect(source).toContain('static shouldDefer = false');
      expect(changes.length).toBe(1);
  });

  test('healSource repairs null static field', () => {
      const input = 'class Foo {\n  static searchHint: null;\n}';
      const { source, changes } = healSource(input);
      expect(source).toContain('static searchHint = null');
      expect(changes.length).toBe(1);
  });

  test('healSource repairs identifier static field', () => {
      const input = 'class Foo {\n  static category: SOME_CONSTANT;\n}';
      const { source, changes } = healSource(input);
      expect(source).toContain('static category = SOME_CONSTANT');
      expect(changes.length).toBe(1);
  });

  test('healSource is idempotent �?second run produces zero changes', () => {
      const input = `class Foo {
      static searchHint: 'some hint';
      static category: 'training';
    }`;
      const first = healSource(input);
      const second = healSource(first.source);
      expect(second.changes.length).toBe(0);
  });

  test('healSource handles mixed correct/incorrect fields', () => {
      const input = `class Foo {
      static toolName = 'Foo';
      static searchHint: 'some hint';
      static category = 'custom';
    }`;
      const { source, changes } = healSource(input);
      expect(source).toContain("static searchHint = 'some hint'");
      expect(source).toContain("static toolName = 'Foo'");
      expect(source).toContain("static category = 'custom'");
      expect(changes.length).toBe(1);
  });

  test('healSource does not touch object/array literals', () => {
      const input = `class Foo {
      static inputSchema: { type: 'object' };
    }`;
      const { changes } = healSource(input);
      // Object literals should NOT be auto-fixed (risky without context)
      expect(changes.length).toBe(0);
  });

  test('healSource preserves non-static colons (e.g., ternary, labels)', () => {
      const input = `class Foo {
      method() {
        return true ? 'yes' : 'no';
      }
    }`;
      const { changes } = healSource(input);
      expect(changes.length).toBe(0);
  });

  test('healFile returns healed=true with changes when file has errors', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-heal-'));
      const tmpFile = path.join(tmpDir, 'index.js');
      fs.writeFileSync(tmpFile, "class Foo {\n  static searchHint: 'fix me';\n}", 'utf-8');
    
      const result = healFile(tmpFile);
      expect(result.healed).toBe(true);
      expect(result.changes.length > 0).toBeTruthy();
    
      // Verify file content was actually changed
      const content = fs.readFileSync(tmpFile, 'utf-8');
      expect(content).toContain("static searchHint = 'fix me'");
    
      fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('healFile returns healed=false when no changes needed', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-heal-'));
      const tmpFile = path.join(tmpDir, 'index.js');
      fs.writeFileSync(tmpFile, "class Foo {\n  static searchHint = 'already correct';\n}", 'utf-8');
    
      const result = healFile(tmpFile);
      expect(result.healed).toBe(false);
      expect(result.changes.length).toBe(0);
    
      fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('healFile returns error when read fails', () => {
      const result = healFile('/nonexistent/path/index.js');
      expect(result.healed).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.error).toContain('read failed');
  });

  test('healFile does nothing when disabled via env', () => {
      withEnv('KHY_TOOL_SYNTAX_HEAL', '0', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-heal-'));
        const tmpFile = path.join(tmpDir, 'index.js');
        fs.writeFileSync(tmpFile, "class Foo {\n  static searchHint: 'fix me';\n}", 'utf-8');
    
        const result = healFile(tmpFile);
        expect(result.healed).toBe(false);
        expect(result.changes.length).toBe(0);
    
        // Content should be unchanged
        const content = fs.readFileSync(tmpFile, 'utf-8');
        expect(content).toContain("static searchHint: 'fix me'");
    
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });
  });

  test('healSource reports correct line numbers', () => {
      const input = `class Foo {
      static toolName = 'Foo';
      static searchHint: 'some hint';
      static category = 'custom';
    }`;
      const { changes } = healSource(input);
      expect(changes[0].line).toBe(3); // line 3 (1-indexed)
      expect(changes[0].before).toContain('searchHint:');
      expect(changes[0].after).toContain('searchHint =');
  });

});

