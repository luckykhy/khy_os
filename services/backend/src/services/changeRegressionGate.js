/**
 * @deprecated 2026-09-03 此文件是 quantApp 的兼容别名 shim，3 月后删除。
 * 如需使用，请改为 require('./domain/extensions/extensions/quantApp').loadModule('services/changeRegressionGate.js')
 */
// 兼容别名：核心不依赖 khyquant 的磁盘位置，只点名服务 quant-app（[DESIGN-ARCH-069] §3.4）
// 应用缺席时这里返回 null 而不是加载期抛出 MODULE_NOT_FOUND —— 那是 §4.1「删目录即卸载」的前提
module.exports = require('./domain/extensions/extensions/quantApp').loadModule('services/changeRegressionGate.js');
