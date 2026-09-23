#!/usr/bin/env node
/**
 * 自动修复文档索引中的断链
 * 用法：node auto-fix-doc-index.js [--apply]
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

// 查找相似文件
function findSimilarFile(baseDir, targetName) {
  // 检查目录是否存在
  if (!fs.existsSync(baseDir)) {
    return null;
  }
  
  try {
    const files = fs.readdirSync(baseDir);
    const decoded = decodeUrl(targetName);
    
    // 精确匹配
    for (const file of files) {
      if (file === decoded || file === targetName) {
        return file;
      }
    }
    
    // 部分匹配
    for (const file of files) {
      const fileBase = path.basename(file, path.extname(file));
      const targetBase = path.basename(decoded, path.extname(decoded));
      
      if (fileBase.includes(targetBase) || targetBase.includes(fileBase)) {
        return file;
      }
    }
  } catch (e) {
    // 目录不存在或无法访问
  }
  
  return null;
}

function main() {
  console.log('🔍 自动修复文档索引中的断链...\n');
  
  let content = fs.readFileSync(INDEX_FILE, 'utf8');
  const lines = content.split('\n');
  
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
      const targetFile = path.join(baseDir, linkPath);
      
      if (!fs.existsSync(targetFile)) {
        // 尝试查找相似文件
        const dir = path.dirname(targetFile);
        const targetName = path.basename(targetFile);
        const similarFile = findSimilarFile(dir, targetName);
        
        if (similarFile) {
          const newLink = linkPath.replace(targetName, similarFile);
          fixes.push({
            line: idx + 1,
            oldLink: rawLink,
            newLink: newLink,
            oldFile: targetName,
            newFile: similarFile
          });
        }
      }
    }
  });
  
  console.log(`📊 找到 ${fixes.length} 个可修复的断链`);
  
  if (fixes.length > 0) {
    console.log('\n📋 修复列表：');
    fixes.forEach(fix => {
      console.log(`   行 ${fix.line}:`);
      console.log(`     旧: ${fix.oldFile}`);
      console.log(`     新: ${fix.newFile}`);
    });
    
    if (APPLY) {
      console.log('\n🔧 执行修复...');
      
      let fixedCount = 0;
      fixes.forEach(fix => {
        content = content.replace(fix.oldLink, fix.newLink);
        fixedCount++;
      });
      
      fs.writeFileSync(INDEX_FILE, content, 'utf8');
      console.log(`\n✅ 共修复 ${fixedCount} 个断链`);
    } else {
      console.log('\n💡 运行 `node scripts/docs/auto-fix-doc-index.js --apply` 执行修复');
    }
  } else {
    console.log('\n✅ 没有可自动修复的断链');
  }
  
  return fixes.length;
}

const count = main();
process.exit(count > 0 ? 1 : 0);
