'use strict';

const { BaseTool } = require('../_baseTool');
const diskCleanup = require('../../services/diskCleanup');
const _clarify = require('../../services/diskCleanupClarify');

/**
 * DiskCleanupTool — 安全清理 C 盘/D 盘的磁盘清理工具（教 khyos 不破坏用户数据地清盘）。
 *
 * 三种 mode：
 *   · scan  只读：列全部候选（含被保护/在用/跳过的，最透明）
 *   · plan  只读：组装「会清什么 + 可回收多少」的计划 + ASCII 报告
 *   · clean 破坏性：真正删除（需 apply:true）。声明 isDestructive→经 riskGate 不可绕人闸，
 *           即便 acceptEdits/yolo 也必须人工确认（对照 feedback「四红线必确认」）。
 *
 * 安全由引擎保证：只清 junkCatalog 白名单、两道否决 fail-closed、回收站等 review 需显式
 * includeReview、删前 TOCTOU 重检。mode=scan/plan 时 isDestructive()=false（只读放行）。
 */
class DiskCleanupTool extends BaseTool {
  static toolName = 'DiskCleanup';
  static category = 'system';
  static risk = 'high';
  static aliases = ['clean_disk', 'cleanup_disk', 'disk_cleanup', 'clean_c_drive'];
  static searchHint = '清理 C盘 D盘 磁盘 垃圾 缓存 临时文件 回收站 清理空间 disk cleanup free space';

  // 动态风险：仅 mode=clean && apply=true 时才是破坏性，scan/plan 为只读。
  isReadOnly(input) {
    const mode = input && input.mode;
    return mode !== 'clean';
  }
  isDestructive(input) {
    return !!(input && input.mode === 'clean' && input.apply === true);
  }
  isConcurrencySafe() { return false; }

