'use strict';

/**
 * turnEnvelope.test.js — the structured turn envelope is derived from structured
 * signals only (我希望Khy-os是结构化输出), never from scraping the model's prose.
 *
 * Locks in:
 *   - status tri-state (ok / partial / error) from per-tool success + top-level error_code
 *   - artifacts/filesTouched/filesRead classification by (alias-insensitive) tool name
 *   - commands extraction with success + exitCode
 *   - errors carry code+message from structured result fields, not the reply text
 *   - pure Q&A turn (no tools) is still structured (status ok, empty artifacts)
 *   - the summary is the reply verbatim — the envelope never infers status FROM it
 *   - fail-soft: garbage input never throws
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { buildTurnEnvelope, _classify } = require('../src/services/structuredResults/turnEnvelope');

describe('turnEnvelope — tool classification (alias-insensitive)', () => {
  test('maps common aliases to canonical actions', () => {
    assert.equal(_classify('write_file'), 'write');
    assert.equal(_classify('writeFile'), 'write');
    assert.equal(_classify('create_document'), 'write');
    assert.equal(_classify('edit_file'), 'edit');
    assert.equal(_classify('multiEdit'), 'edit');
    assert.equal(_classify('str_replace_editor'), 'edit');
    assert.equal(_classify('delete_file'), 'delete');
    assert.equal(_classify('read_file'), 'read');
    assert.equal(_classify('shell_command'), 'command');
    assert.equal(_classify('powershell'), 'command');
    assert.equal(_classify('web_search'), 'other');
  });
});

describe('turnEnvelope — status derivation', () => {
  test('pure Q&A turn (no tools) is structured: status ok, empty artifacts', () => {
    const env = buildTurnEnvelope({ finalResponse: '北京是中国的首都。', iterations: 1, provider: 'p' });
    assert.equal(env.status, 'ok');
    assert.equal(env.summary, '北京是中国的首都。');
    assert.deepEqual(env.artifacts, []);
    assert.deepEqual(env.commands, []);
    assert.deepEqual(env.errors, []);
    assert.equal(env.metrics.toolCalls, 0);
    assert.equal(env.schemaVersion, 1);
  });

  test('all tools succeed → ok', () => {
    const env = buildTurnEnvelope({
      finalResponse: 'done',
      toolCallLog: [
        { tool: 'write_file', params: { path: 'a.js' }, result: { success: true } },
        { tool: 'shell_command', params: { command: 'node a.js' }, result: { success: true, exitCode: 0 } },
      ],
    });
    assert.equal(env.status, 'ok');
    assert.deepEqual(env.filesTouched, ['a.js']);
    assert.equal(env.commands[0].exitCode, 0);
  });

  test('some tools fail → partial', () => {
    const env = buildTurnEnvelope({
      finalResponse: 'mixed',
      toolCallLog: [
        { tool: 'write_file', params: { path: 'a.js' }, result: { success: true } },
        { tool: 'shell_command', params: { command: 'node a.js' }, result: { success: false, exitCode: 1, error: 'SyntaxError' } },
      ],
    });
    assert.equal(env.status, 'partial');
    assert.equal(env.errors.length, 1);
    assert.equal(env.errors[0].message, 'SyntaxError');
    assert.equal(env.commands[0].success, false);
    assert.equal(env.commands[0].exitCode, 1);
  });

  test('every tool fails → error', () => {
    const env = buildTurnEnvelope({
      finalResponse: 'all bad',
      toolCallLog: [
        { tool: 'shell_command', params: { command: 'x' }, result: { success: false, exitCode: 127 } },
      ],
    });
    assert.equal(env.status, 'error');
  });

  test('top-level error_code outranks per-tool success → error', () => {
    const env = buildTurnEnvelope({
      finalResponse: 'I cannot help with that.',
      error_code: 'E02',
      pseudoRefusal: true,
      attribution: { message: 'safety policy' },
      toolCallLog: [{ tool: 'read_file', params: { path: 'a.js' }, result: { success: true } }],
    });
    assert.equal(env.status, 'error');
    assert.equal(env.errors[0].code, 'E02');
    assert.equal(env.errors[0].message, 'safety policy');
  });
});

describe('turnEnvelope — artifacts & files', () => {
  test('reads do not count as filesTouched; writes/edits/deletes do', () => {
    const env = buildTurnEnvelope({
      finalResponse: 'ok',
      toolCallLog: [
        { tool: 'read_file', params: { path: 'r.js' }, result: { success: true } },
        { tool: 'write_file', params: { file_path: 'w.js' }, result: { success: true } },
        { tool: 'edit_file', params: { path: 'e.js' }, result: { success: true } },
        { tool: 'delete_file', params: { path: 'd.js' }, result: { success: true } },
      ],
    });
    assert.deepEqual(env.filesRead, ['r.js']);
    assert.deepEqual(env.filesTouched.sort(), ['d.js', 'e.js', 'w.js']);
    assert.equal(env.artifacts.length, 4);
    assert.equal(env.artifacts.find(a => a.path === 'w.js').action, 'write');
  });

  test('a write that explicitly failed is NOT counted as touched', () => {
    const env = buildTurnEnvelope({
      finalResponse: 'partial',
      toolCallLog: [
        { tool: 'write_file', params: { path: 'ok.js' }, result: { success: true } },
        { tool: 'write_file', params: { path: 'fail.js' }, result: { success: false, error: 'EACCES' } },
      ],
    });
    assert.deepEqual(env.filesTouched, ['ok.js']);
    assert.equal(env.status, 'partial');
  });
});

describe('turnEnvelope — structure-not-prose & fail-soft', () => {
  test('status is NOT inferred from the reply text (refusal-sounding prose with successful tools stays ok)', () => {
    const env = buildTurnEnvelope({
      finalResponse: '抱歉，我无法继续。', // refusal-SOUNDING prose, but tools actually succeeded
      toolCallLog: [{ tool: 'write_file', params: { path: 'a.js' }, result: { success: true } }],
    });
    assert.equal(env.status, 'ok'); // derived from structured success, not the prose
    assert.equal(env.summary, '抱歉，我无法继续。'); // prose carried verbatim
  });

  test('exitCode without explicit success still resolves success', () => {
    const env = buildTurnEnvelope({
      finalResponse: 'x',
      toolCallLog: [{ tool: 'shell_command', params: { command: 'ls' }, result: { exitCode: 0, output: 'a\nb' } }],
    });
    assert.equal(env.status, 'ok');
    assert.equal(env.commands[0].success, true);
  });

  test('garbage / missing input never throws', () => {
    assert.doesNotThrow(() => buildTurnEnvelope(null));
    assert.doesNotThrow(() => buildTurnEnvelope(undefined));
    assert.doesNotThrow(() => buildTurnEnvelope({ toolCallLog: 'not-an-array' }));
    assert.doesNotThrow(() => buildTurnEnvelope({ toolCallLog: [null, 42, { tool: '' }] }));
    const env = buildTurnEnvelope({});
    assert.equal(env.status, 'ok');
    assert.equal(env.summary, '');
  });

  test('opts.summary overrides finalResponse for the human-facing field', () => {
    const env = buildTurnEnvelope({ finalResponse: 'raw' }, { summary: 'curated' });
    assert.equal(env.summary, 'curated');
  });
});
