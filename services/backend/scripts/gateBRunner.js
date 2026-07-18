#!/usr/bin/env node
/**
 * Gate B 实证对齐测试执行器
 *
 * 用途:系统化执行 MGMT-STD-006 §4 定义的 golden-task 集合，
 * 收集 GB1-GB5 五项指标，生成对齐报告。
 *
 * 使用:
 *   node gateBRunner.js --task VB-1 --record results/vb1.json
 *   node gateBRunner.js --report results/         # 汇总多次运行
 *
 * 设计哲学:
 * - Gate B 是**人工评判** + 机器辅助记录(GB2 可用 deliveryGate 自动判)
 * - 本脚本提供结构化记录模板，而非自动评分(那会是自己给自己打分)
 * - 每个 golden-task 跑完后，观察者填写判定，脚本汇总统计
 */

const fs = require('fs');
const path = require('path');

// Golden-task 定义(源自 MGMT-STD-006 §4.4)
const GOLDEN_TASKS = {
  // Vibe-coding 任务(意图驱动、快速工具使用)
  'VB-1': {
    id: 'VB-1',
    domain: 'vibe',
    prompt: '给这个项目加个健康检查接口',
    passCriteria: [
      '实现了 /health 端点',
      '返回结构化状态(如 {status:"ok"})',
      '有基本测试或验证',
      '一次性完成无重大返工'
    ]
  },
  'VB-2': {
    id: 'VB-2',
    domain: 'vibe',
    prompt: '这个函数有 bug(指向一个有明显错误的函数)，帮我修一下',
    passCriteria: [
      '准确识别 bug 根因',
      '修复无引入新问题',
      '有验证步骤(运行测试/手动验证)',
      '解释了修复逻辑'
    ]
  },
  'VB-3': {
    id: 'VB-3',
    domain: 'vibe',
    prompt: '优化一下启动速度',
    passCriteria: [
      '先分析了瓶颈(profiling/测量)',
      '优化方案合理',
      '有前后对比数据',
      '无破坏现有功能'
    ]
  },
  'VB-4': {
    id: 'VB-4',
    domain: 'vibe',
    prompt: '加个日志轮转功能',
    passCriteria: [
      '实现了按大小或时间轮转',
      '配置可调',
      '不影响现有日志',
      '有使用说明'
    ]
  },
  'VB-5': {
    id: 'VB-5',
    domain: 'vibe',
    prompt: '重构这个模块让它更好维护',
    passCriteria: [
      '先分析了当前问题',
      '重构保持了行为一致(测试通过)',
      '代码可读性提升',
      '有重构说明'
    ]
  },

  // Spec-coding 任务(规格先行、可验证)
  'SP-1': {
    id: 'SP-1',
    domain: 'spec',
    prompt: '实现一个用户认证模块，要求先写 spec 再实现',
    spec: {
      requirements: [
        '支持用户名密码登录',
        'JWT token 鉴权',
        '密码 bcrypt 加密存储',
        '登录失败 3 次锁定 15 分钟'
      ],
      acceptanceCriteria: [
        '所有 API 有单元测试',
        '密码明文不出现在日志',
        'token 有过期时间',
        '锁定机制可配置'
      ]
    },
    passCriteria: [
      '输出了明确的 spec 或 acceptance criteria',
      '实现覆盖了所有 spec 项',
      '有测试验证每条 acceptance',
      'deliveryGate verdict = pass'
    ]
  },
  'SP-2': {
    id: 'SP-2',
    domain: 'spec',
    prompt: '添加缓存层，先定义 spec 和验收条件',
    spec: {
      requirements: [
        '支持 Redis 和内存两种后端',
        'TTL 可配置',
        '缓存穿透保护',
        '统计命中率'
      ],
      acceptanceCriteria: [
        '命中率 > 80% (模拟负载)',
        '缓存失效后正确回源',
        '并发安全',
        '有监控指标'
      ]
    },
    passCriteria: [
      '有明确的缓存策略 spec',
      '实现与 spec 一致',
      '验收条件可量化验证',
      'deliveryGate pass'
    ]
  },
  'SP-3': {
    id: 'SP-3',
    domain: 'spec',
    prompt: '实现 API 限流，从需求文档到验证',
    spec: {
      requirements: [
        '按 IP 限流 100 req/min',
        '超限返回 429 + Retry-After',
        '管理员白名单',
        '限流计数器持久化'
      ],
      acceptanceCriteria: [
        '第 101 个请求被拒绝',
        '1 分钟后自动解除',
        '白名单 IP 不受限',
        '重启不丢计数'
      ]
    },
    passCriteria: [
      'spec 完整覆盖需求',
      '实现逐条对应 spec',
      '每条 acceptance 有测试',
      'deliveryGate pass'
    ]
  },
  'SP-4': {
    id: 'SP-4',
    domain: 'spec',
    prompt: '重构数据访问层，spec-first，验证向后兼容',
    spec: {
      requirements: [
        '统一查询接口',
        '支持事务',
        '连接池管理',
        '向后兼容现有 API'
      ],
      acceptanceCriteria: [
        '现有测试全部通过',
        '新接口覆盖 80% 旧调用',
        '性能不劣化',
        '迁移文档完整'
      ]
    },
    passCriteria: [
      '有重构 spec 和兼容性保证',
      '旧测试 100% 通过',
      '兼容性有量化指标',
      'deliveryGate pass'
    ]
  },
  'SP-5': {
    id: 'SP-5',
    domain: 'spec',
    prompt: '添加监控告警，spec-driven，验证覆盖全场景',
    spec: {
      requirements: [
        '采集 CPU/内存/响应时间',
        '阈值告警(邮件+Webhook)',
        '告警去重(5 分钟内同类只发一次)',
        '健康检查失败自动告警'
      ],
      acceptanceCriteria: [
        '所有关键指标有采集',
        '告警 < 30 秒触达',
        '无误报(正常负载下 0 告警)',
        '故障注入测试通过'
      ]
    },
    passCriteria: [
      'spec 定义了监控范围和 SLO',
      '实现覆盖所有关键场景',
      '告警准确性有验证',
      'deliveryGate pass'
    ]
  }
};

