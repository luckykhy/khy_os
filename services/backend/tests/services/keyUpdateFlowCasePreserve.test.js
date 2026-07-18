'use strict';

/**
 * keyUpdateFlowCasePreserve — 回归:抽取裸 key 时必须**保留原始大小写**。
 *
 * 缺陷背景:_cleanKey 曾复用 _norm(),而 _norm() 会 `.toLowerCase()`(它本是为标签/厂商
 * 比对而设,lowercase 合理)。结果智谱 hex32.secret 形态的 secret 段(大小写混合,如
 * `FaKeSeCrEt123`)被 lowercase 成 `n9fnhfs1o9mukjf4`——写入的 key 已损坏,GLM 端
 * 依旧 404。此为「粘 key 后识图仍 404」链路上的第二个 bug(第一个是图片附着时 key_update
 * 被整体跳过,见 repl.js 图注让路例外)。
 *
 * 修复:新增 _trimEdges()(仅去首尾标点、**不 lowercase**),_cleanKey 改用它;_norm 仍
 * lowercase 供标签/厂商比对(shape 推断用大小写不敏感正则,不受影响)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.KHY_KEY_UPDATE_FLOW; // 默认开

const f = require('../../src/services/keyUpdateFlow');

test('智谱 hex32.secret 裸 key:抽取后保留原始大小写', () => {
  const orig = '0123456789abcdef0123456789abcdef.FaKeSeCrEt123';
  const d = f.looksLikeBareKey(orig);
  assert.equal(d.isKey, true, '应识别为一把 key');
  assert.equal(d.key, orig, 'key 必须逐字节保留大小写(secret 段大小写敏感)');
});

test('保留大小写后仍按形态归属 glm(shape 正则大小写不敏感)', () => {
  const orig = '0123456789abcdef0123456789abcdef.FaKeSeCrEt123';
  const key = f.looksLikeBareKey(orig).key;
  assert.equal(f.inferProviderFromKeyShape(key), 'glm');
});

test('带首尾标点/标签的 key:去边界但保留 key 本身大小写', () => {
  const secret = 'FaKeSeCrEt123';
  const orig = `0123456789abcdef0123456789abcdef.${secret}`;
  const d = f.looksLikeBareKey(`密钥 ${orig}。`);
  assert.equal(d.isKey, true);
  assert.equal(d.key, orig, '去中英文标点与标签词,但 key 大小写不变');
  assert.ok(d.key.includes(secret), 'secret 段大小写完整保留');
});

test('sk- 家族 key 同样保留大小写', () => {
  const orig = 'sk-AbCdEf123456XYZ';
  const d = f.looksLikeBareKey(orig);
  assert.equal(d.isKey, true);
  assert.equal(d.key, orig, 'sk- key 大小写保留');
});
