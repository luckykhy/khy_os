'use strict';

/**
 * AgentAssetsTool — 统一发现/读取/迁移外部 agent 工具的记忆、工具与技能。
 *
 * 这是 services/agentAssets/* 那三层(注册表 / 适配器 / 编排)对模型的唯一出口。
 * 与既有工具的分工:DiscoverSkillsTool 只看 khy 自己的技能,LocalMemoryRecall 只读
 * khy 自己的记忆,configureExternalApp/importExternalAppModels 只碰外部 app 的
 * 「模型与连接配置」——三类资产的跨工具迁移此前无人负责,本工具补的就是这一层。
 *
 * 安全:凭据在适配器出口就被抹成占位符,故本工具的返回值里绝不会出现 API key/token;
 * 回写时占位符路径沿用目标侧现值,不会拿占位符覆盖用户真实密钥。
 * 写操作 dryRun 默认为真(risk:'high' 驱动人工确认闸门),模型必须显式传
 * dryRun=false 才落盘;action=sync/import/export 未确认时只回计划。
 */

const registry = require('../../services/domain/agents/agentAssets/registry.js');
const { defineTool } = require('../_baseTool');

/**
 * 厂商清单从注册表推导,**不在本文件写死**。写死的话「新增一家 = 一个适配器文件 +
 * 表里一行」就不成立了:模型看到的 description/enum 还停在旧清单上,新接的那家
 * 对模型等于不存在。这里用静态表 AGENT_ASSET_SOURCES 而不是受门控的
 * listSourceIds(env):工具 schema 在模块加载时就固定了,拿不到调用时的 env。
 */
const _SOURCE_IDS = Object.freeze(registry.AGENT_ASSET_SOURCES.map((s) => s.id));
const _SOURCE_LABELS = registry.AGENT_ASSET_SOURCES.map((s) => s.label).join('、');
const _SOURCE_ID_LIST = _SOURCE_IDS.map((id) => `'${id}'`).join('|');

const _ACTIONS = Object.freeze(['discover', 'list', 'plan', 'import', 'export', 'sync']);

const _WRITE_ACTIONS = Object.freeze(['import', 'export', 'sync']);

function _resolveAction(input) {
  const a = String((input && input.action) || 'discover')
    .trim()
    .toLowerCase();
  return _ACTIONS.includes(a) ? a : 'discover';
}

function _kinds(input) {
  const raw = input && input.kinds;
  if (Array.isArray(raw)) {
    return raw;
  }
  const s = String(raw || '').trim();
  return s ? s.split(/[,\s]+/).filter(Boolean) : [];
}

/** 干跑判定:显式 false 才落盘,其余一切(缺省/true/字符串)都算干跑。 */
function _isDryRun(input) {
  return !(input && (input.dryRun === false || input.dryRun === 'false'));
}

