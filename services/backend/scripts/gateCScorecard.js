#!/usr/bin/env node
/**
 * Gate C 模型独立性与执行确定性评分卡
 *
 * 度量 khy 作为"严格执行器"的能力，而非依赖模型的"聪明"
 *
 * 使用:
 *   node gateCScorecard.js [--json]
 */

const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.join(__dirname, '..');

function req(rel) {
  return require(path.join(BACKEND_ROOT, rel));
}

// Gate C 维度定义
const DIMENSIONS = [
  {
    id: 'C1',
    label: '任务模板库覆盖率',
    description: '常见任务有明确的操作模板',
    max: 3,
    probe: () => {
      try {
        const { listTemplates } = req('src/services/taskTemplates.js');
        const templates = listTemplates();

        // 核心任务类型: 添加功能、修bug、重构、spec-driven、测试
        const coreTaskTypes = ['add', 'fix', 'refactor', 'spec', 'test'];
        const covered = templates.filter(t =>
          coreTaskTypes.some(type => t.id.includes(type) || t.keywords.some(k => k.includes(type)))
        );

        // 0-2: <2 模板, 2-3: 2-3 模板, 3: ≥4 模板
        const score = Math.min(3, Math.max(0, covered.length - 1));

        return {
          score,
          reason: `${templates.length} 个模板, ${covered.length} 个核心类型覆盖`,
          evidence: { total: templates.length, covered: covered.length, templateIds: templates.map(t => t.id) }
        };
      } catch (err) {
        return { score: 0, reason: `taskTemplates 不可用: ${err.message}` };
      }
    }
  },

  {
    id: 'C2',
    label: '步骤粒度适中',
    description: '任务模板的步骤数量适中(5-10步)',
    max: 2,
    probe: () => {
      try {
        const { TEMPLATES } = req('src/services/taskTemplates.js');
        const stepCounts = TEMPLATES.map(t => t.steps.length);
        const avg = stepCounts.reduce((a,b) => a+b, 0) / stepCounts.length;

        // 理想步骤数: 5-10
        const score = avg >= 5 && avg <= 10 ? 2 : avg >= 3 && avg <= 15 ? 1 : 0;

        return {
          score,
          reason: `平均步骤数 ${avg.toFixed(1)} (理想 5-10)`,
          evidence: { stepCounts, avg }
        };
      } catch (err) {
        return { score: 0, reason: `无法分析步骤粒度: ${err.message}` };
      }
    }
  },

  {
    id: 'C3',
    label: '步骤验证完整性',
    description: '每个步骤有明确的验证条件',
    max: 2,
    probe: () => {
      try {
        const { TEMPLATES } = req('src/services/taskTemplates.js');
        let totalSteps = 0;
        let stepsWithVerify = 0;

        TEMPLATES.forEach(t => {
          t.steps.forEach(step => {
            totalSteps++;
            if (step.verify) stepsWithVerify++;
          });
        });

        const ratio = stepsWithVerify / totalSteps;
        const score = ratio >= 0.8 ? 2 : ratio >= 0.5 ? 1 : 0;

        return {
          score,
          reason: `${stepsWithVerify}/${totalSteps} 步骤有验证条件 (${(ratio*100).toFixed(1)}%)`,
          evidence: { totalSteps, stepsWithVerify, ratio }
        };
      } catch (err) {
        return { score: 0, reason: `无法分析验证完整性: ${err.message}` };
      }
    }
  },

  {
    id: 'C4',
    label: '失败处理机制',
    description: '步骤失败时有明确的处理策略',
    max: 2,
    probe: () => {
      try {
        const { TEMPLATES } = req('src/services/taskTemplates.js');
        let totalSteps = 0;
        let stepsWithFailure = 0;

        TEMPLATES.forEach(t => {
          t.steps.forEach(step => {
            totalSteps++;
            if (step.onFailure) stepsWithFailure++;
          });
        });

        const ratio = stepsWithFailure / totalSteps;
        // 不是所有步骤都需要 onFailure，50% 已经很好
        const score = ratio >= 0.3 ? 2 : ratio >= 0.15 ? 1 : 0;

        return {
          score,
          reason: `${stepsWithFailure}/${totalSteps} 步骤有失败处理 (${(ratio*100).toFixed(1)}%)`,
          evidence: { totalSteps, stepsWithFailure, ratio }
        };
      } catch (err) {
        return { score: 0, reason: `无法分析失败处理: ${err.message}` };
      }
    }
  },

  {
    id: 'C5',
    label: 'deliveryGate 自动验证',
    description: 'spec-coding 任务自动触发 deliveryGate',
    max: 2,
    probe: () => {
      try {
        // 检查 agenticHarnessService 中的 deliveryGate 自动调用
        const harnessPath = path.join(BACKEND_ROOT, 'src/services/agenticHarnessService.js');
        if (!fs.existsSync(harnessPath)) {
          return { score: 0, reason: 'agenticHarnessService 不存在' };
        }

        const content = fs.readFileSync(harnessPath, 'utf8');
        const hasAutoCall = content.includes('evaluateDelivery(projectRoot');
        const hasRemediation = content.includes('buildRemediationPrompt');
        const hasGateControl = content.includes('KHY_DELIVERY_GATE');

        const score = (hasAutoCall ? 1 : 0) + (hasRemediation && hasGateControl ? 1 : 0);

        return {
          score,
          reason: `deliveryGate 自动调用=${hasAutoCall}, remediation=${hasRemediation}, 门控=${hasGateControl}`,
          evidence: { hasAutoCall, hasRemediation, hasGateControl }
        };
      } catch (err) {
        return { score: 0, reason: `无法检查 deliveryGate: ${err.message}` };
      }
    }
  },

  {
    id: 'C6',
    label: '工具调用确定性',
    description: '有界循环、收敛判断、防退化机制',
    max: 3,
    probe: () => {
      try {
        const loopPath = path.join(BACKEND_ROOT, 'src/services/toolUseLoop.js');
        if (!fs.existsSync(loopPath)) {
          return { score: 0, reason: 'toolUseLoop 不存在' };
        }

        const content = fs.readFileSync(loopPath, 'utf8');
        const hasMaxIter = content.includes('maxIterations') || content.includes('MAX_ITERATIONS');
        const hasStreamGuard = content.includes('streamRepGuard') || content.includes('_streamRepGuard');
        const hasClosure = content.includes('deliverableClosure') || content.includes('shouldConclude');

        const score = (hasMaxIter ? 1 : 0) + (hasStreamGuard ? 1 : 0) + (hasClosure ? 1 : 0);

        return {
          score,
          reason: `有界循环=${hasMaxIter}, 防退化=${hasStreamGuard}, 收敛判断=${hasClosure}`,
          evidence: { hasMaxIter, hasStreamGuard, hasClosure }
        };
      } catch (err) {
        return { score: 0, reason: `无法检查工具循环: ${err.message}` };
      }
    }
  },

  {
    id: 'C7',
    label: '步中验证注入',
    description: '工具循环中有定期验证点',
    max: 2,
    probe: () => {
      try {
        const loopPath = path.join(BACKEND_ROOT, 'src/services/toolUseLoop.js');
        if (!fs.existsSync(loopPath)) {
          return { score: 0, reason: 'toolUseLoop 不存在' };
        }

        const content = fs.readFileSync(loopPath, 'utf8');
        // 检查是否有中间验证机制
        const hasProgressCheck = content.includes('checkProgress') || content.includes('verifyStep');
        const hasIntermediateCheck = content.includes('intermediate') && content.includes('verify');

        // 当前可能没有完整实现，这是改进方向
        const score = hasProgressCheck || hasIntermediateCheck ? 2 : 0;

        return {
          score,
          reason: hasProgressCheck || hasIntermediateCheck ? '有步中验证机制' : '缺少步中验证(改进方向)',
          evidence: { hasProgressCheck, hasIntermediateCheck }
        };
      } catch (err) {
        return { score: 0, reason: `无法检查步中验证: ${err.message}` };
      }
    }
  }
];

