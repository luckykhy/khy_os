'use strict';

/**
 * DiskAnalyzeTool — 跨平台磁盘分析:找**大文件 / 旧安装包 / 重复文件**,查磁盘占用。
 *
 * 背景(goal「D 盘有哪些垃圾/大文件/旧安装包/重复文件」):khyos 此前无正规磁盘分析路径——
 * DiskCleanup 只清白名单缓存(D 盘几乎啥也找不到),全仓零重复文件检测。缺能力时弱模型即兴写
 * `powershell Get-ChildItem -Recurse` 扫全盘 → 静默全盘递归被 60s 空闲超时杀掉 → 重试调大 timeout
 * 撞 schema 上限报不透明的 `Invalid tool parameters`。本工具提供**有界、只读、跨平台**的正规替代:
 * 墙钟预算 + 条目上限 + hash 候选上限三重兜底,不靠模型手写 PowerShell/find/du。
 *
 * 恒只读:只 stat/readdir/readFile,绝不写盘/删除(清理请转 DiskCleanup)。
 * 门控 KHY_DISKANALYZE_TOOL(flagRegistry 声明式注册,默认开)。关 → 导出 benign 非工具对象,
 * 自动发现循环(tools/index.js Phase 1)全部跳过 → 工具不注册(= 今日无此工具的行为)。
 */
const { BaseTool } = require('../_baseTool');
const diskAnalyze = require('../../services/diskAnalyze');

function _gateEnabled(env = process.env) {
  try {
    const flagRegistry = require('../../services/flagRegistry');
    return flagRegistry.isFlagEnabled('KHY_DISKANALYZE_TOOL', env);
  } catch {
    const raw = env && env.KHY_DISKANALYZE_TOOL;
    if (raw === undefined || raw === null) return true;
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

class DiskAnalyzeTool extends BaseTool {
  static toolName = 'DiskAnalyze';
  static category = 'system';
  static risk = 'low';
  static aliases = ['analyze_disk', 'find_large_files', 'find_duplicates', 'find_old_installers', 'disk_usage'];
  static searchHint = '磁盘分析 大文件 旧安装包 重复文件 磁盘占用 空间去哪了 D盘 C盘 large files duplicate files old installers disk usage what takes space';

  // 恒只读:纯 stat/readdir/readFile,永不删除。
  isReadOnly() { return true; }
  isDestructive() { return false; }
  isConcurrencySafe() { return false; }

  prompt() {
    return [
      '跨平台磁盘分析:找大文件、旧安装包、重复文件,看磁盘空间被什么占用。**只读,绝不删除**。',
      '',
      '找大文件 / 旧安装包 / 重复文件 / 磁盘占用时,**用本工具,不要**手写',
      '`powershell Get-ChildItem -Recurse` / `dir /s` / `find` / `du` 去全盘递归——那样会静默',
      '跑很久、被空闲超时杀掉。本工具有墙钟预算 + 条目上限,超限自动返回部分结果并标记 truncated。',
      '',
      'path/roots: 要分析的目录或盘符,如 "D:"、["C:","D:"]、"~/Downloads"。省略=当前目录。',
      'find: 要找哪几类,["large","installers","duplicates"] 的子集,默认全找。',
      'top: 每类返回前 N 项(默认 20)。',
      'minSizeMB: 「大文件」下限(默认 100MB)。',
      'olderThanDays: 「旧安装包」的天数阈值(默认 180 天)。',
      'maxDepth: 递归深度上限(默认 24)。',
      '',
      '返回 largeFiles / oldInstallers / duplicateGroups + 一份 ASCII 报告(report)。',
      '清理磁盘请改用 DiskCleanup(那个会真删,经人工确认闸)。',
    ].join('\n');
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要分析的单个目录或盘符,如 "D:"、"~/Downloads"。与 roots 二选一',
        },
        roots: {
          type: 'array',
          description: '要分析的多个目录/盘符,如 ["C:","D:"]。省略且无 path=当前目录',
          items: { type: 'string' },
        },
        find: {
          type: 'array',
          description: '找哪几类:large(大文件) / installers(旧安装包) / duplicates(重复文件)。省略=全找',
          items: { type: 'string', enum: ['large', 'installers', 'duplicates'] },
        },
        top: {
          type: 'number',
          description: '每类返回前 N 项。默认 20',
        },
        minSizeMB: {
          type: 'number',
          description: '「大文件」下限(MB)。默认 100',
        },
        olderThanDays: {
          type: 'number',
          description: '「旧安装包」的天数阈值。默认 180',
        },
        maxDepth: {
          type: 'number',
          description: '递归深度上限。默认 24',
        },
      },
      required: [],
    };
  }

  async execute(params, context) {
    const p = params || {};
    // 逐参覆盖:工具入参 → 引擎读的临时 env(不污染 process.env,只本次调用生效)。
    const env = Object.assign({}, process.env);
    if (Number.isFinite(p.minSizeMB) && p.minSizeMB > 0) env.KHY_DISKANALYZE_MIN_SIZE_MB = String(Math.floor(p.minSizeMB));
    if (Number.isFinite(p.olderThanDays) && p.olderThanDays > 0) env.KHY_DISKANALYZE_OLD_INSTALLER_DAYS = String(Math.floor(p.olderThanDays));

    const result = diskAnalyze.analyze({
      roots: p.roots,
      path: p.path,
      find: p.find,
      top: p.top,
      maxDepth: p.maxDepth,
      env,
    });

    return {
      success: result.success !== false,
      platform: result.platform,
      roots: result.roots,
      largeFiles: result.largeFiles,
      oldInstallers: result.oldInstallers,
      duplicateGroups: result.duplicateGroups,
      totals: result.totals,
      truncated: result.truncated,
      notes: result.notes,
      report: result.report,
      hint: result.truncated
        ? '扫描达到上限提前结束,结果为部分视图。可缩小 path/roots 或调 KHY_FS_WALK_BUDGET_MS 再扫。'
        : '这是只读分析,未改动任何文件。要清理请用 DiskCleanup。',
    };
  }

  getActivityDescription() {
    return '分析磁盘占用';
  }
}

// 门控关 → 导出 benign 非工具对象,自动发现全部跳过(= 工具不注册,今日行为)。
if (!_gateEnabled(process.env)) {
  module.exports = { _khyDiskAnalyzeDisabled: true };
} else {
  module.exports = new DiskAnalyzeTool();
  module.exports.DiskAnalyzeTool = DiskAnalyzeTool;
}
