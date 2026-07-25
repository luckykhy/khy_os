'use strict';

/**
 * UpstreamStudyTool — 把开源项目更新压缩包「学进来」:取其精华弃其糟粕。
 *
 * 背景(goal「Khy 参考了大量开源项目, 这些项目更新时把压缩包给 khyos, 也能取其精华弃其糟粕学习更新」):
 * khy 此前无任何正规路径吃进「更新包」——缺能力时弱模型只会手动解压、cat 一堆随机文件 flail,极易
 * 走死循环。本工具提供**只读、有界**的正规替代:借 archiveInspectService 只列目录(零解压、无
 * zip-slip),纯叶子甄别每条属精华(源码/CHANGELOG/测试/理据文档)还是糟粕(vendored/构建产物/
 * 压缩/二进制/密钥/lockfile),可选对比旧基线出「新增/改动/删除」,产出**策展阅读清单 + 拒绝桶 +
 * 下一步引导**。**只忠告不自动合并**——由模型/人据此选择性移植。
 *
 * 恒只读:只列目录 / 遍历基线目录做 stat,绝不解压落盘、绝不改 Khy 源码。
 * 门控 KHY_UPSTREAM_STUDY_TOOL(flagRegistry 声明式注册,默认开)。关 → 导出 benign 非工具对象,
 * 自动发现循环(tools/index.js Phase 1)全部跳过 → 工具不注册(= 今日无此工具的行为)。
 */
const { BaseTool } = require('../_baseTool');
const upstreamStudy = require('../../services/upstreamStudy');

function _gateEnabled(env = process.env) {
  try {
    const flagRegistry = require('../../services/flagRegistry');
    return flagRegistry.isFlagEnabled('KHY_UPSTREAM_STUDY_TOOL', env);
  } catch {
    const raw = env && env.KHY_UPSTREAM_STUDY_TOOL;
    if (raw === undefined || raw === null) return true;
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

class UpstreamStudyTool extends BaseTool {
  static toolName = 'UpstreamStudy';
  static category = 'analysis';
  static risk = 'low';
  static aliases = ['study_upstream', 'learn_archive', 'study_archive', 'upstream_learn', 'learn_from_zip'];
  static searchHint = '开源项目 更新 压缩包 学习 取其精华弃其糟粕 更新包 upstream study learn archive zip tar 参考项目 借鉴 对比 baseline 更新学习';

  // 恒只读:只列目录 / stat 基线,永不解压落盘、永不改源码。
  isReadOnly() { return true; }
  isDestructive() { return false; }
  isConcurrencySafe() { return false; }

  prompt() {
    return [
      '把开源项目**更新压缩包**学进来:只读列出内容,甄别**精华**(该读/借鉴)与**糟粕**(该忽略),',
      '产出一份有界的策展阅读清单。**只忠告, 不自动合并**——你据清单选择性移植到 Khy。',
      '',
      '用户把某个 Khy 参考过的开源项目的更新包(.zip / .tar.gz)给你时,**用本工具, 不要**手动解压、',
      '再 cat 一堆随机文件——那样会漫无目的、极易走死循环。本工具零解压(无 zip-slip)、条目有上限。',
      '',
      'archive: 压缩包路径(.zip / .tar / .tar.gz),必填。',
      'baseline: 可选,旧版本已解压目录(如上一版 /tmp/Proj-main)。给了就多算「新增/改动/删除」。',
      'top: 精华阅读清单条目数(默认 25)。',
      '',
      '返回 essence(精华清单, 按学习价值排序)、dross(糟粕桶计数)、diff(相对基线)、recognized',
      '(识别到的已学过项目)、plan(移植计划)、report(ASCII 报告)。拿到清单后用 Read 逐个读精华文件。',
      '',
      'plan 回答两问:**哪些能改代码、哪些不能改**——plan.forbidden 是**不能移植**的(许可证/法律文件',
      '照搬会引入上游许可、以及一切糟粕),每个精华项还带 portability(safe 可择优移植 / caution 谨慎',
      '不能整段覆盖, 如构建配置/changelog)。**哪些先改、哪些后改**——plan.waves 按波次排序:0 先读理解',
      '改动 → 1 先改接口/契约/配置(实现依赖它们)→ 2 再改具体实现 → 3 最后改测试验证。按此顺序移植。',
      '',
      '注:更新包很大时先设 KHY_ARCHIVE_MAX_LIST_ENTRIES(默认 2000)提高列出上限, 否则清单会被截断。',
    ].join('\n');
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        archive: {
          type: 'string',
          description: '开源项目更新压缩包路径(.zip / .tar / .tar.gz)。必填',
        },
        baseline: {
          type: 'string',
          description: '可选:旧版本已解压目录。给了就额外算新增/改动/删除(按相对路径+大小比对)',
        },
        top: {
          type: 'number',
          description: '精华阅读清单返回前 N 项。默认 25',
        },
      },
      required: ['archive'],
    };
  }

  async execute(params) {
    const p = params || {};
    if (!p.archive) {
      return { success: false, error: '请提供 archive(开源项目更新压缩包路径)' };
    }
    const result = await upstreamStudy.study({
      archive: p.archive,
      baseline: p.baseline,
      top: p.top,
      env: process.env,
    });

    if (result.success === false) {
      return { success: false, archive: result.archive, error: result.error, skipped: result.skipped };
    }

    return {
      success: true,
      archive: result.archive,
      format: result.format,
      recognized: result.recognized,
      totals: result.totals,
      essence: result.essence,
      essenceTotal: result.essenceTotal,
      dross: result.dross,
      drossTotal: result.drossTotal,
      diff: result.diff,
      plan: result.plan,             // 移植计划:能改/不能改(forbidden+portability)+ 先改/后改(waves)。门关时为 undefined。
      truncated: result.truncated,
      report: result.report,
      hint: '这是只读分析:已列出精华/糟粕, 未改动任何文件。用 Read 逐个读精华清单里的文件, '
        + '只挑真正的改进选择性移植到 Khy —— 按 plan.waves 的先后顺序改、避开 plan.forbidden, 不要整包合并。',
    };
  }

  getActivityDescription() {
    return '学习开源更新包';
  }
}

// 门控关 → 导出 benign 非工具对象,自动发现全部跳过(= 工具不注册,今日行为)。
if (!_gateEnabled(process.env)) {
  module.exports = { _khyUpstreamStudyDisabled: true };
} else {
  module.exports = new UpstreamStudyTool();
  module.exports.UpstreamStudyTool = UpstreamStudyTool;
}
