/**
 * taskTemplates.js
 *
 * 任务模板库 — 为常见编程任务提供明确的操作序列
 * 目标: 降低模型推理负担,让小模型也能通过"执行手册"完成任务
 *
 * 设计哲学:
 * - 模板不是"代码生成器",而是"操作指南"
 * - 每个步骤都是明确的工具调用 + 验证条件
 * - 支持参数化(如文件名、功能名)
 */

const fs = require('fs');
const path = require('path');

/**
 * 任务模板结构
 */
class TaskTemplate {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.description = config.description;
    this.applicableWhen = config.applicableWhen; // 匹配条件(关键词数组)
    this.steps = config.steps; // 步骤序列
    this.requiredParams = config.requiredParams || []; // 需要用户提供的参数
  }

  /**
   * 检查用户输入是否匹配此模板
   */
  matches(userInput) {
    const input = userInput.toLowerCase();
    return this.applicableWhen.some(keyword => input.includes(keyword));
  }

  /**
   * 生成执行指令(给模型的明确步骤)
   */
  generateInstructions(params = {}) {
    const lines = [];
    lines.push(`# 执行模板: ${this.name}`);
    lines.push('');
    lines.push(`**任务**: ${this.description}`);
    lines.push('');
    lines.push('**执行步骤** (请严格按顺序执行):');
    lines.push('');

    this.steps.forEach((step, idx) => {
      lines.push(`## Step ${idx + 1}: ${step.description}`);
      lines.push('');

      // 工具调用指令
      if (step.tool) {
        lines.push(`**使用工具**: \`${step.tool}\``);
        if (step.toolParams) {
          lines.push('**参数**:');
          Object.entries(step.toolParams).forEach(([key, value]) => {
            const resolved = this._resolveParam(value, params);
            lines.push(`  - ${key}: ${resolved}`);
          });
        }
        lines.push('');
      }

      // 验证条件
      if (step.verify) {
        lines.push(`**验证**: ${step.verify}`);
        lines.push('');
      }

      // 失败处理
      if (step.onFailure) {
        lines.push(`**失败处理**: ${step.onFailure}`);
        lines.push('');
      }
    });

    lines.push('---');
    lines.push('**重要**: 每步完成后,检查输出是否符合验证条件。如不符合,按失败处理执行。');

    return lines.join('\n');
  }

  _resolveParam(value, params) {
    if (typeof value === 'string' && value.startsWith('{{') && value.endsWith('}}')) {
      const paramName = value.slice(2, -2);
      return params[paramName] || value;
    }
    // 递归替换字符串中的所有 {{param}}
    if (typeof value === 'string') {
      return value.replace(/\{\{(\w+)\}\}/g, (match, paramName) => {
        return params[paramName] !== undefined ? params[paramName] : match;
      });
    }
    return value;
  }
}

// ==================== 内置任务模板 ====================