  prompt() {
    return [
      '安全清理磁盘（C盘/D盘）空间，绝不破坏用户数据。',
      '只从已知垃圾白名单清理：系统/用户临时文件、浏览器HTTP缓存、缩略图/崩溃转储、',
      'npm/pip/yarn/cargo 等包管理器缓存、本项目自身缓存。',
      '绝不碰：文档/桌面/下载/图片/视频/云盘/源码工程/数据库等用户数据（两道否决+fail-closed）。',
      '',
      'mode:',
      '  scan  — 只读，列全部候选（含被保护/在用/跳过项，最透明）',
      '  plan  — 只读，给「会清什么 + 可回收多少」计划与报告（推荐先跑）',
      '  clean — 真正清理，需 apply:true（破坏性，会经人工确认闸）',
      '',
      'roots: 限定盘符如 ["C:"] 或 ["C:","D:"]；省略=全部可写盘。',
      'includeReview: 是否一并清「需确认」类（回收站/系统更新缓存/macOS/Linux 大缓存）——',
      '  这些涉及可恢复数据，默认 false，务必先向用户说明再开启。',
      'keepRecentHours: 最近多少小时内有写入的目录判为「在用」跳过（默认 2）。',
      'scanDepth/maxDepth: 扫描深度——shallow(2层)/standard(6层,默认)/deep(12层),越深越准越慢。',
      'granularity: scan 结果颗粒度——coarse(按大类汇总)/standard(按目录)/fine(逐项按体积明细)。',
      '清盘前应先用 AskUserQuestion 把「扫描深度」「颗粒细度」交给用户选,再据其选择传参。',
      '建议流程：先 plan 看清单 → 用户确认 → clean apply。',
    ].join('\n');
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: 'scan 只读列候选 / plan 只读计划 / clean 真正清理',
          enum: ['scan', 'plan', 'clean'],
          default: 'plan',
        },
        roots: {
          type: 'array',
          description: '限定盘符，如 ["C:"]、["C:","D:"]；省略=全部可写盘',
          items: { type: 'string' },
        },
        includeReview: {
          type: 'boolean',
          description: '是否一并清理「需确认」类(回收站/更新缓存/大缓存)。默认 false',
          default: false,
        },
        keepRecentHours: {
          type: 'number',
          description: '最近 N 小时内有写入的目录判为在用并跳过。默认 2',
        },
        scanDepth: {
          type: 'string',
          description: '扫描深度档:shallow(浅,2层) / standard(标准,6层,默认) / deep(深,12层)。越深体积/在用判定越准但越慢。也可用 maxDepth 直接给数字',
          enum: ['shallow', 'standard', 'deep'],
        },
        maxDepth: {
          type: 'number',
          description: '扫描递归深度上限(数字,1-64)。优先级高于 scanDepth;省略=用全局默认(6)',
        },
        granularity: {
          type: 'string',
          description: 'scan 结果的颗粒细度:coarse(按大类汇总) / standard(按目录,默认) / fine(逐项按体积明细)',
          enum: ['coarse', 'standard', 'fine'],
        },
        categories: {
          type: 'array',
          description: '仅清理指定类别(system-temp/browser-cache/pkg-cache/...)；省略=全部',
          items: { type: 'string' },
        },
        apply: {
          type: 'boolean',
          description: '仅 mode=clean 生效。false=演练(dry-run，不删)；true=真正删除',
          default: false,
        },
      },
      required: [],
    };
  }

  async execute(params) {
    const mode = (params && params.mode) || 'plan';
    // 扫描深度:用户选的档(scanDepth)或直接数字(maxDepth)→ 归一为递归深度上限;缺省 null
    // → 不放进 opts,scanner 逐字节回退全局阈值(6)。颗粒细度只作用于 scan 输出形状。
    const _depth = _clarify.resolveScanDepth(params);
    const _granularity = _clarify.resolveGranularity(params);
    const opts = {
      roots: params.roots,
      includeReview: !!params.includeReview,
      keepRecentHours: params.keepRecentHours,
      categories: params.categories,
    };
    if (_depth != null) opts.maxDepth = _depth;

    if (mode === 'scan') {
      const res = diskCleanup.scan(opts);
      const candidates = res.candidates.map((c) => ({
        id: c.id,
        label: c.label,
        path: c.path,
        drive: c.drive,
        category: c.category,
        safety: c.safety,
        sizeBytes: c.sizeBytes,
        fileCount: c.fileCount,
        eligible: c.eligible,
        skipReason: c.skipReason,
      }));
      const shaped = _clarify.shapeScanCandidates(candidates, _granularity);
      return {
        success: true,
        mode,
        platform: res.platform,
        driveRoots: res.driveRoots,
        scanDepth: _depth != null ? _depth : 'default',
        granularity: shaped.granularity,
        candidateCount: candidates.length,
        // coarse → 汇总行(rolledUp);standard/fine → 候选明细(fine 已按体积降序)。
        ...(shaped.rolledUp
          ? { categorySummary: shaped.rows }
          : { candidates: shaped.rows }),
      };
    }

    if (mode === 'plan') {
      const p = diskCleanup.plan(opts);
      return {
        success: true,
        mode,
        ...this._planSummary(p),
        report: diskCleanup.renderPlanReport(p),
      };
    }

    // mode === 'clean'
    const apply = params.apply === true;
    const { plan: p, report } = await diskCleanup.clean({ ...opts, apply });
    return {
      success: true,
      mode,
      applied: apply,
      ...this._planSummary(p),
      report: diskCleanup.renderPlanReport(p),
      execution: report.totals,
      items: report.items.map((i) => ({
        label: i.label,
        path: i.path,
        status: i.status,
        freedBytes: i.freedBytes,
        removedItems: i.removedItems,
        vetoReason: i.vetoReason,
        failureCount: (i.failures || []).length,
      })),
      failures: report.failures,
      hint: apply
        ? '已执行清理。'
        : '这是演练(dry-run)，未删除任何文件。确认后以 apply:true 真正清理。',
    };
  }

  _planSummary(p) {
    return {
      platform: p.platform,
      driveRoots: p.driveRoots,
      includeReview: p.includeReview,
      totals: p.totals,
      byCategory: p.byCategory,
      byDrive: p.byDrive,
      review: p.review.map((c) => ({ label: c.label, path: c.path, sizeBytes: c.sizeBytes, note: c.note })),
      protectedSkipped: p.skipped.map((c) => ({ label: c.label, path: c.path, reason: c.skipReason })),
    };
  }

  getActivityDescription(input) {
    const mode = (input && input.mode) || 'plan';
    const map = { scan: '扫描磁盘垃圾', plan: '规划磁盘清理', clean: '清理磁盘空间' };
    return map[mode] || '磁盘清理';
  }
}

module.exports = DiskCleanupTool;