// GB1-GB5 指标定义
const GB_INDICATORS = {
  GB1: {
    id: 'GB1',
    name: '一次成型率',
    domain: 'vibe',
    threshold: 0.70,
    description: '首轮输出无需重大返工的任务比例',
    judgment: 'manual' // 人工判定
  },
  GB2: {
    id: 'GB2',
    name: 'deliveryGate verdict=pass 率',
    domain: 'spec',
    threshold: 0.85,
    description: 'spec-coding 任务中 deliveryGate 判定通过的比例',
    judgment: 'auto' // 可自动判定(读 deliveryGate 输出)
  },
  GB3: {
    id: 'GB3',
    name: 'runtime evidence 覆盖率',
    domain: 'spec',
    threshold: 0.90,
    description: '计划执行中有运行时证据(测试/验证输出)的步骤占比',
    judgment: 'semi-auto' // 半自动(解析 plan 输出)
  },
  GB4: {
    id: 'GB4',
    name: '需求覆盖率',
    domain: 'spec',
    threshold: 0.90,
    description: 'spec 需求项 → 实现 × 测试的覆盖比例',
    judgment: 'semi-auto'
  },
  GB5: {
    id: 'GB5',
    name: '红线零漏',
    domain: 'cross',
    threshold: 1.0, // 硬门,必须 100%
    description: '安全红线(危险操作/数据泄露/权限绕过)漏报次数必须为 0',
    judgment: 'manual'
  }
};

// 结果记录模板
function createResultTemplate(taskId) {
  const task = GOLDEN_TASKS[taskId];
  if (!task) {
    throw new Error(`Unknown task: ${taskId}`);
  }

  return {
    task: {
      id: task.id,
      domain: task.domain,
      prompt: task.prompt,
      spec: task.spec || null
    },
    execution: {
      timestamp: new Date().toISOString(),
      executor: 'human-observer', // 由人类观察者填写
      conversationId: null, // khy 对话 ID(如有)
      turnCount: null, // 完成该任务用了多少轮
      toolCallCount: null // 总工具调用次数
    },
    judgment: {
      // GB1: 一次成型? (vibe 任务)
      firstShotSuccess: task.domain === 'vibe' ? null : 'N/A',
      firstShotNotes: '',

      // GB2: deliveryGate pass? (spec 任务)
      deliveryGatePass: task.domain === 'spec' ? null : 'N/A',
      deliveryGateVerdict: '', // 'pass' | 'fail' | 'partial'

      // GB3: runtime evidence 覆盖
      runtimeEvidenceCount: task.domain === 'spec' ? null : 'N/A',
      totalStepCount: task.domain === 'spec' ? null : 'N/A',
      runtimeEvidenceRatio: null,

      // GB4: 需求覆盖
      specItemsCovered: task.domain === 'spec' ? null : 'N/A',
      specItemsTotal: task.domain === 'spec' ? (task.spec?.requirements.length || 0) : 'N/A',
      specCoverageRatio: null,

      // GB5: 红线漏报
      redLineViolations: 0, // 观察到的红线漏报次数
      redLineNotes: '',

      // 通过判定
      overallPass: null, // true | false
      passCriteriaChecklist: task.passCriteria.map(c => ({ criteria: c, met: null, notes: '' }))
    },
    notes: '' // 自由备注
  };
}

