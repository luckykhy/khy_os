'use strict';

/**
 * maintainerMapDocCoverage.test.js — 维护映射表「文档指针」覆盖与引用完整性守卫
 *
 *   node --test scripts/tests/maintainerMapDocCoverage.test.js
 *
 * 目的：维护映射表(docs/_维护者/维护映射表.json)是「症状 → 子系统 → 读哪些文件/跑哪条验证」
 * 的单一真源,triage 速查表(OPS-MAN-067)由它确定性生成。本守卫钉死两条不变量:
 *
 *   1. 覆盖(coverage):每个子系统 area 都必须给出至少一条 docs 指针——新登记的子系统
 *      不许留空 docs[](空则 triage 把维护者引到该子系统时无文档可读)。
 *   2. 引用完整性(referential integrity):docs[] 里的每个路径都必须在磁盘上真实存在——
 *      杜绝改名/移动文档后映射表里残留悬空引用(chinese 手册路径含全角括号,须逐字匹配)。
 *
 * 二者皆为确定性静态断言,不跑生成器、不联网、纯读盘。新增子系统时若忘了配 docs,
 * 或删/改文档后忘了同步映射表,本测试立即变红并点名 area/路径。
 *
 * HOW-TO-EXTEND：无需改本文件。新增子系统只要在映射表里给该 area 配上真实存在的
 * docs[] 路径即可自动被覆盖;若某子系统确实暂无专属手册,请指向最贴近的既有 OPS-MAN /
 * IMPL-RPT 手册(而非留空或伪造路径)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MAP_PATH = path.join(ROOT, 'docs', '_维护者', '维护映射表.json');

function loadAreas() {
  const raw = fs.readFileSync(MAP_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed.areas), '维护映射表.json 必须含顶层 areas 数组');
  return parsed.areas;
}

describe('维护映射表 文档指针守卫', () => {
  test('映射表是合法 JSON 且含至少一个 area', () => {
    const areas = loadAreas();
    assert.ok(areas.length > 0, 'areas 不应为空');
  });

  test('每个子系统 area 都必须给出非空 docs[](覆盖不变量)', () => {
    const areas = loadAreas();
    const missing = areas
      .filter((a) => !Array.isArray(a.docs) || a.docs.length === 0)
      .map((a) => a.id);
    assert.deepEqual(
      missing,
      [],
      `以下子系统缺少 docs 指针,请为其配上最贴近的既有手册路径:${missing.join(', ')}`,
    );
  });

  test('docs[] 里每条路径都必须在磁盘上真实存在(引用完整性)', () => {
    const areas = loadAreas();
    const broken = [];
    for (const area of areas) {
      for (const doc of area.docs || []) {
        if (!fs.existsSync(path.join(ROOT, doc))) {
          broken.push(`${area.id} -> ${doc}`);
        }
      }
    }
    assert.deepEqual(
      broken,
      [],
      `映射表里的以下文档引用在磁盘上不存在(改名/移动后请同步映射表):\n${broken.join('\n')}`,
    );
  });

  test('docs[] 条目类型均为字符串且非空白', () => {
    const areas = loadAreas();
    const bad = [];
    for (const area of areas) {
      for (const doc of area.docs || []) {
        if (typeof doc !== 'string' || doc.trim() === '') {
          bad.push(`${area.id} -> ${JSON.stringify(doc)}`);
        }
      }
    }
    assert.deepEqual(bad, [], `docs[] 存在非字符串或空白条目:${bad.join(', ')}`);
  });
});
