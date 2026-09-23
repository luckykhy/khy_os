#!/usr/bin/env node
/**
 * check-unbypassable-gate.js — SECURITY-002 critical gate 不可绕过。
 *
 * 规则真源 docs/10_规范/registry/RULES-REGISTRY.json 的 SECURITY-002：不可逆操作或显式
 * critical，即便 KHY_SYSCALL_GATEWAY=off、即便 bypass/yolo，也不得绕过。
 *
 * 载体 services/backend/src/services/riskGate.js 的 isUnbypassableGate() 是这条
 * 红线的单一真源（permission gate 与 gateway L1 预授权都读它），且是纯函数 ——
 * 所以本检查器做**行为断言**而非文本扫描：改文本可能绕过正则，改行为才等于改语义。
 *
 * 四条断言：
 *   1. 不可逆样本必须判为不可绕过（红线本体）
 *   2. 安全样本必须**不**判为不可绕过（精度回归会让自主模式寸步难行）
 *   3. 判定与 KHY_SYSCALL_GATEWAY / KHY_PERMISSION_MODE 无关（规则的字面要求）
 *   4. 非 human-gate 的步骤类型必须返回 false（不得误伤 hardened/flexible）
 *
 * 用法：
 *   node scripts/ci/check-unbypassable-gate.js
 *   node scripts/ci/check-unbypassable-gate.js --strict-warnings
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RULE_ID = 'SECURITY-002';
const MODULE_REL = 'services/backend/src/services/riskGate.js';
const cwd = process.cwd();
const args = process.argv.slice(2);
const strictWarnings = args.includes('--strict-warnings');

const findings = [];
const add = (severity, id, relFile, line, message) =>
  findings.push({ severity, id, file: relFile, line, message });

const moduleAbs = path.join(cwd, MODULE_REL);
const moduleText = fs.existsSync(moduleAbs) ? fs.readFileSync(moduleAbs, 'utf8') : null;

const lineOf = (needle) => {
  if (!moduleText) return 1;
  const i = moduleText.indexOf(needle);
  return i === -1 ? 1 : moduleText.slice(0, i).split('\n').length;
};

if (moduleText === null) {
  add('error', 'gate-module-missing', MODULE_REL, 1,
    `载体 ${MODULE_REL} 不存在：SECURITY-002 的单一真源缺失，不可绕过红线无从校验。`);
} else {
  const gate = require(path.resolve(cwd, MODULE_REL));
  if (typeof gate.isUnbypassableGate !== 'function' || typeof gate.assess !== 'function') {
    add('error', 'gate-api-missing', MODULE_REL, lineOf('isUnbypassableGate'),
      'riskGate 未导出 isUnbypassableGate / assess：调用方无法引用不可绕过判定，红线失效。');
  } else {
    // ── 1. 不可逆样本必须不可绕过 ──────────────────────────────────────
    // 样本取 shell 形态：本载体判定的是 shell 命令风险，纯 Python 源码不是它的输入。
    const DESTRUCTIVE = [
      'rm -rf /',
      'rm -rf ~',
      'git reset --hard HEAD~1',
      'DROP TABLE users;',
      'kill -9 1234',
      'dd if=/dev/zero of=/dev/sda',
      'chmod -R 777 /',
    ];
    for (const command of DESTRUCTIVE) {
      const assessment = gate.assess('shellCommand', { command });
      if (!gate.isUnbypassableGate(assessment)) {
        add('error', 'gate-destructive-bypassable', MODULE_REL, lineOf('function isUnbypassableGate'),
          `不可逆命令「${command}」被判为可绕过（risk=${assessment.riskLevel}, `
          + `step=${assessment.stepType}, destructive=${assessment.isDestructive}）：`
          + '违反 SECURITY-002，bypass/yolo 会静默批准数据丢失。');
      }
    }

    // ── 1b. 已知分类盲区：这些不可逆形态被判成非 destructive ───────────
    // 这是 commandRiskClassifier 的启发式覆盖缺口，不是 isUnbypassableGate 的
    // 逻辑错误，故按 warning 记录不阻断；列出是为让缺口可见、可登记基线。
    const KNOWN_GAPS = [
      'python -c "import shutil; shutil.rmtree(\'/etc\')"',
      'python3 -c "import os; os.remove(\'/etc/passwd\')"',
      'find / -delete',
    ];
    for (const command of KNOWN_GAPS) {
      const assessment = gate.assess('shellCommand', { command });
      if (!gate.isUnbypassableGate(assessment)) {
        add('warn', 'gate-classifier-gap', MODULE_REL, lineOf('function isUnbypassableGate'),
          `不可逆形态「${command}」分类为 risk=${assessment.riskLevel}、destructive=${assessment.isDestructive}，`
          + '未触发不可绕过：bypass/yolo 下可静默执行。属分类器覆盖缺口，建议扩充 commandRiskClassifier。');
      }
    }

    // ── 2. 安全样本不得被判不可绕过（精度）────────────────────────────
    const SAFE = ['echo hello', 'ls -la', 'node --version', 'git status', 'pwd'];
    for (const command of SAFE) {
      const assessment = gate.assess('shellCommand', { command });
      if (gate.isUnbypassableGate(assessment)) {
        add('warn', 'gate-safe-nagged', MODULE_REL, lineOf('function isUnbypassableGate'),
          `安全命令「${command}」被判为不可绕过（risk=${assessment.riskLevel}）：`
          + '精度回归会让自主模式对每条命令都弹窗。');
      }
    }

    // ── 3. 判定与旁路环境无关 ─────────────────────────────────────────
    const BYPASS_ENVS = [
      { KHY_SYSCALL_GATEWAY: 'off', KHY_PERMISSION_MODE: '' },
      { KHY_SYSCALL_GATEWAY: '', KHY_PERMISSION_MODE: 'bypass' },
      { KHY_SYSCALL_GATEWAY: 'off', KHY_PERMISSION_MODE: 'bypass' },
      { KHY_SYSCALL_GATEWAY: 'off', KHY_PERMISSION_MODE: 'yolo' },
    ];
    const probe = `
      const g = require(${JSON.stringify(path.resolve(cwd, MODULE_REL))});
      const a = g.assess('shellCommand', { command: 'rm -rf /' });
      process.stdout.write(g.isUnbypassableGate(a) ? 'UNBYPASSABLE' : 'BYPASSED');
    `;
    for (const override of BYPASS_ENVS) {
      const env = { ...process.env, KHY_SYSCALL_GATEWAY: '', KHY_PERMISSION_MODE: '' };
      for (const [k, v] of Object.entries(override)) if (v) env[k] = v;
      const run = spawnSync(process.execPath, ['-e', probe], { cwd, env, encoding: 'utf8' });
      const label = Object.entries(override).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ');
      if (run.error) {
        add('error', 'gate-env-probe-failed', MODULE_REL, lineOf('function isUnbypassableGate'),
          `旁路环境探针（${label}）执行失败：${run.error.message}。无法证明该环境下红线仍生效。`);
        continue;
      }
      const verdict = String(run.stdout || '').trim();
      if (verdict !== 'UNBYPASSABLE') {
        add('error', 'gate-env-dependent', MODULE_REL, lineOf('function isUnbypassableGate'),
          `旁路环境 ${label || '<空>'} 下「rm -rf /」判定为 ${verdict || '(空)'}：`
          + 'KHY_SYSCALL_GATEWAY 或权限档改变了不可绕过判定，违反 SECURITY-002。');
      }
    }

    // ── 4. 非 human-gate 步骤类型必须返回 false ───────────────────────
    for (const stepType of ['hardened', 'flexible', undefined, null]) {
      if (gate.isUnbypassableGate({ stepType, riskLevel: 'critical', isDestructive: true })) {
        add('error', 'gate-non-human-passes', MODULE_REL, lineOf('function isUnbypassableGate'),
          `stepType=${String(stepType)} 被判为不可绕过：该函数应只对 human-gate 生效，`
          + '否则 hardened/flexible 步骤会全部弹窗。');
      }
    }

    // 关键路径反向断言：critical 与 destructive 两条独立通道都必须是 true。
    for (const assessment of [
      { stepType: 'human-gate', riskLevel: 'critical', isDestructive: false },
      { stepType: 'human-gate', riskLevel: 'high', isDestructive: true },
    ]) {
      if (!gate.isUnbypassableGate(assessment)) {
        add('error', 'gate-channel-broken', MODULE_REL, lineOf('function isUnbypassableGate'),
          `assessment ${JSON.stringify(assessment)} 被判为可绕过：`
          + 'critical 与 isDestructive 是两条独立触发通道，任一失效都留漏洞。');
      }
    }
  }
}

findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const errors = findings.filter((f) => f.severity === 'error');
const warns = findings.filter((f) => f.severity === 'warn');

console.log(`check-unbypassable-gate: ${RULE_ID} critical gate 不可绕过`);
console.log(`载体: ${MODULE_REL}（行为断言，非文本扫描）`);

for (const f of findings) {
  const tag = f.severity === 'error' ? 'ERROR' : 'WARN ';
  console.log(`[${tag}] ${f.id} ${f.file}:${f.line}`);
  console.log(`  ${f.message}`);
}

console.log(`\nSummary: ${errors.length} error(s), ${warns.length} warning(s).`);
process.exitCode = errors.length || (strictWarnings && warns.length) ? 1 : 0;
