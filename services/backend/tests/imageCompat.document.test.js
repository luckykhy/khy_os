'use strict';

// Workstream B — native Anthropic document blocks for PDF/text passthrough.
// toAnthropicDocumentBlocks must produce valid {type:'document', source:{...}}
// blocks for base64 / dataURL / url / text inputs and drop garbage.

const {
  normalizeDocItem,
  toAnthropicDocumentBlocks,
} = require('../src/services/gateway/adapters/_imageCompat');

// A short but base64-valid string (>= 64 chars so the heuristic accepts it).
const VALID_B64 = Buffer.from('PDF-CONTENT-'.repeat(8)).toString('base64');

describe('normalizeDocItem', () => {
  test('raw base64 string → base64 kind, default pdf mime', () => {
    const doc = normalizeDocItem(VALID_B64);
    expect(doc).toMatchObject({ kind: 'base64', mimeType: 'application/pdf' });
    expect(doc.data).toBe(VALID_B64);
  });

  test('data URL string → base64 kind with parsed mime', () => {
    const dataUrl = `data:application/pdf;base64,${VALID_B64}`;
    const doc = normalizeDocItem(dataUrl);
    expect(doc).toMatchObject({ kind: 'base64', mimeType: 'application/pdf', data: VALID_B64 });
  });

  test('http url string → url kind', () => {
    const doc = normalizeDocItem('https://example.com/spec.pdf');
    expect(doc).toMatchObject({ kind: 'url', url: 'https://example.com/spec.pdf' });
  });

  test('{ base64, mimeType, name } object → base64 kind with title', () => {
    const doc = normalizeDocItem({ base64: VALID_B64, mimeType: 'application/pdf', name: 'report.pdf' });
    expect(doc).toMatchObject({ kind: 'base64', mimeType: 'application/pdf', title: 'report.pdf' });
  });

  test('{ text } object → text kind', () => {
    const doc = normalizeDocItem({ text: 'hello document', name: 'note' });
    expect(doc).toMatchObject({ kind: 'text', mimeType: 'text/plain', text: 'hello document', title: 'note' });
  });

  test('garbage / empty → null', () => {
    expect(normalizeDocItem(null)).toBeNull();
    expect(normalizeDocItem('')).toBeNull();
    expect(normalizeDocItem('not base64 !!!')).toBeNull();
    expect(normalizeDocItem({})).toBeNull();
  });
});

describe('toAnthropicDocumentBlocks', () => {
  test('produces a valid base64 document block', () => {
    const blocks = toAnthropicDocumentBlocks([{ base64: VALID_B64, mimeType: 'application/pdf', name: 'a.pdf' }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: VALID_B64 },
      title: 'a.pdf',
    });
  });

  test('produces a url document block', () => {
    const blocks = toAnthropicDocumentBlocks(['https://example.com/x.pdf']);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'document', source: { type: 'url', url: 'https://example.com/x.pdf' } });
  });

  test('produces a text document block', () => {
    const blocks = toAnthropicDocumentBlocks([{ text: 'plain doc body' }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'plain doc body' } });
  });

  test('mixed valid + garbage → only valid blocks', () => {
    const blocks = toAnthropicDocumentBlocks([
      { base64: VALID_B64, mimeType: 'application/pdf' },
      null,
      'garbage !!!',
      'https://example.com/y.pdf',
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].source.type).toBe('base64');
    expect(blocks[1].source.type).toBe('url');
  });

  test('empty / non-array → []', () => {
    expect(toAnthropicDocumentBlocks([])).toEqual([]);
    expect(toAnthropicDocumentBlocks(undefined)).toEqual([]);
    expect(toAnthropicDocumentBlocks(null)).toEqual([]);
  });
});

// Workstream G — citations enabled by default on document blocks (env kill-switch).
describe('toAnthropicDocumentBlocks — citations', () => {
  const ENV_KEY = 'KHY_DOC_CITATIONS';
  let saved;
  beforeEach(() => { saved = process.env[ENV_KEY]; });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  test('default → every block carries citations:{enabled:true}', () => {
    delete process.env[ENV_KEY];
    const blocks = toAnthropicDocumentBlocks([
      { text: 'plain doc body' },
      'https://example.com/y.pdf',
    ]);
    expect(blocks).toHaveLength(2);
    for (const b of blocks) expect(b.citations).toEqual({ enabled: true });
  });

  test('KHY_DOC_CITATIONS=0 → no citations field', () => {
    process.env[ENV_KEY] = '0';
    const blocks = toAnthropicDocumentBlocks([{ text: 'x' }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].citations).toBeUndefined();
  });

  test('text-source document keeps source.type === text under citations', () => {
    delete process.env[ENV_KEY];
    const blocks = toAnthropicDocumentBlocks([{ name: 'a.csv', mimeType: 'text/plain', text: 'x,y\n1,2' }]);
    expect(blocks[0].source.type).toBe('text');
    expect(blocks[0].citations).toEqual({ enabled: true });
  });
});
