'use strict';

/**
 * searchTokenizer — 抽出的领域中性 CJK/ASCII 分词器的 golden 行为锁（node:test）。
 *
 * 背景：该分词器原是 `knowledgeTeachingService._searchTokenize` 的内联实现，被
 * `learningRetrieval` 跨模块借用，那条 require 边把 learningRetrieval / guideRetriever /
 * guideInjector 拽进巨型 SCC。下沉为零依赖叶子模块后，巨型 SCC 82→79
 * （[DESIGN-ARCH-051] §六.2）。原知识库测试是 Jest（本环境无运行器），故以此**可运行**
 * 的 node:test golden 套件钉死「行为逐字不变」+「叶子零依赖」+「两侧导出仍一致」。
 */

const test = require('node:test');
const assert = require('node:assert');

const { tokenizeForSearch } = require('../../src/services/searchTokenizer');

// 原内联实现的逐字副本，作为 golden 基准——抽出后必须与之字节一致。
function _goldenInline(text) {
  const lower = String(text || '').toLowerCase();
  const parts = lower.match(/[一-鿿]+|[a-z0-9_]+/g) || [];
  const tokens = [];
  for (const part of parts) {
    if (/^[一-鿿]+$/.test(part)) {
      for (let i = 0; i < part.length; i++) {
        tokens.push(part[i]);
        if (i < part.length - 1) tokens.push(part.slice(i, i + 2));
      }
    } else {
      tokens.push(part);
    }
  }
  return [...new Set(tokens.filter(Boolean))];
}

const SAMPLES = [
  '内核调度抢占 preempt scheduler',
  '量化 quant stop_loss 止损',
  'ABC123 混合 mixed 文本 text',
  '',
  '   ',
  '单',
  '多字符串测试 hello_world 42',
  '内核',
  'kernel',
  '决策 allow deny ask agentask',
  'CamelCase_underscore 中英mixed混排',
];

test('与原内联实现逐字等价（golden）', () => {
  for (const s of SAMPLES) {
    assert.deepStrictEqual(tokenizeForSearch(s), _goldenInline(s), `分词不一致：${JSON.stringify(s)}`);
  }
});

test('中文按「单字 + 相邻 bigram」切分、去重', () => {
  // “内核” → 内, 内核, 核（相邻 bigram，末字无后继）
  assert.deepStrictEqual(tokenizeForSearch('内核'), ['内', '内核', '核']);
});

test('英文/数字/下划线按整词、大小写归一', () => {
  assert.deepStrictEqual(tokenizeForSearch('Hello_World 42'), ['hello_world', '42']);
});

test('中英混排各自切分、整体去重', () => {
  const out = tokenizeForSearch('内核kernel内核'); // 第二个“内核”被去重
  assert.deepStrictEqual(out, ['内', '内核', '核', 'kernel']);
});

test('空 / 非字符串 / 纯标点 → 空数组，绝不抛', () => {
  assert.deepStrictEqual(tokenizeForSearch(''), []);
  assert.deepStrictEqual(tokenizeForSearch('   '), []);
  assert.deepStrictEqual(tokenizeForSearch('！@#—…'), []);
  assert.deepStrictEqual(tokenizeForSearch(null), []);
  assert.deepStrictEqual(tokenizeForSearch(undefined), []);
  assert.deepStrictEqual(tokenizeForSearch(12345), ['12345']); // String() 兜底
});

test('叶子模块零依赖（含注释也无 require 调用语法——防架构债扫描器误判幽灵边回退）', () => {
  // 本仓库架构债扫描器按行匹配 require 调用、不剔除注释；若本文件任何位置（含注释）
  // 出现 require('./xxx') 样式，就会凭空生成一条依赖边，可能把叶子重新拖回 SCC、
  // 令 82→79 的解耦前功尽弃。故断言整文件源码不含任何 require 调用语法。
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/searchTokenizer.js'), 'utf8');
  assert.strictEqual(/\brequire\s*\(/.test(src), false, '叶子模块源码（含注释）不得出现 require 调用语法');
});

test('两侧导出一致：knowledgeTeachingService.tokenizeForSearch === 叶子实现', () => {
  const kt = require('../../src/services/knowledgeTeachingService');
  assert.strictEqual(typeof kt.tokenizeForSearch, 'function');
  // 同输入同输出（kt 导出现已转引叶子）
  for (const s of SAMPLES) {
    assert.deepStrictEqual(kt.tokenizeForSearch(s), tokenizeForSearch(s));
  }
});
