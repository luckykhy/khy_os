'use strict';

/**
 * projectBlueprint/catalog.js — 「怎么按类型交付项目」的单一真源（数据驱动）。
 *
 * 教 khyos 一种类型一种类型地建项目，且要在**小模型 / 短上下文**下也能干成。第一原则
 * （对照 [[project_disk_cleanup_safe]] 的白名单单源、[[project_short_context_engineering]]
 * 的窗口比例化）：
 *
 *   知识不塞进提示词，而是活在可检索的数据里——模型每次只取它当前里程碑需要的一小片。
 *
 * 两类条目，都从 src/blueprints/ 下的 JSON 加载，本模块是它们唯一的装载/匹配入口：
 *
 *   · archetype（可构建原型，blueprints/archetypes/*.json）：引用一个既有脚手架模板
 *     （projectTemplateService 的 templates/*.json，文件树真源），并在其上叠加**有序里程碑**，
 *     把「一次吐 19 个文件」拆成「逐阶段、每阶段几个文件」的可执行路径。
 *   · concept（概念知识卡，blueprints/concepts/*.json）：MVC/DDD/CQRS/RAG 这类「讲法而非框架」
 *     的可检索小卡，触发词命中即返回，供模型按需取一小段而非背全书。
 *
 * fail-soft：任何单条 JSON 损坏只跳过该条，绝不让整表加载失败。
 */

const fs = require('fs');
const path = require('path');

const projectTemplateService = require('../projectTemplateService');

const BLUEPRINTS_DIR = path.join(__dirname, '..', '..', 'blueprints');
const ARCHETYPES_DIR = path.join(BLUEPRINTS_DIR, 'archetypes');
const CONCEPTS_DIR = path.join(BLUEPRINTS_DIR, 'concepts');

function _envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 阈值集中声明，环境变量可调。 */
const thresholds = {
  // 正常窗口下单个里程碑切片的字符上限（短窗口再由 contextProfile 进一步收紧）。
  defaultSliceChars: _envInt('KHY_BLUEPRINT_SLICE_CHARS', 5000),
  // 概念卡 summary 体积护栏（防止有人把长文塞进卡片，破坏「按需取小片」初衷）。
  conceptSummaryMaxChars: _envInt('KHY_BLUEPRINT_CONCEPT_MAX_CHARS', 1200),
};

let _cache = null;

function _loadDir(dir, expectedKind) {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out; // 目录缺失 → 空表，绝不抛
  }
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') continue;
      if (!obj.id) continue;
      if (expectedKind && obj.kind && obj.kind !== expectedKind) continue;
      obj.kind = obj.kind || expectedKind;
      obj._filename = file;
      out.push(obj);
    } catch {
      // 单条损坏跳过，不污染整表
    }
  }
  return out;
}

function _load() {
  if (_cache) return _cache;
  _cache = {
    archetypes: _loadDir(ARCHETYPES_DIR, 'archetype'),
    concepts: _loadDir(CONCEPTS_DIR, 'concept'),
  };
  return _cache;
}

/** 测试/重载用：清空缓存。 */
function _resetCache() {
  _cache = null;
}

function listArchetypes() {
  return _load().archetypes.slice();
}

function listConcepts() {
  return _load().concepts.slice();
}

function getArchetype(id) {
  if (!id) return null;
  const lower = String(id).toLowerCase();
  return _load().archetypes.find((a) => String(a.id).toLowerCase() === lower) || null;
}

function getConcept(id) {
  if (!id) return null;
  const lower = String(id).toLowerCase();
  return _load().concepts.find((c) => String(c.id).toLowerCase() === lower) || null;
}

/** 取 archetype 关联的脚手架模板（原始对象，含 raw files）。缺失返回 null。 */
function templateFor(archetype) {
  if (!archetype || !archetype.templateName) return null;
  try {
    return projectTemplateService.loadTemplates().find((t) => t.name === archetype.templateName) || null;
  } catch {
    return null;
  }
}

/**
 * archetype 关联模板的**原始**文件路径清单（含 {groupPath} 等占位符，未渲染）。
 * 里程碑的 files 引用的就是这些原始路径——不变量校验据此进行。
 * @returns {string[]}
 */
function templateFiles(archetype) {
  const tmpl = templateFor(archetype);
  if (!tmpl || !Array.isArray(tmpl.files)) return [];
  return tmpl.files.map((f) => f.path);
}

/** archetype 的有效触发词 = 自身 triggers ∪ 关联模板 triggers。 */
function _archetypeTriggers(archetype) {
  const set = new Set();
  for (const t of archetype.triggers || []) set.add(String(t).toLowerCase());
  const tmpl = templateFor(archetype);
  for (const t of (tmpl && tmpl.triggers) || []) set.add(String(t).toLowerCase());
  set.add(String(archetype.id).toLowerCase());
  return [...set].filter(Boolean);
}

/**
 * 按用户文本命中 archetype（触发词包含匹配，大小写不敏感；镜像 projectTemplateService.matchTemplate）。
 * @param {string} userText
 * @returns {object|null}
 */
function matchArchetype(userText) {
  if (!userText) return null;
  const lower = String(userText).toLowerCase();
  for (const a of _load().archetypes) {
    for (const trig of _archetypeTriggers(a)) {
      if (trig && lower.includes(trig)) return a;
    }
  }
  return null;
}

/**
 * 按用户文本命中概念卡（触发词或 id/name 命中）。
 * @param {string} userText
 * @returns {object|null}
 */
function matchConcept(userText) {
  if (!userText) return null;
  const lower = String(userText).toLowerCase();
  for (const c of _load().concepts) {
    const triggers = [
      ...(c.triggers || []),
      c.id,
      c.name,
    ].filter(Boolean).map((t) => String(t).toLowerCase());
    for (const trig of triggers) {
      if (trig && lower.includes(trig)) return c;
    }
  }
  return null;
}

module.exports = {
  thresholds,
  BLUEPRINTS_DIR,
  listArchetypes,
  listConcepts,
  getArchetype,
  getConcept,
  templateFor,
  templateFiles,
  matchArchetype,
  matchConcept,
  _resetCache,
};