const TEMPLATES = [
  // VB-1 类型: 添加 API 端点
  new TaskTemplate({
    id: 'add-api-endpoint',
    name: '添加 API 端点',
    description: '在现有 API 服务中添加新的端点',
    applicableWhen: ['添加接口', '新增端点', 'add endpoint', 'add api', '健康检查'],
    requiredParams: ['endpoint', 'method', 'responseData'],
    steps: [
      {
        description: '读取现有服务器文件',
        tool: 'Read',
        toolParams: { file_path: '{{serverFile}}' },
        verify: '文件内容已显示,确认服务器框架类型(Express/Koa/原生http)',
      },
      {
        description: '在路由处理中添加新端点',
        tool: 'Edit',
        toolParams: {
          file_path: '{{serverFile}}',
          old_string: '{{insertPoint}}',
          new_string: '{{insertPoint}}\n  } else if (req.url === \'{{endpoint}}\' && req.method === \'{{method}}\') {\n    res.writeHead(200, { \'Content-Type\': \'application/json\' });\n    res.end(JSON.stringify({{responseData}}));\n'
        },
        verify: '端点代码已插入,响应格式正确',
        onFailure: '如找不到插入点,在文件末尾添加'
      },
      {
        description: '创建测试文件验证端点',
        tool: 'Write',
        toolParams: {
          file_path: '{{testFile}}',
          content: 'const http = require(\'http\');\nconst assert = require(\'assert\');\n\nhttp.get(\'http://localhost:3000{{endpoint}}\', (res) => {\n  let data = \'\';\n  res.on(\'data\', chunk => data += chunk);\n  res.on(\'end\', () => {\n    const json = JSON.parse(data);\n    console.log(\'✓ Endpoint working:\', json);\n  });\n});'
        },
        verify: '测试文件已创建'
      },
      {
        description: '更新 README 文档',
        tool: 'Read',
        toolParams: { file_path: 'README.md' },
        verify: '确认 README 存在'
      },
      {
        description: '在 README 的 Endpoints 章节添加新端点说明',
        tool: 'Edit',
        toolParams: {
          file_path: 'README.md',
          old_string: '## Endpoints',
          new_string: '## Endpoints\n- {{method}} {{endpoint}} - {{description}}'
        },
        verify: '文档已更新',
        onFailure: '如无 Endpoints 章节,创建新章节'
      }
    ]
  }),

  // VB-2 类型: 修复 Bug
  new TaskTemplate({
    id: 'fix-bug',
    name: '修复 Bug',
    description: '定位并修复代码中的错误',
    applicableWhen: ['修bug', 'fix bug', '有bug', '有错误', '不工作', 'not working', 'bug', '修', '修复', 'fix'],
    requiredParams: ['bugFile', 'symptom'],
    steps: [
      {
        description: '读取问题文件',
        tool: 'Read',
        toolParams: { file_path: '{{bugFile}}' },
        verify: '文件内容已显示'
      },
      {
        description: '分析症状并定位错误代码',
        verify: '在响应中明确指出错误的行号和原因'
      },
      {
        description: '修复错误',
        tool: 'Edit',
        toolParams: {
          file_path: '{{bugFile}}',
          old_string: '{{buggyCode}}',
          new_string: '{{fixedCode}}'
        },
        verify: '代码已修复,逻辑正确'
      },
      {
        description: '如有测试文件,运行测试验证修复',
        tool: 'Bash',
        toolParams: { command: 'npm test || node test.js' },
        verify: '测试通过或无测试可跳过',
        onFailure: '如测试失败,检查修复是否引入新问题'
      },
      {
        description: '在响应中解释修复逻辑',
        verify: '用户能理解为什么这样修复'
      }
    ]
  }),

  // VB-4 类型: 添加功能模块
  new TaskTemplate({
    id: 'add-feature-module',
    name: '添加功能模块',
    description: '创建新的功能模块(如日志、缓存)',
    applicableWhen: ['添加功能', '加个', '实现', 'add feature', '日志', '缓存', 'logging', 'cache'],
    requiredParams: ['featureName', 'moduleFile'],
    steps: [
      {
        description: '创建功能模块文件',
        tool: 'Write',
        toolParams: {
          file_path: '{{moduleFile}}',
          content: '{{moduleCode}}'
        },
        verify: '模块文件已创建,导出接口清晰'
      },
      {
        description: '读取主文件准备集成',
        tool: 'Read',
        toolParams: { file_path: '{{mainFile}}' },
        verify: '主文件内容已显示'
      },
      {
        description: '在主文件中导入并使用新模块',
        tool: 'Edit',
        toolParams: {
          file_path: '{{mainFile}}',
          old_string: '{{importSection}}',
          new_string: '{{importSection}}\nconst {{featureName}} = require(\'./{{moduleFile}}\');'
        },
        verify: '模块已导入'
      },
      {
        description: '在适当位置调用模块功能',
        tool: 'Edit',
        toolParams: {
          file_path: '{{mainFile}}',
          old_string: '{{usagePoint}}',
          new_string: '{{usageCode}}'
        },
        verify: '模块已集成到业务逻辑'
      },
      {
        description: '创建单元测试',
        tool: 'Write',
        toolParams: {
          file_path: '{{testFile}}',
          content: '{{testCode}}'
        },
        verify: '测试文件已创建'
      },
      {
        description: '运行测试验证功能',
        tool: 'Bash',
        toolParams: { command: 'node {{testFile}}' },
        verify: '所有测试通过',
        onFailure: '检查模块实现,修复失败的测试'
      },
      {
        description: '更新文档',
        tool: 'Read',
        toolParams: { file_path: 'README.md' }
      },
      {
        description: '在 README 中添加功能说明',
        tool: 'Edit',
        toolParams: {
          file_path: 'README.md',
          old_string: '## Features',
          new_string: '## Features\n\n### {{featureName}}\n{{featureDescription}}\n\n**配置**:\n```javascript\n{{configExample}}\n```\n\n**使用**:\n```javascript\n{{usageExample}}\n```'
        },
        verify: '文档已完整更新'
      }
    ]
  }),

  // SP-1 类型: spec-driven 实现
  new TaskTemplate({
    id: 'spec-driven-implementation',
    name: 'Spec-driven 实现',
    description: '先写规格,再实现,最后验证',
    applicableWhen: ['先写spec', 'spec-driven', '先定义', 'specification', '定义 spec', '验收条件'],
    requiredParams: ['featureName', 'requirements'],
    steps: [
      {
        description: '创建规格文档',
        tool: 'Write',
        toolParams: {
          file_path: '{{specFile}}',
          content: '# {{featureName}} Specification\n\n## Requirements\n{{requirements}}\n\n## Acceptance Criteria\n{{acceptanceCriteria}}\n\n## Implementation Plan\n{{implementationPlan}}'
        },
        verify: '规格文档完整,包含需求、验收条件、实现计划'
      },
      {
        description: '按规格实现核心功能',
        tool: 'Write',
        toolParams: {
          file_path: '{{implFile}}',
          content: '{{implementationCode}}'
        },
        verify: '实现代码覆盖所有需求项'
      },
      {
        description: '创建验收测试(对应 AC)',
        tool: 'Write',
        toolParams: {
          file_path: '{{testFile}}',
          content: '{{testCode}}'
        },
        verify: '每条 AC 有对应测试'
      },
      {
        description: '运行测试验证',
        tool: 'Bash',
        toolParams: { command: 'node {{testFile}}' },
        verify: '所有 AC 测试通过',
        onFailure: '测试失败 → 回到实现步骤修复'
      },
      {
        description: '创建 deliveryGate 验证脚本',
        tool: 'Write',
        toolParams: {
          file_path: '{{verifyFile}}',
          content: '{{verifyCode}}'
        },
        verify: 'deliveryGate 脚本已创建'
      },
      {
        description: '运行 deliveryGate',
        tool: 'Bash',
        toolParams: { command: 'node {{verifyFile}}' },
        verify: 'deliveryGate verdict = PASS',
        onFailure: '如 FAIL,根据 missing 项补全'
      },
      {
        description: '更新文档',
        tool: 'Edit',
        toolParams: {
          file_path: 'README.md',
          old_string: '{{docInsertPoint}}',
          new_string: '{{docContent}}'
        },
        verify: '文档包含规格链接和使用说明'
      }
    ]
  })
];

/**
 * 根据用户输入匹配任务模板
 * 优先匹配关键词更多的模板(更精确)
 */
function matchTemplate(userInput) {
  const input = userInput.toLowerCase();
  let bestMatch = null;
  let maxMatches = 0;

  for (const template of TEMPLATES) {
    const matchCount = template.applicableWhen.filter(keyword =>
      input.includes(keyword.toLowerCase())
    ).length;

    if (matchCount > maxMatches) {
      maxMatches = matchCount;
      bestMatch = template;
    }
  }

  return bestMatch;
}

/**
 * 生成任务执行指令
 */
function generateTaskInstructions(userInput, params = {}) {
  const template = matchTemplate(userInput);

  if (!template) {
    return null;
  }

  return {
    templateId: template.id,
    templateName: template.name,
    instructions: template.generateInstructions(params),
    requiredParams: template.requiredParams
  };
}

/**
 * 列出所有可用模板
 */
function listTemplates() {
  return TEMPLATES.map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
    keywords: t.applicableWhen,
    requiredParams: t.requiredParams
  }));
}

module.exports = {
  TaskTemplate,
  TEMPLATES,
  matchTemplate,
  generateTaskInstructions,
  listTemplates
};