function computeScorecard(options = {}) {
  const results = [];
  let totalScore = 0;
  let totalMax = 0;

  for (const dim of DIMENSIONS) {
    const result = dim.probe();
    results.push({
      id: dim.id,
      label: dim.label,
      description: dim.description,
      score: result.score,
      max: dim.max,
      reason: result.reason,
      evidence: result.evidence || null
    });
    totalScore += result.score;
    totalMax += dim.max;
  }

  const ratio = totalMax > 0 ? totalScore / totalMax : 0;
  const gate = options.gate || 0.70; // Gate C 阈值 70%
  const verdict = ratio >= gate ? 'PASS' : ratio >= gate * 0.7 ? 'PARTIAL' : 'FAIL';

  return {
    standard: 'MGMT-STD-006',
    gate: 'C',
    gateName: '模型独立性与执行确定性',
    verdict,
    threshold: gate,
    total: { score: totalScore, max: totalMax },
    ratio,
    rows: results,
    summary: `Gate C ${verdict}: ${totalScore}/${totalMax} (${(ratio*100).toFixed(1)}%), 阈值 ${(gate*100).toFixed(0)}%`,
    notes: 'Gate C 度量 khy 作为"严格执行器"的能力。高分意味着小模型也能通过明确的操作指南完成任务。'
  };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');

  const result = computeScorecard();

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n=== Gate C: 模型独立性与执行确定性 ===\n`);
    console.log(`判定: ${result.verdict}`);
    console.log(`得分: ${result.total.score}/${result.total.max} (${(result.ratio*100).toFixed(1)}%)`);
    console.log(`阈值: ${(result.threshold*100).toFixed(0)}%\n`);

    result.rows.forEach(row => {
      const mark = row.score === row.max ? '✓' : row.score > 0 ? '~' : '✗';
      console.log(`[${mark}] ${row.id}: ${row.label} (${row.score}/${row.max})`);
      console.log(`    ${row.reason}`);
    });

    console.log(`\n${result.summary}`);
    console.log(`\n${result.notes}`);
  }

  process.exit(result.verdict === 'FAIL' ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { computeScorecard, DIMENSIONS };
