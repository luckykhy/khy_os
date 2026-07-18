'use strict';

/**
 * topology.js — `/topology` 命令薄壳:把历次 /fork 分叉**组织成一张会话网**并可视化。
 *
 * 学自 Stello「把线性对话炸开成一张网」。背后算法(反向边 → 正向森林、树渲染、
 * 「你在这里」)在纯叶子 cli/sessionTopology;读盘/派生 status/读 digest 在薄壳服务
 * services/session/sessionForestService。本 handler 只解析子命令 + 渲染。
 *
 * 子命令:
 *   /topology              森林树视图(默认 view)
 *   /topology digest       orchestrator 视角的各分支 digest(id/状态/memory 摘要)
 *   /topology putInsight <id> <text>   写某分支的一次性 insight(下次进入该会话注入一次即清)
 *   /topology putMemory  <id> <text>   写某分支的外向 memory 摘要(绝不自注入,仅供跨支读取)
 *   (刀 3 追加 synthesize)
 *
 * 门控:KHY_SESSION_TOPOLOGY 默认开;关 → 森林退化为平铺会话列表(字节级近似历史)。
 */

const { printInfo, printError, printSuccess, printTable, printWarn } = require('../formatters');

function _forest() {
  return require('../../services/session/sessionForestService');
}

function _topology() {
  return require('../sessionTopology');
}

// 收敛到 utils/truncateEllipsis 单一真源(逐字节/语义等价委托,调用点不变)
const _truncate = require('../../utils/truncateEllipsis');

function _renderView(svc, topo) {
  const current = svc.getCurrentSessionId();
  const { forest } = svc.listForest({});
  if (!forest.nodes.length) {
    printInfo('暂无持久化会话——先聊几句,或用 /fork 分出一条岔路,这里就会长出一张网。');
    return true;
  }
  const enabled = topo.topologyEnabled(process.env);
  printInfo(
    `会话拓扑(${forest.nodes.length} 个节点 · ${forest.roots.length} 条主干)` +
    (enabled ? '' : '  ⚠ KHY_SESSION_TOPOLOGY=0:已退化为平铺列表')
  );
  const lines = topo.renderForestTree(forest, { currentId: current });
  for (const line of lines) printInfo(line);
  if (current && forest.byId[current]) {
    printInfo('');
    printInfo('提示:思路若开始发散,/fork 开一条新分支,而非把当前线越拉越长。');
  }
  return true;
}

function _renderDigest(svc) {
  const digests = svc.listDigests({});
  if (!digests.length) {
    printInfo('暂无会话 digest。');
    return true;
  }
  const rows = digests.map((d) => [
    _truncate(d.id, 12),
    _truncate(d.label, 28),
    d.status,
    String(d.turnCount),
    d.memory ? _truncate(d.memory, 48) : '—',
  ]);
  printInfo('各分支 digest(orchestrator 视角;memory = 外向摘要,绝不注入节点自身上下文):');
  printTable(['Session', 'Label', 'Status', 'Turns', 'Memory'], rows);
  return true;
}

function _renderPut(svc, slot, args) {
  const id = args && args[0];
  const text = (args || []).slice(1).join(' ').trim();
  if (!id || !text) {
    printError(`用法:/topology ${slot === 'insight' ? 'putInsight' : 'putMemory'} <sessionId> <文本>`);
    return false;
  }
  const ok = slot === 'insight' ? svc.putInsight(id, text) : svc.putMemory(id, text);
  if (!ok) {
    printError(`写入失败:会话 ${_truncate(id, 16)} 不存在,或 KHY_SESSION_SLOTS=0 已禁用三槽。`);
    return false;
  }
  if (slot === 'insight') {
    printSuccess(`已写入 insight → ${_truncate(id, 16)}:下次进入该会话注入一次即清空。`);
  } else {
    printSuccess(`已写入 memory → ${_truncate(id, 16)}:外向摘要,绝不注入该节点自身,供跨支/综合读取。`);
  }
  return true;
}

