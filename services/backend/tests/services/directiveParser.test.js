'use strict';

/**
 * Tests for directiveParser.js — directive extraction, stripping,
 * whitespace normalization, and reply ID sanitization.
 */

const {
  extractDirectives,
  stripDirectives,
  normalizeWhitespace,
  sanitizeReplyId,
  MAX_REPLY_ID_LENGTH,
} = require('../../src/services/directiveParser');

describe('extractDirectives', () => {
  test('returns defaults for empty/null input', () => {
    const result = extractDirectives(null);
    expect(result).toEqual({ audioAsVoice: false, replyTo: null, replyToCurrent: false });
    expect(extractDirectives('')).toEqual({ audioAsVoice: false, replyTo: null, replyToCurrent: false });
  });

  test('detects audio_as_voice directive', () => {
    const result = extractDirectives('Hello [[audio_as_voice]] world');
    expect(result.audioAsVoice).toBe(true);
  });

  test('detects reply_to directive with ID', () => {
    const result = extractDirectives('Hello [[reply_to: msg-123]] world');
    expect(result.replyTo).toBe('msg-123');
    expect(result.replyToCurrent).toBe(false);
  });

  test('detects reply_to_current directive', () => {
    const result = extractDirectives('Hello [[reply_to_current]] world');
    expect(result.replyToCurrent).toBe(true);
    expect(result.replyTo).toBeNull();
  });

  test('does not detect directives inside code blocks', () => {
    const text = '```\n[[audio_as_voice]]\n```';
    const result = extractDirectives(text);
    expect(result.audioAsVoice).toBe(false);
  });

  test('handles whitespace-tolerant directive tags', () => {
    const result = extractDirectives('[[  audio_as_voice  ]]');
    expect(result.audioAsVoice).toBe(true);
  });
});

describe('stripDirectives', () => {
  test('removes audio_as_voice tag', () => {
    const result = stripDirectives('Hello [[audio_as_voice]] world');
    expect(result).not.toContain('audio_as_voice');
    expect(result).toContain('Hello');
    expect(result).toContain('world');
  });

  test('removes reply_to tag', () => {
    const result = stripDirectives('Text [[reply_to: abc]] more');
    expect(result).not.toContain('reply_to');
  });

  test('preserves directives inside code blocks', () => {
    const text = 'Normal text\n```\n[[audio_as_voice]]\n```\nMore text';
    const result = stripDirectives(text);
    expect(result).toContain('[[audio_as_voice]]');
  });

  test('returns empty string for null input', () => {
    expect(stripDirectives(null)).toBe('');
    expect(stripDirectives('')).toBe('');
  });

  test('trims result', () => {
    const result = stripDirectives('  [[audio_as_voice]]  ');
    expect(result).toBe('');
  });
});

describe('normalizeWhitespace', () => {
  test('collapses multiple newlines to double newline', () => {
    const result = normalizeWhitespace('a\n\n\n\nb');
    expect(result).toBe('a\n\nb');
  });

  test('normalizes CRLF to LF', () => {
    const result = normalizeWhitespace('a\r\nb');
    expect(result).toBe('a\nb');
  });

  test('preserves code block content', () => {
    const text = '```\n  preserved   spacing  \n```';
    const result = normalizeWhitespace(text);
    expect(result).toContain('  preserved   spacing  ');
  });

  test('returns empty string for falsy input', () => {
    expect(normalizeWhitespace(null)).toBe('');
    expect(normalizeWhitespace('')).toBe('');
  });
});

describe('sanitizeReplyId', () => {
  test('trims whitespace', () => {
    expect(sanitizeReplyId('  msg-123  ')).toBe('msg-123');
  });

  test('removes control characters', () => {
    expect(sanitizeReplyId('msg\x00-\x1f123')).toBe('msg-123');
  });

  test('removes bracket characters', () => {
    expect(sanitizeReplyId('msg[123]')).toBe('msg123');
  });

  test('returns undefined for empty/null input', () => {
    expect(sanitizeReplyId('')).toBeUndefined();
    expect(sanitizeReplyId(null)).toBeUndefined();
    expect(sanitizeReplyId('   ')).toBeUndefined();
  });

  test('truncates to MAX_REPLY_ID_LENGTH', () => {
    const longId = 'a'.repeat(MAX_REPLY_ID_LENGTH + 100);
    const result = sanitizeReplyId(longId);
    expect(result.length).toBe(MAX_REPLY_ID_LENGTH);
  });

  test('preserves normal IDs unchanged', () => {
    expect(sanitizeReplyId('abc-def-123')).toBe('abc-def-123');
  });
});