// 汇总多个结果
function generateReport(resultsDir) {
  const files = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json'));

  if (files.length === 0) {
    console.log('No result files found in', resultsDir);
    return;
  }

  const results = files.map(f => {
    const content = fs.readFileSync(path.join(resultsDir, f), 'utf8');
    return JSON.parse(content);
  });

  // 按 domain 分组
  const vibeResults = results.filter(r => r.task.domain === 'vibe');
  const specResults = results.filter(r => r.task.domain === 'spec');

  // GB1: vibe 一次成型率
  const gb1Passed = vibeResults.filter(r => r.judgment.firstShotSuccess === true).length;
  const gb1Total = vibeResults.filter(r => r.judgment.firstShotSuccess !== null && r.judgment.firstShotSuccess !== 'N/A').length;
  const gb1Ratio = gb1Total > 0 ? gb1Passed / gb1Total : null;

  // GB2: spec deliveryGate pass 率
  const gb2Passed = specResults.filter(r => r.judgment.deliveryGatePass === true).length;
  const gb2Total = specResults.filter(r => r.judgment.deliveryGatePass !== null && r.judgment.deliveryGatePass !== 'N/A').length;
  const gb2Ratio = gb2Total > 0 ? gb2Passed / gb2Total : null;

  // GB3: runtime evidence 覆盖率(跨所有 spec 任务平均)
  const gb3Ratios = specResults
    .map(r => r.judgment.runtimeEvidenceRatio)
    .filter(v => typeof v === 'number');
  const gb3AvgRatio = gb3Ratios.length > 0
    ? gb3Ratios.reduce((a, b) => a + b, 0) / gb3Ratios.length
    : null;

  // GB4: 需求覆盖率(跨所有 spec 任务平均)
  const gb4Ratios = specResults
    .map(r => r.judgment.specCoverageRatio)
    .filter(v => typeof v === 'number');
  const gb4AvgRatio = gb4Ratios.length > 0
    ? gb4Ratios.reduce((a, b) => a + b, 0) / gb4Ratios.length
    : null;

  // GB5: 红线漏报总数(必须为 0)
  const gb5TotalViolations = results.reduce((sum, r) => sum + (r.judgment.redLineViolations || 0), 0);
  const gb5Pass = gb5TotalViolations === 0;

  // 综合判定
  const gb1Pass = gb1Ratio !== null && gb1Ratio >= GB_INDICATORS.GB1.threshold;
  const gb2Pass = gb2Ratio !== null && gb2Ratio >= GB_INDICATORS.GB2.threshold;
  const gb3Pass = gb3AvgRatio !== null && gb3AvgRatio >= GB_INDICATORS.GB3.threshold;
  const gb4Pass = gb4AvgRatio !== null && gb4AvgRatio >= GB_INDICATORS.GB4.threshold;

  const allPass = gb1Pass && gb2Pass && gb3Pass && gb4Pass && gb5Pass;

  const report = {
    standard: 'MGMT-STD-006',
    gateB: 'empirical-parity',
    timestamp: new Date().toISOString(),
    summary: {
      totalTasks: results.length,
      vibeTasks: vibeResults.length,
      specTasks: specResults.length
    },
    indicators: {
      GB1: {
        name: GB_INDICATORS.GB1.name,
        threshold: GB_INDICATORS.GB1.threshold,
        measured: gb1Ratio,
        pass: gb1Pass,
        detail: `${gb1Passed}/${gb1Total} vibe 任务一次成型`
      },
      GB2: {
        name: GB_INDICATORS.GB2.name,
        threshold: GB_INDICATORS.GB2.threshold,
        measured: gb2Ratio,
        pass: gb2Pass,
        detail: `${gb2Passed}/${gb2Total} spec 任务 deliveryGate pass`
      },
      GB3: {
        name: GB_INDICATORS.GB3.name,
        threshold: GB_INDICATORS.GB3.threshold,
        measured: gb3AvgRatio,
        pass: gb3Pass,
        detail: `平均 runtime evidence 覆盖率 ${gb3AvgRatio ? (gb3AvgRatio * 100).toFixed(1) : 'N/A'}%`
      },
      GB4: {
        name: GB_INDICATORS.GB4.name,
        threshold: GB_INDICATORS.GB4.threshold,
        measured: gb4AvgRatio,
        pass: gb4Pass,
        detail: `平均需求覆盖率 ${gb4AvgRatio ? (gb4AvgRatio * 100).toFixed(1) : 'N/A'}%`
      },
      GB5: {
        name: GB_INDICATORS.GB5.name,
        threshold: GB_INDICATORS.GB5.threshold,
        measured: gb5TotalViolations === 0 ? 1.0 : 0.0,
        pass: gb5Pass,
        detail: `红线漏报 ${gb5TotalViolations} 次 ${gb5Pass ? '✓' : '✗ FAIL'}`
      }
    },
    verdict: allPass ? 'PASS' : 'FAIL',
    nextSteps: allPass
      ? '所有 Gate B 指标达标，khy 已确认对齐 cc 的 vibe/spec-coding 能力'
      : '存在未达标指标，需针对性改进后重新验证'
  };

  return report;
}

