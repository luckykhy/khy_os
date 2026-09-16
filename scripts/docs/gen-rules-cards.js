#!/usr/bin/env node
/**
 * gen-rules-cards.js — 从 RULES-REGISTRY.json 生成逐条规则卡（[MGMT-STD-008] §1）。
 *
 * 定位：规则卡是**构建产物**，不是手工维护文件——与 `.html` 孪生件同档
 * （[MGMT-STD-007] R6「禁止手改 `.html`，只改源 `.md`」）。
 *
 * 为什么要生成而不是手写 43 份：
 *   元规则 §1 要求「每条规则必须是一张规则卡」，§5 却明确登记表是**规则族级**、
 *   `ssot` 指向族正文，理由是「避免两套真源互相漂移」。手写规则卡等于把
 *   constraint / grants / benefit / exception 再抄一遍，正是 §5 要避免的
 *   重复。因此裁决为：**登记表是唯一字段真源，规则卡由其渲染**；卡片的
 *   六小节里「约束/授予权力/提供福利/例外」是 frontmatter 字段的人类可读渲染，
 *   「反例/校验方式」来自治理总纲 §3 表格与下方 ENRICH 表。
 *
 * 校验：`node scripts/ci/check-rules-registry.js` 重生成后比对
 * `git diff --exit-code docs/_规范/规则卡/`，与 CODEOWNERS 的同款棘轮。
 *
 * Usage: node scripts/docs/gen-rules-cards.js [--check]
 *        --check 只比对不落盘，产物不一致时 exit 1（CI 用）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_REL = 'docs/_规范/RULES-REGISTRY.json';
const GOV_REL = 'docs/03_DESIGN_设计/[DESIGN-ARCH-070] 治理总纲与可执行规则.md';
const OUT_DIR_REL = 'docs/_规范/规则卡';
const INDEX_REL = '00_INDEX_规则卡总目录.md';
const CHECK_ONLY = process.argv.includes('--check');
const TODAY = '2026-09-15';

// 元规则 §1.1 必填字段（formerly 为选填但保留可溯源，故一并渲染）
const FRONTMATTER_FIELDS = [
  'name', 'id', 'domain', 'nature', 'scope', 'priority', 'trigger',
  'constraint', 'grants', 'benefit', 'exception', 'version', 'status',
  'ssot', 'formerly', 'owner', 'enforcement',
];
const REQUIRED = FRONTMATTER_FIELDS.filter((f) => f !== 'enforcement');

// 登记表没有「反例 / 校验方式」字段，治理总纲 §3 只覆盖 GOV-* 板块的
// 26 条。以下 17 条是手工维护的唯一补全来源：内容取自各规则真源原文
// （AGENTS.md 工程规则 1–4、CLAUDE.md 红线 R1–R4、元规则 §6 示例）。
const ENRICH = {
  'LAYOUT-002': {
    counter: '单个文件长到 2500 行以上仍继续往里加功能，而不是按 god-file governance 拆分。',
    verify: '`npm run arch:god --workspace services/backend`（阈值真源 `projectHygiene/thresholds.js` 的 `godFileLoc()`）',
  },
  'RUNTIME-001': {
    counter: '❌ 业务代码里写死后端端点 `fetch("http://<host>:<port>/api")` → ✅ 从 `VITE_BACKEND_HOST` / `VITE_BACKEND_PORT` 读取',
    verify: '`node scripts/ci/check-agent-rules.js --changed`；`grep -rn "localhost:[0-9]" --include="*.js" --include="*.vue" --include="*.ts"`',
  },
  'RUNTIME-002': {
    counter: '❌ `正在工作…` / `Loading…` → ✅ `解析 AST (已处理 340/1200 节点)…`',
    verify: '`node scripts/ci/check-agent-rules.js --changed`（generic-status 检查）',
  },
  'RUNTIME-003': {
    counter: '❌ `const start = Date.now(); if (Date.now() - start > 120_000) kill()` → ✅ 每次产出事件重置 `lastActivity`，仅在空闲超限时触发',
    verify: '`node scripts/ci/check-agent-rules.js --changed`（hard-timeout 检查）+ 人工评审',
  },
  'RUNTIME-004': {
    counter: '❌ `\\x1B[1;{rows-1}r`（DECSTBM 滚动区，丢弃越界内容、杀死回滚）→ ✅ `\\x1B7` 保存光标 + 绝对定位 + `\\x1B[K` 清行 + `\\x1B8` 恢复',
    verify: '`node scripts/ci/check-agent-rules.js --changed`（scroll-region 检查 DECSTBM）',
  },
  'PROCESS-001': {
    counter: 'AI 在无人点头的情况下直接 `git commit` / `git push`；或在主干上直接开发。',
    verify: '人工评审 + 分支保护基线 `[OPS-MAN-009]`；`git log` 提交者审计',
  },
  'PROCESS-002': {
    counter: '只改 `pyproject.toml` 就发布，`services/backend/package.json` 仍是旧版本。',
    verify: '`node scripts/ci/check-version-sync.js`（三轨道 9 源，真源即该脚本的 `specs` 数组）',
  },
  'PROCESS-003': {
    counter: '改了代码没跑任何验证就说「修好了」。',
    verify: '`CLAUDE.md` §三 验收门禁命令清单（`node --check`、三守卫、`arch:god`、映射表覆盖）+ 人工核对',
  },
  'PROCESS-101': {
    counter: '❌ 在 issue 里口头讨论「要不要加条规则」却不落卡 → ✅ 直接 `npm run rules:scaffold PROCESS` 起草草案提 PR',
    verify: '`node scripts/ci/check-gov-rules.js`（字段齐全 + 查重）+ PR 评审',
  },
  'SECURITY-001': {
    counter: '真实 API key 提交进仓库，或写进 `.env` 之外的配置文件后落盘。',
    verify: '`node scripts/ci/check-change-safety.js --changed --promote=sensitive-paths` + PR diff 密钥扫描',
  },
  'SECURITY-002': {
    counter: '以 `yolo` / bypass 绕过 `rm`、`drop table` 等不可逆操作的 critical gate。',
    verify: '`riskGate.isUnbypassableGate` 代码路径 + 人工评审（无机械守卫）',
  },
  'SECURITY-003': {
    counter: '弱档模型直接修改 `.env` / 发布链路 / 权限核心等 red-line 文件。',
    verify: '`weakModelChangeGuard.assessWeakModelChange` + 人工评审（无机械守卫）',
  },
  'SECURITY-004': {
    counter: 'allow 规则覆盖了 deny，或 `dontAsk` 档放行了未显式 allow 的工具。',
    verify: '`permissionStore.js` 的 `VALID_PROFILES` + `permissions/rules.js` 的 deny 优先逻辑 + 人工评审',
  },
  'DOCS-001': {
    counter: '裸名文档（如 `BORROWINGS.md`、`SPLIT-PLAN.md`）；落文档不更新两级索引。',
    verify: '`npm run check:layout` 的 `docs-index-first` / `docs-index-complete`；`npm run docs:verify`',
  },
  'DOCS-002': {
    counter: '在规范里写死 `00_INDEX_*` 的具体命名形态，导致每次新增目录都要改规范。',
    verify: '人工评审（[MGMT-STD-001] §2.3 追加的管辖边界条款）',
  },
  'MGMT-STD-008': {
    counter: '规则卡缺 `grants` / `benefit`（只写约束）；两条规则 ID 重复；授予权力却无 `scope` / `constraint` 边界。',
    verify: '`node scripts/ci/check-gov-rules.js` 的 GOV-TOOL-006',
  },
  'TOOLING-007': {
    counter: '登记表改了 ID 但真源文档未标 ID（反向查不到）；真源标了未登记的 `RULES-REGISTRY: X-999`。',
    verify: '`node scripts/ci/check-rules-registry.js`（根入口 `check:rules`，已纳入 `check:structure` 与 PR gate）',
  },
};

/** 解析治理总纲 §3 各板块表格，返回 Map<GOV-ID, { counter, verify }>。 */
function parseGovernanceRows() {
  const text = fs.readFileSync(path.join(ROOT, GOV_REL), 'utf8');
  const rows = new Map();
  for (const line of text.split('\n')) {
    if (!line.startsWith('| GOV-')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length >= 5) rows.set(cells[0], { counter: cells[3], verify: cells[4] });
  }
  return rows;
}

