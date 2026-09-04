#!/usr/bin/env node

'use strict';

/**
 * security-scan.js — 安全扫描器
 *
 * 检测以下安全问题：
 *   1. eval() 和 new Function() 的使用
 *   2. Math.random() 在安全敏感上下文的使用
 *   3. 空 catch 块（无注释说明）
 *   4. JSON.parse 无 try/catch 保护
 *
 * Usage: node scripts/ci/security-scan.js
 */

const fs = require('fs');
const path = require('path');

const repoRoot = process.env.KHY_REPO_LAYOUT_ROOT
  ? path.resolve(process.env.KHY_REPO_LAYOUT_ROOT)
  : path.resolve(__dirname, '..', '..');

const findings = [];

// ── 规则 1: 检测 eval() 和 new Function() ─────────────────────────────
function checkDynamicCodeExec() {
  const scanDirs = [
    'services/backend/src',
  ];
  
  const dangerousPatterns = [
    { pattern: /\beval\s*\(/, name: 'eval()' },
    { pattern: /\bnew\s+Function\s*\(/, name: 'new Function()' },
  ];
  
  for (const dir of scanDirs) {
    const fullDir = path.join(repoRoot, dir);
    if (!fs.existsSync(fullDir)) continue;
    
    const files = walkDir(fullDir);
    for (const file of files) {
      if (!file.endsWith('.js')) continue;
      
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        
        // 跳过注释
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
        
        for (const { pattern, name } of dangerousPatterns) {
          if (pattern.test(line)) {
            findings.push({
              rule: 'DYNAMIC_CODE_EXEC',
              severity: 'error',
              file: path.relative(repoRoot, file),
              line: i + 1,
              message: `检测到危险的 ${name} 调用，请使用 vm 模块替代`,
            });
          }
        }
      }
    }
  }
}

// ── 规则 2: 检测 Math.random() 在安全敏感上下文的使用 ─────────────────────
function checkMathRandomInSecureContext() {
  const scanDirs = ['services/backend/src'];
  const securePatterns = [
    /token/i,
    /secret/i,
    /password/i,
    /auth/i,
    /key/i,
    /session/i,
    /crypto/i,
    /random/i,
  ];
  
  for (const dir of scanDirs) {
    const fullDir = path.join(repoRoot, dir);
    if (!fs.existsSync(fullDir)) continue;
    
    const files = walkDir(fullDir);
    for (const file of files) {
      if (!file.endsWith('.js')) continue;
      
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        
        if (/Math\.random\s*\(/.test(line)) {
          // 检查是否在安全敏感上下文
          const context = lines.slice(Math.max(0, i - 3), i + 1).join(' ');
          const isSecureContext = securePatterns.some(p => p.test(context));
          
          if (isSecureContext) {
            findings.push({
              rule: 'MATH_RANDOM_SECURE_CONTEXT',
              severity: 'warning',
              file: path.relative(repoRoot, file),
              line: i + 1,
              message: `安全敏感上下文中使用 Math.random()，建议改用 crypto.randomBytes()`,
            });
          }
        }
      }
    }
  }
}

// ── 规则 3: 检测无注释的空 catch 块 ─────────────────────────────────────
function checkEmptyCatchBlocks() {
  const scanDirs = ['services/backend/src'];
  
  for (const dir of scanDirs) {
    const fullDir = path.join(repoRoot, dir);
    if (!fs.existsSync(fullDir)) continue;
    
    const files = walkDir(fullDir);
    for (const file of files) {
      if (!file.endsWith('.js')) continue;
      
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        
        // 检测 } catch (_) {} 或 } catch (e) {}
        if (/catch\s*\(\s*\w*\s*\)\s*\{\s*\}/.test(trimmed)) {
          // 检查是否有注释
          const prevLine = i > 0 ? lines[i - 1].trim() : '';
          if (!prevLine.includes('/*') && !prevLine.includes('//') && !trimmed.includes('/*')) {
            findings.push({
              rule: 'EMPTY_CATCH_BLOCK',
              severity: 'warning',
              file: path.relative(repoRoot, file),
              line: i + 1,
              message: `空 catch 块应添加注释说明为何忽略异常`,
            });
          }
        }
      }
    }
  }
}

// ── 规则 4: 检测 JSON.parse 无 try/catch 保护 ────────────────────────────
function checkUnsafeJsonParse() {
  const scanDirs = ['services/backend/src'];
  
  for (const dir of scanDirs) {
    const fullDir = path.join(repoRoot, dir);
    if (!fs.existsSync(fullDir)) continue;
    
    const files = walkDir(fullDir);
    for (const file of files) {
      if (!file.endsWith('.js')) continue;
      
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        
        if (/JSON\.parse\s*\(/.test(line)) {
          // 检查是否在 try/catch 中
          const context = lines.slice(Math.max(0, i - 5), i + 1).join(' ');
          if (!context.includes('try')) {
            findings.push({
              rule: 'UNSAFE_JSON_PARSE',
              severity: 'warning',
              file: path.relative(repoRoot, file),
              line: i + 1,
              message: `JSON.parse 无 try/catch 保护，建议改用 safeJsonParse`,
            });
          }
        }
      }
    }
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────
function walkDir(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'vendor' && !entry.name.startsWith('.')) {
        results.push(...walkDir(full));
      }
    } else {
      results.push(full);
    }
  }
  return results;
}

// ── 主函数 ────────────────────────────────────────────────────────────────
function main() {
  console.log('\n[security-scan] 开始安全扫描...\n');
  
  checkDynamicCodeExec();
  checkMathRandomInSecureContext();
  checkEmptyCatchBlocks();
  checkUnsafeJsonParse();
  
  if (findings.length === 0) {
    console.log('✅ 安全扫描通过，未发现问题。\n');
    return;
  }
  
  const errors = findings.filter(f => f.severity === 'error');
  const warnings = findings.filter(f => f.severity === 'warning');
  
  console.log(`❌ 发现 ${findings.length} 个安全问题：\n`);
  
  if (errors.length > 0) {
    console.log(`  Errors (${errors.length}):`);
    for (const f of errors) {
      console.log(`    [${f.rule}] ${f.file}:${f.line} - ${f.message}`);
    }
    console.log('');
  }
  
  if (warnings.length > 0) {
    console.log(`  Warnings (${warnings.length}):`);
    for (const f of warnings) {
      console.log(`    [${f.rule}] ${f.file}:${f.line} - ${f.message}`);
    }
    console.log('');
  }
  
  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

main();