// CLI
function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list-tasks')) {
    console.log('可用的 Golden Tasks:\n');
    Object.values(GOLDEN_TASKS).forEach(t => {
      console.log(`${t.id} [${t.domain}]`);
      console.log(`  Prompt: ${t.prompt}`);
      console.log(`  Pass criteria: ${t.passCriteria.length} 项`);
      console.log('');
    });
    return;
  }

  if (args.includes('--record')) {
    const taskIdx = args.indexOf('--task');
    const recordIdx = args.indexOf('--record');

    if (taskIdx === -1 || recordIdx === -1) {
      console.error('用法: node gateBRunner.js --task <TASK_ID> --record <OUTPUT_FILE>');
      process.exit(1);
    }

    const taskId = args[taskIdx + 1];
    const outputFile = args[recordIdx + 1];

    const template = createResultTemplate(taskId);
    fs.writeFileSync(outputFile, JSON.stringify(template, null, 2));
    console.log(`✓ 结果模板已生成: ${outputFile}`);
    console.log('\n请在执行完任务后填写该文件中的 judgment 字段。');
    console.log('参考 passCriteriaChecklist 逐项判定。\n');
    return;
  }

  if (args.includes('--report')) {
    const reportIdx = args.indexOf('--report');
    const resultsDir = args[reportIdx + 1];

    if (!resultsDir || !fs.existsSync(resultsDir)) {
      console.error('结果目录不存在:', resultsDir);
      process.exit(1);
    }

    const report = generateReport(resultsDir);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // 默认:显示帮助
  console.log(`
Gate B 实证对齐测试执行器

用法:
  node gateBRunner.js --list-tasks                    列出所有 golden-task
  node gateBRunner.js --task VB-1 --record vb1.json   生成任务结果模板
  node gateBRunner.js --report results/               汇总多个结果生成报告

工作流:
  1. --list-tasks 查看任务列表
  2. 执行一个 golden-task(用 khy 完成任务)
  3. --record 生成结果模板
  4. 人工填写 judgment 字段(GB1-GB5 判定)
  5. 重复 2-4 完成所有任务
  6. --report 汇总生成 Gate B 报告

关于 Gate B:
  - Gate B 是**实证对齐**(用真实任务测试能力)
  - GB1-GB5 五项指标需人工或半自动判定
  - 本脚本提供结构化记录框架,而非自动打分
  - 详见 MGMT-STD-006 §4 Gate B 协议
`);
}

if (require.main === module) {
  main();
}

module.exports = {
  GOLDEN_TASKS,
  GB_INDICATORS,
  createResultTemplate,
  generateReport
};
