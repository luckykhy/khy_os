/**
 * Unit tests for the per-adapter model curation layer (modelCuration.js):
 * applyOverrides (hide / add / rename / default) + verify cache TTL.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

describe('modelCuration', () => {
  let tmpFile;
  let modelCuration;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `khy_model_overrides_${process.pid}_${Math.floor(process.hrtime()[1])}.json`);
    process.env.KHY_MODEL_OVERRIDES_FILE = tmpFile;
    delete process.env.KHY_MODEL_VERIFY_TTL_MS;
    jest.resetModules();
    modelCuration = require('../../src/services/gateway/modelCuration');
    modelCuration._resetCache();
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    delete process.env.KHY_MODEL_OVERRIDES_FILE;
    delete process.env.KHY_MODEL_VERIFY_TTL_MS;
    if (modelCuration) modelCuration._resetCache();
  });

  const raw = () => ([
    { id: 'model-a', name: 'Model A', isDefault: true, discoverySource: 'baseline' },
    { id: 'model-b', name: 'Model B', discoverySource: 'remote' },
  ]);

  test('passthrough when no overrides', () => {
    const out = modelCuration.applyOverrides('cursor', raw());
    expect(out.map(m => m.id)).toEqual(['model-a', 'model-b']);
    expect(out[0].isDefault).toBe(true);
  });

  test('hide removes a model from the list', () => {
    modelCuration.setAdapterOverride('cursor', { hidden: ['model-a'] });
    const out = modelCuration.applyOverrides('cursor', raw());
    expect(out.map(m => m.id)).toEqual(['model-b']);
  });

  test('added appends a custom model flagged custom/user', () => {
    modelCuration.setAdapterOverride('cursor', { added: [{ id: 'mine', name: '我的模型' }] });
    const out = modelCuration.applyOverrides('cursor', raw());
    const mine = out.find(m => m.id === 'mine');
    expect(mine).toBeTruthy();
    expect(mine.custom).toBe(true);
    expect(mine.discoverySource).toBe('user');
    expect(mine.name).toBe('我的模型');
  });

  test('renamed changes display name only', () => {
    modelCuration.setAdapterOverride('cursor', { renamed: { 'model-b': 'B 重命名' } });
    const out = modelCuration.applyOverrides('cursor', raw());
    expect(out.find(m => m.id === 'model-b').name).toBe('B 重命名');
  });

  test('defaultModel re-marks the default uniquely', () => {
    modelCuration.setAdapterOverride('cursor', { defaultModel: 'model-b' });
    const out = modelCuration.applyOverrides('cursor', raw());
    expect(out.find(m => m.id === 'model-a').isDefault).toBe(false);
    expect(out.find(m => m.id === 'model-b').isDefault).toBe(true);
  });

  test('stale defaultModel (hidden/nonexistent) preserves original markers', () => {
    // defaultModel 指向一个不在列表中的模型时，不得清掉适配器自带的默认标记。
    modelCuration.setAdapterOverride('cursor', { defaultModel: 'ghost-model' });
    const out = modelCuration.applyOverrides('cursor', raw());
    expect(out.find(m => m.id === 'model-a').isDefault).toBe(true);
    expect(out.find(m => m.id === 'model-b').isDefault).toBeFalsy();
  });

  test('overrides persist across cache reset (written to disk)', () => {
    modelCuration.setAdapterOverride('cursor', { hidden: ['model-a'] });
    modelCuration._resetCache();
    const out = modelCuration.applyOverrides('cursor', raw());
    expect(out.map(m => m.id)).toEqual(['model-b']);
  });

  test('setAdapterOverride merges fields, not replaces whole record', () => {
    modelCuration.setAdapterOverride('cursor', { hidden: ['model-a'] });
    modelCuration.setAdapterOverride('cursor', { defaultModel: 'model-b' });
    const ov = modelCuration.getAdapterOverride('cursor');
    expect(ov.hidden).toEqual(['model-a']);
    expect(ov.defaultModel).toBe('model-b');
  });

  test('verify cache stores and reads status', () => {
    expect(modelCuration.getVerifyStatus('cursor', 'model-a')).toBe('unknown');
    modelCuration.recordVerify('cursor', 'model-a', 'verified', 42);
    expect(modelCuration.getVerifyStatus('cursor', 'model-a')).toBe('verified');
    const rec = modelCuration.getVerifyRecord('cursor', 'model-a');
    expect(rec.latencyMs).toBe(42);
  });

  test('verify cache expires after TTL', () => {
    process.env.KHY_MODEL_VERIFY_TTL_MS = '5';
    modelCuration.recordVerify('cursor', 'model-a', 'verified', 10);
    const start = Date.now();
    while (Date.now() - start < 12) { /* busy wait past 5ms TTL */ }
    expect(modelCuration.getVerifyStatus('cursor', 'model-a')).toBe('unknown');
  });

  test('clearAdapterOverride removes the record', () => {
    modelCuration.setAdapterOverride('cursor', { hidden: ['model-a'] });
    expect(modelCuration.clearAdapterOverride('cursor')).toBe(true);
    expect(modelCuration.getAdapterOverride('cursor')).toEqual({});
  });
});
