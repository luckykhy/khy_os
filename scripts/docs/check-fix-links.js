#!/usr/bin/env node
/**
 * 检查并修复文档中的断链
 * 用法：node check-fix-links.js [--fix]
 */

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--fix');
const ROOT = path.resolve(__dirname, '..', '..');

// URL 解码函数
function decodeUrl(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

// 查找所有 .md 文件
function findMdFiles(dir) {
  let files = [];
  const skipDirs = new Set(['node_modules', '.git', 'build', 'dist']);
  
  fs.readdirSync(dir, { withFileTypes: true }).forEach(d => {
    const p = path.join(dir, d.name);
    if (d.isDirectory() && !skipDirs.has(d.name)) {
      files = files.concat(findMdFiles(p));
    } else if (d.name.endsWith('.md')) {
      files.push(p);
    }
  });
  return files;
}

// 提取文件中的链接
function extractLinks(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const links = [];
  
  // 匹配 [text](link.md) 格式
  const regex = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  
  while ((match = regex.exec(content)) !== null) {
    const text = match[1];
    const rawLink = match[2];
    
    // 跳过外部链接
    if (rawLink.startsWith('http') || rawLink.startsWith('#') || rawLink.startsWith('mailto:')) {
      continue;
    }
    
    // 解码 URL
    const decodedLink = decodeUrl(rawLink);
    
    // 解析锚点
    const hashIdx = decodedLink.indexOf('#');
    const anchor = hashIdx >= 0 ? decodedLink.slice(hashIdx) : '';
    const linkPath = hashIdx >= 0 ? decodedLink.slice(0, hashIdx) : decodedLink;
    
    links.push({
      text,
      rawLink,
      decodedLink,
      linkPath,
      anchor,
      line: content.slice(0, match.index).split('\n').length
    });
  }
  
  return links;
}

// 检查链接是否有效
function isLinkValid(filePath, linkPath) {
  if (!linkPath) return true; // 纯锚点链接
  
  const dir = path.dirname(filePath);
  const resolved = path.resolve(dir, linkPath);
  
  // 检查文件是否存在（不区分大小写）
  const normalized = resolved.replace(/\//g, path.sep);
  return fs.existsSync(normalized);
}

// 主函数
function main() {
  console.log('🔍 扫描文档链接...\n');
  
  const mdFiles = findMdFiles(path.join(ROOT, 'docs'));
  const issues = [];
  
  mdFiles.forEach(file => {
    const links = extractLinks(file);
    const relFile = path.relative(ROOT, file);
    
    links.forEach(link => {
      if (!isLinkValid(file, link.linkPath)) {
        // 尝试找到实际文件
        const dir = path.dirname(file);
        const decoded = decodeUrl(link.rawLink);
        const actualPath = path.resolve(dir, decoded);
        
        if (fs.existsSync(actualPath.replace(/\//g, path.sep))) {
          // 文件存在，是编码问题
          issues.push({
            file: relFile,
            line: link.line,
            raw: link.rawLink,
            decoded: decoded,
            type: 'encoding',
            fix: decoded
          });
        } else {
          // 文件不存在
          issues.push({
            file: relFile,
            line: link.line,
            raw: link.rawLink,
            decoded: decoded,
            type: 'missing',
            fix: null
          });
        }
      }
    });
  });
  
  // 统计
  const encodingIssues = issues.filter(i => i.type === 'encoding');
  const missingIssues = issues.filter(i => i.type === 'missing');
  
  console.log(`📊 扫描完成：${mdFiles.length} 个文件，${issues.length} 个问题`);
  console.log(`   - 编码问题：${encodingIssues.length} 个`);
  console.log(`   - 缺失文件：${missingIssues.length} 个`);
  
  if (encodingIssues.length > 0) {
    console.log('\n📋 编码问题示例：');
    encodingIssues.slice(0, 5).forEach(issue => {
      console.log(`   ${issue.file}:${issue.line}`);
      console.log(`     原始: ${issue.raw}`);
      console.log(`     解码: ${issue.fix}`);
    });
  }
  
  if (missingIssues.length > 0) {
    console.log('\n📋 缺失文件示例：');
    missingIssues.slice(0, 5).forEach(issue => {
      console.log(`   ${issue.file}:${issue.line}`);
      console.log(`     链接: ${issue.decoded}`);
    });
  }
  
  // 修复编码问题
  if (APPLY && encodingIssues.length > 0) {
    console.log('\n🔧 修复编码问题...');
    
    const fileGroups = {};
    encodingIssues.forEach(issue => {
      if (!fileGroups[issue.file]) {
        fileGroups[issue.file] = [];
      }
      fileGroups[issue.file].push(issue);
    });
    
    let fixedCount = 0;
    
    Object.entries(fileGroups).forEach(([file, issues]) => {
      const fullPath = path.join(ROOT, file);
      let content = fs.readFileSync(fullPath, 'utf8');
      
      issues.forEach(issue => {
        // 替换编码后的链接为解码后的链接
        content = content.replace(issue.raw, issue.fix);
        fixedCount++;
      });
      
      fs.writeFileSync(fullPath, content, 'utf8');
      console.log(`   ✅ 修复: ${file} (${issues.length} 个链接)`);
    });
    
    console.log(`\n✅ 共修复 ${fixedCount} 个编码问题`);
  }
  
  return issues.length;
}

const issues = main();
process.exit(issues > 0 ? 1 : 0);
