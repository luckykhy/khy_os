#!/usr/bin/env node
/**
 * 修复文档索引中的断链
 * 用法：node fix-doc-index.js [--apply]
 */

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const ROOT = path.resolve(__dirname, '..', '..');
const INDEX_FILE = path.join(ROOT, 'docs', '00_INDEX_文档索引.md');

// URL 解码
function decodeUrl(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

// 检查文件是否存在
function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

// 查找实际文件
function findActualFile(baseDir, relativePath) {
  // 直接尝试
  const direct = path.join(baseDir, relativePath);
  if (fileExists(direct)) return direct;
  
  // 解码 URL 后尝试
  const decoded = decodeUrl(relativePath);
  const decodedPath = path.join(baseDir, decoded);
  if (fileExists(decodedPath)) return decodedPath;
  
  // 尝试不同的编码方式
  const variants = [
    decoded.replace(/[%（）]/g, c => {
      const map = { '%': '%', '（': '(', '）': ')' };
      return map[c] || c;
    }),
    decoded.replace(/[（）]/g, c => c === '（' ? '(' : ')'),
  ];
  
  for (const variant of variants) {
    const variantPath = path.join(baseDir, variant);
    if (fileExists(variantPath)) return variantPath;
  }
  
  return null;
}

function main() {
  console.log('🔍 检查文档索引中的链接...\n');
  
  const content = fs.readFileSync(INDEX_FILE, 'utf8');
  const lines = content.split('\n');
  
  const issues = [];
  const fixes = [];
  
  lines.forEach((line, idx) => {
    // 匹配 [text](link) 格式
    const regex = /\[([^\]]*)\]\(([^)]+)\)/g;
    let match;
    
    while ((match = regex.exec(line)) !== null) {
      const text = match[1];
      const rawLink = match[2];
      
      // 跳过外部链接和锚点
      if (rawLink.startsWith('http') || rawLink.startsWith('#') || rawLink.startsWith('mailto:')) {
        continue;
      }
      
      // 跳过占位符链接
      if (rawLink.includes('<') || rawLink.includes('>')) {
        continue;
      }
      
      // 解析链接
      const hashIdx = rawLink.indexOf('#');
      const anchor = hashIdx >= 0 ? rawLink.slice(hashIdx) : '';
      const linkPath = hashIdx >= 0 ? rawLink.slice(0, hashIdx) : rawLink;
      
      // 检查文件是否存在
      const baseDir = path.dirname(INDEX_FILE);
      const actualFile = findActualFile(baseDir, linkPath);
      
      if (!actualFile) {
        issues.push({
          line: idx + 1,
          text,
          rawLink,
          linkPath,
          anchor
        });
      }
    }
  });
  
  console.log(`📊 检查完成：${lines.length} 行，${issues.length} 个断链`);
  
  if (issues.length > 0) {
    console.log('\n📋 断链列表：');
    issues.forEach(issue => {
      console.log(`   行 ${issue.line}: [${issue.text}](${issue.rawLink})`);
    });
    
    if (APPLY) {
      console.log('\n🔧 修复断链...');
      
      // 这里可以添加自动修复逻辑
      // 目前只报告问题，需要手动修复
      
      console.log('\n⚠️  需要手动修复以下断链：');
      issues.forEach(issue => {
        console.log(`   行 ${issue.line}: ${issue.rawLink}`);
        console.log(`     → 文件不存在，请检查文件名或删除链接`);
      });
    } else {
      console.log('\n💡 运行 `node scripts/docs/fix-doc-index.js --apply` 查看修复建议');
    }
  } else {
    console.log('\n✅ 所有链接有效');
  }
  
  return issues.length;
}

const count = main();
process.exit(count > 0 ? 1 : 0);
