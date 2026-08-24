// 兼容别名：核不点名 khyquant 的磁盘位置，只点名服务 quant-app（[DESIGN-ARCH-069] §3.4）。
// 应用缺席时这里得到 null 而不是加载期抛 MODULE_NOT_FOUND —— 那是 §4.1「删目录即卸载」的前提。
module.exports = require('../services/extensions/quantApp').loadModule('routes/dashboard');
