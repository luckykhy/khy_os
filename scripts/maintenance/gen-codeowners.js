#!/usr/bin/env node
'use strict';

/**
 * gen-codeowners.js — 从「维护映射表 + 维护者名册」生成 .github/CODEOWNERS。
 *
 * 为什么存在
 * ----------
 * .github/CODEOWNERS 此前是 581 条规则、50KB，全部 owner 写作 `@<area-id>` 占位符。
 * GitHub 对无效 owner 的处理是**静默忽略**：文件看起来很完整，实际一条都不生效，
 * 开启「Require review from Code Owners」也不会向任何人请求评审。
 * 同时原文件头注明「the first matching pattern takes precedence」，与 GitHub 的实际
 * 行为相反 —— CODEOWNERS 是**最后匹配者优先**。这一点在本仓库不是学术问题：
 * 581 条规则覆盖 481 个唯一路径，有 25 个路径被多个 area 重复声明
 * （services/backend/src/services/gateway/aiGateway.js 被声明 9 次），
 * 一旦填入真实用户名，归属会解析成与注释相反的结果。
 *
 * 因此改为生成式：
 *   docs/_维护者/维护映射表.json   →  area 的 id / label / paths（已存在的真源）
 *   .github/maintainers.json      →  area id → GitHub 账号（本次新增，需人工填写）
 *   .github/CODEOWNERS            →  生成产物，不要手改
 *
 * 未分配维护者的 area **不会**产出规则 —— 宁可让全局兜底 owner 接管，也不要写入
 * 一条被 GitHub 丢弃的无效规则。名册填一个，CODEOWNERS 就多生效一条，可逐步推进。
 *
 * 零依赖（纯 fs/path），node 直跑。只写上述两个文件，绝不联网。
 *
 * 用法：
 *   node scripts/maintenance/gen-codeowners.js                  # 生成 .github/CODEOWNERS
 *   node scripts/maintenance/gen-codeowners.js --check          # 校验产物与真源一致（CI 用）
 *   node scripts/maintenance/gen-codeowners.js --sync-roster    # 把新增/移除的 area 同步进名册
 *   node scripts/maintenance/gen-codeowners.js --dry-run        # 只打印，不写盘
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MAP = path.join(ROOT, 'docs', '_维护者', '维护映射表.json');
const ROSTER = path.join(ROOT, '.github', 'maintainers.json');
const OUT = path.join(ROOT, '.github', 'CODEOWNERS');

// GitHub 承认的 owner 形态：@user、@org/team、邮箱。其余（含 @<area-id> 占位符）一律拒绝。
const OWNER_RE = /^(@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9._-]+)?|[^@\s]+@[^@\s]+\.[^@\s]+)$/;

// CODEOWNERS 的 pattern 不支持空格转义，带空格的路径永远匹配不到。
const PATTERN_INVALID_RE = /\s/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function loadAreas() {
  const map = readJson(MAP);
  if (!Array.isArray(map.areas)) {
    throw new Error(`${path.relative(ROOT, MAP)} 缺少 areas 数组`);
  }
  return map.areas;
}

/** 名册不存在时给出一份仅含兜底 owner 的骨架，避免首次运行直接报错。 */
function loadRoster() {
  if (!fs.existsSync(ROSTER)) {
    return { defaultOwners: [], areaOwners: {} };
  }
  const r = readJson(ROSTER);
  return {
    defaultOwners: Array.isArray(r.defaultOwners) ? r.defaultOwners : [],
    areaOwners: r.areaOwners && typeof r.areaOwners === 'object' ? r.areaOwners : {},
  };
}

/**
 * 生成 CODEOWNERS 全文。
 * @returns {{ text: string, warnings: string[], stats: object }}
 */