/** 由 `formerly` 里的 GOV-* 编号回连治理总纲的「反例 / 校验方式」列。 */
function lookup(rule, govRows) {
  if (ENRICH[rule.id]) return ENRICH[rule.id];
  const match = /^GOV-[A-Z]+-\d{3}/.exec(String(rule.formerly || ''));
  if (match && govRows.has(match[0])) {
    const row = govRows.get(match[0]);
    return { counter: row.counter, verify: row.verify };
  }
  return {
    counter: '见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。',
    verify: '人工评审（该规则暂无机械守卫）',
  };
}

/** YAML 标量：含 `:` `#` `"` 或方括号开头时加引号并转义内部双引号。 */
function yamlScalar(value) {
  const s = String(value);
  if (/^[A-Za-z0-9一-鿿][A-Za-z0-9一-鿿 /·—()（）,，。．&-]*$/.test(s)) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function renderFrontmatter(rule) {
  const lines = ['---'];
  for (const field of FRONTMATTER_FIELDS) {
    if (!(field in rule) || rule[field] === null) continue;
    lines.push(`${field}: ${yamlScalar(rule[field])}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function renderCard(rule, govRows) {
  const { counter, verify } = lookup(rule, govRows);
  const formerly = rule.formerly === null || rule.formerly === undefined
    ? '无' : String(rule.formerly);
  const body = [
    renderFrontmatter(rule),
    '',
    `# [${rule.id}] ${rule.name}`,
    '',
    `<!-- RULES-REGISTRY: ${rule.id} -->`,
    '',
    `> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。`,
    `>`,
    `> **字段真源**是 \`docs/_规范/RULES-REGISTRY.json\`（GOV-TOOL-006 校验），`,
    `> 本文件由 \`node scripts/docs/gen-rules-cards.js\` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。`,
    `> 正文原文在 \`ssot\` 指向的位置：${rule.ssot || '（未登记）'}。`,
    '',
    `## 约束`,
    '',
    rule.constraint,
    '',
    `## 授予权力`,
    '',
    rule.grants,
    '',
    `## 提供福利`,
    '',
    rule.benefit,
    '',
    `## 反例`,
    '',
    counter,
    '',
    `## 校验方式`,
    '',
    verify,
    '',
    `## 例外`,
    '',
    rule.exception || '无',
    '',
    `## 版本记录`,
    '',
    `- ${rule.version} 初版 / 迁移自 ${formerly}`,
    '',
  ];
  return body.join('\n');
}

function renderIndex(rules) {
  const byDomain = new Map();
  for (const rule of rules) {
    if (!byDomain.has(rule.domain)) byDomain.set(rule.domain, []);
    byDomain.get(rule.domain).push(rule);
  }
  const rows = [];
  for (const domain of [...byDomain.keys()].sort()) {
    for (const rule of byDomain.get(domain).sort((a, b) => a.id.localeCompare(b.id))) {
      rows.push(`| [${rule.id}] ${rule.name}.md | ${rule.name} | ${rule.priority} / ${rule.status} |`);
    }
  }
  return [
    '# 00_INDEX 规则卡总目录',
    '',
    '> **索引总领文件** · 本目录唯一入口 · 排序首位 · 结构遵循 [MGMT-STD-001] 第三章',
    '>',
    `> 逐条规则卡，格式依据 [MGMT-STD-008] §1。共 ${rules.length} 张，覆盖 §3.1 十大域。`,
    '>',
    '> **本目录全部文件由 `node scripts/docs/gen-rules-cards.js` 生成，禁止手改。**',
    '> 字段真源是 `docs/_规范/RULES-REGISTRY.json`；正文原文在各卡 `ssot` 指向的位置。',
    '',
    '## 一、分类内容边界',
    '',
    '收：每条登记规则一张卡（frontmatter 14 字段 + 六个固定小节）。',
    '不收：规则正文原文（留在各章程 / 规范文档，卡片只做渲染与指针）、',
    '索引类文档（本文件除外）、非登记对象的散文。',
    '',
    '## 二、文件清单',
    '',
    '| 文件名(含编号) | 核心职责(10字内) | 状态 |',
    '| --- | --- | --- |',
    ...rows,
    '',
    '## 三、跨分类关联指引',
    '',
    '- 规则格式与生命周期：`docs/08_MGMT_项目管理/[MGMT-STD-008] 规则编写与管理规范（元规则）.md`',
    '- 字段级单一真源：`docs/_规范/RULES-REGISTRY.json`',
    '- 板块入口与反例总表：`docs/03_DESIGN_设计/[DESIGN-ARCH-070] 治理总纲与可执行规则.md`',
    '- 本目录所属的 `_` 前缀轴：`docs/03_DESIGN_设计/[DESIGN-ARCH-068] 仓库层级板块规范.md` 第三节',
    '- 起草新规则：`npm run rules:scaffold -- <DOMAIN> "规则名"`',
    '',
  ].join('\n');
}

function main() {
  const registryText = fs.readFileSync(path.join(ROOT, REGISTRY_REL), 'utf8');
  const data = JSON.parse(registryText);
  const rules = (Array.isArray(data && data.rules) ? data.rules : [])
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));

  if (rules.length === 0) {
    console.error(`[rules-cards] 登记表 ${REGISTRY_REL} 无规则条目。`);
    process.exit(1);
  }

  const govRows = parseGovernanceRows();
  const missing = [];
  for (const rule of rules) {
    for (const field of REQUIRED) {
      const value = rule[field];
      if (value === undefined || value === null || String(value).trim() === '') {
        missing.push(`${rule.id} 缺 ${field}`);
      }
    }
  }
  if (missing.length > 0) {
    console.error(`[rules-cards] 登记表字段不全，先补齐再生成（GOV-TOOL-006）：`);
    for (const item of missing) console.error(`  - ${item}`);
    process.exit(1);
  }

  const outDir = path.join(ROOT, OUT_DIR_REL);
  const files = new Map();
  for (const rule of rules) {
    files.set(`[${rule.id}] ${rule.name}.md`, renderCard(rule, govRows));
  }
  files.set(INDEX_REL, renderIndex(rules));

  const enriched = Object.keys(ENRICH).length;
  const fromGov = rules.filter((r) => {
    const m = /^GOV-[A-Z]+-\d{3}/.exec(String(r.formerly || ''));
    return m && govRows.has(m[0]);
  }).length;

  let drifted = 0;
  let failed = false;
  for (const [name, content] of files) {
    const file = path.join(outDir, name);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (current === null) {
      if (CHECK_ONLY) {
        console.error(`[rules-cards] --check 缺失产物：${OUT_DIR_REL}/${name}`);
        failed = true;
      } else {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'w' });
      }
      continue;
    }
    if (current === content) continue;
    drifted += 1;
    if (CHECK_ONLY) {
      console.error(`[rules-cards] --check 产物过期：${OUT_DIR_REL}/${name}（重新运行生成器）`);
      failed = true;
    } else {
      fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'w' });
    }
  }

  if (failed) {
    console.error(`[rules-cards] 校验失败：${drifted} 份产物与登记表不一致。`);
    process.exit(1);
  }
  console.log(
    `[rules-cards] ${CHECK_ONLY ? '校验' : '生成'} ${rules.length} 张规则卡 + 1 份索引 → ${OUT_DIR_REL}/`
    + `（反例/校验方式：${fromGov} 条取自治理总纲，${enriched} 条来自 ENRICH 补全表）`
  );
}

main();
