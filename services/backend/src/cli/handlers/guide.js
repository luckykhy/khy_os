/**
 * CLI Handler: `khy guide` — 轨迹即教材 / 地图模板（DESIGN-ARCH-049 capability C）。
 *
 * 把一条已录制的成功轨迹蒸馏成「地图模板」，供弱模型/效果差的大模型照着走：
 *
 *   khy guide map [session]                    强模型蒸馏轨迹 → map.json（+qualityScore）
 *   khy guide export <mapId> [--format=md|folder]  map → SKILL.md 入技能生态
 *   khy guide list                             列已蒸馏 map（task + qualityScore）
 *
 * 防呆（方案 §六防呆红线）：
 *   - 仅强模型可作者地图（mapAuthor 闸 KHY_TRAJ_MAP_AUTHOR_MIN_STRENGTH）；弱模型显式拒绝。
 *   - 纯编排：蒸馏/持久化/导出全在 trajectoryGuide 子系统，handler 只读/编排。
 *   - 未知 session / mapId 友好报错，不崩。
 */
'use strict';

const chalk = require('chalk').default || require('chalk');
const {
  printError, printWarn, printInfo, printSuccess, printTable,
} = require('../formatters');

const sessionPersistence = require('../../services/sessionPersistence');
const replayLedger = require('../../services/trajectoryReplay/replayLedger');
const replayBundle = require('../../services/trajectoryReplay/replayBundle');
const mapAuthor = require('../../services/trajectoryGuide/mapAuthor');
const mapStore = require('../../services/trajectoryGuide/mapStore');
const mapExport = require('../../services/trajectoryGuide/mapExport');
const trajectoryGuideConfig = require('../../services/trajectoryGuide/config');
// Model-name SSOT: strongest-known model fallback flows from constants/models.js.
const { PRIMARY: MODELS } = require('../../constants/models');

/** 解析目标 sessionId：显式参数优先，否则取最近一条会话。 */
function resolveSessionId(arg) {
  if (arg) return String(arg);
  const sessions = sessionPersistence.listPersistedSessions({ limit: 1 });
  return sessions.length ? sessions[0].sessionId : null;
}

/** 解析当前作者模型 id：显式 --model 优先，否则用配置默认（或保守占位）。 */
function resolveAuthorModel(options) {
  if (options && typeof options.model === 'string' && options.model.trim()) {
    return options.model.trim();
  }
  // 复用 repairModel 旋钮作为「当前强模型」线索；缺省回退到最强已知模型。
  return trajectoryGuideConfig.repairModel() || MODELS.opus;
}

/** `khy guide map [session]` — 强模型蒸馏轨迹为地图模板。 */
function guideMap(arg, options = {}) {
  const sessionId = resolveSessionId(arg);
  if (!sessionId) {
    printWarn('未找到任何会话可蒸馏。');
    printInfo('用 `khy replay list` 查看可回放/可蒸馏的会话。');
    return;
  }

  // 优先读已导出的回放包（自包含 manifest）；否则从账本即时构建一个 manifest。
  let manifest = null;
  const bundleDir = replayBundle.bundleDirFor(sessionId);
  const read = replayBundle.readBundle(bundleDir);
  if (read.ok) {
    manifest = read.manifest;
  } else {
    const jsonlPath = sessionPersistence.jsonlPathFor(sessionId);
    const ledgerPath = replayLedger.ledgerPathFor(jsonlPath);
    const steps = replayLedger.read(ledgerPath);
    if (!steps.length) {
      printWarn(`该会话无回放账本，无步骤可蒸馏: ${sessionId}`);
      printInfo('账本在 AI 调用文件/壳工具时按需生成；先 `khy replay export <会话ID>`。');
      return;
    }
    manifest = { v: 1, sessionId, env: null, steps };
  }

  const modelId = resolveAuthorModel(options);
  let result;
  try {
    result = mapAuthor.authorMap(manifest, { modelId, task: options.task });
  } catch (e) {
    if (e && e.code === 'MAP_AUTHOR_FORBIDDEN') {
      printError(`模型 ${modelId} 智能不足，不可作者地图模板（仅强模型可蒸馏）。`);
      printInfo('用 --model=<强模型ID> 指定，或调 KHY_TRAJ_MAP_AUTHOR_MIN_STRENGTH。');
      return;
    }
    printError(`蒸馏失败: ${e && e.message ? e.message : String(e)}`);
    return;
  }

  const file = mapStore.saveMap(result.map);
  const m = result.map;
  console.log(`\n  ${chalk.cyan.bold('地图模板已蒸馏')}  ${chalk.dim(m.id)}\n`);
  printInfo(`任务: ${m.task}`);
  printInfo(`步骤: ${m.steps.length}  质量分: ${chalk.green(String(m.qualityScore))}  作者: ${m.createdBy} (${m.createdTier})`);
  printInfo(`已存: ${file}`);
  printSuccess(`导出为技能: khy guide export ${m.id}`);
}

/** `khy guide export <mapId> [--format=md|folder]` — 导出地图为技能。 */
async function guideExport(arg, options = {}) {
  if (!arg) {
    printWarn('用法: khy guide export <mapId> [--format=md|folder]');
    printInfo('用 `khy guide list` 查看已蒸馏的地图。');
    return;
  }
  const format = options.format === 'md' || options.format === 'folder' ? options.format : 'folder';
  let res;
  try {
    res = await mapExport.exportAsSkill(String(arg), { format });
  } catch (e) {
    if (e && e.code === 'MAP_NOT_FOUND') {
      printError(`未找到地图: ${arg}`);
      printInfo('用 `khy guide list` 查看已蒸馏的地图。');
      return;
    }
    printError(`导出失败: ${e && e.message ? e.message : String(e)}`);
    return;
  }
  console.log(`\n  ${chalk.cyan.bold('地图已入技能生态')}  ${chalk.dim(res.mapId)}\n`);
  printInfo(`技能名: ${res.name}`);
  printInfo(`目录: ${res.dest}  (格式 ${res.format})`);
  printSuccess('弱模型可经技能目录照此地图走。');
}

/** `khy guide list` — 列出已蒸馏的地图模板。 */
function guideList() {
  const maps = mapStore.listMaps();
  if (!maps.length) {
    printInfo('暂无地图模板。蒸馏：khy guide map <会话ID>。');
    return;
  }
  const rows = maps
    .slice()
    .sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0))
    .map((m) => [
      m.id,
      (m.task || '(untitled)').slice(0, 36),
      String((m.steps || []).length),
      chalk.green(String(m.qualityScore == null ? '?' : m.qualityScore)),
      (m.createdBy || '?'),
    ]);
  console.log(`\n  ${chalk.cyan.bold('地图模板')}\n`);
  printTable(['地图 ID', '任务', '步数', '质量分', '作者模型'], rows);
  printInfo('导出为技能：khy guide export <地图ID>。');
}

/**
 * Main handler — dispatch `guide` 子命令。
 */
async function handleGuide(subCommand, args = [], options = {}) {
  const sub = String(subCommand || 'list').toLowerCase();

  if (sub === 'map') return guideMap(args[0], options);
  if (sub === 'export') return guideExport(args[0], options);
  if (sub === 'list') return guideList();

  printError(`未知子命令: ${sub}`);
  printInfo('可用: map | export | list');
  return undefined;
}

module.exports = { handleGuide };