function build(areas, roster) {
  const warnings = [];
  const lines = [];

  const badDefault = roster.defaultOwners.filter((o) => !OWNER_RE.test(o));
  if (badDefault.length) {
    warnings.push(`defaultOwners 中的无效 owner（GitHub 会静默忽略）：${badDefault.join(' ')}`);
  }

  lines.push('# 本文件由 scripts/maintenance/gen-codeowners.js 生成，请不要手改。');
  lines.push('# 要调整归属：编辑 .github/maintainers.json，然后重跑');
  lines.push('#   node scripts/maintenance/gen-codeowners.js');
  lines.push('#');
  lines.push('# 真源：docs/_维护者/维护映射表.json（area 的 label 与 paths）');
  lines.push('#       .github/maintainers.json（area → GitHub 账号）');
  lines.push('#');
  lines.push('# 优先级：CODEOWNERS 是**最后匹配者优先**（不是最先）。因此全局兜底规则');
  lines.push('# 必须写在最前面，越具体的规则越靠后。');
  lines.push('');

  if (roster.defaultOwners.length) {
    lines.push('# 全局兜底：未被下方任何具体规则命中的文件由这些人评审。');
    lines.push(`* ${roster.defaultOwners.join(' ')}`);
    lines.push('');
  } else {
    warnings.push('defaultOwners 为空 —— 没有任何全局兜底 owner，未分配区域的改动不会请求评审。');
  }

  // path → 最后一个声明它的 area，用于暴露「被多个 area 抢占」的路径。
  const claimedBy = new Map();
  let ruleCount = 0;
  let ownedAreas = 0;
  const skippedPatterns = [];

  for (const area of areas) {
    const owners = roster.areaOwners[area.id];
    if (!Array.isArray(owners) || owners.length === 0) continue;

    const bad = owners.filter((o) => !OWNER_RE.test(o));
    if (bad.length) {
      warnings.push(`area "${area.id}" 含无效 owner（已跳过整个 area）：${bad.join(' ')}`);
      continue;
    }

    const paths = (area.paths || []).filter((p) => {
      if (PATTERN_INVALID_RE.test(p)) {
        skippedPatterns.push(`${area.id}: ${p}`);
        return false;
      }
      return true;
    });
    if (paths.length === 0) continue;

    ownedAreas += 1;
    lines.push(`# [${area.id}] ${area.label || ''}`.trimEnd());
    for (const p of paths) {
      const prev = claimedBy.get(p);
      if (prev && prev !== area.id) {
        warnings.push(`路径被多个 area 声明，按 last-match-wins 归属 "${area.id}"（"${prev}" 失效）：${p}`);
      }
      claimedBy.set(p, area.id);
      lines.push(`${p} ${owners.join(' ')}`);
      ruleCount += 1;
    }
    lines.push('');
  }

  if (skippedPatterns.length) {
    warnings.push(
      `${skippedPatterns.length} 条路径含空格，CODEOWNERS pattern 无法匹配，已跳过：\n  ` +
        skippedPatterns.slice(0, 5).join('\n  ')
    );
  }

  const unassigned = areas.filter((a) => {
    const o = roster.areaOwners[a.id];
    return !Array.isArray(o) || o.length === 0;
  });

  lines.push('# ─────────────────────────────────────────────────────────────────────────');
  lines.push(`# 尚未分配维护者的 area：${unassigned.length} / ${areas.length}`);
  lines.push('# 这些区域暂由上方的全局兜底 owner 负责。在 .github/maintainers.json 的');
  lines.push('# areaOwners 里填入 GitHub 账号并重跑本脚本，即可让对应规则生效。');

  // 结尾恒为单个换行，避免 --check 因空白差异误报。
  return {
    text: lines.join('\n').replace(/\n+$/, '') + '\n',
    warnings,
    stats: {
      areas: areas.length,
      ownedAreas,
      unassigned: unassigned.length,
      rules: ruleCount,
      skippedPatterns: skippedPatterns.length,
    },
  };
}

/** 把映射表里新增的 area 补进名册（值为空数组），并报告已消失的 id。 */
function syncRoster(areas, roster) {
  const ids = areas.map((a) => a.id);
  const added = [];
  const removed = Object.keys(roster.areaOwners).filter((id) => !ids.includes(id));
  const next = { defaultOwners: roster.defaultOwners, areaOwners: {} };
  for (const id of ids) {
    if (Object.prototype.hasOwnProperty.call(roster.areaOwners, id)) {
      next.areaOwners[id] = roster.areaOwners[id];
    } else {
      next.areaOwners[id] = [];
      added.push(id);
    }
  }
  return { next, added, removed };
}

function main(argv) {
  const args = argv.slice(2);
  const check = args.includes('--check');
  const dryRun = args.includes('--dry-run');
  const sync = args.includes('--sync-roster');

  const areas = loadAreas();
  const roster = loadRoster();

  if (sync) {
    const { next, added, removed } = syncRoster(areas, roster);
    const existing = fs.existsSync(ROSTER) ? readJson(ROSTER) : {};
    const merged = { ...existing, defaultOwners: next.defaultOwners, areaOwners: next.areaOwners };
    if (!dryRun) {
      fs.writeFileSync(ROSTER, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    }
    console.log(`[codeowners] 名册同步：新增 ${added.length} 个 area，映射表中已消失 ${removed.length} 个。`);
    if (removed.length) console.log(`  已消失（仍保留在名册中，请人工确认）：${removed.join(', ')}`);
    return 0;
  }

  const { text, warnings, stats } = build(areas, roster);

  if (check) {
    if (!fs.existsSync(OUT)) {
      console.error('[codeowners] FAIL — .github/CODEOWNERS 不存在，请运行本脚本生成。');
      return 1;
    }
    const actual = fs.readFileSync(OUT, 'utf-8').replace(/\r\n/g, '\n');
    // 占位符检测：即便与生成结果一致，也不允许无效 owner 混入。
    const placeholders = actual.match(/@<[^>]+>/g) || [];
    if (placeholders.length) {
      console.error(`[codeowners] FAIL — 存在 ${placeholders.length} 个占位符 owner，GitHub 会静默忽略这些规则。`);
      return 1;
    }
    if (actual !== text) {
      console.error('[codeowners] FAIL — .github/CODEOWNERS 与真源不一致（漂移）。');
      console.error('  修复：node scripts/maintenance/gen-codeowners.js 然后提交产物。');
      return 1;
    }
    console.log(`[codeowners] OK — 与真源一致（${stats.rules} 条规则 / ${stats.ownedAreas} 个已分配 area）。`);
    for (const w of warnings) console.log(`  提示：${w}`);
    return 0;
  }

  if (dryRun) {
    console.log(text);
  } else {
    fs.writeFileSync(OUT, text, 'utf-8');
  }
  console.log(
    `[codeowners] ${dryRun ? '(dry-run) ' : ''}已分配 ${stats.ownedAreas}/${stats.areas} 个 area，` +
      `产出 ${stats.rules} 条规则，未分配 ${stats.unassigned} 个。`
  );
  for (const w of warnings) console.warn(`  警告：${w}`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { build, syncRoster, OWNER_RE };
