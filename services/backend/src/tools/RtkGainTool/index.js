'use strict';

const { BaseTool } = require('../_baseTool');
const rtkMode = require('../../services/rtkMode');
const rtkEffectiveState = require('../../services/rtkEffectiveState');

/**
 * RtkGainTool —— 展示 RTK 省 token 统计(只读)。
 *
 * 用户要求把 RTK 做成 khy 默认 token 节省层并「集成 rtk gain 省 token 统计展示」。
 * 本工具是 rtk gain 对模型的只读出口:
 *   · gain    —— 跑 `rtk gain [--project]`,解析出总省量/占比/分命令明细;
 *   · status  —— rtk 版本 + 是否启用(KHY_RTK_MODE/KHY_RTK_FILE_TOOLS)+ 二进制定位。
 *
 * 只读、并发安全:只运行 rtk 的只读统计子命令并解析文本,不写盘、不改配置。
 * 缺二进制时返回明确提示(未安装 / 自动安装是否开启),不抛。
 */
class RtkGainTool extends BaseTool {
  static toolName = 'RtkGain';
  static category = 'analysis';
  static risk = 'safe';
  static aliases = ['rtk_gain', 'rtk_stats', 'token_savings'];
  static searchHint = 'rtk gain token 节省 省 token 统计 savings 省了多少 token RTK 状态';

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return [
      'RTK 省 token 统计(只读)。RTK 是 khy 默认开启的 token 节省层,把命令输出压缩后再喂模型。',
      'view:',
      "  · 'gain'   —— 跑 `rtk gain`,返回总省量/占比/分命令明细(project=true 仅本项目);",
      "  · 'status' —— rtk 版本 + 启用状态(KHY_RTK_MODE / KHY_RTK_FILE_TOOLS)+ 二进制路径。",
      '缺 rtk 二进制时返回未安装提示。统计是只读的,不改任何配置。',
    ].join('\n');
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          description: "返回内容:'gain' 省 token 统计(默认) / 'status' 启用状态与版本",
          enum: ['gain', 'status'],
          default: 'gain',
        },
        project: {
          type: 'boolean',
          description: 'gain 视图:仅统计当前项目(rtk gain --project)。默认 false 为全局。',
          default: false,
        },
      },
      required: [],
    };
  }

  async execute(params = {}) {
    const view = params.view || 'gain';
    const bin = await rtkMode.resolveBinary();

    if (view === 'status') {
      const mode = rtkMode.modeEnabled();
      // 真实生效态对账(加法式):保留原有 enabled(env 意图)/installed(二进制)字段不变,
      // 另加 effective(两者皆真才生效)+ statusLabel(人话),消除「enabled:true 但没装」的歧义。
      // 门控关 → describeEffectiveState 返 null,不加新字段(逐字节回退旧结构)。
      const eff = rtkEffectiveState.describeEffectiveState(
        { mode, installed: !!bin, autoInstall: rtkMode.autoInstallEnabled() },
        process.env
      );
      return {
        success: true,
        view,
        enabled: mode,
        fileToolsEnabled: rtkMode.fileToolsEnabled(),
        autoInstallEnabled: rtkMode.autoInstallEnabled(),
        binary: bin || null,
        installed: !!bin,
        version: bin ? rtkMode.probeVersion({ bin }) : null,
        ...(eff ? { effective: eff.effective, status: eff.status, statusLabel: eff.label, hint: eff.hint } : {}),
      };
    }

    // view === 'gain'
    if (!bin) {
      return {
        success: false,
        view,
        installed: false,
        error: rtkMode.autoInstallEnabled()
          ? 'rtk 尚未安装(首次跑 shell 命令时会自动安装,稍后再查统计)。'
          : 'rtk 未安装且自动安装已关闭(KHY_RTK_AUTO_INSTALL)。',
      };
    }

    const res = rtkMode.runGain({ bin, project: !!params.project });
    if (res.error) {
      return { success: false, view, installed: true, error: res.error };
    }
    return {
      success: true,
      view,
      installed: true,
      stats: res.stats,
      raw: res.raw,
    };
  }

  getActivityDescription(input) {
    const view = (input && input.view) || 'gain';
    return view === 'status' ? 'RTK 启用状态' : 'RTK 省 token 统计';
  }
}

module.exports = RtkGainTool;
