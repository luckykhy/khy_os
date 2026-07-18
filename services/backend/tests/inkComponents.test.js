'use strict';

/**
 * Tests for cli/ui/inkComponents.js — lightweight CLI UI components.
 */

const {
  Box,
  Text,
  ProgressBar,
  Table,
  VStack,
  HStack,
} = require('../src/cli/ui/inkComponents');

// Helper: strip ANSI escape codes for content assertions
function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

describe('inkComponents', () => {
  // ── Box ──

  describe('Box()', () => {
    test('renders with borders and content', () => {
      const result = Box({ content: 'Hello' });
      const plain = stripAnsi(result);

      // Should have top border, content line, bottom border
      expect(plain).toContain('Hello');
      expect(plain).toContain('┌');
      expect(plain).toContain('┐');
      expect(plain).toContain('└');
      expect(plain).toContain('┘');
    });

    test('includes title in top border', () => {
      const result = Box({ content: 'Body text', title: 'My Title' });
      const plain = stripAnsi(result);

      expect(plain).toContain('My Title');
      // Title should appear in the first line (top border)
      const lines = plain.split('\n');
      expect(lines[0]).toContain('My Title');
    });

    test('uses double border style characters', () => {
      const result = Box({ content: 'Double', borderStyle: 'double' });
      const plain = stripAnsi(result);

      expect(plain).toContain('╔');
      expect(plain).toContain('╗');
      expect(plain).toContain('╚');
      expect(plain).toContain('╝');
    });

    test('uses round border style characters', () => {
      const result = Box({ content: 'Round', borderStyle: 'round' });
      const plain = stripAnsi(result);

      expect(plain).toContain('╭');
      expect(plain).toContain('╮');
      expect(plain).toContain('╰');
      expect(plain).toContain('╯');
    });

    test('uses none border style (spaces)', () => {
      const result = Box({ content: 'None', borderStyle: 'none' });
      const plain = stripAnsi(result);

      // "none" uses space characters for borders
      expect(plain).not.toContain('┌');
      expect(plain).not.toContain('╔');
      expect(plain).not.toContain('╭');
      expect(plain).toContain('None');
    });

    test('respects padding option', () => {
      const noPad = Box({ content: 'X', padding: 0 });
      const withPad = Box({ content: 'X', padding: 2 });

      // More padding means more lines and wider box
      const noPadLines = noPad.split('\n').length;
      const withPadLines = withPad.split('\n').length;
      expect(withPadLines).toBeGreaterThan(noPadLines);
    });
  });

  // ── Text ──

  describe('Text()', () => {
    test('returns unchanged content when no style given', () => {
      const result = Text('plain text');
      expect(result).toBe('plain text');
    });

    test('returns unchanged content when style is falsy', () => {
      const result = Text('no style', null);
      expect(result).toBe('no style');
    });

    test('applies bold style', () => {
      const result = Text('bold text', { bold: true });
      // chalk.bold wraps with ANSI codes. The stripped text should still be there.
      const plain = stripAnsi(result);
      expect(plain).toBe('bold text');
      // The raw result should differ from plain input (ANSI codes added)
      // or be the same if chalk is in no-color mode. Either is valid.
      expect(result).toBeDefined();
    });

    test('applies dim style', () => {
      const result = Text('dimmed', { dim: true });
      const plain = stripAnsi(result);
      expect(plain).toBe('dimmed');
    });
  });

  // ── ProgressBar ──

  describe('ProgressBar()', () => {
    test('renders at 0%', () => {
      const result = ProgressBar({ value: 0 });
      const plain = stripAnsi(result);

      expect(plain).toContain('0%');
      // Should have all empty characters
      expect(plain).toContain('░');
    });

    test('renders at 50%', () => {
      const result = ProgressBar({ value: 50 });
      const plain = stripAnsi(result);

      expect(plain).toContain('50%');
      expect(plain).toContain('█');
      expect(plain).toContain('░');
    });

    test('renders at 100%', () => {
      const result = ProgressBar({ value: 100 });
      const plain = stripAnsi(result);

      expect(plain).toContain('100%');
      // Should have all complete characters
      expect(plain).toContain('█');
      expect(plain).not.toContain('░');
    });

    test('renders with custom label', () => {
      const result = ProgressBar({ value: 75, label: 'Download' });
      const plain = stripAnsi(result);

      expect(plain).toContain('Download');
      expect(plain).toContain('75%');
    });

    test('clamps value above 100 to 100%', () => {
      const result = ProgressBar({ value: 150 });
      const plain = stripAnsi(result);
      expect(plain).toContain('100%');
    });

    test('clamps negative value to 0%', () => {
      const result = ProgressBar({ value: -10 });
      const plain = stripAnsi(result);
      expect(plain).toContain('0%');
    });
  });

  // ── Table ──

  describe('Table()', () => {
    test('renders headers and rows', () => {
      const result = Table({
        headers: ['Name', 'Age'],
        rows: [['Alice', '30'], ['Bob', '25']],
      });
      const plain = stripAnsi(result);

      expect(plain).toContain('Name');
      expect(plain).toContain('Age');
      expect(plain).toContain('Alice');
      expect(plain).toContain('30');
      expect(plain).toContain('Bob');
      expect(plain).toContain('25');
    });

    test('renders separator between header and rows', () => {
      const result = Table({
        headers: ['Col'],
        rows: [['val']],
      });
      const plain = stripAnsi(result);

      // Separator uses ─ character
      expect(plain).toContain('─');
    });

    test('handles empty rows array', () => {
      const result = Table({
        headers: ['A', 'B'],
        rows: [],
      });
      const plain = stripAnsi(result);

      // Should still have header and separator, just no data rows
      expect(plain).toContain('A');
      expect(plain).toContain('B');
      const lines = plain.split('\n');
      // header line + separator = 2 lines
      expect(lines.length).toBe(2);
    });
  });

  // ── VStack ──

  describe('VStack()', () => {
    test('joins components with newlines', () => {
      const result = VStack('Line 1', 'Line 2', 'Line 3');
      expect(result).toBe('Line 1\nLine 2\nLine 3');
    });

    test('filters out falsy values', () => {
      const result = VStack('A', null, 'B', undefined, 'C');
      expect(result).toBe('A\nB\nC');
    });

    test('returns empty string when all values are falsy', () => {
      const result = VStack(null, undefined, false, '');
      expect(result).toBe('');
    });
  });

  // ── HStack ──

  describe('HStack()', () => {
    test('joins single-line components horizontally with default gap', () => {
      const result = HStack(['Hello', 'World']);
      expect(result).toContain('Hello');
      expect(result).toContain('World');
      // Default gap is 2 spaces
      expect(result).toBe('Hello  World');
    });

    test('joins with custom gap', () => {
      const result = HStack(['A', 'B'], 4);
      expect(result).toBe('A    B');
    });

    test('handles multi-line components', () => {
      const result = HStack(['Line1\nLine2', 'Col1\nCol2']);
      const lines = result.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('Line1');
      expect(lines[0]).toContain('Col1');
      expect(lines[1]).toContain('Line2');
      expect(lines[1]).toContain('Col2');
    });
  });
});
