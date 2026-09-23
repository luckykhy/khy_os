#!/usr/bin/env node
'use strict';

/**
 * rules-scaffold.js — 生成带 [MGMT-STD-008] §1.1 全字段的规则卡骨架。
 *
 * 兑现元规则 §4.6 第 1 条「模板即福利」：不必手查字段清单与命名规约，
 * 一条命令产出骨架，填正文即可提 PR。
 *
 * Usage:
 *   node scripts/docs/rules-scaffold.js <DOMAIN> ["规则中文名"]
 *   node scripts/docs/rules-scaffold.js RUNTIME "新加限流规则"
 *
 * 领域清单（[MGMT-STD-008] §3.1）：LAYOUT RUNTIME COMMS API TOOLING
 * MEMORY SOURCING PROCESS SECURITY DOCS
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY = path.join(ROOT, 'docs', '10_规范', 'registry', 'RULES-REGISTRY.json');
const OUT_DIR = path.join(ROOT, 'docs', '10_规范', '其它规范');

const DOMAINS = ['LAYOUT', 'RUNTIME', 'COMMS', 'API', 'TOOLING', 'MEMORY', 'SOURCING', 'PROCESS', 'SECURITY', 'DOCS'];

const DOMAIN_HINT = {
  LAYOUT: '目录层级 / 依赖方向 / 根白名单 / 任务入口命名 / 文件规模',
  RUNTIME: '硬编码 / 状态文本 / 超时 / 终端渲染',
  COMMS: 'ACP / 消息信封 / trace / 终态 / 错误码',
  API: '内外 API 边界 / 统一信封 / 版本弃用',
  TOOLING: 'Skill / MCP / 扩展登记 / 最小权限 / 升级废弃',
  MEMORY: '读写入口 / 生命周期 / session 与 persistent 区分',
  SOURCING: '借鉴范围 / 实现唯一性 / 能力域归属',
  PROCESS: '分支 / 提交 / 发布 / 评审 / 版本同步',
  SECURITY: '密钥存储 / 权限档 / critical gate / 弱模型护栏',
  DOCS: '命名 / 编号 / 孪生件 / 索引 / 规则卡格式',
};

const DOMAIN_TPL = {
  LAYOUT: '新增文件 / 目录时',
  RUNTIME: '运行时执行到相关路径时',
  COMMS: '消息跨协议边界时',
  API: '新增或变更公开 API 时',
  TOOLING: '注册新工具或扩展时',
  MEMORY: '写入记忆记录时',
  SOURCING: '从外部项目引入实现前',
  PROCESS: '提交或发布前',
  SECURITY: '处理凭据或裁决权限时',
  DOCS: '新增或修改文档时',
};

const PRIORITY_TPL = {
  LAYOUT: 'P1', RUNTIME: 'P1', COMMS: 'P1', API: 'P1', TOOLING: 'P2',
  MEMORY: 'P2', SOURCING: 'P0', PROCESS: 'P1', SECURITY: 'P0', DOCS: 'P2',
};

const ownerFor = (domain) => {
  if (domain === 'LAYOUT' || domain === 'SOURCING') return 'architecture-team';
  if (domain === 'COMMS') return 'protocol-team';
  if (domain === 'PROCESS' || domain === 'SECURITY' || domain === 'DOCS') return 'governance-team';
  return 'backend-team';
};

function slugify(name) {
  return String(name || '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function nextId(domain) {
  let max = 0;
  if (fs.existsSync(REGISTRY)) {
    try {
      const data = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
      for (const rule of data.rules || []) {
        const m = /^([A-Z0-9]+(?:-[A-Z0-9]+)*)-(\d{3})$/.exec(String(rule.id || ''));
        if (!m || m[1] !== domain) continue;
        const n = parseInt(m[2], 10);
        if (n > max) max = n;
      }
    } catch (err) {
      console.warn(`  警告：读取 ${path.relative(ROOT, REGISTRY)} 失败（${err.message}），按 001 起始`);
    }
  }
  return `${domain}-${String(max + 1).padStart(3, '0')}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function render(id, name, domain) {
  const num = id.split('-').pop();
  const todayStr = today();
  const owner = ownerFor(domain);
  return `---
name: ${name}
id: ${id}
domain: ${domain}
nature: 约束为主，兼权力与福利
scope: "<在此填写 glob 或枚举；越具体越好>"
priority: ${PRIORITY_TPL[domain]}
trigger: ${DOMAIN_TPL[domain]}
constraint: "<要做什么 / 禁止做什么；必须可量化、可校验>"
grants: "<本条赋予谁、在什么条件下的行动资格；纯约束写「见约束边界」>"
benefit: "<本条如何降低决策成本 / 给出明确做事方向；纯约束写「见正文」>"
exception: "<豁免情形 + 理由；无则写「无」>"
version: "1.0.0 (${todayStr})"
status: draft
ssot: "<语义权威位置：文件#锚点 或 代码路径>"
owner: ${owner}
formerly: 无
---

# [${id}] ${name}

> **域**：${domain}（${DOMAIN_HINT[domain]}）
> **状态**：draft — 提 PR 前必须填全三元字段，并在 \`docs/10_规范/registry/RULES-REGISTRY.json\` 查重登记。
> **元规则**：\`[MGMT-STD-008] 规则编写与管理规范（元规则）\` §1 规则卡格式。

## 约束

（逐条可校验地写出要做什么 / 禁止什么）

## 授予权力

（本条赋予谁、何种条件下的行动资格；纯约束写「见约束边界」）

## 提供福利

（本条如何降低决策成本 / 给出明确做事方向；纯约束写「见正文」）

## 反例

\`\`\`
// 违反的样子
\`\`\`

\`\`\`
// 正确写法
\`\`\`

## 校验方式

\`node scripts/ci/check-gov-rules.js\`（GOV-TOOL-006：字段齐全 + ID 唯一 + 权力-约束配对）
\`node scripts/ci/check-agent-rules.js --changed\`（涉 RUNTIME 时）

## 例外

（豁免清单 + 理由；无则写「无」）

## 版本记录

- 1.0.0 (${todayStr}) 初版（骨架由 \`rules:scaffold\` 生成，编号 ${num} 取自登记表现有最大号 +1）
`;
}

function register(ruleId, ruleName, domain, fileName) {
  if (!fs.existsSync(REGISTRY)) {
    return { registered: false, note: '登记表不存在，跳过登记' };
  }
  const data = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const rules = Array.isArray(data.rules) ? data.rules : [];
  if (rules.some((r) => r.id === ruleId)) {
    return { registered: false, note: `ID ${ruleId} 已存在，跳过登记（编号复用被禁止）` };
  }
  rules.push({
    id: ruleId,
    name: ruleName,
    domain,
    nature: '约束为主，兼权力与福利',
    scope: '（待填写）',
    priority: PRIORITY_TPL[domain],
    status: 'draft',
    trigger: DOMAIN_TPL[domain],
    constraint: '（待填写：可量化、可校验）',
    grants: '见约束边界',
    benefit: '（待填写）',
    exception: '无',
    version: `1.0.0 (${today()})`,
    ssot: `docs/10_规范/${fileName}`,
    owner: ownerFor(domain),
    formerly: null,
  });
  data.rules = rules;
  if (data.meta) {
    data.meta.version = '2.1.0';
    data.meta.updated = today();
    data.meta.ruleCount = rules.length;
  }
  fs.writeFileSync(REGISTRY, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return { registered: true, count: rules.length };
}

function main() {
  const domainArg = (process.argv[2] || '').toUpperCase();
  if (!DOMAINS.includes(domainArg)) {
    console.log(`用法：node scripts/docs/rules-scaffold.js <DOMAIN> [规则中文名]`);
    console.log(`\n可选 DOMAIN：${DOMAINS.join(' ')}`);
    console.log('\n领域职责：');
    for (const d of DOMAINS) console.log(`  ${d.padEnd(10)} ${DOMAIN_HINT[d]}`);
    process.exit(2);
  }

  const nameArg = (process.argv[3] || '').trim();
  if (!nameArg) {
    console.error(`缺少规则中文名：node scripts/docs/rules-scaffold.js ${domainArg} "<规则名>"`);
    process.exit(2);
  }

  const id = nextId(domainArg);
  const slug = slugify(nameArg);
  const fileName = `${id}${slug ? '-' + slug : ''}.md`;
  const outPath = path.join(OUT_DIR, fileName);

  if (fs.existsSync(outPath)) {
    console.error(`已存在，拒绝覆盖：${path.relative(ROOT, outPath)}`);
    process.exit(1);
  }

  const body = render(id, nameArg, domainArg);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, body, 'utf8');
  console.log(`已生成规则卡：${path.relative(ROOT, outPath)}（ID ${id}，domain ${domainArg}）`);

  const reg = register(id, nameArg, domainArg, fileName);
  if (reg.registered) {
    console.log(`已登记进 RULES-REGISTRY.json（status=draft，现有 ${reg.count} 条）`);
  } else {
    console.log(`登记表：${reg.note}`);
  }

  console.log('\n下一步：');
  console.log('  1. 填全正文六个小节 + frontmatter 的 scope/constraint/grants/benefit/exception/ssot');
  console.log('  2. node scripts/ci/check-gov-rules.js        # 字段齐全 + 幂律配对');
  console.log('  3. npm run docs:build && npm run docs:verify # 孪生件 + 死链');
  console.log('  4. 同步两处索引：docs/10_规范/00_INDEX_*.md 与 docs/00_INDEX_文档索引.md');
  console.log('  5. PR 合并后置 status=active（元规则 §4.2）');
}

main();
