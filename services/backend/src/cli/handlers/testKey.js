'use strict';

/**
 * testKey.js — `khy test-key` CLI:输入各厂商 API Key,测试是否连通。
 *
 * /goal「把各个模型厂商的测试命令写成脚本,方便 pip 装后输入 key 测试是否连通」。
 *
 * 用法:
 *   khy test-key list                     列出可测厂商 + 协议族 + 端点(诚实标注不可测的与理由)
 *   khy test-key <厂商> [--key K] [--model M] [--endpoint E]
 *                                          测单个厂商(key 优先级:--key > 环境变量 > 交互输入)
 *   khy test-key --all                     测所有「环境变量里已配 key」的厂商
 *   khy test-key                           (交互 TTY)逐厂商提示输入 key 并测试
 *
 * 判定 / 请求构造全部委托 providerConnectivitySpec(单一真源);本层做 IO + 交互 + 表格渲染。
 * key 只在运行时传入(命令行参数 / 环境变量 / 交互密文输入),**绝不写入 repo / 包 / 磁盘**。
 */

const { printError, printInfo, printTable, printSuccess } = require('../formatters');

/**
 * @param {string[]} args 位置参数(args[0] = 子命令或厂商名)
 * @param {object} options 解析后的 --flag 选项
 */
async function handleTestKey(args = [], options = {}) {
  const env = process.env;
  const spec = require('../../services/gateway/providerConnectivitySpec');
  const tester = require('../../services/gateway/providerConnectivityTester');

  if (!spec.isEnabled(env)) {
    printError('厂商连通性自检已被 KHY_PROVIDER_CONNECTIVITY_TEST 关闭。');
    return;
  }

  const sub = String((args && args[0]) || '').trim();
  const timeoutMs = _timeoutMs(options);

  // ── list:列出全部厂商目标 ──
  if (sub === 'list' || options.list === true) {
    const targets = spec.listConnectivityTargets(env);
    const rows = targets.map((t) => [
      t.name,
      t.poolKey || '-',
      t.service || '-',
      t.testable ? '可测' : '跳过',
      t.testable ? (t.endpoint || '(需 --endpoint)') : (t.skipReason || '-'),
    ]);
    printTable(['厂商', 'poolKey', '协议', '连通测试', '端点 / 说明'], rows);
    printInfo('用法: khy test-key <厂商> [--key K] [--model M] [--endpoint E]  |  khy test-key --all');
    return;
  }

  // ── --all:测所有环境变量里已配 key 的厂商 ──
  if (options.all === true) {
    printInfo('测试所有「环境变量里已配置 key」的厂商(未配 key 的自动跳过)…');
    const results = await tester.testAll({ timeoutMs }, env);
    _printResults(results);
    return;
  }

  // ── 单个厂商 ──
  if (sub) {
    const target = spec.resolveConnectivityTarget(sub, env);
    if (!target) {
      printError(`未知厂商: ${sub}。用 khy test-key list 查看可测厂商。`);
      return;
    }
    if (!target.testable) {
      printError(`${target.name} 暂不支持自动连通测试:${target.skipReason}`);
      return;
    }
    let key = String(options.key || (target.envKey && env[target.envKey]) || '').trim();
    if (!key) key = await _promptKey(target);
    if (!key) { printInfo('未提供 key,已取消。'); return; }
    const model = options.model || target.testModel;
    printInfo(`测试 ${target.name}(${target.service} 协议,模型 ${model})…`);
    const res = await tester.testConnectivity({
      poolKey: target.poolKey, key,
      model: options.model, endpoint: options.endpoint, timeoutMs,
    }, env);
    _printResults([res]);
    return;
  }

  // ── 裸调用:交互模式逐厂商提问(仅 TTY)──
  if (!process.stdin || !process.stdin.isTTY) {
    printInfo('用法: khy test-key list | khy test-key <厂商> [--key K] | khy test-key --all');
    printInfo('(非交互环境无法提示输入 key;请用 --key 或环境变量,或加 --all。)');
    return;
  }
  const targets = spec.listConnectivityTargets(env).filter((t) => t.testable);
  printInfo(`将逐个厂商询问 API Key(共 ${targets.length} 个,直接回车即跳过)。`);
  const results = [];
  for (const t of targets) {
    // eslint-disable-next-line no-await-in-loop
    const key = await _promptKey(t);
    if (!key) { printInfo(`跳过 ${t.name}。`); continue; }
    // eslint-disable-next-line no-await-in-loop
    results.push(await tester.testConnectivity({ poolKey: t.poolKey, key, timeoutMs }, env));
  }
  if (results.length) _printResults(results);
  else printInfo('未输入任何 key。');
}

/** 交互密文输入一把 key(非 TTY / 失败 → '')。 */
async function _promptKey(target) {
  if (!process.stdin || !process.stdin.isTTY) return '';
  try {
    const { promptCompat } = require('../uiPrompt');
    const ans = await promptCompat([{
      type: 'password', name: 'key', mask: '*',
      message: `输入 ${target.name} 的 API Key(直接回车跳过):`,
    }]);
    return String((ans && ans.key) || '').trim();
  } catch { return ''; }
}

/** 把 --timeout(秒)转成毫秒;缺省 → undefined(交给 tester 默认 15s)。 */
function _timeoutMs(options) {
  const raw = options && (options.timeout || options.t);
  const secs = Number(raw);
  return Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : undefined;
}

/** 渲染结果表格 + 汇总。 */
function _printResults(results) {
  const rows = results.map((r) => {
    const glyph = r.verdict === 'ok' ? '✓' : (r.verdict === 'skipped' ? '·' : '✗');
    const detail = r.label || r.reason || r.error || '-';
    const lat = r.latencyMs != null ? `${r.latencyMs}ms` : '-';
    return [`${glyph} ${r.name || r.poolKey || '-'}`, r.status || '-', lat, detail];
  });
  printTable(['厂商', '状态码', '耗时', '结论'], rows);
  const okCount = results.filter((r) => r.verdict === 'ok').length;
  const failCount = results.filter((r) => r.verdict !== 'ok' && r.verdict !== 'skipped').length;
  if (okCount > 0 && failCount === 0) {
    printSuccess(`共 ${results.length} 项:连通且 key 有效 ${okCount} 项。`);
  } else {
    printInfo(`共 ${results.length} 项:连通且 key 有效 ${okCount} 项,失败 ${failCount} 项。`);
  }
}

module.exports = { handleTestKey };