async function _renderSynthesize(svc) {
  printInfo('跨支综合:读遍所有分支 digest → 反思 → 回写各支 insight + 根 memory……');
  let res;
  try {
    res = await svc.synthesize({});
  } catch (e) {
    printError(`综合失败:${(e && e.message) || e}`);
    return false;
  }
  if (!res || !res.ok) {
    const reason = res && res.reason;
    if (reason === 'disabled') {
      printWarn('KHY_CROSS_BRANCH_SYNTHESIS=0:跨支综合已禁用。');
    } else if (reason === 'empty') {
      printInfo('网中暂无分支可综合——先用 /fork 分出几条岔路。');
    } else if (reason === 'no-model') {
      printWarn('无可用模型 / 离线:跨支综合需要模型推理,当前不可用(绝不伪造综合)。');
    } else {
      printError('综合未完成(未知原因)。');
    }
    return false;
  }
  printSuccess(
    `综合完成:回写 ${res.written.insights} 条分支 insight` +
    (res.written.rootId ? ` + 根 ${_truncate(res.written.rootId, 12)} 的 memory` : '') + '。'
  );
  if (res.rootSynthesis) {
    printInfo('');
    printInfo('【根综合】');
    printInfo(res.rootSynthesis);
  }
  return true;
}

function _help() {
  printInfo([
    'khy /topology — 把历次 /fork 分叉组织成一张「会话拓扑网」',
    '',
    '  /topology                       森林树视图(默认):根 → 分支,标注当前所在节点',
    '  /topology digest                各分支 digest(id/状态/turns/memory 摘要)',
    '  /topology putInsight <id> <文本>  写某分支一次性 insight(注入一次即清)',
    '  /topology putMemory  <id> <文本>  写某分支外向 memory(绝不自注入,仅跨支读)',
    '  /topology synthesize            跨支综合:读遍所有分支 → 反思 → 回写各支 insight + 根 memory',
    '',
    '  Gate: KHY_SESSION_TOPOLOGY=0 → 退化为平铺会话列表(字节级近似历史)。',
    '        KHY_SESSION_SLOTS=0    → 禁用三槽(putInsight/putMemory 拒绝,注入消失)。',
    '        KHY_CROSS_BRANCH_SYNTHESIS=0 → 禁用跨支综合。',
  ].join('\n'));
}

/**
 * @param {string} subCommand
 * @param {string[]} [args]
 * @param {object} [options]
 * @returns {Promise<boolean>}
 */
async function handleTopology(subCommand, args = [], options = {}) {
  const svc = _forest();
  const topo = _topology();
  const list = Array.isArray(args) ? args : [];
  // 子命令可能来自 router 的 subCommand,或落在 args[0](topology 未登记 SUB_COMMANDS)。
  // 后者情形下,put* 的实参从 args[1] 起,故据来源算出剩余实参 rest。
  const hasExplicitSub = subCommand != null && String(subCommand) !== '';
  const sub = String(hasExplicitSub ? subCommand : (list[0] || 'view')).toLowerCase();
  const rest = hasExplicitSub ? list : list.slice(1);

  try {
    switch (sub) {
      case 'view':
      case '':
        return _renderView(svc, topo);
      case 'digest':
      case 'digests':
        return _renderDigest(svc);
      case 'putinsight':
        return _renderPut(svc, 'insight', rest);
      case 'putmemory':
        return _renderPut(svc, 'memory', rest);
      case 'synthesize':
      case 'synth':
        return await _renderSynthesize(svc);
      case 'help':
        _help();
        return true;
      default:
        printWarn(`未知子命令:${sub}`);
        _help();
        return true;
    }
  } catch (e) {
    printError(`topology ${sub} failed: ${(e && e.message) || e}`);
    return false;
  }
}

module.exports = { handleTopology };