module.exports = defineTool({
  name: 'agentAssets',
  description:
    '统一发现与迁移外部 agent 工具的三类资产(记忆 memory / 工具 tool / 技能 skill)。' +
    `已接入:${_SOURCE_LABELS}。` +
    'action=discover 全景盘点各家装没装、各有多少项;list 列某一家的资产;plan 只看某个方向会发生什么;import 外部→khy-os;export khy-os→外部;sync 双向。写操作 dryRun 默认为真,只有显式传 dryRun=false 才落盘;同名不同内容一律保留双方并生成冲突副本,绝不覆盖用户资产;返回值里的凭据字段一律已脱敏。',
  category: 'system',
  risk: 'high',
  aliases: ['agent_assets', 'externalAgentAssets'],
  searchHint:
    '外部 agent 资产 记忆 工具 技能 迁移 同步 导入 导出 memory tool skill mcp 跨工具 搬记忆 搬技能 agent assets migrate sync import export 换工具 资产清零 ' + _SOURCE_IDS.join(' '),
  isReadOnly: (input) => !_WRITE_ACTIONS.includes(_resolveAction(input)) || _isDryRun(input),
  isConcurrencySafe: false,
  shouldDefer: true,
  maxResultSizeChars: 8000,

  inputSchema: {
    action: {
      type: 'string',
      required: false,
      enum: _ACTIONS.slice(),
      description:
        "动作:'discover'(默认,全景盘点)|'list'(列某一家)|'plan'(只看计划)|'import'(外部→khy-os)|'export'(khy-os→外部)|'sync'(双向)",
    },
    tool: {
      type: 'string',
      required: false,
      enum: _SOURCE_IDS.slice(),
      description: `目标工具 id:${_SOURCE_ID_LIST}。list/import/export/sync 必填`,
    },
    to: {
      type: 'string',
      required: false,
      description: 'plan 动作的目标侧工具 id(缺省 khy-os);也可用于 tool→to 的直接迁移',
    },
    kinds: {
      type: 'string',
      required: false,
      description: "资产类型过滤,逗号分隔:'memory'|'tool'|'skill'。缺省三类全要",
    },
    dryRun: {
      type: 'boolean',
      required: false,
      description: '干跑开关。默认为真(只回计划不落盘);必须显式传 false 才真正写入',
    },
    onConflict: {
      type: 'string',
      required: false,
      enum: ['keep-both', 'skip'],
      description:
        "冲突处理:'keep-both'(默认,保留双方 + 生成冲突副本)|'skip'(跳过冲突项)。两者都绝不覆盖目标侧原资产",
    },
  },

  getActivityDescription(input) {
    const action = _resolveAction(input);
    const tool = String((input && input.tool) || '').trim();
    const kinds = _kinds(input);
    const scope = kinds.length ? kinds.join('/') : '记忆/工具/技能';
    if (action === 'discover') {
      return `盘点各外部 agent 工具的${scope}资产(只读)`;
    }
    if (action === 'list') {
      return `列出 ${tool || '指定工具'} 的${scope}资产(只读)`;
    }
    if (action === 'plan') {
      return `预演 ${tool || '源'} → ${String((input && input.to) || 'khy-os')} 的${scope}同步计划(只读)`;
    }
    const mode = _isDryRun(input) ? '干跑' : '落盘';
    if (action === 'import') {
      return `把 ${tool || '外部工具'} 的${scope}导入 khy-os（${mode}）`;
    }
    if (action === 'export') {
      return `把 khy-os 的${scope}导出到 ${tool || '外部工具'}（${mode}）`;
    }
    return `双向同步 khy-os 与 ${tool || '外部工具'} 的${scope}（${mode}）`;
  },

  async execute(params = {}) {
    const model = require('../../services/domain/agents/agentAssets/assetModel.js');
    if (!model.isEnabled(process.env)) {
      return {
        success: false,
        error: '外部 agent 资产层已被门控关闭(KHY_AGENT_ASSETS=off),未读写任何文件',
      };
    }
    const sync = require('../../services/domain/agents/agentAssets/sync.js');
    const action = _resolveAction(params);
    const kinds = _kinds(params);
    const dryRun = _isDryRun(params);
    const tool = String(params.tool || '').trim();

    try {
      if (action === 'discover') {
        const res = sync.discover({ kinds });
        return res.ok
          ? { success: true, action, ...res }
          : { success: false, action, error: res.error };
      }

      if (action === 'list') {
        if (!tool) {
          return { success: false, action, error: '缺少参数 tool(要列出哪一家的资产)' };
        }
        const res = sync.listTool(tool, { kinds });
        if (!res.ok) {
          return { success: false, action, error: res.error };
        }
        return {
          success: true,
          action,
          tool: res.tool,
          label: res.label,
          detected: res.detected,
          root: res.root || '',
          error: res.error || '',
          checked: res.checked || [],
          counts: Object.fromEntries(
            Object.keys(res.byKind || {}).map((k) => [k, res.byKind[k].length])
          ),
          assets: res.assets.map((a) => ({
            kind: a.kind,
            identity: model.assetIdentity(a),
            name: a.title || a.name || a.id,
            scope: a.scope || '',
            toolKind: a.toolKind || '',
            path: (a.source && a.source.path) || '',
            redactedFields: (a.source && a.source.redactedFields) || [],
            updatedAt: a.updatedAt || '',
          })),
        };
      }

      if (action === 'plan') {
        if (!tool) {
          return { success: false, action, error: '缺少参数 tool(同步的源侧工具)' };
        }
        const res = sync.plan({ from: tool, to: String(params.to || 'khy-os').trim(), kinds });
        return res.ok
          ? { success: true, action, ...res }
          : { success: false, action, error: res.error };
      }

      // 写动作:import / export / sync
      if (!tool) {
        return { success: false, action, error: `缺少参数 tool（${action} 的外部工具一侧）` };
      }
      const common = { kinds, dryRun, onConflict: params.onConflict };
      let res;
      if (action === 'import') {
        res = sync.importAssets({ ...common, from: tool });
      } else if (action === 'export') {
        res = sync.exportAssets({ ...common, to: tool });
      } else {
        res = sync.syncAssets({ ...common, a: tool, b: String(params.to || 'khy-os').trim() });
      }
      if (!res.ok) {
        return { success: false, action, dryRun, error: res.error };
      }
      return {
        success: true,
        action,
        dryRun,
        ...res,
        hint: dryRun
          ? '以上为干跑计划,未写入任何文件。确认无误后带 dryRun=false 重新调用才会落盘。'
          : '已落盘。冲突项以冲突副本形式保留,目标侧原资产未被改动。',
      };
    } catch (err) {
      return { success: false, action, error: (err && err.message) || String(err) };
    }
  },
});
