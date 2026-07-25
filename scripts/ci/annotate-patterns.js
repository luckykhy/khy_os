#!/usr/bin/env node
/**
 * @pattern Visitor, Command
 *
 * 批量为源文件添加 @pattern 注释
 * 读取 pattern-registry.json，为每个文件头部插入 @pattern 声明
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(ROOT, 'docs', 'design-patterns', 'pattern-registry.json');
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));

let modified = 0;
let skipped = 0;
let errors = 0;

function hasPatternTag(content) {
  return /@pattern\s+/i.test(content);
}

function addPatternToJS(filePath, patterns) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (hasPatternTag(content)) { skipped++; return; }
  const tag = `/**\n * @pattern ${patterns.join(', ')}\n */`;

  // 如果已有顶部注释块，在其后插入
  // 如果以 'use strict' 开头，在其后插入
  // 如果以 shebang 开头，在其后插入
  let result;
  if (content.startsWith('#!')) {
    const nl = content.indexOf('\n');
    result = content.slice(0, nl + 1) + tag + '\n' + content.slice(nl + 1);
  } else if (content.startsWith('/**')) {
    // 在已有 JSDoc 块的 */ 后找到注释末尾，在 @pattern 未出现时插入
    const endIdx = content.indexOf('*/');
    if (endIdx !== -1) {
      // 在现有 JSDoc 块内追加 @pattern
      result = content.slice(0, endIdx) + ` * @pattern ${patterns.join(', ')}\n ` + content.slice(endIdx);
    } else {
      result = tag + '\n' + content;
    }
  } else if (/^\/\*[^*]/.test(content)) {
    // 普通多行注释
    const endIdx = content.indexOf('*/');
    if (endIdx !== -1) {
      result = content.slice(0, endIdx) + ` * @pattern ${patterns.join(', ')}\n ` + content.slice(endIdx);
    } else {
      result = tag + '\n' + content;
    }
  } else if (content.startsWith('//')) {
    // 单行注释开头 — 在第一个非注释行前插入
    const lines = content.split('\n');
    let insertAt = 0;
    while (insertAt < lines.length && lines[insertAt].startsWith('//')) insertAt++;
    lines.splice(insertAt, 0, tag);
    result = lines.join('\n');
  } else {
    result = tag + '\n' + content;
  }
  fs.writeFileSync(filePath, result);
  modified++;
}

function addPatternToPython(filePath, patterns) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (hasPatternTag(content)) { skipped++; return; }
  const tag = `# @pattern ${patterns.join(', ')}`;

  let result;
  if (content.startsWith('#!')) {
    const nl = content.indexOf('\n');
    result = content.slice(0, nl + 1) + tag + '\n' + content.slice(nl + 1);
  } else if (content.startsWith('# -*- coding')) {
    const nl = content.indexOf('\n');
    result = content.slice(0, nl + 1) + tag + '\n' + content.slice(nl + 1);
  } else {
    result = tag + '\n' + content;
  }
  fs.writeFileSync(filePath, result);
  modified++;
}

function addPatternToVue(filePath, patterns) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (hasPatternTag(content)) { skipped++; return; }
  const tag = `<!-- @pattern ${patterns.join(', ')} -->`;
  fs.writeFileSync(filePath, tag + '\n' + content);
  modified++;
}

function addPatternToC(filePath, patterns) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (hasPatternTag(content)) { skipped++; return; }
  const tag = `/**\n * @pattern ${patterns.join(', ')}\n */`;

  let result;
  if (content.startsWith('/**') || content.startsWith('/*')) {
    const endIdx = content.indexOf('*/');
    if (endIdx !== -1) {
      result = content.slice(0, endIdx) + ` * @pattern ${patterns.join(', ')}\n ` + content.slice(endIdx);
    } else {
      result = tag + '\n' + content;
    }
  } else if (content.startsWith('#ifndef') || content.startsWith('#pragma') || content.startsWith('#include')) {
    result = tag + '\n' + content;
  } else {
    result = tag + '\n' + content;
  }
  fs.writeFileSync(filePath, result);
  modified++;
}

function addPatternToASM(filePath, patterns) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (hasPatternTag(content)) { skipped++; return; }
  const tag = `; @pattern ${patterns.join(', ')}`;
  fs.writeFileSync(filePath, tag + '\n' + content);
  modified++;
}

function addPatternToShell(filePath, patterns) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (hasPatternTag(content)) { skipped++; return; }
  const tag = `# @pattern ${patterns.join(', ')}`;

  let result;
  if (content.startsWith('#!')) {
    const nl = content.indexOf('\n');
    result = content.slice(0, nl + 1) + tag + '\n' + content.slice(nl + 1);
  } else {
    result = tag + '\n' + content;
  }
  fs.writeFileSync(filePath, result);
  modified++;
}

function addPatternToCSS(filePath, patterns) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (hasPatternTag(content)) { skipped++; return; }
  const tag = `/* @pattern ${patterns.join(', ')} */`;
  fs.writeFileSync(filePath, tag + '\n' + content);
  modified++;
}

function addPatternToMoonBit(filePath, patterns) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (hasPatternTag(content)) { skipped++; return; }
  const tag = `/// @pattern ${patterns.join(', ')}`;
  fs.writeFileSync(filePath, tag + '\n' + content);
  modified++;
}

for (const [relPath, patterns] of Object.entries(registry)) {
  const absPath = path.join(ROOT, relPath);
  if (!fs.existsSync(absPath)) {
    // console.warn(`SKIP (not found): ${relPath}`);
    skipped++;
    continue;
  }

  const ext = path.extname(relPath).toLowerCase();
  try {
    switch (ext) {
      case '.js':
      case '.ts':
        addPatternToJS(absPath, patterns);
        break;
      case '.vue':
        addPatternToVue(absPath, patterns);
        break;
      case '.py':
        addPatternToPython(absPath, patterns);
        break;
      case '.c':
      case '.h':
        addPatternToC(absPath, patterns);
        break;
      case '.asm':
        addPatternToASM(absPath, patterns);
        break;
      case '.sh':
      case '.ps1':
        addPatternToShell(absPath, patterns);
        break;
      case '.css':
        addPatternToCSS(absPath, patterns);
        break;
      case '.mbt':
        addPatternToMoonBit(absPath, patterns);
        break;
      default:
        skipped++;
    }
  } catch (err) {
    console.error(`ERROR: ${relPath}: ${err.message}`);
    errors++;
  }
}

console.log(`Modified: ${modified}`);
console.log(`Skipped:  ${skipped}`);
console.log(`Errors:   ${errors}`);
